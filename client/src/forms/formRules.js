// Which form definition a screen uses, and how answers move between a form on
// screen and a stored payload. Pure functions over plain objects — no Dexie, no
// React — so the choices that decide whether a record stays readable are tested
// with literals.
//
// A "catalog" is the list of published definitions this device holds for the
// signed-in user's organisation (see forms/formStore.js): rows of
// { formType, version, title, fields }.
//
// PAYLOAD VALUE RULE (extends the one documented above createRecord in
// records/recordService.js): numbers are JSON numbers, dates are "YYYY-MM-DD",
// text and choices are strings, yes/no is true or false, and an unanswered
// field is null. Coercion happens here, where the definition says which field
// is which; the server checks the same rules again (server/forms/formRules.js)
// and is the authority. The checks below exist so a worker hears about a
// problem while they are still at the household, not at the next sync.

import { BUILTIN_FORMS, HOUSEHOLD_SURVEY } from "./builtinForms.js";

// The form the capture screen collects. One form type for now; the builder
// can version it, and other types can be published, but capture asks for this.
export const CAPTURE_FORM_TYPE = HOUSEHOLD_SURVEY;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** This exact version of this form, from the catalog or the built-in copy. */
export function findDefinition(catalog, formType, version) {
  const cached = catalog.find((def) => def.formType === formType && def.version === version);
  if (cached) return cached;
  // Only an exact (type, version) match, never "the nearest version": the
  // built-in copy IS the published version 1, so using it is not a guess.
  return BUILTIN_FORMS.find((def) => def.formType === formType && def.version === version) ?? null;
}

/** The highest version of a form the device has, or the built-in one. */
export function latestDefinition(catalog, formType) {
  const versions = catalog.filter((def) => def.formType === formType);
  const pool = versions.length > 0 ? versions : BUILTIN_FORMS.filter((def) => def.formType === formType);
  return pool.reduce((latest, def) => (latest === null || def.version > latest.version ? def : latest), null);
}

/**
 * Which definition a capture screen should use.
 *
 *   NEW record   the latest published version of the form. With nothing
 *                downloaded yet, the built-in version 1, which is still a
 *                published version the server accepts.
 *   EDIT         the record's OWN version, exactly. An old record stays on the
 *                form it was captured with, so its answers stay valid and it is
 *                never silently moved onto fields it was not asked.
 *
 * Returns { definition, builtin } or { missing: { formType, version } } when
 * that version is not on this device. Missing is reported, never patched over
 * with a different version: editing a version-3 record against version 2's
 * fields would drop or mislabel answers.
 *
 * @param {object} args
 * @param {Array}  args.catalog   published definitions on this device
 * @param {string} [args.formType] for a new record
 * @param {object} [args.record]   for an edit: { formType, formVersion }
 */
export function chooseDefinition({ catalog, formType = CAPTURE_FORM_TYPE, record = null }) {
  if (record) {
    const definition = findDefinition(catalog, record.formType, record.formVersion);
    if (!definition) {
      return { missing: { formType: record.formType, version: record.formVersion } };
    }
    return { definition, builtin: !catalog.includes(definition) };
  }

  const definition = latestDefinition(catalog, formType);
  if (!definition) return { missing: { formType, version: null } };
  return { definition, builtin: !catalog.includes(definition) };
}

// ---------------------------------------------------------------------------
// Form state <-> payload
//
// Inputs hold strings. Yes/no is held as "yes" / "no" / "" so a select can
// show "not answered" — a required yes/no starts unanswered rather than
// pre-ticked, because a default answer is an answer nobody gave.
// ---------------------------------------------------------------------------

export function emptyValues(definition) {
  return Object.fromEntries(definition.fields.map((field) => [field.key, ""]));
}

export function isPristine(values) {
  return Object.values(values ?? {}).every((value) => value === "");
}

/** A stored payload as the form shows it. Keys not in the definition are not shown. */
export function toFormValues(definition, payload) {
  const values = emptyValues(definition);
  for (const field of definition.fields) {
    const value = payload?.[field.key];
    if (value === null || value === undefined) continue;
    if (field.type === "yesno") values[field.key] = value === true ? "yes" : value === false ? "no" : "";
    else values[field.key] = String(value);
  }
  return values;
}

/**
 * What the form says, as a payload: every key of the definition, unanswered as
 * null. A number that does not parse is kept as NaN so checkAnswers reports it
 * rather than it quietly becoming "unanswered".
 */
