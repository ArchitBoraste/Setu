import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SYNC_STATE } from "../src/records/syncState.js";
import {
  EDIT_BLOCK,
  belongsToPushQueue,
  canSeeRecord,
  countUnsynced,
  editBlockReason,
} from "../src/records/scope.js";

const ORG = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ORG = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const WADGAON = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const SHIRUR = "8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";
const WORKER_A = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const WORKER_B = "6f5e4d3c-2b1a-4f9e-8d7c-5b4a3f2e1d0c";
const WORKER_C = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
const SUPERVISOR = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

function user(overrides = {}) {
  return {
    userId: WORKER_A,
    role: "field_worker",
    organizationId: ORG,
    areaId: WADGAON,
    ...overrides,
  };
}

const workerA = user();
const workerB = user({ userId: WORKER_B });
// Covers another village, but may use the same phone.
const workerC = user({ userId: WORKER_C, areaId: SHIRUR });
const supervisor = user({ userId: SUPERVISOR, role: "supervisor", areaId: null });

// A Dexie row, frozen so a rule that tried to "fix up" what it was handed
// would throw instead of passing quietly.
function row(overrides = {}) {
  return Object.freeze({
    id: "3d2c1b0a-9f8e-4d7c-b6a5-4f3e2d1c0b9a",
    organizationId: ORG,
    createdBy: WORKER_A,
    areaId: WADGAON,
    lastEditedBy: WORKER_A,
    syncState: SYNC_STATE.SYNCED,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// canSeeRecord
// ---------------------------------------------------------------------------

describe("canSeeRecord: a supervisor", () => {
  test("sees a record a field worker captured", () => {
    assert.equal(canSeeRecord(row(), supervisor), true);
  });

  test("does not see another organisation's record left on a shared phone", () => {
    assert.equal(canSeeRecord(row({ organizationId: OTHER_ORG }), supervisor), false);
  });

  test("an admin sees the organisation too", () => {
    assert.equal(canSeeRecord(row(), user({ userId: SUPERVISOR, role: "admin" })), true);
  });
});

describe("canSeeRecord: a field worker", () => {
  test("sees their own capture", () => {
    assert.equal(canSeeRecord(row(), workerA), true);
  });

  test("sees a colleague's capture in the same area", () => {
    assert.equal(canSeeRecord(row(), workerB), true);
  });

  // The shared-phone case: A's sync put Wadgaon's rows on the phone, and C, who
  // covers Shirur, signs in next. Sharing the IndexedDB must not put them on C's
  // screen.
  test("never sees another area's record left on a shared phone", () => {
    assert.equal(canSeeRecord(row(), workerC), false);
    assert.equal(canSeeRecord(row({ createdBy: WORKER_C }), workerC), false);
  });

  test("a record with no area is seen by its creator and no other worker", () => {
    const unassigned = row({ areaId: null });
    assert.equal(canSeeRecord(unassigned, workerA), true);
    assert.equal(canSeeRecord(unassigned, workerB), false);
    assert.equal(canSeeRecord(unassigned, supervisor), true);
  });

  test("a row stored before areas existed is treated as having no area", () => {
    const legacy = { ...row() };
    delete legacy.areaId;
    assert.equal(canSeeRecord(legacy, workerA), true);
    assert.equal(canSeeRecord(legacy, workerB), false);
  });

  test("a worker with no area sees only their own unassigned captures", () => {
    const unassignedWorker = user({ areaId: null });
    assert.equal(canSeeRecord(row({ areaId: null }), unassignedWorker), true);
    assert.equal(canSeeRecord(row(), unassignedWorker), false);
  });

  test("a worker moved to another area stops seeing the old one's records", () => {
    const moved = user({ areaId: SHIRUR });
    assert.equal(canSeeRecord(row(), moved), false);
  });
});

describe("canSeeRecord: no row, or nobody signed in", () => {
  test("is never visible", () => {
    assert.equal(canSeeRecord(null, workerA), false);
    assert.equal(canSeeRecord(row(), null), false);
  });
});

// ---------------------------------------------------------------------------
// belongsToPushQueue — who sends a pending change
// ---------------------------------------------------------------------------

describe("belongsToPushQueue", () => {
  test("B's edit of A's record is B's to send", () => {
    const edited = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B });
    assert.equal(belongsToPushQueue(edited, workerB), true);
  });

  // Regression: selected by createdBy, B's edit was never pushed by B, and was
  // pushed under A's identity when A next signed in on the same phone.
  test("B's edit of A's record is never sent by A, on the same phone or any other", () => {
    const edited = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B });
    assert.equal(belongsToPushQueue(edited, workerA), false);
  });

  // The server decides what a moved worker may still write; the device does
  // not quietly strand a capture they made before the move.
  test("a worker's own capture is still theirs to send after they move area", () => {
    const captured = row({ syncState: SYNC_STATE.PENDING });
    assert.equal(belongsToPushQueue(captured, user({ areaId: SHIRUR })), true);
  });

  test("a supervisor's edit to a worker's record is the supervisor's to send", () => {
    const edited = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: SUPERVISOR });
    assert.equal(belongsToPushQueue(edited, supervisor), true);
  });

  // Regression: the queue used to select by createdBy, so this row went out
  // under the creator's token the next time they signed in on the same phone.
  test("a supervisor's edit is never sent by the worker who captured the record", () => {
    const edited = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: SUPERVISOR });
    assert.equal(belongsToPushQueue(edited, workerA), false);
  });

  test("a worker's own new capture is theirs to send", () => {
    assert.equal(belongsToPushQueue(row({ syncState: SYNC_STATE.PENDING }), workerA), true);
  });

  test("synced, conflicted and refused rows are never sent, whoever last edited them", () => {
    for (const syncState of [SYNC_STATE.SYNCED, SYNC_STATE.CONFLICT, SYNC_STATE.REJECTED]) {
      assert.equal(belongsToPushQueue(row({ syncState }), workerA), false, syncState);
    }
  });

  test("a row with no recorded editor is sent by nobody", () => {
    const orphan = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: null });
    assert.equal(belongsToPushQueue(orphan, workerA), false);
  });
});

