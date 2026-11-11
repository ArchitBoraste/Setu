import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  DEFINITION_ERROR,
  MAX_PAYLOAD_FIELDS,
  MAX_PAYLOAD_UTF8_BYTES,
  MAX_STRING_LENGTH,
  PAYLOAD_ERROR,
  checkKeyStability,
  planPublish,
  validateDefinition,
  validatePayload,
} from "../forms/formRules.js";
import { HOUSEHOLD_SURVEY_V1 } from "../forms/householdSurveyV1.js";

// A definition as the push route hands it to validatePayload: a database row.
function definition(fields, { formType = "test_form", version = 1 } = {}) {
  return { formType, version, status: "published", fields };
}

const V1 = definition(HOUSEHOLD_SURVEY_V1.fields, {
  formType: HOUSEHOLD_SURVEY_V1.formType,
  version: 1,
});

const ANSWERS = {
  householdName: "Patil",
  memberCount: 5,
  childrenUnderFive: 1,
  visitDate: "2026-09-22",
  waterSource: "Handpump",
  notes: null,
};

const survey = (payload) => validatePayload(V1, payload);

// One field of each type, every rule switched on, for the per-type tests.
const EVERY_RULE = definition([
  { key: "name", label: "Name", type: "text", required: true, maxLength: 10 },
  { key: "age", label: "Age", type: "number", required: true, min: 0, max: 120, integer: true },
  { key: "weight", label: "Weight", type: "number", required: false, min: 0.5 },
  { key: "seenOn", label: "Seen on", type: "date", required: true },
  { key: "colour", label: "Colour", type: "select", required: true, options: ["Red", "Blue"] },
  { key: "followUp", label: "Follow-up needed", type: "yesno", required: true },
]);

const VALID = { name: "Asha", age: 30, weight: 52.5, seenOn: "2026-11-10", colour: "Red", followUp: false };

const check = (overrides) => validatePayload(EVERY_RULE, { ...VALID, ...overrides });
const refusedFor = (result, field) => {
  assert.equal(result.error?.reason, PAYLOAD_ERROR.INVALID, JSON.stringify(result));
  assert.equal(result.error.field, field);
};

// ---------------------------------------------------------------------------
// validateDefinition
// ---------------------------------------------------------------------------

