import { SYNC_STATE } from "../records/syncState.js";

// What to do with one pulled row, given whatever this device already holds for
// that id.
//
// Pure, and in its own module, because this is the only place in the app where
// getting a decision wrong destroys collected data rather than merely annoying
// somebody. A worker's unsent household visit exists on exactly one phone, in
// exactly one row, and every branch below that says "overwrite" is a branch that
// can end it. It is separated from the Dexie writes so the table can be read as
// a table, and tested with plain objects.

export const PULL_ACTION = {
  // No local row: take the server's copy as-is.
  INSERT: "insert",
  // Local row agrees with the server: take the newer copy.
  OVERWRITE: "overwrite",
  // Local row holds work the server has not got. Change nothing at all.
  KEEP_LOCAL: "keep_local",
  // Local row is already in conflict: refresh the server copy shown beside it,
  // and resolve nothing.
  REFRESH_CONFLICT: "refresh_conflict",
  // The server deleted a row this device has unsent edits for. Raise it.
  DELETE_CONFLICT: "delete_conflict",
  // Already applied; the row arrived again inside an overlapping window.
  SKIP: "skip",
};

// States meaning "this device is holding something the server has not accepted".
// PENDING is waiting to be pushed; REJECTED was refused and is waiting for a
// worker to edit it. Neither is a copy of anything on the server, so neither can
// be recreated if it is overwritten.
function hasUnsentWork(local) {
  return (
    local.syncState === SYNC_STATE.PENDING || local.syncState === SYNC_STATE.REJECTED
  );
}

/**
 * @param {object|null} local   the Dexie row, or null
 * @param {object}      remote  the row as the server returned it
 */
export function classifyPulledRow(local, remote) {
  if (!local) {
    // Includes tombstones for rows this device never had. Storing them costs a
    // soft-deleted row that nothing renders, and skipping them would leave the
    // device unable to tell "never seen" from "deleted elsewhere" — which
    // matters the moment undelete exists, since the push route already allows
    // it. Pruning old tombstones is a separate job for a later step.
    return { action: PULL_ACTION.INSERT };
  }

  if (hasUnsentWork(local)) {
    // THE TOMBSTONE CASE.
    //
    // A supervisor deleted this record while the worker was holding an edit
    // they had not managed to send. Both of the obvious answers are wrong:
    //
    //   apply the delete   destroys the only copy of that visit. The worker
    //                      walked to a household, sat with a family, and the
    //                      record disappears off their phone with no trace that
    //                      it ever existed. This is the harm the whole project
    //                      is built to prevent.
    //
    //   ignore the delete  silently overrides a deliberate act. Records get
    //                      deleted because a household withdrew consent, or was
    //                      entered twice, or was the wrong family — and the
    //                      device would push the row straight back, undoing the
    //                      deletion without telling anybody it had.
    //
    // So neither side decides. The row is raised as a conflict, which preserves
    // both facts — the worker's edit and the server's deletion — and hands the
    // choice to a person, which is what step 12 exists for.
    //
    // The property that makes this safe rather than merely undecided: CONFLICT
    // is not PENDING, and the push queue selects only PENDING rows. Moving the
    // row here takes it out of the push queue, so the device will NOT recreate
    // the deleted record on the server while the question is open. It stops the
    // resurrection without destroying the work.
    if (remote.deletedAt !== null) {
      return { action: PULL_ACTION.DELETE_CONFLICT };
    }

    // An ordinary edit landing on top of unsent local work.
    //
    // Nothing is touched — not the payload, not syncState, and above all not
    // syncedVersion. That last one is the trap. syncedVersion is the base the
    // next push sends, and the server reads it as "the version this worker
    // edited from". Advancing it here would make the next push claim a base it
    // never saw; the server would compare base == stored.version, accept it, and
    // overwrite the other device's edit with no conflict raised and no record
    // that anything was lost. Leaving it alone means the push arrives with a
    // stale base and the SERVER raises the conflict — which is right, because the
    // server is the only party holding both copies and the device id needed to
    // tell a real collision from this device's own echo.
    //
    // Push runs before pull, so a row should rarely still be pending here. It
    // happens when the push failed: no signal, a rejected batch, a 4xx.
    return { action: PULL_ACTION.KEEP_LOCAL };
  }

  if (local.syncState === SYNC_STATE.CONFLICT) {
    // Refresh what the comparison view shows beside the worker's copy, so they
    // are not reading a server version that has since moved on — and resolve
    // NOTHING. The local payload, version and syncedVersion are all left exactly
    // as they are.
    //
    // A resolved record arriving here still takes this branch, and that is
    // correct. The record alone cannot say whether the disagreement was settled:
    // a kept_server resolution writes nothing to the record at all, so "the
    // version moved" and "a person decided" are different facts and only one of
    // them travels on this feed. Leaving conflict state is driven by
    // classifyResolution() below, off the conflict's own lifecycle, and the
    // resolution is applied after this page so it has the last word.
    return { action: PULL_ACTION.REFRESH_CONFLICT };
  }

  // SYNCED. The device has no changes of its own, so the server's copy is simply
  // newer. This is the ordinary path and the one that carries deletions.
  //
  // The version check is not an optimisation. Windows can overlap — a retried
  // pull, a cursor that did not advance because the last page never arrived —
  // and rewriting a row this device already holds would churn localUpdatedAt and
  // shuffle the worker's list under them for no reason.
  if (local.syncedVersion !== null && remote.version <= local.syncedVersion) {
    return { action: PULL_ACTION.SKIP };
  }

  return { action: PULL_ACTION.OVERWRITE };
}

