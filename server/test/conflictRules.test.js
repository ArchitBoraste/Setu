import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EXISTENCE,
  RESOLUTION,
  RESOLVE_ERROR,
  deletedAtAfter,
  planResolution,
} from "../sync/conflictRules.js";
import { REJECT_REASON } from "../sync/pushRules.js";

// When the record was first deleted, and this resolution's clock reading.
const FIRST_DELETED_AT = "2026-09-20 11:05:42.318000";
const RESOLVED_NOW = "2026-09-22 16:00:00.000000";

// The record as the server holds it, read under the lock.
function storedRecord(overrides = {}) {
  return {
    formType: "household_survey",
    formVersion: 1,
    version: 4,
    payload: { householdName: "Patil", memberCount: 5, visitDate: "2026-09-20" },
    ...overrides,
  };
}

// The push that lost, as record_conflicts filed it.
function filedConflict(overrides = {}) {
  return {
    formType: "household_survey",
    formVersion: 2,
    payload: { householdName: "Patil", memberCount: 6, visitDate: "2026-09-21" },
    submittedDeleted: 0,
    ...overrides,
  };
}

function plan(resolution, overrides = {}) {
  return planResolution({
    resolution,
    conflict: filedConflict(overrides.conflict),
    record: storedRecord(overrides.record),
    mergedPayload: overrides.mergedPayload,
  });
}

describe("planResolution: choosing a resolution", () => {
  test("a resolution that is not one of the three is refused before anything is decided", () => {
    for (const resolution of [undefined, null, "", "KEPT_SERVER", "delete", "kept_both"]) {
      const result = plan(resolution);
      assert.equal(result.value, undefined);
      assert.equal(result.error?.reason, RESOLVE_ERROR.INVALID, String(resolution));
    }
  });
});

describe("planResolution: keeping the server's copy", () => {
  // Regression: kept_server must spend no version and move no updated_at.
  test("keeping the server's copy writes nothing to the record, whatever the losing push was", () => {
    for (const submittedDeleted of [1, 0, null]) {
      assert.deepEqual(plan(RESOLUTION.KEPT_SERVER, { conflict: { submittedDeleted } }), {
        value: { resolution: RESOLUTION.KEPT_SERVER, write: null, superseded: null },
      });
    }
  });
});

describe("planResolution: keeping the worker's copy", () => {
  test("the worker's answers and form revision become the record, one version up", () => {
    const { value } = plan(RESOLUTION.KEPT_CLIENT);
    const conflict = filedConflict();
    assert.equal(value.resolution, RESOLUTION.KEPT_CLIENT);
    assert.equal(value.write.formType, conflict.formType);
    assert.equal(value.write.formVersion, conflict.formVersion);
    assert.deepEqual(value.write.payload, conflict.payload);
    assert.equal(value.write.payloadText, JSON.stringify(conflict.payload));
    assert.equal(value.write.version, storedRecord().version + 1);
  });

  test("the version it replaces is kept whole, with the form revision it was captured under", () => {
    const record = storedRecord();
    assert.deepEqual(plan(RESOLUTION.KEPT_CLIENT).value.superseded, {
      version: record.version,
      formType: record.formType,
      formVersion: record.formVersion,
      payload: record.payload,
      payloadText: JSON.stringify(record.payload),
    });
  });

  // Regression: submitted_deleted 1 / 0 / NULL each mean something different
  // (migration 003), and only the recorded facts may change existence.
  test("keeping a worker's deletion deletes the record", () => {
    const { value } = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted: 1 } });
    assert.equal(value.write.existence, EXISTENCE.DELETE);
  });

  test("keeping a worker's live edit against a deleted record restores it", () => {
    const { value } = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted: 0 } });
    assert.equal(value.write.existence, EXISTENCE.RESTORE);
  });

  test("keeping a worker's copy whose deletion was never recorded leaves deleted_at unchanged", () => {
    for (const submittedDeleted of [null, undefined]) {
      const { value } = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted } });
      assert.equal(value.write.existence, EXISTENCE.KEEP, String(submittedDeleted));
    }
  });

  test("only an exact 1 or 0 can delete or restore; any other value leaves the household as it is", () => {
    // mysql2 returns TINYINT(1) as a number. Anything else is a driver or
    // schema change, and must fall to "do nothing" rather than to a guess.
    for (const submittedDeleted of [true, false, "1", "0", 2, -1]) {
      const { value } = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted } });
      assert.equal(value.write.existence, EXISTENCE.KEEP, JSON.stringify(submittedDeleted));
    }
  });

  test("a copy already collected stays choosable even if it would fail today's validation", () => {
    const olderRules = { formVersion: 1, payload: { memberCount: "5" } };
    const result = plan(RESOLUTION.KEPT_CLIENT, { conflict: olderRules });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value.write.payload, { memberCount: "5" });
  });
});