describe("validateDefinition", () => {
  test("version 1 of the household survey is a valid definition, unchanged by normalising", () => {
    const result = validateDefinition({
      title: HOUSEHOLD_SURVEY_V1.title,
      fields: HOUSEHOLD_SURVEY_V1.fields,
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value.fields, HOUSEHOLD_SURVEY_V1.fields);
  });

  test("labels, title and options are trimmed; unset optional properties are left out", () => {
    const { value } = validateDefinition({
      title: "  Survey  ",
      fields: [
        { key: "a", label: "  A  ", type: "text", required: false, maxLength: null, multiline: false },
        { key: "b", label: "B", type: "select", options: [" Yes ", "No"] },
        { key: "c", label: "C", type: "number", min: null, max: 5, integer: false },
      ],
    });
    assert.equal(value.title, "Survey");
    assert.deepEqual(value.fields, [
      { key: "a", label: "A", type: "text", required: false },
      { key: "b", label: "B", type: "select", required: false, options: ["Yes", "No"] },
      { key: "c", label: "C", type: "number", required: false, max: 5 },
    ]);
  });

  test("a form with no fields, or no title, is refused", () => {
    for (const def of [{ title: "T", fields: [] }, { title: "T" }, { title: "", fields: [{ key: "a", label: "A", type: "text" }] }]) {
      assert.equal(validateDefinition(def).error?.reason, DEFINITION_ERROR, JSON.stringify(def));
    }
    assert.equal(validateDefinition(null).error?.reason, DEFINITION_ERROR);
  });

  test("a key used twice is reported on the second field, naming the first", () => {
    const { error } = validateDefinition({
      title: "T",
      fields: [
        { key: "a", label: "A", type: "text" },
        { key: "b", label: "B", type: "text" },
        { key: "a", label: "Again", type: "number" },
      ],
    });
    assert.equal(error.errors.length, 1);
    assert.deepEqual(
      { index: error.errors[0].index, prop: error.errors[0].prop },
      { index: 2, prop: "key" }
    );
    assert.match(error.errors[0].message, /field 1/);
  });

  test("an empty or whitespace label is refused", () => {
    for (const label of ["", "   ", undefined, 7]) {
      const { error } = validateDefinition({ title: "T", fields: [{ key: "a", label, type: "text" }] });
      assert.equal(error.errors[0].prop, "label", JSON.stringify(label));
    }
  });

  test("keys must be identifiers that start with a lowercase letter", () => {
    for (const key of ["", "Name", "1st", "has space", "a-b", "__proto__", "a".repeat(65), 5]) {
      const { error } = validateDefinition({ title: "T", fields: [{ key, label: "L", type: "text" }] });
      assert.equal(error?.errors[0].prop, "key", JSON.stringify(key));
    }
    for (const key of ["a", "householdName", "q_1"]) {
      assert.equal(
        validateDefinition({ title: "T", fields: [{ key, label: "L", type: "text" }] }).error,
        undefined,
        key
      );
    }
  });

  test("an unknown type is refused", () => {
    const { error } = validateDefinition({ title: "T", fields: [{ key: "a", label: "A", type: "photo" }] });
    assert.equal(error.errors[0].prop, "type");
  });

  test("required must be a real boolean", () => {
    const { error } = validateDefinition({
      title: "T",
      fields: [{ key: "a", label: "A", type: "text", required: "yes" }],
    });
    assert.equal(error.errors[0].prop, "required");
  });

  test("a property that belongs to another type is refused, not silently dropped", () => {
    const { error } = validateDefinition({
      title: "T",
      fields: [
        { key: "a", label: "A", type: "text", min: 3 },
        { key: "b", label: "B", type: "yesno", options: ["Y", "N"] },
      ],
    });
    assert.deepEqual(
      error.errors.map((e) => [e.index, e.prop]),
      [
        [0, "min"],
        [1, "options"],
      ]
    );
  });

  test("number bounds must be numbers, and the minimum not above the maximum", () => {
    const bad = (field) =>
      validateDefinition({ title: "T", fields: [{ key: "n", label: "N", type: "number", ...field }] })
        .error?.errors[0].prop;
    assert.equal(bad({ min: "0" }), "min");
    assert.equal(bad({ max: Number.NaN }), "max");
    assert.equal(bad({ min: 5, max: 1 }), "max");
    assert.equal(bad({ integer: "true" }), "integer");
    assert.equal(bad({ min: 1, max: 1 }), undefined);
  });

  test("a choice field needs at least one distinct, non-empty option", () => {
    const bad = (options) =>
      validateDefinition({ title: "T", fields: [{ key: "s", label: "S", type: "select", options }] })
        .error?.errors[0].prop;
    assert.equal(bad(undefined), "options");
    assert.equal(bad([]), "options");
    assert.equal(bad(["A", " "]), "options");
    assert.equal(bad(["A", " A "]), "options");
    assert.equal(bad(["A", 3]), "options");
    assert.equal(bad(["A", "B"]), undefined);
  });

  test("a text field's maximum length is a whole number within the server's limit", () => {
    const bad = (maxLength) =>
      validateDefinition({ title: "T", fields: [{ key: "t", label: "T", type: "text", maxLength }] })
        .error?.errors[0].prop;
    for (const maxLength of [0, -1, 2.5, "10", MAX_STRING_LENGTH + 1]) {
      assert.equal(bad(maxLength), "maxLength", String(maxLength));
    }
    assert.equal(bad(MAX_STRING_LENGTH), undefined);
  });

  test("every problem is reported at once, each with the position of its field", () => {
    const { error } = validateDefinition({
      title: "",
      fields: [
        { key: "ok", label: "Fine", type: "text" },
        { key: "a", label: "", type: "text" },
        { key: "b", label: "B", type: "select", options: [] },
      ],
    });
    assert.deepEqual(
      error.errors.map((e) => [e.index, e.prop]),
      [
        [null, "title"],
        [1, "label"],
        [2, "options"],
      ]
    );
    assert.match(error.message, /3 problems/);
  });

  test("more fields than a payload may carry is refused", () => {
    const fields = Array.from({ length: MAX_PAYLOAD_FIELDS + 1 }, (_, i) => ({
      key: `q${i}`,
      label: `Q${i}`,
      type: "text",
    }));
    assert.equal(validateDefinition({ title: "T", fields }).error?.errors[0].prop, "fields");
  });
});

// ---------------------------------------------------------------------------
// Key stability across versions
// ---------------------------------------------------------------------------

describe("checkKeyStability", () => {
  const v1 = { version: 1, fields: [{ key: "water", type: "select" }, { key: "count", type: "number" }] };
  const v2 = { version: 2, fields: [{ key: "water", type: "select" }] }; // count removed

  test("keys that keep their type, and brand-new keys, pass", () => {
    assert.deepEqual(
      checkKeyStability([v1, v2], [
        { key: "water", type: "select" },
        { key: "visited", type: "yesno" },
      ]),
      []
    );
  });

  test("a key may never change type from one version to the next", () => {
    const errors = checkKeyStability([v1], [{ key: "other", type: "text" }, { key: "water", type: "text" }]);
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0].index, errors[0].key, errors[0].prop], [1, "water", "type"]);
    assert.match(errors[0].message, /select field in version 1/);
  });

  test("a key removed in a later version may not come back with a different type", () => {
    const errors = checkKeyStability([v1, v2], [{ key: "count", type: "text" }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /number field in version 1/);
  });

  test("a key removed in a later version may come back with its old type", () => {
    assert.deepEqual(checkKeyStability([v1, v2], [{ key: "count", type: "number" }]), []);
  });
});

