import Dexie from "dexie";
import { db, isDatabaseOutdated } from "../db/index.js";
import { getCachedUser } from "../auth/authService.js";
import { getDeviceId, newUuid } from "../lib/device.js";

// No network code lives in this file, by design. Capture writes to IndexedDB and
// returns; the sync layer moves rows to the server on its own schedule.

export const SYNC_STATE = {
  // Local changes the server has not accepted yet.
  PENDING: "pending",
  // Server and device agree, as of serverUpdatedAt.
  SYNCED: "synced",
  // Both sides changed the row since the last sync. Needs a human or a rule.
  CONFLICT: "conflict",
};

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
 */
export async function listRecords() {
  const user = await requireUser();

  return currentUserRange(user, "[createdBy+localUpdatedAt]")
    .reverse()
    .filter((row) => row.deletedAt === null)
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
