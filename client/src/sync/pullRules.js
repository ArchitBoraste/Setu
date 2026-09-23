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
  // The server deleted a record this device holds unsent work for. Keep the
  // work queued exactly as it is and note the deletion beside it; the next push
  // raises the conflict ON THE SERVER, where it can be resolved.
  KEEP_LOCAL_DELETED: "keep_local_deleted",
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
    //   ignore the delete  overrides a deliberate act without anybody seeing.
    //                      Records get deleted because a household withdrew
    //                      consent, or was entered twice, or was the wrong
    //                      family.
    //
    // So neither side decides here, and — this is the part that changed — the
    // DEVICE does not declare a conflict either. It used to: the row was moved to
    // CONFLICT on the spot. But a conflict the server has no row for is one no
    // supervisor can see and no resolution can ever close, and since conflicted
    // rows became read-only that lock was permanent — around a household visit
    // that existed on this phone and nowhere else.
    //
    // The lock was also never what protected the deletion. The server's version
    // comparison is. This row's push carries base = syncedVersion, which predates
    // the deletion, so it arrives BEHIND the tombstone. An accept needs either
    // base == stored.version, which it is not, or the echo rule — which needs
    // this phone to be the tombstone's author, and a phone cannot author a
    // deletion while holding a live unsent edit to the same row, because nothing
    // on it can undelete. A tombstone written by a resolution carries
    // RESOLVED_DEVICE_ID, which the echo rule refuses outright. Every such push
    // is therefore filed as a conflict: a real record_conflicts row, in the
    // supervisor's queue, resolvable three ways like any other — keeping the
    // deletion among them.
    //
    // So the work stays queued exactly as it is, and the tombstone is noted
    // beside it so the worker is told. Nothing loops: the row only becomes
    // CONFLICT when the server files one, and from then on it is read-only.
    //
    // Why the push has not already raised it: sync pushes before it pulls, so in
    // the ordinary case it has. The row reaches this branch only when that push
    // did not land — it failed, or the worker edited the row while it was in the
    // air — or when the row was REJECTED, in which case it waits for the worker
    // to fix it and then goes the same way.
    if (remote.deletedAt !== null) {
      return { action: PULL_ACTION.KEEP_LOCAL_DELETED };
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

// ---------------------------------------------------------------------------
// ROWS ALREADY STUCK IN THE OLD LOCK
//
// Phones running a build from step 12 up to this fix may hold rows the pull
// moved to CONFLICT with no conflict on the server. The v6 Dexie upgrade flags
// every row that COULD be one (legacyDeletionLock), and each sync releases the
// flagged rows still locked once its resolutions have been applied.
//
// "Could be", because the flag is not proof. The old lock left a row exactly as
// a real conflict does — CONFLICT, with the server's tombstone beside it — and a
// real conflict filed against a deleted record looks the same. Releasing a real
// one is harmless: its re-push carries the same device, base and payload, and
// fileConflict folds it back into the open conflict it already has. That is also
// why the release waits for the resolutions half: a real conflict already
// RESOLVED on the server is adopted there and loses the flag, instead of being
// re-pushed into a second dispute after a supervisor has already decided.
// ---------------------------------------------------------------------------

/**
 * The state a flagged, still-locked row returns to, or null to leave it alone.
 *
 * Back to the state the lock took it from. A REJECTED row goes back to REJECTED:
 * its payload was refused, and pushing it would only be refused again — it
 * waits for the worker to fix it, and then escalates like any other. The lock
 * never cleared syncError, while a push that files a real conflict always does,
 * so a syncError on a locked row is how a REJECTED origin is recognised.
 * Anything else goes back to PENDING, into the push queue, where the next push
 * files it on the server.
 *
 * @param {object|null} local  the Dexie row, or null
 */
export function releaseLegacyDeletionLock(local) {
  if (!local || local.syncState !== SYNC_STATE.CONFLICT || !local.legacyDeletionLock) {
    return null;
  }
  return local.syncError ? SYNC_STATE.REJECTED : SYNC_STATE.PENDING;
}

// ---------------------------------------------------------------------------
// THE CURSOR AND THE SCOPE IT WAS ADVANCED IN
//
// A cursor says "every row in ONE SET, changed up to here, is on this device".
// Which set is decided by the server — the organisation for a supervisor, an
// area for a field worker — and it can change under a device that has done
// nothing: a worker moved to another village keeps the same user id, the same
// phone and the same cursor. A window starting at that cursor would skip every
// row of the new village that changed before it — silently, and for good.
//
// So the cursor is stored WITH the scope key it was advanced in, the device
// sends both, and the server honours the cursor only if the key is still that
// user's scope (sinceForScope in server/sync/pullRules.js); otherwise it reads
// from the beginning and says which scope it served. The device then stamps the
// new cursor with THAT key.
//
// Keyed like this rather than by (user, area) on the device, because the device
// is precisely the party that does not know it was moved until the server
// tells it. A cursor chosen by the device's idea of its own area would be the
// stale one on exactly the sync that matters. It also covers what an area key
// would not: a promotion to supervisor, a move between organisations, and a
// worker with no area at all.
//
// One cursor per user, not one per scope. Moving back to a village worked
// before starts that window from the beginning again rather than resuming an
// old cursor — one full pull, in exchange for never having to argue that a
// cursor left behind months ago is still sound.
// ---------------------------------------------------------------------------

/**
 * The stored cursor, or null for "read from the beginning".
 *
 * Cursors written before scopes existed are bare strings. They name no scope,
 * so no scope can vouch for them, and they are read as absent: one full pull,
 * which REPLAY SAFETY above makes harmless.
 */
export function readCursor(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof value.until === "string" &&
    typeof value.scope === "string"
  ) {
    return { until: value.until, scope: value.scope };
  }
  return null;
}

/**
 * Where the window this sync read actually started, given the scope the server
 * says it served. The device's own view of what it asked for is not enough: a
 * cursor from another scope was ignored by the server, and the window began at
 * the epoch.
 */
export function windowStart(cursor, servedScopeKey) {
  return cursor !== null && cursor.scope === servedScopeKey ? cursor.until : null;
}

// Facts about a record only the server holds for certain, which do not change
// what the record SAYS: its area (fixed at first insert) and the names shown
// beside it.
const SERVER_METADATA_FIELDS = ["areaId", "createdByName", "updatedByName"];

/**
 * What to copy from a pulled row onto a synced local row the pull otherwise
 * SKIPS because this device already holds that version — or null.
 *
 * A row can reach its current version without those facts: pulled by a build
 * from before they existed, or captured here and pushed, when the device only
 * guessed the area. Skipping by version alone would leave those rows filed
 * under the wrong area, and hidden from the worker they belong to, until the
 * record next changed.
 *
 * Payload, version and sync state are never part of this. A value the server
 * does not have (null) never replaces one the device has.
 */
export function pulledMetadataPatch(local, remote) {
  const patch = {};
  for (const field of SERVER_METADATA_FIELDS) {
    const value = remote[field];
    if (value !== null && value !== undefined && local[field] !== value) {
      patch[field] = value;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
