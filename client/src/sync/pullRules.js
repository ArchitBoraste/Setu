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
    // classifyResolution() below, off the conflict's own lifecycle. Resolutions
    // for a window are applied BEFORE its record pages, so a row this reaches
    // is one that is still genuinely locked.
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
  // This phone's own dispute is over: take the server's copy whole, advance
  // syncedVersion to the server's version, and rejoin normal operation.
  ADOPT: "adopt",
  // Tell the worker what was decided, and change not one byte of the record.
  NOTIFY: "notify",
  // Nothing on this device to update, or nothing it has not already been told.
  SKIP: "skip",
};

// ---------------------------------------------------------------------------
// REPLAY SAFETY
//
// Every rule below has to give the right answer for a resolution this device
// has ALREADY applied, arriving again. That is not hypothetical. The sync
// cursor is per user, so a user's first sync on a phone — including every user
// on every phone once, when the per-user cursor replaced the per-device one —
// starts from the beginning and receives every resolution ever made about their
// records. Records survive that replay because classifyPulledRow() skips
// anything at or below syncedVersion. Resolutions have to be made to survive it
// here, and the two things that can go wrong are:
//
//   a stale ADOPT    an old resolution arriving while the row is locked for a
//                    NEWER conflict would unlock it — replacing the worker's
//                    copy and releasing the row while the dispute that actually
//                    locked it is still open in the supervisor's queue.
//
//   a stale NOTIFY   a notice the worker read and dismissed months ago would
//                    come back, and a row the decision deleted would reappear
//                    in their list with it.
//
// Both are answered from state the device already holds — syncedVersion — so
// replay safety needs no record of which resolutions have been seen, and holds
// for devices that were already in the field before this rule existed.
// ---------------------------------------------------------------------------

/**
 * Is this the resolution of the dispute THIS PHONE raised on this row?
 *
 * A conflicted row is locked by exactly one push: the one this device sent from
 * base = syncedVersion, which is frozen for as long as the row stays locked.
 * record_conflicts keeps that push's device_id and base_version, so the pair
 * names the dispute precisely:
 *
 *   another device's conflict about the same record   different device id
 *   an older conflict from this device, already        smaller base: adopting
 *   adopted — the replay case                           it moved syncedVersion
 *                                                       past its base, and a
 *                                                       later conflict can only
 *                                                       be raised from there
 *
 * Retries of one push are folded into one conflict row by the server, so a
 * device never has two open disputes with the same base.
 *
 * The limit, stated so it is not mistaken for complete: builds before the
 * step-12 toWire fix pushed a row pulled from another phone under THAT phone's
 * id. A conflict raised that way never matches here and the row stays locked.
 * It needs an old build, a pulled row, and a conflict raised on it.
 */
function isThisPhonesDispute(local, resolution, deviceId) {
  const submitted = resolution.submitted ?? {};
  return (
    typeof deviceId === "string" &&
    submitted.deviceId === deviceId &&
    submitted.baseVersion === (local.syncedVersion ?? 0)
  );
}

/**
 * Did this row hold the version the decision replaced — so the worker's copy on
 * this phone is what changed?
 *
 * superseded.version is the version the record carried immediately before the
 * resolution overwrote it. A row at or below it held that content, or older;
 * the decision is news here. A row above it has already been moved past the
 * decision — by the pull that carried it, on this phone, some earlier sync —
 * and telling the worker again is the stale-notice replay described above.
 *
 * kept_server replaced nothing, and resolutions made before migration 002 kept
 * no superseded copy; neither has a replaced version to compare with, so
 * neither announces itself to a phone that was not party to the dispute.
 */
function heldReplacedVersion(local, resolution) {
  const superseded = resolution.superseded;
  if (!superseded) return false;
  return local.syncedVersion != null && local.syncedVersion <= superseded.version;
}

/**
 * What a resolution arriving on this phone does to the local row.
 *
 * The unsent-work guarantee comes first and does not depend on the verdict: a
 * row holding work the server has not accepted is never adopted over. Fields of
 * the resolution are read only to NARROW what happens to a conflicted row —
 * never to widen it — so no value in a response can talk this into overwriting
 * a household visit that exists on one phone.
 *
 * @param {object|null} local       the Dexie row, or null
 * @param {object}      resolution  one entry from GET /api/sync/resolutions
 * @param {string}      deviceId    this install's id, from getDeviceId()
 */
export function classifyResolution(local, resolution, deviceId) {
  // A resolution for a record this device does not hold. The record itself
  // arrives through the ordinary pull if it is in scope. A fresh phone therefore
  // gets no notices for decisions made long before it existed — it never held
  // the versions they replaced.
  if (!local) return { action: RESOLUTION_ACTION.SKIP };

  if (
    local.syncState === SYNC_STATE.CONFLICT &&
    isThisPhonesDispute(local, resolution, deviceId)
  ) {
    // The row this whole mechanism exists for, and the only case that may move
    // syncedVersion on a locked row.
    return { action: RESOLUTION_ACTION.ADOPT };
  }

  // Everything else leaves the record exactly as it is.
  //
  //   PENDING or REJECTED  work the server has not accepted. Adopting would
  //                        overwrite a household visit that exists on one phone
  //                        to settle a dispute this row is not part of. The
  //                        next push carries its stale base, and the SERVER
  //                        decides, as the only party holding both copies.
  //
  //   CONFLICT, not ours   locked for a different dispute — another device's,
  //                        or an older one of ours already adopted. It stays
  //                        locked until ITS resolution arrives.
  //
  //   SYNCED               the new version arrives through the ordinary record
  //                        pull. But the worker is told when their copy was the
  //                        one replaced: a record silently becoming something
  //                        else on the phone of the person who walked to that
  //                        household is not acceptable.
  return heldReplacedVersion(local, resolution)
    ? { action: RESOLUTION_ACTION.NOTIFY }
    : { action: RESOLUTION_ACTION.SKIP };
}