export function toPayload(definition, values) {
  const payload = {};
  for (const field of definition.fields) {
    const raw = values?.[field.key];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      payload[field.key] = null;
    } else if (field.type === "number") {
      payload[field.key] = Number(text);
    } else if (field.type === "yesno") {
      payload[field.key] = text === "yes" ? true : text === "no" ? false : null;
    } else {
      // Text keeps what was typed, trimmed. Dates arrive as "YYYY-MM-DD" from
      // <input type="date">; choices as the option text.
      payload[field.key] = text;
    }
  }
  return payload;
}

/**
 * Problems a worker can fix, by field key: {} when there are none. The same
 * rules the server applies, phrased for the person at the household.
 */
export function checkAnswers(definition, payload) {
  const problems = {};
  for (const field of definition.fields) {
    const value = payload?.[field.key] ?? null;
    if (value === null) {
      if (field.required) problems[field.key] = "Required.";
      continue;
    }
    const problem = checkOne(field, value);
    if (problem) problems[field.key] = problem;
  }
  return problems;
}

function checkOne(field, value) {
  switch (field.type) {
    case "text": {
      if (typeof value !== "string") return "Must be text.";
      if (field.required && value.trim() === "") return "Required.";
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `At most ${field.maxLength} characters.`;
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a number.";
      if (field.integer && !Number.isInteger(value)) return "Must be a whole number.";
      if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}.`;
      if (field.max !== undefined && value > field.max) return `Must be at most ${field.max}.`;
      return null;
    }
    case "date": {
      if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return "Must be a date.";
      const parsed = new Date(value);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
        ? null
        : "Must be a real date.";
    }
    case "select":
      return field.options.includes(value) ? null : "Choose one of the options.";
    case "yesno":
      return typeof value === "boolean" ? null : "Choose yes or no.";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Reading a payload back: labels, values, a one-line summary
// ---------------------------------------------------------------------------

/** One answer, for reading. A field nobody answered is "—", never blank. */
export function formatValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean" || field?.type === "yesno") {
    return value === true ? "Yes" : value === false ? "No" : String(value);
  }
  return String(value);
}

/**
 * The rows of a comparison of payloads: every key either side holds, each
 * with the label and field of the first definition that declares it.
 *
 * Ordered as the definitions order their fields, so a comparison reads in the
 * order the worker was asked; keys no definition declares (a version this
 * device does not have) follow, by name rather than hidden.
 *
 * @param {Array<object>}        payloads
 * @param {Array<object|null>}   definitions  in order of preference
 * @returns {Array<{ key, label, field }>}
 */
export function describeFields(payloads, definitions) {
  const present = new Set();
  for (const payload of payloads) {
    for (const key of Object.keys(payload ?? {})) present.add(key);
  }

  const rows = [];
  const placed = new Set();
  for (const definition of definitions) {
    for (const field of definition?.fields ?? []) {
      if (!present.has(field.key) || placed.has(field.key)) continue;
      rows.push({ key: field.key, label: field.label, field });
      placed.add(field.key);
    }
  }
  for (const key of present) {
    if (!placed.has(key)) rows.push({ key, label: key, field: null });
  }
  return rows;
}

/**
 * A record in one line: its first one-line text answer as a title, then the
 * first two other answers that were given, dates first.
 *
 * Without the record's definition the keys are all there is, so the first
 * text value stands in for a title and nothing is labelled.
 */
export function summarise(payload, definition) {
  if (!definition) {
    const firstText = Object.values(payload ?? {}).find((v) => typeof v === "string" && v !== "");
    return firstText ?? "(no name)";
  }

  const titleField = definition.fields.find((f) => f.type === "text" && !f.multiline);
  const title = (titleField && payload?.[titleField.key]) || "(no name)";

  const rest = definition.fields
    .filter((f) => f !== titleField && !(f.type === "text" && f.multiline))
    .filter((f) => payload?.[f.key] !== null && payload?.[f.key] !== undefined && payload?.[f.key] !== "")
    .sort((a, b) => (a.type === "date" ? 0 : 1) - (b.type === "date" ? 0 : 1))
    .slice(0, 2)
    // Only the leading date goes unlabelled: it reads as "when", but a second
    // bare date beside it ("2026-11-10 · 2026-12-01") would not say which is
    // the visit and which the follow-up.
    .map((f, i) =>
      f.type === "date" && i === 0
        ? formatValue(f, payload[f.key])
        : `${f.label}: ${formatValue(f, payload[f.key])}`
    );

  return [title, ...rest].join(" · ");
}
