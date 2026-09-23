import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SYNC_STATE } from "../src/records/syncState.js";
import {
  PULL_ACTION,
  RESOLUTION_ACTION,
  classifyPulledRow,
  classifyResolution,
  pulledMetadataPatch,
  readCursor,
  releaseLegacyDeletionLock,
  windowStart,
} from "../src/sync/pullRules.js";

const RECORD_ID = "3d2c1b0a-9f8e-4d7c-b6a5-4f3e2d1c0b9a";
const THIS_DEVICE = "0f8e5c1a-6b2d-4e7f-9a3c-5d1e2f3a4b5c";
const OTHER_DEVICE = "7c3a9e1f-2b4d-4c6e-8f0a-1b2c3d4e5f60";
const WORKER = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

const TOMBSTONE_AT = "2026-09-22 15:16:21.934000";

// The Dexie row. Frozen all the way down, so a decision function that tried to
// "fix up" the row it was handed would throw instead of passing quietly.
function localRow(overrides = {}) {
  return deepFreeze({
    id: RECORD_ID,
    createdBy: WORKER,
    deviceId: THIS_DEVICE,
    formType: "household_survey",
    formVersion: 1,
    payload: { householdName: "Patil", memberCount: 5 },
    version: 4,
    syncedVersion: 3,
    syncState: SYNC_STATE.SYNCED,
    serverConflict: null,
    resolvedNotice: null,
    deletedAt: null,
    syncError: null,
    ...overrides,
  });
}

function remoteRow(overrides = {}) {
  return {
    id: RECORD_ID,
    createdBy: WORKER,
    deviceId: OTHER_DEVICE,
    formType: "household_survey",
    formVersion: 1,
    payload: { householdName: "Patil", memberCount: 7 },
    version: 4,
    createdAt: "2026-09-20 09:00:00.000000",
    updatedAt: "2026-09-22 15:16:21.934000",
    deletedAt: null,
    ...overrides,
  };
}