// ---------------------------------------------------------------------------
// editBlockReason
// ---------------------------------------------------------------------------

describe("editBlockReason", () => {
  test("a synced row is editable by anyone who can see it", () => {
    assert.equal(editBlockReason(row(), supervisor), null);
    assert.equal(editBlockReason(row(), workerA), null);
  });

  test("a conflicted row is locked for everyone", () => {
    const conflicted = row({ syncState: SYNC_STATE.CONFLICT });
    assert.equal(editBlockReason(conflicted, workerA), EDIT_BLOCK.CONFLICT);
    assert.equal(editBlockReason(conflicted, supervisor), EDIT_BLOCK.CONFLICT);
  });

  test("a row holding another person's unsent change waits for them", () => {
    for (const syncState of [SYNC_STATE.PENDING, SYNC_STATE.REJECTED]) {
      const theirs = row({ syncState, lastEditedBy: SUPERVISOR });
      assert.equal(editBlockReason(theirs, workerA), EDIT_BLOCK.OTHER_EDITOR, syncState);
    }
  });

  // The shared-phone case the lock exists for: B's edit is on this phone, not
  // yet sent, and A signs in. A editing on top of it would send B's answers
  // under A's name.
  test("a colleague's unsent edit on a shared phone is locked for the next worker", () => {
    const edited = row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B });
    assert.equal(editBlockReason(edited, workerA), EDIT_BLOCK.OTHER_EDITOR);
    assert.equal(editBlockReason(edited, workerB), null);
  });

  test("a row holding the user's own unsent change stays editable", () => {
    for (const syncState of [SYNC_STATE.PENDING, SYNC_STATE.REJECTED]) {
      assert.equal(editBlockReason(row({ syncState }), workerA), null, syncState);
    }
  });
});

// ---------------------------------------------------------------------------
// countUnsynced — the remove-account warning
// ---------------------------------------------------------------------------

describe("countUnsynced", () => {
  test("splits by who made the change, not who captured the record", () => {
    const rows = [
      // A's capture, edited by B and not yet sent: B's work, which A's Sync
      // cannot send.
      row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B }),
      // B's capture, edited by A: A's work.
      row({ createdBy: WORKER_B, syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_A }),
    ];
    assert.deepEqual(countUnsynced(rows, workerA), {
      mine: 1,
      others: 1,
      otherWorkers: 1,
      total: 2,
    });
  });

  test("counts pending, conflicted and refused rows and nothing synced", () => {
    const rows = [
      row({ syncState: SYNC_STATE.PENDING }),
      row({ syncState: SYNC_STATE.CONFLICT }),
      row({ syncState: SYNC_STATE.REJECTED }),
      row({ syncState: SYNC_STATE.SYNCED }),
    ];
    assert.equal(countUnsynced(rows, workerA).mine, 3);
  });

  test("counts distinct other editors", () => {
    const rows = [
      row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B }),
      row({ syncState: SYNC_STATE.PENDING, lastEditedBy: WORKER_B }),
      row({ syncState: SYNC_STATE.PENDING, lastEditedBy: SUPERVISOR }),
    ];
    assert.deepEqual(countUnsynced(rows, workerA), {
      mine: 0,
      others: 3,
      otherWorkers: 2,
      total: 3,
    });
  });

  test("with nobody signed in, every unsynced row belongs to someone else", () => {
    const rows = [row({ syncState: SYNC_STATE.PENDING })];
    assert.deepEqual(countUnsynced(rows, null), {
      mine: 0,
      others: 1,
      otherWorkers: 1,
      total: 1,
    });
  });
});