describe("planPublish", () => {
  const draft = { title: "Survey", fields: [{ key: "a", label: "A", type: "text" }] };

  test("the first version of a form is 1, and each next one is one above the latest", () => {
    assert.equal(planPublish({ draft, published: [] }).value.version, 1);
    assert.equal(
      planPublish({
        draft,
        published: [
          { version: 2, fields: [] },
          { version: 1, fields: [] },
        ],
      }).value.version,
      3
    );
  });

  test("a draft that breaks a rule, or changes a key's type, is not published", () => {
    assert.equal(
      planPublish({ draft: { title: "S", fields: [] }, published: [] }).error?.reason,
      DEFINITION_ERROR
    );
    const changed = planPublish({
      draft,
      published: [{ version: 1, fields: [{ key: "a", type: "number" }] }],
    });
    assert.equal(changed.error?.reason, DEFINITION_ERROR);
    assert.equal(changed.error.errors[0].prop, "type");
  });
});

// ---------------------------------------------------------------------------
// validatePayload
// ---------------------------------------------------------------------------

describe("validatePayload: household survey version 1", () => {
  test("valid answers come back with the exact text that will be stored", () => {
    const result = survey(ANSWERS);
    assert.equal(result.error, undefined);
    assert.equal(result.value.payload, ANSWERS);
    assert.equal(result.value.payloadText, JSON.stringify(ANSWERS));
  });

  test("nothing is required: all-null and empty answers are accepted", () => {
    const allNull = Object.fromEntries(Object.keys(ANSWERS).map((key) => [key, null]));
    assert.equal(survey(allNull).error, undefined);
    assert.equal(survey({}).error, undefined);
  });

  test("a count that arrives as text is refused, naming the field but not the answer", () => {
    const result = survey({ ...ANSWERS, memberCount: "five people" });
    refusedFor(result, "memberCount");
    assert.doesNotMatch(result.error.message, /five people/);
  });

  test("counts are whole numbers from 0, as the capture screen enforced", () => {
    refusedFor(survey({ ...ANSWERS, memberCount: -1 }), "memberCount");
    refusedFor(survey({ ...ANSWERS, childrenUnderFive: 1.5 }), "childrenUnderFive");
    assert.equal(survey({ ...ANSWERS, memberCount: 0 }).error, undefined);
  });

  test("a water source outside version 1's list is refused", () => {
    refusedFor(survey({ ...ANSWERS, waterSource: "Borewell" }), "waterSource");
    refusedFor(survey({ ...ANSWERS, waterSource: "handpump" }), "waterSource");
  });

  test("a field version 1 does not declare is refused", () => {
    const result = survey({ ...ANSWERS, toiletAvailable: "yes" });
    refusedFor(result, "toiletAvailable");
    assert.match(result.error.message, /household_survey version 1/);
  });

  test("a key that names something on Object.prototype is not mistaken for a field", () => {
    refusedFor(survey(JSON.parse('{"constructor": "x"}')), "constructor");
  });

  test("answers that are not a single object are refused", () => {
    for (const payload of [null, undefined, [], "answers", 5]) {
      assert.equal(survey(payload).error?.reason, PAYLOAD_ERROR.INVALID);
    }
  });
});

