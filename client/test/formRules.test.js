import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_FORM_TYPE,
  checkAnswers,
  chooseDefinition,
  describeFields,
  emptyValues,
  findDefinition,
  formatValue,
  isPristine,
  latestDefinition,
  summarise,
  toFormValues,
  toPayload,
} from "../src/forms/formRules.js";
import { BUILTIN_FORMS, HOUSEHOLD_SURVEY_V1 } from "../src/forms/builtinForms.js";
// The server's copy of the same published version. Imported across workspaces
// only here, as a drift guard: the phone's fallback must be that version.
import { HOUSEHOLD_SURVEY_V1 as SERVER_V1 } from "../../server/forms/householdSurveyV1.js";

// Catalog rows as forms/formStore.js holds them.
function published(version, fields, formType = CAPTURE_FORM_TYPE) {
  return {
    id: `${formType}-${version}`,
    organizationId: "org-1",
    formType,
    version,
    title: `Survey v${version}`,
    fields,
  };
}

const V1 = published(1, HOUSEHOLD_SURVEY_V1.fields);
const V2 = published(2, [
  ...HOUSEHOLD_SURVEY_V1.fields,
  { key: "followUpNeeded", label: "Follow-up needed", type: "yesno", required: true },
  { key: "nextVisitDate", label: "Next visit date", type: "date", required: false },
]);
const OTHER_FORM_V9 = published(9, [{ key: "school", label: "School", type: "text" }], "school_survey");

describe("the built-in form", () => {
  test("is exactly the published household_survey version 1 on the server", () => {
    // The built-in copy carries a local id; everything the server publishes
    // must match.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const builtin = plain(HOUSEHOLD_SURVEY_V1);
    delete builtin.id;
    assert.deepEqual(builtin, plain(SERVER_V1));
  });
});

// ---------------------------------------------------------------------------
// Which definition a screen uses
// ---------------------------------------------------------------------------

describe("chooseDefinition: a new record", () => {
  test("uses the latest published version of the capture form", () => {
    const choice = chooseDefinition({ catalog: [V1, V2, OTHER_FORM_V9] });
    assert.equal(choice.definition, V2);
    assert.equal(choice.builtin, false);
  });

  test("does not depend on the order the catalog is stored in", () => {
    assert.equal(chooseDefinition({ catalog: [V2, V1] }).definition, V2);
  });

  test("falls back to the built-in version 1 when nothing has been downloaded", () => {
    const choice = chooseDefinition({ catalog: [] });
    assert.equal(choice.definition, HOUSEHOLD_SURVEY_V1);
    assert.equal(choice.builtin, true);
  });

  test("a later version of another form is never picked for this one", () => {
    const choice = chooseDefinition({ catalog: [OTHER_FORM_V9] });
    assert.equal(choice.definition, HOUSEHOLD_SURVEY_V1);
  });

  test("a form with no version anywhere is reported missing", () => {
    assert.deepEqual(chooseDefinition({ catalog: [], formType: "school_survey" }), {
      missing: { formType: "school_survey", version: null },
    });
  });
});

describe("chooseDefinition: editing a record", () => {
  test("uses the record's OWN version, even when a newer one exists", () => {
    const record = { formType: CAPTURE_FORM_TYPE, formVersion: 1 };
    assert.equal(chooseDefinition({ catalog: [V1, V2], record }).definition, V1);
  });

  test("a version-1 record is editable from the built-in copy with nothing downloaded", () => {
    const record = { formType: CAPTURE_FORM_TYPE, formVersion: 1 };
    const choice = chooseDefinition({ catalog: [], record });
    assert.equal(choice.definition, HOUSEHOLD_SURVEY_V1);
    assert.equal(choice.builtin, true);
  });

  test("a version this device does not have is reported, not replaced by another", () => {
    const record = { formType: CAPTURE_FORM_TYPE, formVersion: 3 };
    assert.deepEqual(chooseDefinition({ catalog: [V1, V2], record }), {
      missing: { formType: CAPTURE_FORM_TYPE, version: 3 },
    });
  });

  test("a version-2 record is missing on a phone that only has version 1", () => {
    const record = { formType: CAPTURE_FORM_TYPE, formVersion: 2 };
    assert.ok(chooseDefinition({ catalog: [V1], record }).missing);
  });
});

describe("findDefinition and latestDefinition", () => {
  test("find matches type and version exactly, falling back only to an identical built-in", () => {
    assert.equal(findDefinition([V1, V2], CAPTURE_FORM_TYPE, 2), V2);
    assert.equal(findDefinition([], CAPTURE_FORM_TYPE, 1), BUILTIN_FORMS[0]);
    assert.equal(findDefinition([], CAPTURE_FORM_TYPE, 2), null);
    assert.equal(findDefinition([V1], "school_survey", 1), null);
  });

  test("a downloaded version 1 is preferred to the built-in copy", () => {
    assert.equal(findDefinition([V1], CAPTURE_FORM_TYPE, 1), V1);
    assert.equal(latestDefinition([V1], CAPTURE_FORM_TYPE), V1);
  });
});

// ---------------------------------------------------------------------------
// Form values <-> payload
// ---------------------------------------------------------------------------

