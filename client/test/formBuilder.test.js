import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fileServerErrors,
  moveField,
  newEditorField,
  publishedKeyTypes,
  suggestKey,
  toDefinitionBody,
  toDefinitionField,
  toEditor,
  toPreviewDefinition,
} from "../src/admin/formBuilder.js";
import { HOUSEHOLD_SURVEY_V1 } from "../src/forms/builtinForms.js";

const V1 = {
  id: "d1",
  formType: "household_survey",
  version: 1,
  status: "published",
  title: "Household survey",
  fields: HOUSEHOLD_SURVEY_V1.fields,
};
const V2 = {
  ...V1,
  id: "d2",
  version: 2,
  // memberCount removed in version 2.
  fields: HOUSEHOLD_SURVEY_V1.fields.filter((field) => field.key !== "memberCount"),
};
const DRAFT = { ...V2, id: "d3", version: 3, status: "draft" };

describe("publishedKeyTypes", () => {
  test("lists every key any published version used, removed ones included; drafts do not count", () => {
    const keys = publishedKeyTypes([V1, V2, DRAFT, { ...DRAFT, formType: "other" }], "household_survey");
    assert.deepEqual(keys.get("memberCount"), { type: "number", version: 1 });
    assert.deepEqual(keys.get("waterSource"), { type: "select", version: 2 });
    assert.equal(keys.size, HOUSEHOLD_SURVEY_V1.fields.length);
  });
});

describe("the editor and what is sent", () => {
  test("a copied draft round-trips to exactly the definition it came from", () => {
    const editor = toEditor({ ...DRAFT, fields: HOUSEHOLD_SURVEY_V1.fields }, publishedKeyTypes([V1], "household_survey"));
    const body = toDefinitionBody(editor);
    assert.equal(body.title, "Household survey");
    for (const [i, field] of HOUSEHOLD_SURVEY_V1.fields.entries()) {
      const sent = body.fields[i];
      // Every property of the original comes back with its value...
      for (const [prop, value] of Object.entries(field)) {
        assert.deepEqual(sent[prop], value, `${field.key}.${prop}`);
      }
      // ...and anything else is "not set" (null, or false for a flag), which
      // the server drops when it normalises.
      for (const [prop, value] of Object.entries(sent)) {
        if (!(prop in field)) assert.ok(value === null || value === false, `${field.key}.${prop}`);
      }
    }
  });

  test("copied fields are fixed; a new field is not", () => {
    const editor = toEditor(DRAFT, publishedKeyTypes([V1, V2], "household_survey"));
    assert.ok(editor.fields.every((field) => field.fixed));
    assert.equal(newEditorField().fixed, false);
  });

  test("only the properties of the chosen type are sent, whatever was typed before", () => {
    const field = {
      ...newEditorField(),
      key: "count",
      label: "Count",
      type: "select",
      min: "3",
      maxLength: "10",
      options: "A\n\n B \n",
    };
    assert.deepEqual(toDefinitionField(field), {
      key: "count",
      label: "Count",
      type: "select",
      required: false,
      options: ["A", "B"],
    });
  });

  test("numbers are sent as numbers, blanks as not set, and anything else as typed for the server to refuse", () => {
    const base = { ...newEditorField(), key: "n", label: "N", type: "number" };
    assert.deepEqual(toDefinitionField({ ...base, min: " 0 ", max: "" }).min, 0);
    assert.equal(toDefinitionField({ ...base, max: "" }).max, null);
    assert.equal(toDefinitionField({ ...base, max: "ten" }).max, "ten");
  });

  test("the preview is keyed by card, so two cards with one key are still two inputs", () => {
    const a = { ...newEditorField(), key: "same", label: "A" };
    const b = { ...newEditorField(), key: "same", label: "" };
    const preview = toPreviewDefinition({ title: "T", fields: [a, b] });
    assert.deepEqual(preview.fields.map((f) => f.key), [a.uid, b.uid]);
    assert.equal(preview.fields[1].label, "(no label yet)");
  });
});

describe("suggestKey", () => {
  test("turns a label into a camelCase key", () => {
    assert.equal(suggestKey("Follow-up needed"), "followUpNeeded");
    assert.equal(suggestKey("Next visit date"), "nextVisitDate");
    assert.equal(suggestKey("  ANC visits  "), "ancVisits");
  });

  test("starts with a letter and has no characters a key may not hold", () => {
    assert.equal(suggestKey("5 year plan"), "f5YearPlan");
    assert.equal(suggestKey("पाणी"), "");
    assert.match(suggestKey("Café (main)"), /^[a-z][A-Za-z0-9]*$/);
  });
});

describe("fileServerErrors and moveField", () => {
  test("an error stays on the card it was about, even after the card moves", () => {
    const sentUids = ["u1", "u2", "u3"];
    const filed = fileServerErrors(
      [
        { index: null, prop: "title", message: "Title is required." },
        { index: 2, prop: "label", message: "Label is required." },
      ],
      sentUids
    );
    assert.deepEqual(filed, { form: ["Title is required."], byUid: { u3: ["Label is required."] } });
  });

  test("moving past either end changes nothing", () => {
    const fields = ["a", "b", "c"];
    assert.deepEqual(moveField(fields, 0, -1), fields);
    assert.deepEqual(moveField(fields, 2, 1), fields);
    assert.deepEqual(moveField(fields, 0, 1), ["b", "a", "c"]);
  });
});