describe("validatePayload: every type and rule", () => {
  test("a complete, valid set of answers is accepted", () => {
    assert.equal(check({}).error, undefined);
  });

  test("required: a missing key, a null and a blank text are all unanswered", () => {
    const missing = { ...VALID };
    delete missing.name;
    refusedFor(validatePayload(EVERY_RULE, missing), "name");
    refusedFor(check({ name: null }), "name");
    refusedFor(check({ name: "   " }), "name");
    refusedFor(check({ followUp: null }), "followUp");
  });

  test("required yes/no: false is an answer, not a missing one", () => {
    assert.equal(check({ followUp: false }).error, undefined);
    assert.equal(check({ followUp: true }).error, undefined);
  });

  test("optional fields may be null or absent", () => {
    assert.equal(check({ weight: null }).error, undefined);
    const withoutWeight = { ...VALID };
    delete withoutWeight.weight;
    assert.equal(validatePayload(EVERY_RULE, withoutWeight).error, undefined);
  });

  test("text: must be a string within the field's maximum length", () => {
    refusedFor(check({ name: 42 }), "name");
    refusedFor(check({ name: "a".repeat(11) }), "name");
    assert.equal(check({ name: "a".repeat(10) }).error, undefined);
  });

  test("text without its own maximum is held to the server's string limit", () => {
    const def = definition([{ key: "notes", label: "Notes", type: "text", required: false }]);
    assert.equal(validatePayload(def, { notes: "a".repeat(MAX_STRING_LENGTH) }).error, undefined);
    refusedFor(validatePayload(def, { notes: "a".repeat(MAX_STRING_LENGTH + 1) }), "notes");
  });

  test("text that merely looks like an impossible date is still text", () => {
    const def = definition([{ key: "notes", label: "Notes", type: "text", required: false }]);
    assert.equal(validatePayload(def, { notes: "2026-02-30" }).error, undefined);
  });

  test("number: must be a finite JSON number", () => {
    for (const age of ["30", true, Number.NaN, Number.POSITIVE_INFINITY]) {
      refusedFor(check({ age }), "age");
    }
  });

  test("number: whole numbers only when the field says so", () => {
    refusedFor(check({ age: 30.5 }), "age");
    assert.equal(check({ weight: 52.25 }).error, undefined);
  });

  test("number: the minimum and maximum are inclusive", () => {
    assert.equal(check({ age: 0 }).error, undefined);
    assert.equal(check({ age: 120 }).error, undefined);
    refusedFor(check({ age: -1 }), "age");
    refusedFor(check({ age: 121 }), "age");
    refusedFor(check({ weight: 0.4 }), "weight");
  });

  test("date: a real calendar date written YYYY-MM-DD, and nothing else", () => {
    for (const seenOn of [
      "22/09/2026",
      "09/22/2026",
      "yesterday",
      "5",
      "2026-02-30",
      "2026-13-01",
      "2026-09-22T10:00",
      20260922,
    ]) {
      refusedFor(check({ seenOn }), "seenOn");
    }
    assert.equal(check({ seenOn: "2028-02-29" }).error, undefined);
    refusedFor(check({ seenOn: "2026-02-29" }), "seenOn");
  });

  test("select: one of this version's options, exactly", () => {
    refusedFor(check({ colour: "Green" }), "colour");
    refusedFor(check({ colour: "red" }), "colour");
    refusedFor(check({ colour: ["Red"] }), "colour");
    assert.equal(check({ colour: "Blue" }).error, undefined);
  });

  test("select: an answer is judged by the version that offered it", () => {
    const v2 = definition([{ key: "colour", label: "Colour", type: "select", options: ["Blue"] }], {
      version: 2,
    });
    const v1 = definition([{ key: "colour", label: "Colour", type: "select", options: ["Red", "Blue"] }]);
    assert.equal(validatePayload(v1, { colour: "Red" }).error, undefined);
    refusedFor(validatePayload(v2, { colour: "Red" }), "colour");
  });

  test("yes/no: a real boolean, not text or a number", () => {
    for (const followUp of ["yes", "true", 1, 0]) {
      refusedFor(check({ followUp }), "followUp");
    }
  });

  test("objects and lists are refused in every type", () => {
    for (const key of ["name", "age", "seenOn", "colour", "followUp"]) {
      refusedFor(check({ [key]: { nested: 1 } }), key);
      refusedFor(check({ [key]: [1] }), key);
    }
  });
});

