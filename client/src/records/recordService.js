import Dexie from "dexie";
import { db, isDatabaseOutdated } from "../db/index.js";
import { getCachedUser } from "../auth/authService.js";
import { getDeviceId, newUuid } from "../lib/device.js";
import { SYNC_STATE } from "./syncState.js";

// No network code lives in this file, by design. Capture writes to IndexedDB and
// returns; the sync layer moves rows to the server on its own schedule.

// Defined in its own module so the pull decision table can use it without
// dragging Dexie in, and re-exported here because this is where every caller
// already expects to find it.
export { SYNC_STATE };

/**
 * Payload value rule, for this form and every form after it:
 *
 *   numbers  stored as JSON numbers, never "5". An empty answer is null, not 0
 *            and not "" — "nobody answered" and "answered zero" are different
 *            facts about a household, and only one of them is a measurement.
 *   dates    ISO 8601 strings ("2026-09-22"), not Date objects and not epoch
 *            millis. They survive JSON and MySQL JSON columns unchanged, sort
 *            correctly as text, and carry no timezone to be misread.
 *   text     trimmed strings, empty answer as null.
 *   choices  the option value as a string.
 *
 * Coercion happens at capture, where the form knows which field is which. Once
 * a row is stored, its types are what the server will validate against, and
 * changing the rule later means rewriting rows on every device.
 */
export class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecordError";
  }
}

// Reads are still allowed while outdated so the list on screen does not blank
// out; only writes are refused.
function assertWritable() {
  if (isDatabaseOutdated()) {
    throw new RecordError("Setu was updated in another tab. Reload to continue.");
  }
}

async function requireUser() {
  const user = await getCachedUser();
  // Records are stamped with an owner and an organisation, so there is nothing
  // sensible to write without a signed-in user.
  if (!user) throw new RecordError("Sign in before capturing records.");
  return user;
}

/**
 * The one place a local row is written. Create, edit and delete differ only in
 * the fields they change; everything about sync bookkeeping is decided here, so
 * no path can forget to bump the version or mark the row pending.
 *
 * localUpdatedAt is the device clock and is used ONLY to order the local list.
 * It is never a sync cursor: phone clocks run fast, slow and sometimes years
 * off, and a device that trusted its own clock would skip rows forever.
 * serverUpdatedAt is the authoritative value and stays null until the server
 * stamps the row.
 */
function stampLocalWrite(row, changes) {
  return {
    ...row,
    ...changes,
    version: row.version + 1,
    localUpdatedAt: Date.now(),
    syncState: SYNC_STATE.PENDING,
    // Editing is how a worker gets a rejected row moving again: it re-enters the
    // push queue, and the old reason no longer describes what is about to be
    // sent. serverConflict is deliberately NOT cleared — a worker editing a
    // conflicted row is usually reading the server's copy while they do it.
    syncError: null,
  };
}

// Every read is scoped to the signed-in worker. Phones get handed between
// workers, and one worker must never see, edit or sync another's records, even
// though both sets sit in the same IndexedDB on the same device.
function ownedBy(row, user) {
  return row && row.createdBy === user.userId;
}

/**
 * Applies a change to one record the current user owns.
 * Read, ownership check and write happen inside a transaction so two edits of
 * the same row cannot both read version N and both write N+1.
 */
async function updateOwnedRecord(id, changes) {
  assertWritable();
  const user = await requireUser();

  return db.transaction("rw", db.records, async () => {
    const row = await db.records.get(id);
    if (!ownedBy(row, user)) throw new RecordError("Record not found.");

    const updated = stampLocalWrite(row, changes);
    await db.records.put(updated);
    return updated;
  });
}

/**
 * The device mints the UUID, not the server. A phone with no signal cannot ask
 * for an id, and if two devices each took "the next number" they would give
 * different households the same one, and sync would silently merge two families
 * into one row.
 */
export async function createRecord({ formType, formVersion = 1, payload }) {
  assertWritable();
  const user = await requireUser();
  const deviceId = await getDeviceId();
  const now = Date.now();

  const row = {
    id: newUuid(),
    organizationId: user.organizationId,
    createdBy: user.userId,
    deviceId,
    formType,
    // Which revision of the form produced these answers. A payload is only
    // interpretable next to the form that collected it, and forms change.
    formVersion,
    payload,
    version: 1,
    createdAt: now,
    localUpdatedAt: now,
    // Only the server sets this, on the first successful push.
    serverUpdatedAt: null,
    // The last version the SERVER confirmed, which a push sends as its base
    // version. `version` alone cannot answer the server's question: two devices
    // offline at v3 both produce v4, and identical numbers say nothing about
    // what each edited from. Null until this row has ever synced.
    syncedVersion: null,
    // The server's copy when our push loses a conflict, kept here so the
    // comparison can happen offline, on the phone, with no network.
    serverConflict: null,
    deletedAt: null,
    syncState: SYNC_STATE.PENDING,
  };

  await db.records.add(row);
  return row;
}

