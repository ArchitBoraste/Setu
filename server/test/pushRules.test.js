import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FORM_VERSION,
  MAX_PAYLOAD_FIELDS,
  MAX_PAYLOAD_UTF8_BYTES,
  MAX_STRING_LENGTH,
  PUSH_OUTCOME,
  REJECT_REASON,
  RESOLVED_DEVICE_ID,
  canonicalJson,
  classifyPush,
  mayWrite,
  validateEnvelope,
} from "../sync/pushRules.js";
import { definitionKey } from "../forms/formRules.js";
import { HOUSEHOLD_SURVEY_V1 } from "../forms/householdSurveyV1.js";

const RECORD_ID = "3d2c1b0a-9f8e-4d7c-b6a5-4f3e2d1c0b9a";
const THIS_DEVICE = "0f8e5c1a-6b2d-4e7f-9a3c-5d1e2f3a4b5c";
const OTHER_DEVICE = "7c3a9e1f-2b4d-4c6e-8f0a-1b2c3d4e5f60";

const ANSWERS = {
  householdName: "Patil",
  memberCount: 5,
  childrenUnderFive: 1,
  visitDate: "2026-09-22",
  waterSource: "Handpump",
  notes: null,
};

function storedRow(overrides = {}) {
  return {
    version: 3,
    deviceId: THIS_DEVICE,
    formType: "household_survey",
    formVersion: 1,
    payload: ANSWERS,
    deleted: false,
    ...overrides,
  };
}

function incomingPush(overrides = {}) {
  return {
    deviceId: THIS_DEVICE,
    formType: "household_survey",
    formVersion: 1,
    payload: ANSWERS,
    deleted: false,
    ...overrides,
  };
}