// ---------------------------------------------------------------------------
// The size limits, kept from the push route. Devanagari is the case that
// matters: one UTF-16 unit, three UTF-8 bytes.
// ---------------------------------------------------------------------------

const DEVANAGARI_KA = "क";
const utf8Bytes = (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8");

// A definition declaring every key of these answers as optional text, so only
// the size rules are under test.
function textFormFor(answers) {
  return definition(
    Object.keys(answers).map((key) => ({ key, label: key, type: "text", required: false }))
  );
}

/**
 * Answers whose stored JSON text is exactly `bytes` long in UTF-8: Devanagari
 * fields as long as a field may be, then an ASCII field topping it up.
 */
function devanagariAnswersOf(bytes) {
  const answers = { pad: "" };
  for (let i = 0; ; i += 1) {
    const key = `q${i}`;
    answers[key] = "";
    const room = Math.floor((bytes - utf8Bytes(answers)) / 3);
    if (room <= 0) {
      delete answers[key];
      break;
    }
    answers[key] = DEVANAGARI_KA.repeat(Math.min(room, MAX_STRING_LENGTH));
  }
  answers.pad = "a".repeat(bytes - utf8Bytes(answers));
  assert.equal(utf8Bytes(answers), bytes);
  return answers;
}

describe("validatePayload: size limits", () => {
  test("more keys than the limit is refused as too large, before anything else", () => {
    const keys = Object.fromEntries(
      Array.from({ length: MAX_PAYLOAD_FIELDS + 1 }, (_, i) => [`q${i}`, "a"])
    );
    assert.equal(validatePayload(V1, keys).error?.reason, PAYLOAD_ERROR.TOO_LARGE);
  });

  test("a 65,536-character Devanagari payload, about 196 KB, is accepted", () => {
    const fields = Math.ceil(65_536 / MAX_STRING_LENGTH);
    const answers = Object.fromEntries(
      Array.from({ length: fields }, (_, i) => [
        `q${i}`,
        DEVANAGARI_KA.repeat(Math.min(MAX_STRING_LENGTH, 65_536 - i * MAX_STRING_LENGTH)),
      ])
    );
    assert.ok(utf8Bytes(answers) > 196_000);
    assert.equal(validatePayload(textFormFor(answers), answers).error, undefined);
  });

  test("Devanagari answers exactly at the byte limit are accepted", () => {
    const answers = devanagariAnswersOf(MAX_PAYLOAD_UTF8_BYTES);
    assert.equal(validatePayload(textFormFor(answers), answers).error, undefined);
  });

  test("Devanagari answers one byte over the limit are refused, though far under it in characters", () => {
    const answers = devanagariAnswersOf(MAX_PAYLOAD_UTF8_BYTES + 1);
    assert.ok(JSON.stringify(answers).length < MAX_PAYLOAD_UTF8_BYTES / 2);
    const result = validatePayload(textFormFor(answers), answers);
    assert.equal(result.error?.reason, PAYLOAD_ERROR.TOO_LARGE);
    assert.match(result.error.message, /bytes/);
  });
});

// ---------------------------------------------------------------------------
// The seeded copy in migration 006 is the same definition as the module the
// seed script and the client's fallback are held to.
// ---------------------------------------------------------------------------

describe("household_survey version 1 seed", () => {
  test("migration 006 seeds exactly the fields in forms/householdSurveyV1.js", () => {
    const sql = readFileSync(
      new URL("../db/migrations/006_form_definitions.sql", import.meta.url),
      "utf8"
    );
    const seeded = /-- form-definition:household_survey:1[\s\S]*?CAST\('(\[.*?\])' AS JSON\)/.exec(sql);
    assert.ok(seeded, "seed statement not found in 006");
    assert.deepEqual(JSON.parse(seeded[1]), HOUSEHOLD_SURVEY_V1.fields);
    assert.match(sql, /'household_survey', 1, 'Household survey'/);
  });
});
