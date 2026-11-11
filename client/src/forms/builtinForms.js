// The forms this app can capture with before it has downloaded any.
//
// Only household_survey version 1: the form that was written into the capture
// screen before definitions existed, and the one migration 006 publishes in
// every organisation. A phone that has never synced — first start, offline —
// can therefore still capture, and its records are valid on the server,
// because this is that published version, field for field.
//
// It must stay identical to server/forms/householdSurveyV1.js; a client test
// compares the two. A published version never changes, so neither should this.

export const HOUSEHOLD_SURVEY = "household_survey";

export const HOUSEHOLD_SURVEY_V1 = Object.freeze({
  id: "builtin:household_survey:1",
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

export const BUILTIN_FORMS = Object.freeze([HOUSEHOLD_SURVEY_V1]);
