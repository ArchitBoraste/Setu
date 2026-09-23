// The decision half of POST /api/sync/push, kept away from Express and MySQL.
//
// Everything here is a pure function over plain objects, because this is the one
// part of sync that is hard to get right and impossible to eyeball inside a
// route handler: it decides whether a household visit is written, held back for
// a human, or thrown away. Separated like this it can be called with three
// literals and asserted on.

import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Limits
//
// The byte ceiling is the global express.json({ limit: "5mb" }) in index.js — a
// route-level parser cannot tighten it, because the global one has already run
// by the time this router is reached. So the caps that matter here are on COUNT
// and on per-record size, which together bound what one device can send.
// ---------------------------------------------------------------------------
export const MAX_BATCH_RECORDS = 200;

// Real UTF-8 bytes of the payload's JSON text — what the JSON column stores —
// not JavaScript string length. The two differ by up to 3x for exactly the
// text this app exists to collect: a Devanagari character is one UTF-16 unit
// and three UTF-8 bytes. Sized so a 65,536-character Devanagari payload
// (about 196 KB) still fits.
export const MAX_PAYLOAD_UTF8_BYTES = 256 * 1024;
export const MAX_PAYLOAD_FIELDS = 200;
export const MAX_STRING_LENGTH = 10_000;
export const MAX_FORM_TYPE_LENGTH = 64; // matches records.form_type VARCHAR(64)
export const MAX_FORM_VERSION = 10_000;

// ---------------------------------------------------------------------------
// The device_id stamped on a version written by a CONFLICT RESOLUTION.
//
// records.device_id is not decoration. It is the discriminator the idempotency
// rule below turns on: "a device still sending base = N has never been told
// N+1, so if that same device is named as the author of N+1, its own earlier
// push landed and the response was lost." That premise holds for every version
// a push writes, because only a push can advance a version — until now.
//
// A resolution breaks it. The supervisor writes N+1 from the server, and the
// device that authored N is never told. Left with its own id on the row, that
// device — which is SYNCED, not conflicted, and perfectly free to keep editing
// — would push base = N, be read as its own echo, and ACCEPT: a supervisor's
// decision about someone's data silently overwritten, no conflict raised, no
// trace. That is the worst outcome this step can produce, so the row says
// plainly that no device wrote it.
//
// The nil UUID is safe as that marker because it cannot collide with a real
// device: every id getDeviceId() mints is a v4 UUID, which always carries a 4
// in the version nibble. It is nonetheless REFUSED on the wire by
// validateEnvelope, because it matches the UUID shape and a client claiming it
// would walk straight back into the echo path it exists to close.
// ---------------------------------------------------------------------------
export const RESOLVED_DEVICE_ID = "00000000-0000-0000-0000-000000000000";

export const PUSH_OUTCOME = {
  INSERT: "insert",
  ACCEPT: "accept",
  REPLAY: "replay",
  CONFLICT: "conflict",
  REJECT: "reject",
};

