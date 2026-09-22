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
    // are not reading a server version that has since moved on. Resolving is
    // step 12's job and is deliberately not done here — and the local payload,
    // version and syncedVersion are all left exactly as they are.
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
