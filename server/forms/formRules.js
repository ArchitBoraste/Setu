// What a form definition may say, and whether a payload answers one.
//
// Pure functions over plain objects, like sync/pushRules.js and
// admin/adminRules.js: no Express, no MySQL. A wrong answer here does not throw
// — it refuses a household visit that should have been kept, or keeps one that
// the next reader cannot interpret — so every rule is tested with literals.
//
// A DEFINITION is { title, fields }, where each field is
//
//   { key, label, type, required, ...type-specific }
//
//   text    maxLength (optional, at most MAX_STRING_LENGTH), multiline (a
//           display hint: a textarea instead of a one-line input)
//   number  min, max (optional), integer (optional)
//   date    nothing more; the answer is a calendar date "YYYY-MM-DD"
//   select  options: the strings a worker chooses between; the answer is one
//   yesno   nothing more; the answer is true or false
//
// An unanswered field is null, or absent, for every type. "Nobody answered"
// and "answered zero / no" are different facts about a household.
//
// WHY A PAYLOAD IS CHECKED AGAINST THE VERSION IT CLAIMS, STRICTLY
//
// Before definitions existed the server accepted unknown form versions and
// unknown keys, because a phone could be ahead of the server and its answers
// were real data. That is no longer possible: a phone can only capture against
// a version the server published and sent it, and a published version never
// changes. So anything a payload says that its own version does not declare is
// not "a newer form" — it is a bug or a hand-made request, and the time to say
// so is at the push, while the worker still has the record in front of them.
//
// And checking each record against ITS version is what lets the form change at
// all. A select option dropped in version 3 does not invalidate the answers
// captured under version 2, because those are read against version 2.

import { Buffer } from "node:buffer";

export const FIELD_TYPES = Object.freeze(["text", "number", "date", "select", "yesno"]);

// ---------------------------------------------------------------------------
// Limits. The byte limits are the ones push has always enforced; they moved
// here with the payload check and are re-exported from sync/pushRules.js.
// ---------------------------------------------------------------------------

// Real UTF-8 bytes of the payload's JSON text — what the JSON column stores —
// not JavaScript string length. A Devanagari character is one UTF-16 unit and
// three UTF-8 bytes. Sized so a 65,536-character Devanagari payload fits.
export const MAX_PAYLOAD_UTF8_BYTES = 256 * 1024;
export const MAX_PAYLOAD_FIELDS = 200;
// UTF-16 units, the same unit an <input maxLength> counts, so a limit the
// browser enforced at capture is the limit checked here.
export const MAX_STRING_LENGTH = 10_000;

export const MAX_TITLE_LENGTH = 200; // form_definitions.title VARCHAR(200)
export const MAX_LABEL_LENGTH = 200;
export const MAX_OPTIONS = 100;
export const MAX_OPTION_LENGTH = 200;

// The same narrow shape records.form_type has always been held to.
export const FORM_TYPE_RE = /^[a-z0-9_]{1,64}$/;

// A key is stored inside every answer, for ever, so it is a plain identifier:
// a letter first, then letters, digits or underscores. camelCase is allowed
// because version 1's keys are camelCase. Starting with a letter also keeps
// "__proto__" and friends out.
export const FIELD_KEY_RE = /^[a-z][A-Za-z0-9_]{0,63}$/;

export const PAYLOAD_ERROR = {
  INVALID: "invalid_payload",
  TOO_LARGE: "too_large",
};

export const DEFINITION_ERROR = "invalid_definition";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Which properties each type may carry beyond key, label, type and required.
const TYPE_PROPS = {
  text: ["maxLength", "multiline"],
  number: ["min", "max", "integer"],
  date: [],
  select: ["options"],
  yesno: [],
};