// One entry from GET /api/sync/resolutions.
function resolution({ submitted = {}, superseded = null, ...overrides } = {}) {
  return {
    conflictId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    recordId: RECORD_ID,
    resolution: "kept_server",
    resolvedAt: "2026-09-22 16:00:00.000000",
    resolvedByName: "Supervisor",
    submitted: {
      deviceId: THIS_DEVICE,
      baseVersion: 3,
      byId: WORKER,
      deleted: false,
      payload: { householdName: "Patil", memberCount: 5 },
      ...submitted,
    },
    superseded,
    record: remoteRow({ version: 5 }),
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const UNSENT_STATES = [SYNC_STATE.PENDING, SYNC_STATE.REJECTED];

// ---------------------------------------------------------------------------
// classifyPulledRow
// ---------------------------------------------------------------------------

describe("classifyPulledRow: a record this device has never held", () => {
  test("a record new to this device is stored", () => {
    assert.deepEqual(classifyPulledRow(null, remoteRow()), { action: PULL_ACTION.INSERT });
  });

  test("a tombstone for a record this device never held is still stored", () => {
    assert.deepEqual(classifyPulledRow(null, remoteRow({ deletedAt: TOMBSTONE_AT })), {
      action: PULL_ACTION.INSERT,
    });
  });
});

describe("classifyPulledRow: unsent work on this device", () => {
  // Regression: advancing syncedVersion on a pending row made the next push
  // claim a base it never saw and silently overwrite another device's edit.
  test("a pending local edit is never overwritten by a pull, and its syncedVersion is left alone", () => {
    const local = localRow({ syncState: SYNC_STATE.PENDING });
    const before = structuredClone(local);

    // Exactly the action and nothing else: no patch, no new syncedVersion.
    assert.deepEqual(classifyPulledRow(local, remoteRow({ version: 9 })), {
      action: PULL_ACTION.KEEP_LOCAL,
    });
    assert.deepEqual(local, before);
  });

  // Regression: same bug, for a row the server refused.
  test("a rejected row waiting for the worker to fix it is never overwritten by a pull", () => {
    const local = localRow({
      syncState: SYNC_STATE.REJECTED,
      syncError: { reason: "invalid_payload", message: "memberCount", at: 1 },
    });
    const before = structuredClone(local);

    assert.deepEqual(classifyPulledRow(local, remoteRow({ version: 9 })), {
      action: PULL_ACTION.KEEP_LOCAL,
    });
    assert.deepEqual(local, before);
  });

  test("unsent work is kept whatever version the server sends, older, equal or newer", () => {
    for (const syncState of UNSENT_STATES) {
      for (const version of [1, 3, 4, 99]) {
        for (const deletedAt of [null, TOMBSTONE_AT]) {
          const { action } = classifyPulledRow(localRow({ syncState }), remoteRow({ version, deletedAt }));
          assert.ok(
            action === PULL_ACTION.KEEP_LOCAL || action === PULL_ACTION.KEEP_LOCAL_DELETED,
            `${syncState} v${version} deleted=${deletedAt !== null}: ${action}`
          );
        }
      }
    }
  });

  // Regression: this used to move the row to CONFLICT on the device, where no
  // server-side conflict existed to resolve it — a permanent lock.
  test("a tombstone arriving onto an unsent edit leaves the edit queued, not locked", () => {
    const local = localRow({ syncState: SYNC_STATE.PENDING });
    const before = structuredClone(local);

    const result = classifyPulledRow(local, remoteRow({ version: 5, deletedAt: TOMBSTONE_AT }));
    assert.deepEqual(result, { action: PULL_ACTION.KEEP_LOCAL_DELETED });
    assert.notEqual(result.action, PULL_ACTION.REFRESH_CONFLICT);
    assert.deepEqual(local, before);
  });

  test("a tombstone arriving onto a rejected row leaves it waiting for the worker, not locked", () => {
    const local = localRow({ syncState: SYNC_STATE.REJECTED });
    assert.deepEqual(classifyPulledRow(local, remoteRow({ deletedAt: TOMBSTONE_AT })), {
      action: PULL_ACTION.KEEP_LOCAL_DELETED,
    });
  });
});

describe("classifyPulledRow: a row locked in conflict", () => {
  test("a conflicted row only has the server copy beside it refreshed", () => {
    assert.deepEqual(classifyPulledRow(localRow({ syncState: SYNC_STATE.CONFLICT }), remoteRow()), {
      action: PULL_ACTION.REFRESH_CONFLICT,
    });
  });

  test("a newer server version does not unlock a conflicted row; only its resolution can", () => {
    const local = localRow({ syncState: SYNC_STATE.CONFLICT });
    assert.deepEqual(classifyPulledRow(local, remoteRow({ version: 42 })), {
      action: PULL_ACTION.REFRESH_CONFLICT,
    });
  });

  test("a tombstone arriving onto a conflicted row only refreshes the server copy", () => {
    const local = localRow({ syncState: SYNC_STATE.CONFLICT });
    assert.deepEqual(classifyPulledRow(local, remoteRow({ deletedAt: TOMBSTONE_AT })), {
      action: PULL_ACTION.REFRESH_CONFLICT,
    });
  });
});

describe("classifyPulledRow: a synced row", () => {
  test("a newer server version replaces a synced row", () => {
    assert.deepEqual(classifyPulledRow(localRow(), remoteRow({ version: 4 })), {
      action: PULL_ACTION.OVERWRITE,
    });
  });

  test("a deletion made elsewhere reaches a synced row", () => {
    assert.deepEqual(classifyPulledRow(localRow(), remoteRow({ version: 4, deletedAt: TOMBSTONE_AT })), {
      action: PULL_ACTION.OVERWRITE,
    });
  });

  test("a row re-delivered by an overlapping window is skipped", () => {
    assert.deepEqual(classifyPulledRow(localRow(), remoteRow({ version: 3 })), {
      action: PULL_ACTION.SKIP,
    });
  });

  test("an older copy arriving late never rolls a synced row back", () => {
    assert.deepEqual(classifyPulledRow(localRow(), remoteRow({ version: 2 })), {
      action: PULL_ACTION.SKIP,
    });
  });

  test("a synced row with no server-confirmed version takes the server's copy", () => {
    assert.deepEqual(classifyPulledRow(localRow({ syncedVersion: null }), remoteRow({ version: 1 })), {
      action: PULL_ACTION.OVERWRITE,
    });
  });
});

// ---------------------------------------------------------------------------
// classifyResolution — the deadlock exit
// ---------------------------------------------------------------------------

describe("classifyResolution: which dispute a resolution settles", () => {
  const conflicted = (overrides = {}) =>
    localRow({ syncState: SYNC_STATE.CONFLICT, syncedVersion: 3, ...overrides });

  test("a resolution for a record this phone does not hold changes nothing", () => {
    assert.deepEqual(classifyResolution(null, resolution(), THIS_DEVICE), {
      action: RESOLUTION_ACTION.SKIP,
    });
  });

  // Regression: resolutions used to be matched by record alone, so any
  // resolution about the record unlocked the row.
  test("this phone's own dispute, raised from the base the row is frozen at, unlocks the row", () => {
    assert.deepEqual(classifyResolution(conflicted(), resolution(), THIS_DEVICE), {
      action: RESOLUTION_ACTION.ADOPT,
    });
  });

  // Regression: see above.
  test("another phone's dispute about the same record does not unlock this phone's row", () => {
    const other = resolution({ submitted: { deviceId: OTHER_DEVICE } });
    assert.notEqual(classifyResolution(conflicted(), other, THIS_DEVICE).action, RESOLUTION_ACTION.ADOPT);
  });

  // Regression: a replayed older resolution unlocked a row frozen for a newer,
  // still-open dispute.
  test("an older dispute's resolution does not unlock a row frozen for a newer one", () => {
    // The row adopted the first resolution at v5, was edited, and conflicted
    // again from base 5. The first resolution (base 3, replaced v4) arrives again.
    const local = conflicted({ syncedVersion: 5 });
    const older = resolution({
      resolution: "kept_client",
      submitted: { baseVersion: 3 },
      superseded: { version: 4, formType: "household_survey", formVersion: 1, payload: {} },
    });
    assert.deepEqual(classifyResolution(local, older, THIS_DEVICE), {
      action: RESOLUTION_ACTION.SKIP,
    });
  });

  test("a resolution naming a base this row has not reached does not unlock it", () => {
    const ahead = resolution({ submitted: { baseVersion: 7 } });
    assert.notEqual(classifyResolution(conflicted(), ahead, THIS_DEVICE).action, RESOLUTION_ACTION.ADOPT);
  });

  test("a row that never synced is unlocked by its own dispute raised from base 0", () => {
    const local = conflicted({ syncedVersion: null });
    const own = resolution({ submitted: { baseVersion: 0 } });
    assert.deepEqual(classifyResolution(local, own, THIS_DEVICE), {
      action: RESOLUTION_ACTION.ADOPT,
    });
  });

  test("a phone that cannot name itself never unlocks anything", () => {
    // Both sides missing a device id must not count as a match.
    const anonymous = resolution({ submitted: { deviceId: undefined } });
    for (const deviceId of [undefined, null]) {
      assert.notEqual(
        classifyResolution(conflicted(), anonymous, deviceId).action,
        RESOLUTION_ACTION.ADOPT
      );
    }
  });

  test("a resolution that does not say who submitted the dispute never unlocks a row", () => {
    const unsigned = { ...resolution(), submitted: undefined };
    assert.notEqual(classifyResolution(conflicted(), unsigned, THIS_DEVICE).action, RESOLUTION_ACTION.ADOPT);
  });

  test("unsent work is never adopted over, even by a resolution that names this phone and base", () => {
    for (const syncState of UNSENT_STATES) {
      const local = localRow({ syncState, syncedVersion: 3 });
      assert.notEqual(
        classifyResolution(local, resolution(), THIS_DEVICE).action,
        RESOLUTION_ACTION.ADOPT,
        syncState
      );
    }
  });
});

describe("classifyResolution: telling a worker their copy was replaced", () => {
  const replacedV4 = { version: 4, formType: "household_survey", formVersion: 1, payload: {} };

  test("a worker whose synced copy was the one a decision replaced is told", () => {
    const local = localRow({ syncedVersion: 4 });
    const decision = resolution({ resolution: "merged", superseded: replacedV4 });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.NOTIFY,
    });
  });

  test("a worker offline since before the replaced version is told too", () => {
    const local = localRow({ syncedVersion: 2 });
    const decision = resolution({ resolution: "merged", superseded: replacedV4 });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.NOTIFY,
    });
  });

  test("a notice the worker already moved past is not raised again when the resolution replays", () => {
    const local = localRow({ syncedVersion: 5 });
    const decision = resolution({ resolution: "merged", superseded: replacedV4 });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.SKIP,
    });
  });

  test("keeping the server's copy announces nothing to a phone that was not party to it", () => {
    const local = localRow({ syncedVersion: 4 });
    const decision = resolution({ submitted: { deviceId: OTHER_DEVICE }, superseded: null });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.SKIP,
    });
  });

  test("a row with no server-confirmed version gets no notice", () => {
    const local = localRow({ syncState: SYNC_STATE.PENDING, syncedVersion: null });
    const decision = resolution({ resolution: "merged", superseded: replacedV4 });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.SKIP,
    });
  });

  test("unsent work holding the replaced version is told, and left exactly as it is", () => {
    const local = localRow({ syncState: SYNC_STATE.PENDING, syncedVersion: 4 });
    const decision = resolution({ resolution: "merged", superseded: replacedV4 });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.NOTIFY,
    });
  });

  test("a row locked for another phone's dispute is told its copy was replaced, and stays locked", () => {
    const local = localRow({ syncState: SYNC_STATE.CONFLICT, syncedVersion: 4 });
    const decision = resolution({
      resolution: "merged",
      submitted: { deviceId: OTHER_DEVICE, baseVersion: 4 },
      superseded: replacedV4,
    });
    assert.deepEqual(classifyResolution(local, decision, THIS_DEVICE), {
      action: RESOLUTION_ACTION.NOTIFY,
    });
  });
});