// Reason codes, not sentences. The client shows these to a worker and may one
// day branch on them, and a code survives being reworded.
export const REJECT_REASON = {
  ENVELOPE: "invalid_envelope",
  PAYLOAD: "invalid_payload",
  TOO_LARGE: "too_large",
  UNKNOWN_RECORD: "unknown_record",
  VERSION_AHEAD: "version_ahead",
  FORBIDDEN: "forbidden",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deliberately narrow: lowercase identifiers only, so a form type can never
// carry whitespace, punctuation, or anything that reads as markup downstream.
const FORM_TYPE_RE = /^[a-z0-9_]{1,64}$/;

// The only two shapes a date may take: a calendar date, or that date with a
// time of day (seconds, fraction and offset optional). The groups capture the
// date and each clock field so isRealDate can range-check them.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))?$/;

/**
 * Stable JSON: object keys sorted, at every depth.
 *
 * Needed because MySQL does not store a JSON document as the text it was given.
 * It normalises it, and object keys come back ordered by key length and then by
 * value, not in insertion order. A plain JSON.stringify comparison against the
 * stored copy would therefore report "changed" for a payload that is character
 * for character the same data — which would turn every retry into a fresh write
 * and defeat the idempotency rule below.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Payload validation
//
// The rule being enforced is the one documented above createRecord() in
// client/src/records/recordService.js: numbers as JSON numbers, an unanswered
// field as null, dates as ISO 8601 strings, text and choices as strings.
//
// That rule is applied at capture, where the form knows which field is a count
// and which is free text. Enforcing it again here needs the same knowledge, so
// the checking happens at two levels:
//
//   every value     must be null, a finite number, or a string. This holds for
//                   all forms, known or not, and is what stops an object, an
//                   array or a boolean reaching a column.
//
//   declared field  additionally checked against its type below, which is what
//                   catches "5" where a count belongs. A leaf-type check alone
//                   cannot: a numeric string is a perfectly legal string.
//
// A type violation is a rejection, never a throw. One malformed record is one
// worker's problem, not a reason to fail the other 49 records in the batch.
// ---------------------------------------------------------------------------

/**
 * What the server knows about the forms it has seen. Keyed by form type, then by
 * form version, because a field's TYPE is a property of one revision of a form —
 * that is the whole reason payloads are stored beside a form_version.
 *
 * This is a stand-in for the form builder's registry in a later step, not a
 * second source of truth: it declares types only, never labels or options.
 */
const FORM_FIELD_TYPES = {
  household_survey: {
    1: {
      householdName: "string",
      memberCount: "number",
      childrenUnderFive: "number",
      visitDate: "date",
      waterSource: "string",
      notes: "string",
    },
  },
};

// Two things this deliberately does NOT do, because both would turn a routine
// client change into a total collection outage in the field:
//
//   unknown keys are not rejected. A build that adds a field and forgets to bump
//   the form version would otherwise have every push from every device refused,
//   and nobody finds out until a supervisor asks why the week is empty. An
//   undeclared key still faces the leaf-type check and is stored.
//
//   choice values are not checked for membership. Option lists are edited far
//   more often than field types, and an answer of "Borewell" collected before the
//   list grew is a real answer from a real household, not a validation error.
function fieldTypesFor(formType, formVersion) {
  return FORM_FIELD_TYPES[formType]?.[formVersion] ?? null;
}

function validateDeclaredField(key, value, type) {
  // Unanswered is null for every type. "Nobody answered" and "answered zero" are
  // different facts about a household, and only one of them is a measurement.
  if (value === null) return null;

  if (type === "number") {
    return typeof value === "number"
      ? null
      : `field "${key}" must be a number, not a ${typeof value}`;
  }
  if (type === "date") {
    return typeof value === "string" && isRealDate(value)
      ? null
      : `field "${key}" must be an ISO 8601 date string`;
  }
  return typeof value === "string"
    ? null
    : `field "${key}" must be a string, not a ${typeof value}`;
}

/**
 * A strict ISO 8601 date or date-time that names a moment which exists.
 *
 * Date.parse is never the judge of shape. V8 accepts almost anything — "5" is a
 * day in 2001, "09/22/2026" is a US-style date — so a string must match one of
 * the two ISO shapes above before its values are even looked at.
 */
function isRealDate(text) {
  if (ISO_DATE_RE.test(text)) return isCalendarDate(text);

  const parts = ISO_DATETIME_RE.exec(text);
  if (!parts) return false;

  const [, date, hours, minutes, seconds = "00", offsetHours = "00", offsetMinutes = "00"] =
    parts;
  // Checked by hand rather than by parsing: V8 rolls "24:00" over into the next
  // day instead of refusing it, the same way it rolls impossible dates forward.
  return (
    isCalendarDate(date) &&
    Number(hours) <= 23 &&
    Number(minutes) <= 59 &&
    Number(seconds) <= 59 &&
    Number(offsetHours) <= 23 &&
    Number(offsetMinutes) <= 59
  );
}

// new Date() reads a date-only ISO string as UTC midnight, so a real date
// round-trips exactly. The round trip is what refuses an impossible one: V8
// does not reject "2026-02-30" but rolls it forward to 2 March, and only a
// month that cannot exist at all, such as "2026-13-01", fails to parse.
function isCalendarDate(text) {
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validatePayloadValue(key, value) {
  if (value === null) return null;

  if (typeof value === "number") {
    // JSON itself cannot carry NaN or Infinity, but a hand-built body and any
    // future non-JSON transport can, and both would land in the column as NULL
    // or 0 — a measurement invented by the parser.
    return Number.isFinite(value) ? null : `field "${key}" must be a finite number`;
  }

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return `field "${key}" is longer than ${MAX_STRING_LENGTH} characters`;
    }
    // Only strings SHAPED like an ISO date are date-checked. Free text that
    // matches "2026-09-22" exactly is a date in every real form, and a note that
    // merely contains a date is untouched by these anchors.
    if (
      (ISO_DATE_RE.test(value) || ISO_DATETIME_RE.test(value)) &&
      !isRealDate(value)
    ) {
      return `field "${key}" is not a valid ISO 8601 date`;
    }
    return null;
  }

  // Booleans, objects and arrays are absent from the rule on purpose. Adding one
  // is a change to the capture coercion, to this check, and to every stored row
  // — exactly the kind of change that should not happen by accident.
  return `field "${key}" must be null, a number or a string`;
}