export function updateRecord(id, payload) {
  return updateOwnedRecord(id, { payload });
}

/**
 * Soft delete: the row stays, with deletedAt set, and goes back to pending so
 * the deletion itself syncs. A hard delete would be invisible to every other
 * device — a row that is simply absent looks identical to a row that never
 * arrived, so the other phone would keep its copy and push it back.
 */
export function softDeleteRecord(id) {
  return updateOwnedRecord(id, { deletedAt: Date.now() });
}

function currentUserRange(user, indexKey) {
  return db.records
    .where(indexKey)
    .between([user.userId, Dexie.minKey], [user.userId, Dexie.maxKey]);
}

/**
 * The current user's live records, newest first. Soft-deleted rows are filtered
 * out here rather than by an index, because IndexedDB drops rows with a null key
 * from an index entirely.
 *
 * The exception is a deleted row the server would not take. Hiding those would
 * leave a worker with a conflict or a rejection they are never shown and cannot
 * act on, and a deletion that quietly failed is the one kind a supervisor most
 * needs to hear about. A merely PENDING deletion stays hidden: it is ordinary
 * unfinished work, and showing it back would read as the delete not having
 * worked.
 */
export async function listRecords() {
  const user = await requireUser();

  return currentUserRange(user, "[createdBy+localUpdatedAt]")
    .reverse()
    .filter(
      (row) =>
        row.deletedAt === null ||
        row.syncState === SYNC_STATE.CONFLICT ||
        row.syncState === SYNC_STATE.REJECTED
    )
    .toArray();
}

export async function getRecord(id) {
  const user = await requireUser();
  const row = await db.records.get(id);
  // Another worker's row is reported as missing rather than refused: whether it
  // exists is itself none of this user's business.
  return ownedBy(row, user) ? row : null;
}

/**
 * How many of this user's records are waiting to reach the server. Counts
 * soft-deleted rows too: a pending deletion is unsent work like any other.
 */
export async function countPendingRecords() {
  const user = await requireUser();
  return db.records
    .where("[createdBy+syncState]")
    .equals([user.userId, SYNC_STATE.PENDING])
    .count();
}

/**
 * Unsynced work sitting on this device, counted across EVERY worker who has
 * used it — not only the one signed in now.
 *
 * This is the one read in the file that deliberately ignores the ownership
 * scoping every other query enforces, and it exists precisely because that
 * scoping is otherwise total. Phones get handed on. A worker signs in, sees
 * "0 waiting to sync", and has no way to learn that a colleague's week of
 * household visits is sitting in the same IndexedDB — invisible to every list,
 * every count and every sync, because all of them are correctly scoped to the
 * person holding the phone. That is exactly the state in which a device gets
 * wiped or passed along, and the work is gone.
 *
 * It returns counts only. Who the other worker is stays out of it: authCache
 * holds one row by design, so this device does not know a colleague's name, and
 * it has no business learning one to render a warning.
 *
 * "Unsynced" is every row the server has not accepted — pending, conflicted and
 * rejected alike. A conflicted row's pushed copy does survive server-side in
 * record_conflicts, so counting it here errs toward warning about a record that
 * could in fact be recovered. That is the right direction to be wrong in.
 *
 * A full scan, because syncState is only indexed beside createdBy and there is
 * no way to range across every worker at once. It runs when a screen loads and
 * before a destructive action, never in a loop.
 */
export async function countUnsyncedOnDevice() {
  const user = await getCachedUser();
  const otherOwners = new Set();
  let mine = 0;
  let others = 0;

  await db.records.each((row) => {
    if (row.syncState === SYNC_STATE.SYNCED) return;

    if (user && row.createdBy === user.userId) {
      mine += 1;
    } else {
      others += 1;
      otherOwners.add(row.createdBy);
    }
  });

  return { mine, others, otherWorkers: otherOwners.size, total: mine + others };
}