// ---------------------------------------------------------------------------
// releaseLegacyDeletionLock
// ---------------------------------------------------------------------------

describe("releaseLegacyDeletionLock", () => {
  test("there is nothing to release for a row that is gone", () => {
    assert.equal(releaseLegacyDeletionLock(null), null);
  });

  test("a real conflict that was never flagged is never released", () => {
    assert.equal(releaseLegacyDeletionLock(localRow({ syncState: SYNC_STATE.CONFLICT })), null);
  });

  test("a flagged row that is no longer locked is left alone", () => {
    for (const syncState of [SYNC_STATE.PENDING, SYNC_STATE.REJECTED, SYNC_STATE.SYNCED]) {
      assert.equal(releaseLegacyDeletionLock(localRow({ syncState, legacyDeletionLock: true })), null);
    }
  });

  test("an unsent edit trapped by the old pull-side lock goes back into the push queue", () => {
    const trapped = localRow({ syncState: SYNC_STATE.CONFLICT, legacyDeletionLock: true });
    assert.equal(releaseLegacyDeletionLock(trapped), SYNC_STATE.PENDING);
  });

  test("a trapped row that had been rejected goes back to waiting for the worker, not into the queue", () => {
    const trapped = localRow({
      syncState: SYNC_STATE.CONFLICT,
      legacyDeletionLock: true,
      syncError: { reason: "invalid_payload", message: "memberCount", at: 1 },
    });
    assert.equal(releaseLegacyDeletionLock(trapped), SYNC_STATE.REJECTED);
  });
});

