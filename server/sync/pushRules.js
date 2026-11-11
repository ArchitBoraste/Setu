// The decision half of POST /api/sync/push, kept away from Express and MySQL.
//
// Everything here is a pure function over plain objects, because this is the one
// part of sync that is hard to get right and impossible to eyeball inside a
// route handler: it decides whether a household visit is written, held back for
// a human, or thrown away. Separated like this it can be called with three
// literals and asserted on.

import { canSeeRecord } from "./scopeRules.js";
import {
  FORM_TYPE_RE,
  PAYLOAD_ERROR,
  definitionKey,
  validatePayload,
} from "../forms/formRules.js";

// ---------------------------------------------------------------------------
// Limits
//
// The byte ceiling is the global express.json({ limit: "5mb" }) in index.js — a
// route-level parser cannot tighten it, because the global one has already run
// by the time this router is reached. So the caps that matter here are on COUNT
// and on per-record size, which together bound what one device can send.
//
// The per-record payload limits moved to forms/formRules.js with the payload
// check itself, and are re-exported here because this is where callers and
// tests have always found them.
// ---------------------------------------------------------------------------
export const MAX_BATCH_RECORDS = 200;

export {
  MAX_PAYLOAD_FIELDS,
  MAX_PAYLOAD_UTF8_BYTES,
  MAX_STRING_LENGTH,
} from "../forms/formRules.js";
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
  // The same codes validatePayload returns, so its errors pass through as-is.
  PAYLOAD: PAYLOAD_ERROR.INVALID,
  TOO_LARGE: PAYLOAD_ERROR.TOO_LARGE,
  // The form version the record claims is not a published version of this
  // organisation's form: never published, or still a draft.
  UNKNOWN_FORM: "unknown_form",
  UNKNOWN_RECORD: "unknown_record",
  VERSION_AHEAD: "version_ahead",
  FORBIDDEN: "forbidden",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// Envelope validation
//
// FORM VERSION POLICY: a record must claim a PUBLISHED version of one of its
// organisation's forms, and its answers must fit that version exactly.
//
// This used to be the opposite — any well-formed version was stored, and only
// the versions the server happened to know were checked — because a phone
// could be ahead of the server, and refusing its answers would have destroyed
// field data. Form definitions removed that case. A phone captures only
// against versions the server published and sent it, and a published version
// never changes or disappears, so every version a legitimate phone can claim is
// one the server can check. A version it does not know is a hand-made request
// or a bug, and the time to say so is the push, while the worker who captured
// the record still has it in front of them.
//
// A draft is refused by name, apart from "not published", because it is the
// one mistake an admin can make on purpose and should be told about plainly.
//
// Payload rules live in forms/formRules.js. The definitions are loaded once
// per push batch by the route and handed in, so this stays a pure function.
// ---------------------------------------------------------------------------

function isPositiveInt(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * @param {*}   item         one record off the wire
 * @param {Map} definitions  definitionKey(formType, version) -> the organisation's
 *                           definition row { formType, version, status, fields },
 *                           drafts included so a draft can be named as one
 */
export function validateEnvelope(item, definitions) {
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

  // Checked after the shape, so the lookup only ever sees a well-formed pair.
  const form = `form ${item.formType} version ${item.formVersion}`;
  const definition = definitions?.get(definitionKey(item.formType, item.formVersion));
  if (!definition) {
    return fail(`${form} is not published on the server`, REJECT_REASON.UNKNOWN_FORM);
  }
  if (definition.status !== "published") {
    return fail(`${form} is a draft, not a published form`, REJECT_REASON.UNKNOWN_FORM);
  }

  const payload = validatePayload(definition, item.payload);
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
// ---------------------------------------------------------------------------
// Who may write a stored row
// ---------------------------------------------------------------------------

/**
 * May this caller change a row the server already holds?
 *
 * Exactly the rows they may see — see scopeRules.js. Supervisors and admins
 * correct and remove records across their organisation. A field worker updates
 * or deletes records in their own area, which is what lets two workers covering
 * one village keep a household's record current between them, and any record
 * with no area that they captured themselves. Creating is not decided here: a
 * new row has no stored copy to be scoped by, and the server gives it the
 * creator's own area.
 *
 * Phones are shared and a stolen token is a real thing, so this is re-checked
 * per row rather than assumed from the fact that the row reached a device.
 * `actor` comes from the verified JWT plus a fresh read of the user's area;
 * the request body is never consulted.
 *
 * @param {object} actor   { id, role, organizationId, areaId }
 * @param {object} stored  { organizationId, areaId, createdBy }
 */
export function mayWrite(actor, stored) {
  return canSeeRecord(actor, stored);
}

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