describe("planResolution: merging the two copies", () => {
  const merged = { householdName: "Patil", memberCount: 6, visitDate: "2026-09-20" };

  test("a merge writes the supervisor's answers under the record's form revision, one version up", () => {
    const { value } = plan(RESOLUTION.MERGED, { mergedPayload: merged });
    const record = storedRecord();
    assert.equal(value.resolution, RESOLUTION.MERGED);
    assert.equal(value.write.formType, record.formType);
    assert.equal(value.write.formVersion, record.formVersion);
    assert.deepEqual(value.write.payload, merged);
    assert.equal(value.write.payloadText, JSON.stringify(merged));
    assert.equal(value.write.version, record.version + 1);
  });

  test("a merge keeps the version it replaces", () => {
    const record = storedRecord();
    assert.deepEqual(plan(RESOLUTION.MERGED, { mergedPayload: merged }).value.superseded, {
      version: record.version,
      formType: record.formType,
      formVersion: record.formVersion,
      payload: record.payload,
      payloadText: JSON.stringify(record.payload),
    });
  });

  test("a merge never changes whether the household exists, whatever the losing push was", () => {
    for (const submittedDeleted of [1, 0, null]) {
      const { value } = plan(RESOLUTION.MERGED, {
        mergedPayload: merged,
        conflict: { submittedDeleted },
      });
      assert.equal(value.write.existence, EXISTENCE.KEEP, String(submittedDeleted));
    }
  });

  test("merged answers are validated exactly like a pushed payload", () => {
    for (const mergedPayload of [null, undefined, [], { ...merged, memberCount: true }]) {
      const result = plan(RESOLUTION.MERGED, { mergedPayload });
      assert.equal(result.value, undefined);
      assert.equal(result.error?.reason, REJECT_REASON.PAYLOAD);
    }
  });

  test("a merge is checked against the record's form revision, not the losing copy's", () => {
    // The record is on v1, which declares memberCount a number. The losing copy
    // came from v2, which this server declares nothing about.
    const result = plan(RESOLUTION.MERGED, { mergedPayload: { ...merged, memberCount: "6" } });
    assert.equal(result.error?.reason, REJECT_REASON.PAYLOAD);
    assert.match(result.error.message, /memberCount/);
  });

  test("fields the record's revision does not declare survive a merge", () => {
    const withNewField = { ...merged, toiletAvailable: "yes" };
    const { value } = plan(RESOLUTION.MERGED, { mergedPayload: withNewField });
    assert.equal(value.write.payload.toiletAvailable, "yes");
  });
});

// ---------------------------------------------------------------------------
// deletedAtAfter — what the resolve route writes to records.deleted_at
// ---------------------------------------------------------------------------

describe("deletedAtAfter", () => {
  test("a deletion keeps the time the record was first deleted", () => {
    assert.equal(
      deletedAtAfter(EXISTENCE.DELETE, FIRST_DELETED_AT, RESOLVED_NOW),
      FIRST_DELETED_AT
    );
  });

  test("a deletion of a live record is dated by the resolution's clock", () => {
    assert.equal(deletedAtAfter(EXISTENCE.DELETE, null, RESOLVED_NOW), RESOLVED_NOW);
  });

  test("a restore clears deleted_at, and leaves a live record live", () => {
    assert.equal(deletedAtAfter(EXISTENCE.RESTORE, FIRST_DELETED_AT, RESOLVED_NOW), null);
    assert.equal(deletedAtAfter(EXISTENCE.RESTORE, null, RESOLVED_NOW), null);
  });

  test("leaving existence alone writes back exactly what was read", () => {
    assert.equal(
      deletedAtAfter(EXISTENCE.KEEP, FIRST_DELETED_AT, RESOLVED_NOW),
      FIRST_DELETED_AT
    );
    assert.equal(deletedAtAfter(EXISTENCE.KEEP, null, RESOLVED_NOW), null);
  });

  test("an unrecognised existence value changes nothing rather than guessing", () => {
    for (const existence of [undefined, null, "", "restore_all"]) {
      assert.equal(deletedAtAfter(existence, FIRST_DELETED_AT, RESOLVED_NOW), FIRST_DELETED_AT);
      assert.equal(deletedAtAfter(existence, null, RESOLVED_NOW), null);
    }
  });

  // Regression: submitted_deleted NULL means "not recorded", and must never
  // resurrect a deleted household nor delete a live one.
  test("keeping a worker's copy whose deletion was never recorded leaves deleted_at alone, end to end", () => {
    const { value } = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted: null } });
    for (const current of [FIRST_DELETED_AT, null]) {
      assert.equal(deletedAtAfter(value.write.existence, current, RESOLVED_NOW), current);
    }
  });

  test("keeping a worker's deletion or live edit deletes or restores, end to end", () => {
    const deletion = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted: 1 } });
    assert.equal(
      deletedAtAfter(deletion.value.write.existence, FIRST_DELETED_AT, RESOLVED_NOW),
      FIRST_DELETED_AT
    );
    assert.equal(deletedAtAfter(deletion.value.write.existence, null, RESOLVED_NOW), RESOLVED_NOW);

    const liveEdit = plan(RESOLUTION.KEPT_CLIENT, { conflict: { submittedDeleted: 0 } });
    assert.equal(deletedAtAfter(liveEdit.value.write.existence, FIRST_DELETED_AT, RESOLVED_NOW), null);
  });
});