// ---------------------------------------------------------------------------
// The cursor and the scope it was advanced in
// ---------------------------------------------------------------------------

const WADGAON_SCOPE = "area:2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const SHIRUR_SCOPE = "area:8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";
const CURSOR_AT = "2026-09-22 15:10:00.000000";

describe("readCursor", () => {
  test("a cursor stamped with its scope is read back whole", () => {
    assert.deepEqual(readCursor({ until: CURSOR_AT, scope: WADGAON_SCOPE }), {
      until: CURSOR_AT,
      scope: WADGAON_SCOPE,
    });
  });

  // A bare string names no scope, so no scope can vouch for it: one full pull.
  test("a cursor from before scopes existed reads as no cursor at all", () => {
    assert.equal(readCursor(CURSOR_AT), null);
  });

  test("nothing stored, or half a cursor, reads as no cursor", () => {
    for (const value of [null, undefined, {}, { until: CURSOR_AT }, { scope: WADGAON_SCOPE }]) {
      assert.equal(readCursor(value), null, JSON.stringify(value));
    }
  });
});

describe("windowStart", () => {
  test("the cursor stands when the server served the scope it was advanced in", () => {
    const cursor = { until: CURSOR_AT, scope: WADGAON_SCOPE };
    assert.equal(windowStart(cursor, WADGAON_SCOPE), CURSOR_AT);
  });

  // Regression target: a worker moved to Shirur whose Wadgaon cursor was
  // applied to Shirur would never receive Shirur's older records.
  test("after a move to another area the window starts from the beginning", () => {
    const cursor = { until: CURSOR_AT, scope: WADGAON_SCOPE };
    assert.equal(windowStart(cursor, SHIRUR_SCOPE), null);
  });

  test("with no cursor the window starts from the beginning", () => {
    assert.equal(windowStart(null, WADGAON_SCOPE), null);
  });
});

