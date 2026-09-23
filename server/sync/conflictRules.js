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

// What a resolution does to whether the record exists. Kept apart from the
// answers because the two are decided on different evidence: the answers by a
// supervisor's choice, existence by what the losing push is KNOWN to have been.
export const EXISTENCE = {
  // Leave deleted_at exactly as it is.
  KEEP: "keep",
  // Make the record a tombstone (keeping an existing tombstone's time).
  DELETE: "delete",
  // Clear deleted_at: the household is back in the register.
  RESTORE: "restore",
};

export const RESOLVE_ERROR = {
  INVALID: "invalid_resolution",
  PAYLOAD: REJECT_REASON.PAYLOAD,
};

/**
 * The record's content immediately before a resolution overwrites it.
 *
 * Written into record_conflicts.superseded_* in the same transaction as the
 * overwrite. Without it the version a resolution replaces exists nowhere:
 * `records` keeps no history, every device holding that version is synced and
 * overwrites its own copy on the next pull, and record_conflicts.payload holds
 * the OTHER side — the push that lost. That is how a supervisor's single click
 * used to destroy a worker's accepted answers with no copy left anywhere.
 *
 * Form identity travels with the payload because kept_client adopts the losing
 * copy's form revision, so the replaced answers may belong to a different one.
 */
function snapshotOf(record) {
  return {
    version: record.version,
    formType: record.formType,
    formVersion: record.formVersion,
    payload: record.payload,
    payloadText: JSON.stringify(record.payload),
  };
}

/**
 * What a resolution does to `records`, decided before anything is written.
 *
 * Returns { value: { resolution, write, superseded } }:
 *
 *   write       null when the record is not to be touched, or the exact columns
 *               to set when it is. The version and timestamp rules are the push
 *               route's, not new ones: version + 1, and an explicitly written
 *               updated_at, so a resolved record travels to other devices
 *               through the ordinary delta window like any other change.
 *               `write.existence` is one of EXISTENCE: whether the record
 *               becomes a tombstone, is restored, or keeps its deleted_at.
 *
 *   superseded  what the record held before `write` replaces it, to be kept in
 *               record_conflicts. Null exactly when `write` is null: nothing
 *               replaced, nothing to keep.
 *
 * @param {object} args
 * @param {string} args.resolution     kept_server | kept_client | merged
 * @param {object} args.conflict       { formType, formVersion, payload, submittedDeleted }
 *                                     submittedDeleted is 1, 0 or null (not recorded)
 * @param {object} args.record         { formType, formVersion, payload, version }
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
    return { value: { resolution, write: null, superseded: null } };
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
    //
    // And the losing copy's EXISTENCE comes with it, when it is known. "Keep
    // the worker's version" means the whole of what the worker sent: a deletion
    // takes the household out of the register, a live edit puts it back in.
    // When nobody recorded which it was, existence is left alone — see the note
    // at the foot of this file.
    return {
      value: {
        resolution,
        write: {
          formType: conflict.formType,
          formVersion: conflict.formVersion,
          payload: conflict.payload,
          payloadText: JSON.stringify(conflict.payload),
          version: record.version + 1,
          existence: existenceFromLosingPush(conflict.submittedDeleted),
        },
        superseded: snapshotOf(record),
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
        // A merge never changes whether the record exists. See the note at the
        // foot of this file for why, now that keep-worker can restore.
        existence: EXISTENCE.KEEP,
      },
      superseded: snapshotOf(record),
    },
  };
}

/**
 * Keep-worker's effect on existence, from what record_conflicts RECORDED about
 * the losing push.
 *
 * mysql2 hands a TINYINT(1) back as a number, so the checks are against 1 and 0
 * exactly: anything else — NULL, above all — is "not recorded", and does nothing.
 */
function existenceFromLosingPush(submittedDeleted) {
  if (submittedDeleted === 1) return EXISTENCE.DELETE;
  if (submittedDeleted === 0) return EXISTENCE.RESTORE;
  return EXISTENCE.KEEP;
}

// ---------------------------------------------------------------------------
// WHEN A RESOLUTION DECIDES WHETHER THE RECORD EXISTS — AND WHEN IT DOES NOT.
//
// kept_client — keep the worker's version, the WHOLE of it, including whether
// it was a deletion. record_conflicts.submitted_deleted (migration 003) says
// what is known about that:
//
//   1      the worker's push was a deletion. The record becomes a tombstone; if
//          it already was one, it keeps the moment it was first raised, the push
//          route's rule, so a device that applied the earlier deletion does not
//          see it as a newer event.
//
//   0      the worker's push was a live edit. deleted_at is cleared: if the
//          server had deleted the record, the household is back in the register
//          with the worker's answers. This is the outcome that did not exist
//          before 003 — a server deletion met by a worker's live edit could only
//          ever end deleted, whichever button the supervisor pressed.
//
//   NULL   not recorded (filed before 002, or a 0 from before 003). deleted_at
//          is left EXACTLY as it is. Treating an unknown as "live, so restore"
//          would resurrect a household on the strength of a missing value — the
//          one outcome here that can put a family that withdrew consent back in
//          the register. An unknown must be able to do nothing.
//
// kept_server — the server's copy stands whole, existence included. Nothing is
// written.
//
// merged — NEVER changes existence, even now that keep-worker can restore.
//
//   A merge is the supervisor assembling ANSWERS, field by field, from two
//   copies. Whether the household stays in the register is not an answer, and
//   the merge editor never asks about it. Letting either side's existence ride
//   along would decide it without the supervisor ever being shown it as a
//   choice — silently restoring a household that withdrew consent because a
//   field came from the worker's side, or silently keeping one deleted because
//   another came from the server's.
//
//   So existence is decided only by the two resolutions that take one copy
//   WHOLE, and whose preview states the consequence before it happens:
//   kept_server keeps the server's, kept_client takes the worker's. A supervisor
//   who wants the household restored AND answers from both sides cannot do that
//   in one step today; the review screen says so, and points at keep-worker.
//   Giving the merge editor an explicit, stated existence choice would close
//   that — as its own decision, not an inference.
// ---------------------------------------------------------------------------
