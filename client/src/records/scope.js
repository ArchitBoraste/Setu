import { SYNC_STATE } from "./syncState.js";

// Who may SEE a local row, and whose turn it is to SEND a change to it.
//
// These used to be one question with one answer — "the worker who created it" —
// and every read, edit and push was scoped by createdBy. Once more than one
// person can change a record, they come apart:
//
//   seeing   is about the signed-in user's scope. A supervisor sees the whole
//            organisation; a field worker sees their area, plus any record
//            with no area that they captured themselves — the server's rule,
//            in server/sync/scopeRules.js.
//
//   sending  is about who made the change waiting to go out. A supervisor's
//            edit to a worker's record is the supervisor's to push, under the
//            supervisor's token. Selecting the push queue by createdBy would
//            leave that edit on the phone forever — or, on a shared phone,
//            send it under the worker's identity the next time they sign in.
//
// Pure, with no Dexie, so both rules can be tested with plain objects. These
// decide only what the device RENDERS and which rows it OFFERS; the server
// re-checks every write against the verified token.

const ORGANISATION_ROLES = new Set(["supervisor", "admin"]);

export function seesWholeOrganisation(user) {
  return ORGANISATION_ROLES.has(user?.role);
}

/**
 * May the signed-in user see this row on this device?
 *
 * Phones are shared, so one IndexedDB can hold rows pulled for several people —
 * a supervisor's whole organisation, or two villages' worth when workers from
 * each use the same phone. Every list, count and edit goes through this rather
 * than trusting that a row on the device is a row for whoever is holding it. A
 * worker must never be shown another area's households just because a
 * colleague's sync put them in the same IndexedDB.
 *
 * `user.areaId` is the area the server last reported: at sign-in, and again on
 * every sync.
 */
export function canSeeRecord(row, user) {
  if (!row || !user) return false;
  if (row.organizationId !== user.organizationId) return false;
  if (seesWholeOrganisation(user)) return true;
  // A row with no area is visible to its creator only. `!= null` also covers
  // rows stored before areas existed, which have no areaId field at all.
  if (row.areaId != null) return row.areaId === user.areaId;
  return row.createdBy === user.userId;
}

/** Work the server has not accepted: pending, refused, or held in a conflict. */
export function isUnsynced(row) {
  return row.syncState !== SYNC_STATE.SYNCED;
}

/**
 * Should THIS user's sync send this row?
 *
 * By lastEditedBy — who made the change waiting to go out — and never by
 * createdBy. Visibility is deliberately not required: a worker moved to
 * another area still owns the capture they made before the move, and the
 * server, not this device, decides whether it is accepted.
 */
export function belongsToPushQueue(row, user) {
  return (
    Boolean(row && user) &&
    row.syncState === SYNC_STATE.PENDING &&
    row.lastEditedBy === user.userId
  );
}

export const EDIT_BLOCK = {
  // Two versions already in dispute. See assertEditable in recordService.js.
  CONFLICT: "conflict",
  // Someone else on this phone changed the row and has not sent it yet.
  OTHER_EDITOR: "other_editor",
};

/**
 * Why the signed-in user may not change this row right now, or null.
 *
 * OTHER_EDITOR is the shared-phone case. Editing on top of a colleague's unsent
 * change would fold their work into this user's version and send it under this
 * user's name, and the colleague's own push would then collide with it. The
 * row waits for the person whose change it is.
 */
export function editBlockReason(row, user) {
  if (row.syncState === SYNC_STATE.CONFLICT) return EDIT_BLOCK.CONFLICT;
  if (
    (row.syncState === SYNC_STATE.PENDING || row.syncState === SYNC_STATE.REJECTED) &&
    row.lastEditedBy !== user.userId
  ) {
    return EDIT_BLOCK.OTHER_EDITOR;
  }
  return null;
}

/**
 * Unsynced rows on the device, split by whose change they hold.
 *
 * "Mine" is exactly what this user's Sync can clear — the same lastEditedBy
 * rule the push queue uses — so a warning never tells somebody to press a
 * button that will not help. Counts only: who the other editors are stays off
 * the screen.
 *
 * @param {Iterable<object>} rows
 * @param {object|null}      user  the signed-in user, or null
 */
export function countUnsynced(rows, user) {
  const otherEditors = new Set();
  let mine = 0;
  let others = 0;

  for (const row of rows) {
    if (!isUnsynced(row)) continue;
    if (user && row.lastEditedBy === user.userId) {
      mine += 1;
    } else {
      others += 1;
      otherEditors.add(row.lastEditedBy ?? row.createdBy);
    }
  }

  return { mine, others, otherWorkers: otherEditors.size, total: mine + others };
}