export function validatePayload(formType, formVersion, payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      error: { reason: REJECT_REASON.PAYLOAD, message: "payload must be an object" },
    };
  }

  const keys = Object.keys(payload);
  if (keys.length > MAX_PAYLOAD_FIELDS) {
    return {
      error: {
        reason: REJECT_REASON.TOO_LARGE,
        message: `payload has more than ${MAX_PAYLOAD_FIELDS} fields`,
      },
    };
  }

  const declared = fieldTypesFor(formType, formVersion);

  for (const key of keys) {
    // Messages name the field but never quote the value: a rejection is logged
    // and shown on screen, and the value is a real household's data.
    const problem =
      validatePayloadValue(key, payload[key]) ??
      (declared?.[key]
        ? validateDeclaredField(key, payload[key], declared[key])
        : null);
    if (problem) {
      return { error: { reason: REJECT_REASON.PAYLOAD, message: problem } };
    }
  }

  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_UTF8_BYTES) {
    return {
      error: {
        reason: REJECT_REASON.TOO_LARGE,
        message: `payload is larger than ${MAX_PAYLOAD_UTF8_BYTES} bytes`,
      },
    };
  }

  return { value: { payload, payloadText: text } };
}

// ---------------------------------------------------------------------------
// Envelope validation
//
// FORM VERSION POLICY: the server accepts and stores any well-formed
// form_version. It does not reject versions it "does not know".
//
// Two reasons, in order of weight.
//
// 1. Rejecting would destroy field data. A phone can be three releases behind
//    for a month — no signal, no store, no charger. Its records are household
//    visits that have already happened. Refusing them leaves those rows pending
//    on a device forever, and a device is a thing that gets lost, wiped, or
//    handed to the next worker. An unknown form version is a reason to read a
//    payload carefully; it is never a reason to lose it.
//
// 2. The server does not interpret payloads on push. It stores the answers
//    beside the form_version that produced them, which is precisely what makes
//    them interpretable later. Validation of MEANING belongs at read and report
//    time, where the reader can load the matching form definition — and there is
//    no form registry on this server to validate against today in any case.
//
// The same argument runs in both directions: a version NEWER than anything the
// server has seen is also stored, because a device ahead of the server is the
// normal state during a staged rollout.
//
// What is still enforced is SHAPE — a positive integer within a sane bound — so
// a tampered or corrupt value cannot reach the column.
//
// Knowing a form version is therefore not a gate but a LEVEL OF SCRUTINY. A
// payload from a version in FORM_FIELD_TYPES is checked field by field; one from
// a version the server has never heard of still has to pass the leaf-type check
// and is then stored verbatim beside the version that produced it. Accepting
// less than the server understands is the whole point: the alternative is
// deciding that data collected on an older build never happened.
// ---------------------------------------------------------------------------