function wireItem(overrides = {}) {
  return {
    id: RECORD_ID,
    deviceId: THIS_DEVICE,
    formType: "household_survey",
    formVersion: 1,
    baseVersion: 3,
    deleted: false,
    payload: { ...ANSWERS },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyPush — the three-way comparison
// ---------------------------------------------------------------------------

describe("classifyPush: a record the server has never seen", () => {
  test("a household captured offline is inserted at version 1", () => {
    assert.deepEqual(classifyPush(null, null, incomingPush()), {
      outcome: PUSH_OUTCOME.INSERT,
      version: 1,
    });
  });

  test("a base of 0 on a missing record is the same insert as no base at all", () => {
    assert.deepEqual(classifyPush(0, null, incomingPush()), {
      outcome: PUSH_OUTCOME.INSERT,
      version: 1,
    });
  });

  test("a device claiming to have edited a record the server never had is rejected, not inserted", () => {
    assert.deepEqual(classifyPush(3, null, incomingPush()), {
      outcome: PUSH_OUTCOME.REJECT,
      reason: REJECT_REASON.UNKNOWN_RECORD,
    });
  });
});

describe("classifyPush: an edit made from the version the server holds", () => {
  test("an edit from the current version is accepted one version up, whichever phone sent it", () => {
    for (const deviceId of [THIS_DEVICE, OTHER_DEVICE]) {
      assert.deepEqual(
        classifyPush(3, storedRow({ deviceId: THIS_DEVICE }), incomingPush({ deviceId })),
        { outcome: PUSH_OUTCOME.ACCEPT, version: 4 }
      );
    }
  });

  test("a device claiming a version the server never issued is rejected and overwrites nothing", () => {
    assert.deepEqual(classifyPush(5, storedRow(), incomingPush()), {
      outcome: PUSH_OUTCOME.REJECT,
      reason: REJECT_REASON.VERSION_AHEAD,
    });
  });
});

describe("classifyPush: a push arriving behind the server (lost response vs. real collision)", () => {
  // Regression: a retry after a lost response used to be filed as a conflict
  // against the device's own earlier write.
  test("same device retrying an identical push is a replay, not a conflict", () => {
    const stored = storedRow({ version: 4 });
    // Several retries of one lost response must all land on the one version
    // that was written, never spend a new one each.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(classifyPush(3, stored, incomingPush()), {
        outcome: PUSH_OUTCOME.REPLAY,
        version: 4,
      });
    }
  });

  // Regression: see above — the other half of the same rule.
  test("same device sending different answers after its response was lost is accepted as its newer edit", () => {
    const edited = incomingPush({ payload: { ...ANSWERS, memberCount: 6 } });
    assert.deepEqual(classifyPush(3, storedRow({ version: 4 }), edited), {
      outcome: PUSH_OUTCOME.ACCEPT,
      version: 5,
    });
  });

  // Regression: see above — a collision with ANOTHER phone must still conflict.
  test("a different phone editing from an older version is a conflict, never an overwrite", () => {
    const stored = storedRow({ version: 4, deviceId: OTHER_DEVICE });
    assert.deepEqual(classifyPush(3, stored, incomingPush()), {
      outcome: PUSH_OUTCOME.CONFLICT,
      version: 4,
    });
  });

  test("same device deleting the record after its earlier response was lost is accepted, not replayed", () => {
    const deletion = incomingPush({ deleted: true });
    assert.deepEqual(classifyPush(3, storedRow({ version: 4 }), deletion), {
      outcome: PUSH_OUTCOME.ACCEPT,
      version: 5,
    });
  });

  test("same device re-sending the same answers under a different form is accepted, not replayed", () => {
    for (const changed of [{ formVersion: 2 }, { formType: "child_growth" }]) {
      assert.deepEqual(classifyPush(3, storedRow({ version: 4 }), incomingPush(changed)), {
        outcome: PUSH_OUTCOME.ACCEPT,
        version: 5,
      });
    }
  });

  test("a create whose response was lost is replayed at version 1 when retried", () => {
    const stored = storedRow({ version: 1 });
    assert.deepEqual(classifyPush(null, stored, incomingPush()), {
      outcome: PUSH_OUTCOME.REPLAY,
      version: 1,
    });
  });

  test("a create colliding with another phone's record of the same id is a conflict", () => {
    const stored = storedRow({ version: 1, deviceId: OTHER_DEVICE });
    assert.deepEqual(classifyPush(null, stored, incomingPush()), {
      outcome: PUSH_OUTCOME.CONFLICT,
      version: 1,
    });
  });

  // Regression: MySQL stores JSON with its own key order, so a byte-for-byte
  // comparison turned every retry into a fresh write.
  test("an identical retry is still a replay when the stored answers come back in a different key order", () => {
    // Keys ordered the way MySQL normalises them: by length, then by name.
    const asMysqlReturnsIt = {
      notes: null,
      memberCount: 5,
      visitDate: "2026-09-22",
      waterSource: "Handpump",
      householdName: "Patil",
      childrenUnderFive: 1,
    };
    assert.notEqual(JSON.stringify(asMysqlReturnsIt), JSON.stringify(ANSWERS));

    const stored = storedRow({ version: 4, payload: asMysqlReturnsIt });
    assert.deepEqual(classifyPush(3, stored, incomingPush()), {
      outcome: PUSH_OUTCOME.REPLAY,
      version: 4,
    });
  });

  test("a version a supervisor's resolution wrote is never mistaken for this phone's own echo", () => {
    const resolved = storedRow({ version: 4, deviceId: RESOLVED_DEVICE_ID });
    assert.deepEqual(classifyPush(3, resolved, incomingPush()), {
      outcome: PUSH_OUTCOME.CONFLICT,
      version: 4,
    });
    // Even a push that somehow got past validateEnvelope claiming the reserved
    // id: the echo rule itself refuses to match it.
    const claimingReserved = incomingPush({ deviceId: RESOLVED_DEVICE_ID });
    assert.deepEqual(classifyPush(3, resolved, claimingReserved), {
      outcome: PUSH_OUTCOME.CONFLICT,
      version: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// canonicalJson — what "the same answers" means to the replay rule
// ---------------------------------------------------------------------------

describe("canonicalJson", () => {
  // Regression: see the key-order replay test above.
  test("the same answers compare equal regardless of JSON key order", () => {
    assert.equal(
      canonicalJson({ b: 1, a: "x", c: null }),
      canonicalJson({ c: null, a: "x", b: 1 })
    );
  });

  test("key order is ignored at every depth, not just the top", () => {
    assert.equal(
      canonicalJson({ outer: { z: 1, y: { q: 2, p: 3 } } }),
      canonicalJson({ outer: { y: { p: 3, q: 2 }, z: 1 } })
    );
  });

  test("a count of 5 and the text \"5\" are different answers", () => {
    assert.notEqual(canonicalJson({ memberCount: 5 }), canonicalJson({ memberCount: "5" }));
  });

  test("list order is kept, because a list's order is part of its data", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });
});

// ---------------------------------------------------------------------------
// validateEnvelope — what the server accepts off the wire
// ---------------------------------------------------------------------------

// What the push route loads for the caller's organisation: every version of
// the form types the batch names, drafts included.
const DEFINITIONS = new Map([
  [
    definitionKey("household_survey", 1),
    { formType: "household_survey", version: 1, status: "published", fields: HOUSEHOLD_SURVEY_V1.fields },
  ],
  [
    definitionKey("household_survey", 2),
    { formType: "household_survey", version: 2, status: "draft", fields: HOUSEHOLD_SURVEY_V1.fields },
  ],
]);

const envelope = (item) => validateEnvelope(item, DEFINITIONS);

describe("validateEnvelope", () => {
  test("a well-formed push is accepted and carries only the fields the server trusts", () => {
    const result = envelope(
      wireItem({
        // Ownership and every timestamp come from the JWT and the server's
        // clock. A body naming them must not get them through.
        createdBy: OTHER_DEVICE,
        organizationId: OTHER_DEVICE,
        deletedAt: "2026-09-22 15:16:21.934000",
        updatedAt: "2099-01-01 00:00:00.000000",
      })
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(Object.keys(result.value).sort(), [
      "baseVersion",
      "deleted",
      "deviceId",
      "formType",
      "formVersion",
      "id",
      "payload",
      "payloadText",
    ]);
    assert.equal(result.value.payloadText, JSON.stringify(result.value.payload));
  });

  test("a row that has never synced may omit its base version, which is read as null", () => {
    const withoutBase = wireItem();
    delete withoutBase.baseVersion;
    assert.equal(envelope(withoutBase).value.baseVersion, null);
    assert.equal(envelope(wireItem({ baseVersion: null })).value.baseVersion, null);
    assert.equal(envelope(wireItem({ baseVersion: 0 })).value.baseVersion, 0);
  });

  // Regression: the nil UUID matches the UUID shape, so a client claiming it
  // would be read as the author of a resolution and walk into the echo path.
  test("the reserved resolution device id is refused on the wire", () => {
    const result = envelope(wireItem({ deviceId: RESOLVED_DEVICE_ID }));
    assert.equal(result.error?.reason, REJECT_REASON.ENVELOPE);
    assert.match(result.error.message, /reserved/);
  });

  test("a push that is not a single record object is refused", () => {
    for (const item of [null, undefined, "record", 42, [wireItem()]]) {
      assert.equal(envelope(item).error?.reason, REJECT_REASON.ENVELOPE);
    }
  });

  test("a record id that is not a UUID is refused", () => {
    for (const id of [undefined, 17, "17", "not-a-uuid", `${RECORD_ID}x`]) {
      assert.equal(envelope(wireItem({ id })).error?.reason, REJECT_REASON.ENVELOPE);
    }
  });

  test("a device id that is not a UUID is refused", () => {
    for (const deviceId of [undefined, "", "phone-7", 7]) {
      assert.equal(
        envelope(wireItem({ deviceId })).error?.reason,
        REJECT_REASON.ENVELOPE
      );
    }
  });

  test("a form type carrying capitals, spaces, markup or too many characters is refused", () => {
    for (const formType of [
      undefined,
      "",
      "Household",
      "household survey",
      "<script>",
      "a".repeat(65),
    ]) {
      assert.equal(
        envelope(wireItem({ formType })).error?.reason,
        REJECT_REASON.ENVELOPE,
        `formType ${JSON.stringify(formType)}`
      );
    }
    // Well-formed, so it gets past the shape check to the definition lookup.
    assert.equal(
      envelope(wireItem({ formType: "a".repeat(64) })).error?.reason,
      REJECT_REASON.UNKNOWN_FORM
    );
  });

  test("a form version that is not a whole number from 1 to the ceiling is refused", () => {
    for (const formVersion of [undefined, 0, -1, 1.5, "1", MAX_FORM_VERSION + 1]) {
      assert.equal(
        envelope(wireItem({ formVersion })).error?.reason,
        REJECT_REASON.ENVELOPE,
        `formVersion ${JSON.stringify(formVersion)}`
      );
    }
    assert.equal(
      envelope(wireItem({ formVersion: MAX_FORM_VERSION })).error?.reason,
      REJECT_REASON.UNKNOWN_FORM
    );
  });

  // The policy reversed with form definitions: see the envelope note in
  // sync/pushRules.js. A phone only ever holds versions the server published.
  test("a form version the organisation never published is refused with a reason saying so", () => {
    const result = envelope(wireItem({ formVersion: 99 }));
    assert.equal(result.error?.reason, REJECT_REASON.UNKNOWN_FORM);
    assert.match(result.error.message, /household_survey version 99 is not published/);
  });

  test("a form type the organisation does not have is refused", () => {
    assert.equal(
      envelope(wireItem({ formType: "school_survey" })).error?.reason,
      REJECT_REASON.UNKNOWN_FORM
    );
  });

  test("a draft version is refused by name", () => {
    const result = envelope(wireItem({ formVersion: 2 }));
    assert.equal(result.error?.reason, REJECT_REASON.UNKNOWN_FORM);
    assert.match(result.error.message, /draft/);
  });

  test("the per-record size limits are the ones push has always enforced", () => {
    assert.equal(MAX_PAYLOAD_UTF8_BYTES, 256 * 1024);
    assert.equal(MAX_PAYLOAD_FIELDS, 200);
    assert.equal(MAX_STRING_LENGTH, 10_000);
  });

  test("with no definitions loaded at all, nothing is accepted", () => {
    assert.equal(validateEnvelope(wireItem(), new Map()).error?.reason, REJECT_REASON.UNKNOWN_FORM);
    assert.equal(validateEnvelope(wireItem(), undefined).error?.reason, REJECT_REASON.UNKNOWN_FORM);
  });

  test("answers are checked against the version claimed: an undeclared key is refused", () => {
    const result = envelope(wireItem({ payload: { ...ANSWERS, toiletAvailable: "yes" } }));
    assert.equal(result.error?.reason, REJECT_REASON.PAYLOAD);
    assert.match(result.error.message, /toiletAvailable/);
  });

  test("a negative, fractional or textual base version is refused", () => {
    for (const baseVersion of [-1, 1.5, "3"]) {
      assert.equal(
        envelope(wireItem({ baseVersion })).error?.reason,
        REJECT_REASON.ENVELOPE,
        `baseVersion ${JSON.stringify(baseVersion)}`
      );
    }
  });

  test("a deletion flag that is not a real boolean is refused", () => {
    for (const deleted of [undefined, null, 0, 1, "true", "2026-09-22 15:16:21.934000"]) {
      assert.equal(
        envelope(wireItem({ deleted })).error?.reason,
        REJECT_REASON.ENVELOPE,
        `deleted ${JSON.stringify(deleted)}`
      );
    }
  });

  test("malformed answers are refused with the payload reason, not the envelope one", () => {
    const result = envelope(wireItem({ payload: { ...ANSWERS, memberCount: "5" } }));
    assert.equal(result.error?.reason, REJECT_REASON.PAYLOAD);
  });
});

// ---------------------------------------------------------------------------
// mayWrite — who may change a row the server already holds
// ---------------------------------------------------------------------------

const ORG = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ORG = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const WORKER_A = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const WORKER_B = "6f5e4d3c-2b1a-4f9e-8d7c-5b4a3f2e1d0c";
const SUPERVISOR = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const WADGAON = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const SHIRUR = "8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";

// Built the way the route builds it: identity and role from the verified JWT,
// area from a fresh read of users.area_id.
function actor(overrides = {}) {
  return {
    id: WORKER_A,
    role: "field_worker",
    organizationId: ORG,
    areaId: WADGAON,
    ...overrides,
  };
}

function heldRow(overrides = {}) {
  return { organizationId: ORG, createdBy: WORKER_A, areaId: WADGAON, ...overrides };
}

describe("mayWrite: supervisors and admins", () => {
  test("a supervisor may change a record a field worker captured", () => {
    assert.equal(mayWrite(actor({ id: SUPERVISOR, role: "supervisor" }), heldRow()), true);
  });

  test("an admin may change a record a field worker captured", () => {
    assert.equal(mayWrite(actor({ id: SUPERVISOR, role: "admin" }), heldRow()), true);
  });

  test("a supervisor may not change another organisation's record", () => {
    const supervisor = actor({ id: SUPERVISOR, role: "supervisor" });
    assert.equal(mayWrite(supervisor, heldRow({ organizationId: OTHER_ORG })), false);
  });
});

describe("mayWrite: field workers share their area", () => {
  test("a worker may change a colleague's record in their own area", () => {
    assert.equal(mayWrite(actor({ id: WORKER_B }), heldRow()), true);
  });

  test("a worker may change their own record", () => {
    assert.equal(mayWrite(actor(), heldRow()), true);
  });

  test("a worker may not change a record in another area, even one they captured", () => {
    assert.equal(mayWrite(actor(), heldRow({ areaId: SHIRUR })), false);
  });

  test("a worker moved to another area loses write access to the old one on the next request", () => {
    // Same person, same token; only the area read from the database changed.
    assert.equal(mayWrite(actor({ areaId: SHIRUR }), heldRow()), false);
  });

  test("a record with no area may be changed by its creator and by no other worker", () => {
    const unassigned = heldRow({ areaId: null });
    assert.equal(mayWrite(actor(), unassigned), true);
    assert.equal(mayWrite(actor({ id: WORKER_B }), unassigned), false);
  });

  test("a worker with no area may change their own unassigned records and nothing in an area", () => {
    const unassignedWorker = actor({ areaId: null });
    assert.equal(mayWrite(unassignedWorker, heldRow({ areaId: null })), true);
    assert.equal(mayWrite(unassignedWorker, heldRow()), false);
  });

  test("a worker may not change another organisation's record", () => {
    assert.equal(mayWrite(actor(), heldRow({ organizationId: OTHER_ORG })), false);
  });

  test("a supervisor may change a record in any area, and one with no area", () => {
    const supervisor = actor({ id: SUPERVISOR, role: "supervisor", areaId: null });
    assert.equal(mayWrite(supervisor, heldRow({ areaId: SHIRUR })), true);
    assert.equal(mayWrite(supervisor, heldRow({ areaId: null })), true);
  });
});