// ---------------------------------------------------------------------------
// THE DEADLOCK EXIT
//
// A conflicted row is frozen on purpose. Its syncedVersion is never advanced —
// not by push, which never accepted it, and not by pull, which deliberately
// leaves it alone above — so its base stays permanently stale; and CONFLICT is
// not PENDING, so the push queue cannot pick it up. Those two facts together are
// what stop the row colliding with itself forever, and they are also what make
// the state permanent without something to end it.
//
// A resolution is that something. It is the ONLY thing that may advance
// syncedVersion on a conflicted row, because it is the only event that means
// "the two copies are no longer in dispute" — a person looked at both and said
// which one stands.
// ---------------------------------------------------------------------------

export const RESOLUTION_ACTION = {
  // The row is in conflict and the dispute is over: take the server's copy
  // whole, advance syncedVersion to the server's version, and rejoin normal
  // operation.
  ADOPT: "adopt",
  // Tell the worker what was decided, and change not one byte of the record.
  NOTIFY: "notify",
  // Nothing on this device to update.
  SKIP: "skip",
};

/**
 * Takes the LOCAL row and nothing else, deliberately.
 *
 * Which way the supervisor decided does not appear here, and must not: whether
 * this device may overwrite what it is holding is a question about this device's
 * unsent work, not about the verdict. A rule that read the resolution could be
 * talked into adopting over a pending row by the right value arriving in a
 * response, and the row it would overwrite is a household visit that exists on
 * one phone.
 *
 * @param {object|null} local  the Dexie row, or null
 */
export function classifyResolution(local) {
  // A resolution for a record this device does not hold. It may have been
  // wiped, or belong to another worker on a shared phone. The record itself
  // arrives through the ordinary pull if it is in scope; there is nothing here
  // to reconcile.
  if (!local) return { action: RESOLUTION_ACTION.SKIP };

  if (local.syncState === SYNC_STATE.CONFLICT) {
    // The row this whole mechanism exists for.
    return { action: RESOLUTION_ACTION.ADOPT };
  }

  // NOT in conflict — and the record is emphatically not touched here.
  //
  // Two ways to arrive:
  //
  //   PENDING or REJECTED  this device holds work the server has not accepted.
  //                        Adopting would overwrite a household visit that
  //                        exists on exactly one phone, in exactly one row, to
  //                        settle a dispute this row is not part of. The
  //                        ordinary push/pull machinery already handles it: the
  //                        next push carries its stale base and the SERVER
  //                        decides, which is right, because the server is the
  //                        only party holding both copies.
  //
  //   SYNCED               this device agrees with the server, so there is
  //                        nothing to adopt — the new version arrives through
  //                        the normal record pull in this same window. But the
  //                        worker is told anyway, and that is the point of this
  //                        branch: when a supervisor keeps another device's copy
  //                        or merges one, the record changes under the worker
  //                        who captured it. A record silently becoming something
  //                        else, on the phone of the person who walked to that
  //                        household, is not acceptable.
  return { action: RESOLUTION_ACTION.NOTIFY };
}