function isPositiveInt(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

export function validateEnvelope(item) {
  const fail = (message, reason = REJECT_REASON.ENVELOPE) => ({
    error: { reason, message },
  });

  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return fail("record must be an object");
  }
  if (typeof item.id !== "string" || !UUID_RE.test(item.id)) {
    return fail("id must be a UUID");
  }
  if (typeof item.deviceId !== "string" || !UUID_RE.test(item.deviceId)) {
    return fail("deviceId must be a UUID");
  }
  // The nil UUID matches the shape above, so it has to be refused by name. It
  // marks a version written by a conflict resolution, and a push claiming it
  // would be read as the echo of a write no device made — which is exactly the
  // overwrite RESOLVED_DEVICE_ID exists to prevent.
  if (item.deviceId === RESOLVED_DEVICE_ID) {
    return fail("deviceId is reserved");
  }
  if (typeof item.formType !== "string" || !FORM_TYPE_RE.test(item.formType)) {
    return fail(
      `formType must match [a-z0-9_] and be at most ${MAX_FORM_TYPE_LENGTH} characters`
    );
  }
  if (!isPositiveInt(item.formVersion, MAX_FORM_VERSION)) {
    return fail("formVersion must be a positive integer");
  }
  // null means "this row has never been accepted by the server", which is the
  // insert case. Anything else must be a non-negative integer.
  if (item.baseVersion !== null && item.baseVersion !== undefined) {
    if (!Number.isInteger(item.baseVersion) || item.baseVersion < 0) {
      return fail("baseVersion must be null or a non-negative integer");
    }
  }
  // A boolean, not a timestamp. The client is authoritative on WHETHER a row was
  // deleted and never on WHEN: deleted_at, like created_at and updated_at, is
  // written by this server's clock. Taking a boolean makes that structural
  // rather than a convention someone has to remember to apply.
  if (typeof item.deleted !== "boolean") {
    return fail("deleted must be a boolean");
  }

  // Checked after formType and formVersion, because which fields are declared —
  // and therefore how strictly the payload is read — depends on both.
  const payload = validatePayload(item.formType, item.formVersion, item.payload);
  if (payload.error) return payload;

  return {
    value: {
      id: item.id,
      deviceId: item.deviceId,
      formType: item.formType,
      formVersion: item.formVersion,
      baseVersion: item.baseVersion ?? null,
      deleted: item.deleted,
      payload: payload.value.payload,
      payloadText: payload.value.payloadText,
    },
  };
}

