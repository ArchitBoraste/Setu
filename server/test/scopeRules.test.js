import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SCOPE_KIND, canSeeRecord, isScopeKey, scopeFor } from "../sync/scopeRules.js";

const ORG = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_ORG = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const WADGAON = "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const SHIRUR = "8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";
const WORKER_A = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const WORKER_B = "6f5e4d3c-2b1a-4f9e-8d7c-5b4a3f2e1d0c";
const SUPERVISOR = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

function actor(overrides = {}) {
  return {
    id: WORKER_A,
    role: "field_worker",
    organizationId: ORG,
    areaId: WADGAON,
    ...overrides,
  };
}

function record(overrides = {}) {
  return { organizationId: ORG, areaId: WADGAON, createdBy: WORKER_A, ...overrides };
}

// ---------------------------------------------------------------------------
// scopeFor — what a pull delivers, and what a cursor is stamped with
// ---------------------------------------------------------------------------

describe("scopeFor", () => {
  test("a field worker with an area pulls that area", () => {
    assert.deepEqual(scopeFor(actor()), { kind: SCOPE_KIND.AREA, key: `area:${WADGAON}` });
  });

  test("a supervisor or admin pulls the organisation, whatever area they have", () => {
    for (const role of ["supervisor", "admin"]) {
      assert.deepEqual(scopeFor(actor({ id: SUPERVISOR, role })), {
        kind: SCOPE_KIND.ORGANISATION,
        key: `org:${ORG}`,
      });
    }
  });

  test("a field worker with no area pulls only their own unassigned records", () => {
    assert.deepEqual(scopeFor(actor({ areaId: null })), {
      kind: SCOPE_KIND.OWN,
      key: `own:${ORG}`,
    });
  });

  // The key names the set of rows. Moving a worker must change it, or their
  // cursor would be honoured in a scope it was never advanced in.
  test("moving a worker to another area changes their scope key", () => {
    assert.notEqual(scopeFor(actor()).key, scopeFor(actor({ areaId: SHIRUR })).key);
  });

  test("a promotion to supervisor changes the scope key", () => {
    assert.notEqual(scopeFor(actor()).key, scopeFor(actor({ role: "supervisor" })).key);
  });

  test("the organisation is part of the key, so a move between organisations is a new scope", () => {
    const before = actor({ role: "supervisor" });
    const after = actor({ role: "supervisor", organizationId: OTHER_ORG });
    assert.notEqual(scopeFor(before).key, scopeFor(after).key);
  });
});

describe("isScopeKey", () => {
  test("accepts every key scopeFor mints", () => {
    for (const minted of [
      scopeFor(actor()),
      scopeFor(actor({ areaId: null })),
      scopeFor(actor({ role: "supervisor" })),
    ]) {
      assert.equal(isScopeKey(minted.key), true, minted.key);
    }
  });

  test("refuses anything the server did not mint", () => {
    for (const value of [
      undefined,
      "",
      "area",
      "area:wadgaon",
      `area:${WADGAON}:x`,
      `village:${WADGAON}`,
      `org:${ORG} OR 1=1`,
      [`area:${WADGAON}`],
    ]) {
      assert.equal(isScopeKey(value), false, JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// canSeeRecord — the pull's WHERE clause, as a predicate
// ---------------------------------------------------------------------------

describe("canSeeRecord", () => {
  test("a field worker sees every record in their area, whoever captured it", () => {
    assert.equal(canSeeRecord(actor({ id: WORKER_B }), record()), true);
  });

  test("a field worker never sees another area's record", () => {
    assert.equal(canSeeRecord(actor(), record({ areaId: SHIRUR })), false);
  });

  test("a record with no area is seen by its creator and by supervisors only", () => {
    const unassigned = record({ areaId: null });
    assert.equal(canSeeRecord(actor(), unassigned), true);
    assert.equal(canSeeRecord(actor({ id: WORKER_B }), unassigned), false);
    assert.equal(canSeeRecord(actor({ id: SUPERVISOR, role: "supervisor" }), unassigned), true);
  });

  test("nobody sees another organisation's record", () => {
    for (const role of ["field_worker", "supervisor", "admin"]) {
      assert.equal(canSeeRecord(actor({ role }), record({ organizationId: OTHER_ORG })), false);
    }
  });
});