describe("toPayload and toFormValues", () => {
  test("every key of the definition is sent, unanswered as null", () => {
    assert.deepEqual(toPayload(V2, emptyValues(V2)), {
      householdName: null,
      memberCount: null,
      childrenUnderFive: null,
      visitDate: null,
      waterSource: null,
      notes: null,
      followUpNeeded: null,
      nextVisitDate: null,
    });
  });

  test("numbers become JSON numbers, yes/no a boolean, text is trimmed", () => {
    const payload = toPayload(V2, {
      ...emptyValues(V2),
      householdName: "  Patil ",
      memberCount: "5",
      followUpNeeded: "no",
      nextVisitDate: "2026-12-01",
    });
    assert.equal(payload.householdName, "Patil");
    assert.equal(payload.memberCount, 5);
    assert.equal(payload.followUpNeeded, false);
    assert.equal(payload.nextVisitDate, "2026-12-01");
  });

  test("a number that does not parse is kept as NaN for the check to catch, not as null", () => {
    assert.ok(Number.isNaN(toPayload(V1, { memberCount: "abc" }).memberCount));
  });

  test("a stored payload round-trips through the form unchanged", () => {
    const stored = {
      householdName: "Patil",
      memberCount: 0,
      childrenUnderFive: null,
      visitDate: "2026-09-22",
      waterSource: "Well",
      notes: null,
      followUpNeeded: true,
      nextVisitDate: null,
    };
    assert.deepEqual(toPayload(V2, toFormValues(V2, stored)), stored);
  });

  test("an answered zero and an answered no survive the round trip", () => {
    const values = toFormValues(V2, { memberCount: 0, followUpNeeded: false });
    assert.equal(values.memberCount, "0");
    assert.equal(values.followUpNeeded, "no");
  });

  test("a form nobody has typed into is pristine", () => {
    assert.equal(isPristine(emptyValues(V1)), true);
    assert.equal(isPristine({ ...emptyValues(V1), notes: "x" }), false);
  });
});

describe("checkAnswers", () => {
  const RULES = published(1, [
    { key: "name", label: "Name", type: "text", required: true, maxLength: 5 },
    { key: "age", label: "Age", type: "number", required: false, min: 0, max: 120, integer: true },
    { key: "seen", label: "Seen", type: "date", required: false },
    { key: "colour", label: "Colour", type: "select", required: false, options: ["Red"] },
    { key: "ok", label: "OK", type: "yesno", required: true },
  ]);
  const valid = { name: "Asha", age: 30, seen: "2026-11-10", colour: "Red", ok: false };
  const check = (overrides) => checkAnswers(RULES, { ...valid, ...overrides });

  test("valid answers have no problems; a required no is an answer", () => {
    assert.deepEqual(check({}), {});
  });

  test("each rule is reported on its own field", () => {
    assert.deepEqual(Object.keys(check({ name: null })), ["name"]);
    assert.deepEqual(Object.keys(check({ name: "Ashwini" })), ["name"]);
    assert.deepEqual(Object.keys(check({ age: 30.5 })), ["age"]);
    assert.deepEqual(Object.keys(check({ age: -1 })), ["age"]);
    assert.deepEqual(Object.keys(check({ age: 121 })), ["age"]);
    assert.deepEqual(Object.keys(check({ age: Number.NaN })), ["age"]);
    assert.deepEqual(Object.keys(check({ seen: "2026-02-30" })), ["seen"]);
    assert.deepEqual(Object.keys(check({ colour: "Blue" })), ["colour"]);
    assert.deepEqual(Object.keys(check({ ok: null })), ["ok"]);
  });

  test("version 1 accepts an empty form, as the old screen did", () => {
    assert.deepEqual(checkAnswers(V1, toPayload(V1, emptyValues(V1))), {});
  });

  test("version 2's required yes/no must be answered", () => {
    assert.deepEqual(Object.keys(checkAnswers(V2, toPayload(V2, emptyValues(V2)))), [
      "followUpNeeded",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reading a payload back
// ---------------------------------------------------------------------------

describe("formatValue, describeFields and summarise", () => {
  test("yes/no reads Yes and No; unanswered reads as a dash", () => {
    const yesno = { type: "yesno" };
    assert.equal(formatValue(yesno, true), "Yes");
    assert.equal(formatValue(yesno, false), "No");
    assert.equal(formatValue(yesno, null), "—");
    assert.equal(formatValue(null, 0), "0");
  });

  test("comparison rows follow the definitions' order and labels, then unknown keys", () => {
    const rows = describeFields(
      [{ notes: "a", householdName: "P", mystery: 1 }, { followUpNeeded: true }],
      [V1, V2]
    );
    assert.deepEqual(
      rows.map(({ key, label }) => [key, label]),
      [
        ["householdName", "Household name"],
        ["notes", "Notes"],
        ["followUpNeeded", "Follow-up needed"],
        ["mystery", "mystery"],
      ]
    );
  });

  test("a missing definition still lists every key, by name", () => {
    const rows = describeFields([{ a: 1 }, { b: 2 }], [null, null]);
    assert.deepEqual(rows.map((row) => row.label), ["a", "b"]);
  });

  test("a record's one-line summary leads with its name, then a date", () => {
    const payload = { householdName: "Patil", memberCount: 5, visitDate: "2026-09-22", notes: "x" };
    assert.equal(summarise(payload, V1), "Patil · 2026-09-22 · Members in household: 5");
    assert.equal(summarise({ memberCount: 2 }, V1), "(no name) · Members in household: 2");
  });

  test("a second date in the summary carries its label, so two dates can be told apart", () => {
    const payload = { householdName: "Shinde", visitDate: "2026-11-10", nextVisitDate: "2026-12-01" };
    assert.equal(summarise(payload, V2), "Shinde · 2026-11-10 · Next visit date: 2026-12-01");
  });
});