// ---------------------------------------------------------------------------
// The three-way comparison
//
// The rule is the one documented above record_conflicts in db/schema.sql, with
// one case that comment does not cover: the retry.
//
// IDEMPOTENCY
//
// The failure this is built for is not a crash. It is the server committing a
// push and the response never arriving — a worker on one bar of 2G loses the
// answer, not the request. The device, having heard nothing, sends the same
// push again.
//
// That retry is indistinguishable, on its face, from a collision. It arrives
// with base = N while the server now stores N+1, which is the exact signature of
// "somebody else wrote in between". Answered naively, a sync that SUCCEEDED
// raises a conflict, and a worker is asked to reconcile a household visit
// against their own copy of it. That is worse than the lost response: it teaches
// workers that conflicts are noise, and it fills step 12's queue with rows
// colliding with themselves.
//
// What tells the two apart is WHO made the write the client has not seen.
//
//   records.device_id holds the device of the last ACCEPTED write. A version
//   only ever advances on an accept, and an accept requires base ==
//   records.version — so it can only come from a device the server has already
//   told that version to. A device still sending base = N has never been told
//   N+1. If that same device is nonetheless named as the author of N+1, there is
//   exactly one way it got there: its own earlier push landed, and the response
//   was lost on the way back.
//
//   stored.deviceId === incoming.deviceId therefore is not a collision. There is
//   no second party to it. It is this device hearing its own echo.
//
//   stored.deviceId !== incoming.deviceId is the real thing: another phone
//   edited the same household from the same ancestor, both sides changed it, and
//   a human has to say which is true. Filed as a conflict.
//
// Within the echo case, the payloads decide what to do:
//
//   identical   A pure retry. Return the STORED version and timestamp and write
//               NOTHING. Writing would spend a version and a fresh updated_at on
//               every retry, and updated_at is the delta cursor — a device stuck
//               retrying would drag the same row through every other device's
//               pull, indefinitely. Idempotent has to mean N retries leave ONE
//               version behind, not N.
//
//   different   The worker edited the row again after the response was lost. The
//               server's copy is this device's own earlier state, so there is
//               still no second party: accept, and move to version + 1.
//
// This also covers the retried CREATE with no special case. A lost response to
// an insert leaves the device at baseVersion null (= 0) against a stored version
// of 1 written by itself — the same ladder, the same answer.
//
// The limit of the rule, stated plainly so it is not mistaken for a proof:
// device_id remembers one writer, not a history. If device A's write is later
// built on by device B (B pulled A's version, then pushed), and only THEN A
// retries, A sees B as the last writer and gets a conflict. That is the
// conservative answer — a human reads it — and it costs a false conflict only in
// the narrow window where a retry outlives another device's edit.
//
// What this deliberately does NOT use: a new column, a new table, or an
// idempotency key on the wire. Those are the textbook answer and would be
// cleaner. The shape `records` already carries — device_id beside version —
// answers the question, and that schema is applied on the live database.
// ---------------------------------------------------------------------------

function sameContent(stored, incoming) {
  return (
    stored.formType === incoming.formType &&
    stored.formVersion === incoming.formVersion &&
    stored.deleted === incoming.deleted &&
    canonicalJson(stored.payload) === canonicalJson(incoming.payload)
  );
}

/**
 * @param {number|null} baseVersion  last version the SERVER confirmed to this client
 * @param {object|null} stored       { version, deviceId, formType, formVersion, payload, deleted }
 * @param {object}      incoming     { deviceId, formType, formVersion, payload, deleted }
 */
export function classifyPush(baseVersion, stored, incoming) {
  // A row that has never synced sends null. Folding it to 0 puts the insert on
  // the same ladder as every other comparison instead of beside it.
  const base = baseVersion ?? 0;

  if (!stored) {
    // Deletes are soft, so the server never drops a row. "I edited from version
    // N" about a row that is not here is a claim the server cannot have made.
    if (base > 0) {
      return { outcome: PUSH_OUTCOME.REJECT, reason: REJECT_REASON.UNKNOWN_RECORD };
    }
    return { outcome: PUSH_OUTCOME.INSERT, version: 1 };
  }

  if (base === stored.version) {
    return { outcome: PUSH_OUTCOME.ACCEPT, version: stored.version + 1 };
  }

  if (base > stored.version) {
    // A version this server never issued: a bug on the device, a restored
    // backup, or a tampered body. Overwrite nothing.
    return { outcome: PUSH_OUTCOME.REJECT, reason: REJECT_REASON.VERSION_AHEAD };
  }

  // base < stored.version — see the idempotency note above.
  //
  // The echo rule does not apply to a version a SUPERVISOR wrote. Such a version
  // carries RESOLVED_DEVICE_ID precisely so this branch cannot claim it, because
  // "the only way this device is named as the author of a version it was never
  // told about is its own lost response" is false when the author was a person
  // resolving a conflict on the server. Falling through to CONFLICT is the
  // conservative answer: a human already decided this row once, and a device
  // that never saw that decision does not get to undo it unseen.
  if (stored.deviceId !== RESOLVED_DEVICE_ID && stored.deviceId === incoming.deviceId) {
    if (sameContent(stored, incoming)) {
      return { outcome: PUSH_OUTCOME.REPLAY, version: stored.version };
    }
    return { outcome: PUSH_OUTCOME.ACCEPT, version: stored.version + 1 };
  }

  return { outcome: PUSH_OUTCOME.CONFLICT, version: stored.version };
}
