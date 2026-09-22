// The decision half of POST /api/conflicts/:id/resolve, kept away from Express
// and MySQL for the same reason pushRules.js and pullRules.js are: this is where
// a person decides which version of a household's answers is true, and the
// branch that writes the wrong one destroys the other. Pure functions over plain
// objects can be called with three literals and asserted on.
//
// ---------------------------------------------------------------------------
// RESOLUTION IS ONLINE-ONLY, AND DELIBERATELY SO.
//
// There is no offline path to this, no queued resolution, no Dexie table of
// pending decisions. It is a privileged write, consistent with the earlier
// decision that admin actions do not happen offline, and the reason is not
// convenience.
//
// A conflict is already the record of two devices disagreeing from a shared
// ancestor. Let two supervisors resolve the same conflict from two offline
// phones and the result is a conflict ABOUT a conflict: two closures of one
// dispute, each with its own resolution, resolver and timestamp, each claiming
// to be the decision — and nothing in the version ladder can order them, because
// the ladder tracks the record, not the argument about it. Resolving that would
// need a second, separate reconciliation model layered on the first, and the
// thing it would be reconciling is human judgement, which does not merge.
//
// So the server is the only place a conflict closes. A supervisor with no signal
// can read the queue if it is already on screen and can decide nothing, which is
// the correct failure: nothing is lost, and both copies are still whole. Capture
// stays offline-first and untouched — no field worker's path to saving a
// household visit passes through here.
// ---------------------------------------------------------------------------

import { REJECT_REASON, validatePayload } from "./pushRules.js";

// The three decisions, matching the record_conflicts.resolution ENUM exactly.
export const RESOLUTION = {
  // The stored row was right. The losing copy stays filed, unapplied.
  KEPT_SERVER: "kept_server",
  // The losing copy was right. It becomes the record's new current version.
  KEPT_CLIENT: "kept_client",
  // Neither was right on its own. The supervisor assembled one from both.
  MERGED: "merged",
};

export const RESOLVE_ERROR = {
  INVALID: "invalid_resolution",
  PAYLOAD: REJECT_REASON.PAYLOAD,
};

/**
 * What a resolution does to `records`, decided before anything is written.
 *
 * Returns { value: { resolution, write } } where `write` is null when the record
 * is not to be touched, or the exact columns to set when it is. The version and
 * timestamp rules are the push route's, not new ones: version + 1, and an
 * explicitly written updated_at, so a resolved record travels to other devices
 * through the ordinary delta window like any other change.
 *
 * @param {object} args
 * @param {string} args.resolution     kept_server | kept_client | merged
 * @param {object} args.conflict       { formType, formVersion, payload }
 * @param {object} args.record         { formType, formVersion, version }
 * @param {object} args.mergedPayload  the supervisor's assembled payload, for merged
 */
export function planResolution({ resolution, conflict, record, mergedPayload }) {
  const fail = (message, reason = RESOLVE_ERROR.INVALID) => ({
    error: { reason, message },
  });

  if (!Object.values(RESOLUTION).includes(resolution)) {
    return fail(
      `resolution must be one of ${Object.values(RESOLUTION).join(", ")}`
    );
  }

  if (resolution === RESOLUTION.KEPT_SERVER) {
    // Nothing is written to `records`: the stored row already says what the
    // supervisor decided, and writing a version that changes nothing would spend
    // a version number and a fresh updated_at to say "no change" — dragging the
    // row through every other device's next pull for no reason.
    //
    // This is why closing a conflict cannot be announced through the record
    // alone. A kept_server resolution leaves updated_at where it was, so the row
    // falls into no future delta window, and the device whose copy lost would
    // wait forever for news that structurally cannot arrive. That device learns
    // about it from GET /api/sync/resolutions instead, which is keyed on the
    // conflict's own lifecycle rather than the record's.
    return { value: { resolution, write: null } };
  }

  if (resolution === RESOLUTION.KEPT_CLIENT) {
    // The losing copy brings its own form identity with it. A payload is only
    // interpretable next to the form revision that produced it, so promoting the
    // answers while leaving the record labelled with a different form_version
    // would make them unreadable later in exactly the way form_version exists to
    // prevent.
    //
    // Not re-validated. This payload passed validatePayload on the push that
    // filed it and has been in a JSON column ever since; re-checking it against
    // today's rules would let a later tightening make an already-collected
    // household visit permanently unchoosable — the supervisor would be blocked
    // from picking the only other copy that exists.
    return {
      value: {
        resolution,
        write: {
          formType: conflict.formType,
          formVersion: conflict.formVersion,
          payload: conflict.payload,
          payloadText: JSON.stringify(conflict.payload),
          version: record.version + 1,
        },
      },
    };
  }

  // MERGED. New content arriving from a client, so it is validated exactly as a
  // pushed payload is — the same function, no second, looser set of rules for
  // privileged callers.
  //
  // Checked against the RECORD's form identity, not the conflict's, because a
  // merged payload is a new answer assembled by a supervisor rather than a
  // capture from either device, and the record's current revision is the one
  // every device will read it under. Where the losing copy came from a newer
  // build and carried fields this revision does not declare, they survive:
  // validatePayload deliberately does not reject undeclared keys, for the reason
  // written out beside fieldTypesFor().
  const payload = validatePayload(record.formType, record.formVersion, mergedPayload);
  if (payload.error) {
    return { error: payload.error };
  }

  return {
    value: {
      resolution,
      write: {
        formType: record.formType,
        formVersion: record.formVersion,
        payload: payload.value.payload,
        payloadText: payload.value.payloadText,
        version: record.version + 1,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WHAT A RESOLUTION DELIBERATELY DOES NOT DECIDE: whether the record exists.
//
// deleted_at is never touched here. record_conflicts stores the losing payload,
// its form identity and its versions — but not the `deleted` flag the push
// carried, so the server genuinely does not know whether the copy that lost was
// an edit or a deletion. A resolution that moved deleted_at would therefore be
// guessing at a worker's intent, and guessing wrong either resurrects a
// household that withdrew consent or destroys a visit that happened.
//
// So a resolution decides CONTENT and nothing else, and the tombstone survives
// it unchanged, exactly as it does through a re-push. A supervisor who needs to
// delete or undelete does it as an ordinary write afterwards, where the act is
// explicit and attributable on its own.
// ---------------------------------------------------------------------------