const COMMON_PROPS = ["key", "label", "type", "required"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The key a loaded definition is filed under: one form type, one version. */
export function definitionKey(formType, version) {
  return `${formType}#${version}`;
}

// Keys and options come off the wire in a push; quoting one in a message that
// goes back to the device and into a log should not echo ten thousand bytes.
function quote(text) {
  return JSON.stringify(String(text).slice(0, 64));
}

// Code points, which is what VARCHAR(n) counts under utf8mb4.
function codePoints(text) {
  return [...text].length;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * One field, checked and normalised. Returns { value } or { errors }, where
 * each error is { prop, message } — the caller adds the field's position.
 *
 * Normalised means: label and options trimmed, required a real boolean, and
 * optional properties present only when they say something. Properties that do
 * not belong to the field's type are refused rather than dropped, so a builder
 * bug that sets a minimum on a text field is a message, not a silent loss.
 */
function checkField(field) {
  const errors = [];
  const fail = (prop, message) => errors.push({ prop, message });

  if (!isPlainObject(field)) {
    return { errors: [{ prop: null, message: "Each field must be an object." }] };
  }

  const { key, label, type, required } = field;

  if (typeof key !== "string" || !FIELD_KEY_RE.test(key)) {
    fail(
      "key",
      "Key must start with a lowercase letter and use only letters, digits and _ (at most 64)."
    );
  }

  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (cleanLabel === "") fail("label", "Label is required.");
  else if (codePoints(cleanLabel) > MAX_LABEL_LENGTH) {
    fail("label", `Label must be at most ${MAX_LABEL_LENGTH} characters.`);
  }

  if (!FIELD_TYPES.includes(type)) {
    fail("type", `Type must be one of ${FIELD_TYPES.join(", ")}.`);
    // Nothing type-specific can be judged without a type.
    return { errors };
  }

  if (required !== undefined && typeof required !== "boolean") {
    fail("required", "Required must be true or false.");
  }

  const allowed = new Set([...COMMON_PROPS, ...TYPE_PROPS[type]]);
  for (const prop of Object.keys(field)) {
    // null is how a builder says "not set", so it is tolerated anywhere.
    if (!allowed.has(prop) && field[prop] !== null && field[prop] !== undefined) {
      fail(prop, `"${prop}" does not apply to a ${type} field.`);
    }
  }

  const value = { key, label: cleanLabel, type, required: required === true };
  const isSet = (v) => v !== null && v !== undefined;

  if (type === "text") {
    if (isSet(field.maxLength)) {
      if (
        !Number.isInteger(field.maxLength) ||
        field.maxLength < 1 ||
        field.maxLength > MAX_STRING_LENGTH
      ) {
        fail("maxLength", `Maximum length must be a whole number from 1 to ${MAX_STRING_LENGTH}.`);
      } else {
        value.maxLength = field.maxLength;
      }
    }
    if (isSet(field.multiline)) {
      if (typeof field.multiline !== "boolean") {
        fail("multiline", "Multiline must be true or false.");
      } else if (field.multiline) {
        value.multiline = true;
      }
    }
  }

  if (type === "number") {
    for (const bound of ["min", "max"]) {
      if (!isSet(field[bound])) continue;
      if (typeof field[bound] !== "number" || !Number.isFinite(field[bound])) {
        fail(bound, `${bound === "min" ? "Minimum" : "Maximum"} must be a number.`);
      } else {
        value[bound] = field[bound];
      }
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      fail("max", "Maximum must not be less than the minimum.");
    }
    if (isSet(field.integer)) {
      if (typeof field.integer !== "boolean") {
        fail("integer", "Whole numbers only must be true or false.");
      } else if (field.integer) {
        value.integer = true;
      }
    }
  }

  if (type === "select") {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      fail("options", "A choice field needs at least one option.");
    } else if (field.options.length > MAX_OPTIONS) {
      fail("options", `A choice field may have at most ${MAX_OPTIONS} options.`);
    } else {
      const options = [];
      for (const option of field.options) {
        const text = typeof option === "string" ? option.trim() : "";
        if (text === "") {
          fail("options", "Options must not be empty.");
          break;
        }
        if (codePoints(text) > MAX_OPTION_LENGTH) {
          fail("options", `Each option must be at most ${MAX_OPTION_LENGTH} characters.`);
          break;
        }
        // The answer IS the option text, so two equal options would be two
        // buttons that store the same thing.
        if (options.includes(text)) {
          fail("options", `Option ${quote(text)} is listed twice.`);
          break;
        }
        options.push(text);
      }
      value.options = options;
    }
  }

  return errors.length > 0 ? { errors } : { value };
}

/**
 * A whole definition: { title, fields }.
 *
 * Returns { value: { title, fields } } with everything normalised, or
 *   { error: { reason, message, errors: [{ index, key, prop, message }] } }
 * listing EVERY problem, not just the first, so the builder can mark each
 * field at once. `index` is the field's position in the array sent (null for
 * the title or the list as a whole), which is how the screen finds the card.
 */
export function validateDefinition(definition) {
  const errors = [];

  if (!isPlainObject(definition)) {
    errors.push({ index: null, key: null, prop: null, message: "A form must be an object." });
    return failDefinition(errors);
  }

  const title = typeof definition.title === "string" ? definition.title.trim() : "";
  if (title === "") {
    errors.push({ index: null, key: null, prop: "title", message: "Title is required." });
  } else if (codePoints(title) > MAX_TITLE_LENGTH) {
    errors.push({
      index: null,
      key: null,
      prop: "title",
      message: `Title must be at most ${MAX_TITLE_LENGTH} characters.`,
    });
  }

  const { fields } = definition;
  if (!Array.isArray(fields) || fields.length === 0) {
    errors.push({ index: null, key: null, prop: "fields", message: "A form needs at least one field." });
    return failDefinition(errors);
  }
  if (fields.length > MAX_PAYLOAD_FIELDS) {
    errors.push({
      index: null,
      key: null,
      prop: "fields",
      message: `A form may have at most ${MAX_PAYLOAD_FIELDS} fields.`,
    });
    return failDefinition(errors);
  }

  const clean = [];
  const seen = new Map(); // key -> first index
  fields.forEach((field, index) => {
    const key = isPlainObject(field) && typeof field.key === "string" ? field.key : null;
    const checked = checkField(field);
    if (checked.errors) {
      for (const error of checked.errors) errors.push({ index, key, ...error });
    } else {
      clean.push(checked.value);
    }
    // Reported on the second occurrence, which is the one the admin just added.
    if (key !== null && FIELD_KEY_RE.test(key)) {
      if (seen.has(key)) {
        errors.push({
          index,
          key,
          prop: "key",
          message: `Key ${quote(key)} is already used by field ${seen.get(key) + 1}.`,
        });
      } else {
        seen.set(key, index);
      }
    }
  });

  if (errors.length > 0) return failDefinition(errors);
  return { value: { title, fields: clean } };
}

function failDefinition(errors) {
  return {
    error: {
      reason: DEFINITION_ERROR,
      message:
        errors.length === 1
          ? errors[0].message
          : `This form has ${errors.length} problems. Each is shown next to what it concerns.`,
      errors,
    },
  };
}

/**
 * A key keeps its type for ever, across every version of one form type.
 *
 * Reports are read across versions — "how many households have piped water"
 * reads waterSource from version 1 and version 4 alike — and that only works if
 * waterSource means the same kind of thing in both. A key removed in version 3
 * and brought back in version 5 is the same key, so it is checked against every
 * published version, not just the latest.
 *
 * Options, labels, required and ranges may change: each record is validated
 * against its own version, so old answers stay valid.
 *
 * @param {Array<{version, fields}>} published  every published version
 * @param {Array} fields                         the draft's fields, validated
 * @returns {Array<{index, key, prop, message}>} empty when every key is stable
 */
export function checkKeyStability(published, fields) {
  const errors = [];
  const ordered = [...published].sort((a, b) => a.version - b.version);

  fields.forEach((field, index) => {
    for (const earlier of ordered) {
      const before = earlier.fields.find((f) => f.key === field.key);
      if (before && before.type !== field.type) {
        errors.push({
          index,
          key: field.key,
          prop: "type",
          message:
            `Key ${quote(field.key)} was a ${before.type} field in version ${earlier.version}. ` +
            `A key keeps its type for ever, so give a ${field.type} field a new key.`,
        });
        break;
      }
    }
  });

  return errors;
}

/** The highest published version, or null when there is none. */
export function latestPublished(published) {
  return published.reduce(
    (latest, def) => (latest === null || def.version > latest.version ? def : latest),
    null
  );
}

/**
 * What publishing a draft writes: the definition as validated, under the next
 * version number. Every rule is re-checked here, under the publish lock, even
 * though a draft is checked when it is saved — the published set it was
 * checked against may have moved since.
 *
 * @param {object} args
 * @param {object} args.draft      { title, fields }
 * @param {Array}  args.published  every published version of the same form type
 */
export function planPublish({ draft, published }) {
  const checked = validateDefinition(draft);
  if (checked.error) return checked;

  const unstable = checkKeyStability(published, checked.value.fields);
  if (unstable.length > 0) return failDefinition(unstable);

  const latest = latestPublished(published);
  return {
    value: {
      title: checked.value.title,
      fields: checked.value.fields,
      version: latest === null ? 1 : latest.version + 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

// new Date() reads a date-only ISO string as UTC midnight, so a real date
// round-trips exactly. The round trip is what refuses an impossible one: V8
// rolls "2026-02-30" forward to 2 March rather than rejecting it.
function isCalendarDate(text) {
  if (!ISO_DATE_RE.test(text)) return false;
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** Why one answer does not fit its field, or null. Never quotes the answer. */
function checkAnswer(field, value) {
  const name = `field ${quote(field.key)}`;

  switch (field.type) {
    case "text": {
      if (typeof value !== "string") return `${name} must be text, not a ${typeof value}`;
      const limit = Math.min(field.maxLength ?? MAX_STRING_LENGTH, MAX_STRING_LENGTH);
      if (value.length > limit) return `${name} is longer than ${limit} characters`;
      if (field.required && value.trim() === "") return `${name} is required`;
      return null;
    }
    case "number": {
      if (typeof value !== "number") return `${name} must be a number, not a ${typeof value}`;
      // JSON cannot carry NaN or Infinity, but a non-JSON caller can, and both
      // would land in the column as an invented measurement.
      if (!Number.isFinite(value)) return `${name} must be a finite number`;
      if (field.integer && !Number.isInteger(value)) return `${name} must be a whole number`;
      if (field.min !== undefined && value < field.min) {
        return `${name} must be at least ${field.min}`;
      }
      if (field.max !== undefined && value > field.max) {
        return `${name} must be at most ${field.max}`;
      }
      return null;
    }
    case "date":
      return typeof value === "string" && isCalendarDate(value)
        ? null
        : `${name} must be a date written as YYYY-MM-DD`;
    case "select":
      // Membership is checked against THIS version's options. An answer from a
      // list that has since grown or shrunk is read against the version that
      // offered it, so it is never refused for a later edit to the list.
      return typeof value === "string" && field.options.includes(value)
        ? null
        : `${name} must be one of the options this form version offers`;
    case "yesno":
      return typeof value === "boolean" ? null : `${name} must be yes (true) or no (false)`;
    default:
      return `${name} has a type this server does not know`;
  }
}

/**
 * Do these answers fit this definition?
 *
 * Returns { value: { payload, payloadText } } — payloadText being the exact
 * JSON that is stored — or { error: { reason, message, field? } }.
 *
 * Messages name the field but never quote the value: a rejection is logged
 * and shown on screen, and the value is a real household's data. A problem is
 * a rejection, never a throw: one malformed record is one worker's problem,
 * not a reason to fail the other records in the batch.
 *
 * @param {object} definition  { formType, version, fields }
 * @param {*}      payload
 */
export function validatePayload(definition, payload) {
  const fail = (message, field, reason = PAYLOAD_ERROR.INVALID) => ({
    error: { reason, message, ...(field ? { field } : {}) },
  });

  if (!isPlainObject(payload)) return fail("payload must be an object");

  const keys = Object.keys(payload);
  // Before anything walks the keys, so a body with a million of them costs
  // one comparison.
  if (keys.length > MAX_PAYLOAD_FIELDS) {
    return fail(
      `payload has more than ${MAX_PAYLOAD_FIELDS} fields`,
      null,
      PAYLOAD_ERROR.TOO_LARGE
    );
  }

  // A Map, not an object lookup: a key such as "constructor" must not find
  // something on Object.prototype and pass as declared.
  const fields = new Map(definition.fields.map((field) => [field.key, field]));
  const form = `form ${definition.formType} version ${definition.version}`;

  for (const key of keys) {
    if (!fields.has(key)) return fail(`field ${quote(key)} is not part of ${form}`, key);
  }

  for (const field of definition.fields) {
    const value = Object.hasOwn(payload, field.key) ? payload[field.key] : null;
    if (value === null) {
      if (field.required) return fail(`field ${quote(field.key)} is required`, field.key);
      continue;
    }
    const problem = checkAnswer(field, value);
    if (problem) return fail(problem, field.key);
  }

  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_UTF8_BYTES) {
    return fail(
      `payload is larger than ${MAX_PAYLOAD_UTF8_BYTES} bytes`,
      null,
      PAYLOAD_ERROR.TOO_LARGE
    );
  }

  return { value: { payload, payloadText: text } };
}
