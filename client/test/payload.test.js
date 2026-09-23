import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { differingFields, samePayload, unionFields } from "../src/lib/payload.js";

describe("samePayload", () => {
  // Regression: the server hands payloads back in MySQL's key order, not the
  // order they were captured in.
  test("the same answers are the same regardless of JSON key order", () => {
    assert.ok(
      samePayload(
        { householdName: "Patil", memberCount: 5, visitDate: "2026-09-22" },
        { visitDate: "2026-09-22", memberCount: 5, householdName: "Patil" }
      )
    );
  });

  test("a field missing from an older form revision and a field left unanswered agree", () => {
    assert.ok(samePayload({ householdName: "Patil" }, { householdName: "Patil", notes: null }));
  });

  test("a count of zero and an unanswered count are different answers", () => {
    assert.equal(samePayload({ childrenUnderFive: 0 }, { childrenUnderFive: null }), false);
    assert.equal(samePayload({ childrenUnderFive: 0 }, {}), false);
  });

  test("a count of 5 and the text \"5\" are different answers", () => {
    assert.equal(samePayload({ memberCount: 5 }, { memberCount: "5" }), false);
  });

  test("a record with no answers at all matches one whose answers are all unanswered", () => {
    for (const empty of [null, undefined, {}]) {
      assert.ok(samePayload(empty, { notes: null }));
      assert.equal(samePayload(empty, { notes: "seen" }), false);
    }
  });
});

describe("differingFields", () => {
  test("only the fields the two versions disagree about are reported, from either side", () => {
    const server = { householdName: "Patil", memberCount: 5, waterSource: "well" };
    const worker = { householdName: "Patil", memberCount: 6, notes: "new baby" };
    assert.deepEqual(
      [...differingFields(server, worker)].sort(),
      ["memberCount", "notes", "waterSource"]
    );
  });

  test("identical answers report no differences", () => {
    assert.equal(differingFields({ a: 1, b: "x" }, { b: "x", a: 1 }).size, 0);
  });
});

describe("unionFields", () => {
  test("every field either version names is listed once, in the order first seen", () => {
    assert.deepEqual(
      unionFields({ householdName: "Patil", memberCount: 5 }, { memberCount: 6, notes: null }),
      ["householdName", "memberCount", "notes"]
    );
  });

  test("a missing version contributes no fields", () => {
    assert.deepEqual(unionFields(null, { a: 1 }, undefined), ["a"]);
  });

  test("three versions side by side are all included", () => {
    assert.deepEqual(unionFields({ a: 1 }, { b: 2 }, { c: 3, a: 4 }), ["a", "b", "c"]);
  });
});
