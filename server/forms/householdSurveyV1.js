// household_survey version 1: the form that was built into the capture screen
// before form definitions existed, written down as a definition.
//
// Every record captured before migration 006 claims (household_survey, 1), so
// this has to describe exactly what that screen collected, field for field:
//
//   - the same six keys, because the stored payloads use them;
//   - nothing required, because the screen required nothing;
//   - the two counts as whole numbers from 0. The screen's <input type="number"
//     min="0"> enforced that in the browser (no step attribute means step 1),
//     though the server never checked it. It does now, so a count that only a
//     hand-made request could have produced is refused on its next edit;
//   - the five water sources the screen offered, in its order;
//   - labels from the capture screen, which a worker actually read.
//
// Three copies of this exist, on purpose, and a test holds each to this one:
//   - db/migrations/006_form_definitions.sql seeds existing databases;
//   - db/demoData.js imports this module for fresh installs;
//   - client/src/forms/builtinForms.js is what a phone uses before it has
//     ever downloaded a form, so that a first start offline can still capture.
// A published version is immutable, so none of them should ever change.

export const HOUSEHOLD_SURVEY = "household_survey";

export const HOUSEHOLD_SURVEY_V1 = Object.freeze({
  formType: HOUSEHOLD_SURVEY,
  version: 1,
  title: "Household survey",
  fields: Object.freeze([
    Object.freeze({ key: "householdName", label: "Household name", type: "text", required: false }),
    Object.freeze({
      key: "memberCount",
      label: "Members in household",
      type: "number",
      required: false,
      min: 0,
      integer: true,
    }),
    Object.freeze({
      key: "childrenUnderFive",
      label: "Children under five",
      type: "number",
      required: false,
      min: 0,
      integer: true,
    }),
    Object.freeze({ key: "visitDate", label: "Visit date", type: "date", required: false }),
    Object.freeze({
      key: "waterSource",
      label: "Main water source",
      type: "select",
      required: false,
      options: Object.freeze(["Piped", "Handpump", "Well", "Tanker", "Other"]),
    }),
    Object.freeze({
      key: "notes",
      label: "Notes",
      type: "text",
      required: false,
      multiline: true,
    }),
  ]),
});