describe("pulledMetadataPatch", () => {
  const WADGAON = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";

  test("fills in the area and names a row reached its version without", () => {
    const local = localRow({ syncedVersion: 4 });
    const remote = remoteRow({
      areaId: WADGAON,
      createdByName: "Field Worker A",
      updatedByName: "Field Worker B",
    });
    assert.deepEqual(pulledMetadataPatch(local, remote), {
      areaId: WADGAON,
      createdByName: "Field Worker A",
      updatedByName: "Field Worker B",
    });
  });

  // A capture carries the area the device last knew; the server's is the real one.
  test("corrects an area the device guessed", () => {
    const local = localRow({ areaId: "8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a" });
    assert.deepEqual(pulledMetadataPatch(local, remoteRow({ areaId: WADGAON })), {
      areaId: WADGAON,
    });
  });

  test("returns nothing when the row already agrees", () => {
    const local = localRow({ areaId: WADGAON, createdByName: "Field Worker A" });
    const remote = remoteRow({ areaId: WADGAON, createdByName: "Field Worker A" });
    assert.equal(pulledMetadataPatch(local, remote), null);
  });

  test("never replaces something the device knows with something the server does not", () => {
    const local = localRow({ updatedByName: "Supervisor" });
    assert.equal(pulledMetadataPatch(local, remoteRow({ updatedByName: null })), null);
  });

  test("never touches what the record says or how it syncs", () => {
    const patch = pulledMetadataPatch(
      localRow(),
      remoteRow({ areaId: WADGAON, payload: { householdName: "Other" }, version: 9 })
    );
    assert.deepEqual(Object.keys(patch), ["areaId"]);
  });
});
