import { db } from "../db/index.js";
import { getCachedUser } from "../auth/authService.js";
import {
  NetworkError,
  NotAuthenticatedError,
  apiFetch,
} from "../lib/api.js";
import { getDeviceId } from "../lib/device.js";
import { samePayload } from "../lib/payload.js";
import { SYNC_STATE } from "../records/syncState.js";
import {
  PULL_ACTION,
  RESOLUTION_ACTION,
  classifyPulledRow,
  classifyResolution,
  releaseLegacyDeletionLock,
} from "./pullRules.js";

// The only file in client/src that talks to the server about records. Capture
// writes to IndexedDB and returns; this moves what is there to the server on its
// own schedule, and nothing on the capture path waits for it.
//
// A full sync is pushPending() then pullChanges(), in that order, and the reason
// is written out at the call site in executeSync().

const PUSH_PATH = "/api/sync/push";
const PULL_PATH = "/api/sync/pull";
const RESOLUTIONS_PATH = "/api/sync/resolutions";

// Well under the server's 200 cap. Smaller batches finish inside the short
// connectivity windows a field phone actually gets, and a dropped response costs
// one batch of uncertainty rather than the whole queue's.
const PUSH_BATCH_SIZE = 50;

const MAX_PUSH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// A page well under the server's 500 cap. Each page is applied in its own
// transaction, so smaller pages mean less work thrown away when a pull is
// interrupted halfway down a village's worth of records.
const PULL_PAGE_SIZE = 100;

/**
 * THE DELTA CURSOR. The single most important value this device stores.
 *
 * It holds the string the SERVER returned as `serverTime`, byte for byte. It is
 * never parsed, never turned into a Date, never formatted and re-read, and never
 * compared against anything the device's own clock produced.
 *
 * Reparsing it would be enough to break it. The string carries no timezone, so
 * new Date(...) reads it in whatever zone the phone is set to; a device that
 * crosses a border, or whose user changes the setting, would shift its own
 * cursor by hours and either re-download everything or skip a day of records
 * permanently. Kept opaque, it is simply a token the server issued and the
 * device hands back.
 *
 * ONE PER USER, NOT ONE PER PHONE.
 *
 * A cursor says "everything in MY scope up to here has been applied". Scope is
 * per user — a field worker pulls their own records, a supervisor the
 * organisation, and the resolutions feed is conflicts you raised or records you
 * captured. A single device-wide cursor let one person's sync on a shared phone
 * move it past records and resolutions that were in someone else's scope and
 * never fetched for them. Nothing re-offers what falls below a cursor, so those
 * never arrived — and a row locked waiting for its resolution stayed locked for
 * good. Keyed by user, each person's window is theirs alone.
 *
 * One cursor covers BOTH halves of a sync, records and resolutions, and that is
 * deliberate rather than an omission. Both are read over one closed window and
 * the cursor moves once, after both have been applied. Two cursors could advance
 * separately — records past a window whose resolutions failed — which is the
 * exact "moved past something never delivered" failure this key exists to end.
 *
 * Written ONLY after the final page of both halves has been applied. Signing out
 * keeps it, so a worker returning to a shared phone resumes where they left off;
 * removeAccountFromDevice() clears the whole meta table, cursors included.
 */
const SYNC_CURSOR_PREFIX = "syncCursor:";

// When the server last answered this USER on this device, as the SERVER dated
// it — not Date.now(). Per user for the same reason as the cursor: on a shared
// phone, "Last synced 10:32" under the second worker's name would be the first
// worker's sync, telling them their records went up when they did not.
const LAST_SYNC_PREFIX = "serverSyncedAt:";

const cursorKey = (userId) => `${SYNC_CURSOR_PREFIX}${userId}`;
const lastSyncKey = (userId) => `${LAST_SYNC_PREFIX}${userId}`;

// Fired after every sync attempt so any screen showing record state can re-read.
// A window event rather than a callback list: sync can start from a button in
// one component and from the "online" event with no component involved at all.
export const SYNC_EVENT = "setu:sync-finished";

export const PUSH_STATUS = {
  ACCEPTED: "accepted",
  CONFLICT: "conflict",
  REJECTED: "rejected",
  FAILED: "failed",
};

/**
 * When the server last answered the signed-in user on this device, in the
 * server's own words. A string such as "2026-09-22 15:16:21.934000", for
 * display only.
 */
export async function getLastSyncAt() {
  const user = await getCachedUser();
  if (!user) return null;
  const row = await db.meta.get(lastSyncKey(user.userId));
  return typeof row?.value === "string" ? row.value : null;
}

// Null for a user who has never synced on this phone, which pulls from the
// beginning — exactly like a fresh install. See REPLAY SAFETY in pullRules.js
// for why a full replay is harmless on both halves.
async function getSyncCursor(userId) {
  const row = await db.meta.get(cursorKey(userId));
  return typeof row?.value === "string" ? row.value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter, not a plain doubling. A tower coming back brings every phone in a
// village online in the same second; without jitter they would all retry in
// lockstep and take the server down exactly when it is needed most.
function backoffDelay(attempt) {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/**
 * What goes on the wire.
 *
 * organizationId, createdBy, createdAt and updatedAt are all deliberately
 * absent. The server takes ownership from the verified JWT and every timestamp
 * from its own clock, so sending them would only invite some later version of
 * this route to trust them.
 *
 * deleted is a boolean, not deletedAt, for the same reason: the device is
 * authoritative on WHETHER a row was deleted and never on WHEN.
 */
function toWire(row, deviceId) {
  return {
    id: row.id,
    // THIS device, not row.deviceId.
    //
    // row.deviceId is the phone that AUTHORED the row, and a pull overwrites it
    // with whatever device last wrote the server's copy. Sending that value made
    // this device claim to be another one — and records.device_id is the
    // discriminator the server's idempotency rule turns on. Phone B editing a
    // record it pulled from phone A would push under A's id, and a stale base
    // would then be read as A's own lost response and silently ACCEPTED: B's
    // edit overwriting A's with no conflict raised and no trace that two people
    // had disagreed.
    //
    // The field means "the phone this write came from", so it is answered by the
    // phone the write is coming from.
    deviceId,
    formType: row.formType,
    formVersion: row.formVersion,
    payload: row.payload,
    // The last version the SERVER confirmed, which is the base of the three-way
    // comparison. Not row.version: the local counter says how many times this
    // phone has written the row, which tells the server nothing about what the
    // edit was made from.
    baseVersion: row.syncedVersion ?? null,
    deleted: row.deletedAt !== null,
  };
}

/**
 * One worker's unsent rows.
 *
 * Scoped by createdBy through the compound index, never by a global scan of
 * pending rows. Phones are handed between workers, and a record captured by
 * worker A must not reach the server under worker B's token — which is not a
 * hypothetical, because B's token is the only one this device holds once B signs
 * in. Leaving A's rows pending is the correct behaviour: they are still A's work
 * and still on the device, waiting for A to sign in again.
 *
 * `seen` excludes rows this run has already had an answer about. A row that
 * comes back FAILED, or that the worker edited mid-flight, stays pending on
 * purpose, and without this the loop that drains the queue would keep picking it
 * up and never terminate.
 */
async function collectPendingBatch(user, seen) {
  const rows = await db.records
    .where("[createdBy+syncState]")
    .equals([user.userId, SYNC_STATE.PENDING])
    .limit(PUSH_BATCH_SIZE + seen.size)
    .toArray();

  return rows.filter((row) => !seen.has(row.id)).slice(0, PUSH_BATCH_SIZE);
}

/**
 * Sends one batch, retrying only transport failures.
 *
 * NetworkError is the single retryable case: it means the request never reached
 * a server that looked at it. Anything else is an answer, and repeating a
 * request the server has already considered just asks it to say no again — an
 * ApiError (4xx) will not become a 2xx by being sent twice, and
 * NotAuthenticatedError needs a person, not a retry.
 */
async function pushBatchWithRetry(records) {
  let attempt = 0;

  for (;;) {
    try {
      return await apiFetch(PUSH_PATH, { method: "POST", body: { records } });
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;

      attempt += 1;
      if (attempt >= MAX_PUSH_ATTEMPTS) throw error;
      await sleep(backoffDelay(attempt));
    }
  }
}

/**
 * Writes the server's answers back onto the local rows.
 *
 * Every row is re-read inside the transaction rather than trusting the copy that
 * was sent. The request took time, and during it the worker may have edited the
 * record, signed out, or had the device wiped.
 */
async function applyResults(user, sentById, results, summary) {
  await db.transaction("rw", db.records, async () => {
    for (const result of results) {
      const sent = sentById.get(result.id);
      // An answer about a record this device did not send. Nothing sensible to
      // do with it, and applying it blind would let a reply rewrite an unrelated
      // row.
      if (!sent) continue;

      const row = await db.records.get(result.id);
      // Gone, or the device changed hands mid-sync. Either way this is no longer
      // a row this user may be told about.
      if (!row || row.createdBy !== user.userId) continue;

      if (result.status === PUSH_STATUS.ACCEPTED) {
        // The server accepted the state that was SENT. If the worker edited the
        // row while the request was in flight, the device now holds something
        // newer than the server does, so the row has to stay pending — marking
        // it synced would strand that edit on the phone forever.
        const editedInFlight = row.version !== sent.version;

        // syncedVersion moves either way. The server really did issue this
        // version, and it is the base the next push must send; holding it back
        // would make that push arrive with a stale base.
        await db.records.update(row.id, {
          syncedVersion: result.version,
          serverUpdatedAt: result.serverUpdatedAt,
          syncState: editedInFlight ? SYNC_STATE.PENDING : SYNC_STATE.SYNCED,
          syncError: null,
          // The device's provisional tombstone date, replaced by the server's.
          // A local delete has to write some date before it can be sent and the
          // only clock it has is its own; this is the moment the authoritative
          // value arrives. Guarded on the row still being deleted, because a
          // worker may have changed it while the request was in the air, and on
          // the server actually having sent one.
          ...(row.deletedAt !== null && typeof result.deletedAt === "string"
            ? { deletedAt: result.deletedAt }
            : {}),
        });
        summary.accepted += 1;
        continue;
      }

      if (result.status === PUSH_STATUS.CONFLICT) {
        // Keep the copy already on screen if this row is not the one currently
        // in conflict: a late answer to an older push would otherwise replace
        // the server version a worker is in the middle of reading with a staler
        // one.
        const keepExisting =
          row.serverConflict != null && row.syncState !== SYNC_STATE.CONFLICT;

        await db.records.update(row.id, {
          syncState: SYNC_STATE.CONFLICT,
          ...(keepExisting ? {} : { serverConflict: result.server }),
          syncError: null,
        });
        summary.conflicts += 1;
        continue;
      }

      if (result.status === PUSH_STATUS.REJECTED) {
        // A rejection is final. The row leaves PENDING, and since the push queue
        // only ever selects PENDING rows it is structurally impossible for this
        // to be retried — no attempt counter to get wrong, no backoff to tune. A
        // malformed record does not become valid by being sent again, and a
        // device that kept trying would burn a field worker's data allowance on
        // a request that can only fail.
        //
        // Nothing is deleted. The row stays on the device with its reason
        // attached, because a rejected household visit is still collected data.
        await db.records.update(row.id, {
          syncState: SYNC_STATE.REJECTED,
          syncError: {
            reason: result.reason ?? "unknown",
            message: result.message ?? "The server refused this record.",
            at: Date.now(),
          },
        });
        summary.rejected += 1;
        continue;
      }

      // FAILED: the server did not reach a verdict. Left PENDING untouched so
      // the next sync picks it up.
      summary.failed += 1;
    }
  });
}

async function pushPending(user, summary) {
  const seen = new Set();
  // Read once for the whole push: it is one value per install, and asking per
  // batch would open a Dexie transaction for something that cannot change.
  const deviceId = await getDeviceId();

  for (;;) {
    const batch = await collectPendingBatch(user, seen);
    if (batch.length === 0) return;

    const sentById = new Map(batch.map((row) => [row.id, row]));
    summary.attempted += batch.length;

    const response = await pushBatchWithRetry(batch.map((row) => toWire(row, deviceId)));
    await applyResults(user, sentById, response.results ?? [], summary);

    // Marked seen whatever the answer was, including the rows that stayed
    // pending, so this run cannot loop on them.
    for (const row of batch) seen.add(row.id);
  }
}

// ---------------------------------------------------------------------------
// PULL
// ---------------------------------------------------------------------------

/**
 * One page of the delta window.
 *
 * Retries on transport failure only, exactly as the push does: a NetworkError
 * means nothing was heard back, while an ApiError is the server's considered
 * answer and asking again only gets it repeated.
 *
 * A pull is naturally idempotent — it reads a closed window and writes nothing
 * on the server — so an interrupted page can simply be asked for again.
 */
async function getWithRetry(path, params) {
  let attempt = 0;
  for (;;) {
    try {
      return await apiFetch(`${path}?${params.toString()}`);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;

      attempt += 1;
      if (attempt >= MAX_PUSH_ATTEMPTS) throw error;
      await sleep(backoffDelay(attempt));
    }
  }
}

function windowParams({ since, until, limit }) {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (until) params.set("until", until);
  params.set("limit", String(limit));
  return params;
}

function pullPageWithRetry({ since, until, after, limit }) {
  const params = windowParams({ since, until, limit });
  if (after) {
    params.set("afterUpdatedAt", after.updatedAt);
    params.set("afterId", after.id);
  }
  return getWithRetry(PULL_PATH, params);
}

// The keyset here is a position in resolved_at, not updated_at. Two feeds, two
// parameter names, so one can never be paged with the other's cursor.
function resolutionPageWithRetry({ since, until, after, limit }) {
  const params = windowParams({ since, until, limit });
  if (after) {
    params.set("afterResolvedAt", after.resolvedAt);
    params.set("afterId", after.id);
  }
  return getWithRetry(RESOLUTIONS_PATH, params);
}

/**
 * The server's copy, shaped for the local store.
 *
 * localUpdatedAt is the device clock and orders the worker's list; it means
 * "when this device last wrote this row", which a pull is. It is emphatically
 * not a cursor — that is serverUpdatedAt, which is the server's string, stored
 * unchanged.
 */
function toLocalRow(remote, organizationId, previous) {
  return {
    id: remote.id,
    organizationId,
    createdBy: remote.createdBy,
    deviceId: remote.deviceId,
    formType: remote.formType,
    formVersion: remote.formVersion,
    payload: remote.payload,
    version: remote.version,
    createdAt: previous?.createdAt ?? Date.now(),
    localUpdatedAt: Date.now(),
    serverUpdatedAt: remote.updatedAt,
    // The server has confirmed this version by definition: it just sent it.
    syncedVersion: remote.version,
    serverConflict: null,
    // Carried across, because this is a whole-row put and every field not named
    // here is dropped. A supervisor's decision is news the worker has not
    // acknowledged yet; the next ordinary pull of the same record must not
    // quietly take the explanation off their screen — least of all when the
    // notice is holding the only local copy of the answers that were discarded.
    resolvedNotice: previous?.resolvedNotice ?? null,
    // The server's deletion time, stored unchanged. Both sides of deletedAt are
    // the same representation now (see lib/time.js), so this is simply the
    // authoritative value replacing whatever the device had guessed — dated by
    // the machine that actually made the decision.
    deletedAt: remote.deletedAt,
    syncState: SYNC_STATE.SYNCED,
    syncError: null,
  };
}

/**
 * Applies one page, in one Dexie transaction.
 *
 * The transaction boundary is the page, and it matters: a pull that dies halfway
 * through writing a page must leave that page entirely unapplied, because the
 * cursor is only written after the LAST page. Half a page applied with the
 * cursor unmoved is harmless — it gets re-fetched — but half a page applied
 * with a partially-updated row is not.
 */
async function applyPulledPage(user, records, summary) {
  if (records.length === 0) return;

  await db.transaction("rw", db.records, async () => {
    for (const remote of records) {
      const local = await db.records.get(remote.id);
      const { action } = classifyPulledRow(local ?? null, remote);
      summary.pulled += 1;

      if (action === PULL_ACTION.SKIP) continue;

      if (action === PULL_ACTION.KEEP_LOCAL) {
        // Deliberately nothing. See pullRules.js — touching syncedVersion here
        // would make the next push silently overwrite another device's edit.
        summary.heldBack += 1;
        continue;
      }

      if (action === PULL_ACTION.REFRESH_CONFLICT) {
        await db.records.update(remote.id, { serverConflict: remote });
        summary.pullConflicts += 1;
        continue;
      }

      if (action === PULL_ACTION.KEEP_LOCAL_DELETED) {
        // The worker's row stays exactly as it is — payload, syncedVersion, and
        // above all syncState, so it stays in the push queue. Only the server's
        // tombstone is stored beside it, so the worker is told the record was
        // deleted and that their copy is going to a supervisor. The next push
        // files the conflict on the server; see the tombstone case in
        // pullRules.js for why that push cannot undo the deletion.
        await db.records.update(remote.id, { serverConflict: remote });
        summary.deletedOnServer += 1;
        continue;
      }

      // INSERT and OVERWRITE. organizationId comes from the signed-in user
      // rather than the wire: the server scopes the query to that organisation
      // already, and the row has no business carrying a second opinion.
      await db.records.put(toLocalRow(remote, user.organizationId, local));
      summary.applied += 1;
      if (!local) summary.received += 1;
    }
  });
}

/**
 * What the worker is told, kept on the row itself.
 *
 * `discardedPayload` is the copy THIS DEVICE was holding when the resolution
 * landed — the one the adopt below is about to overwrite.
 *
 * THE GUARANTEE, stated plainly, because a kept_server resolution destroys a
 * worker's local answers and this is the only thing standing between that and a
 * silent loss:
 *
 *   1. It is snapshotted HERE, before db.records.put() replaces the payload, in
 *      the same Dexie transaction. There is no window in which the local copy is
 *      gone and the notice does not yet hold it.
 *   2. The row stays in the worker's list while the notice is set, even if the
 *      resolution deleted it — listRecords() keeps any row carrying one — so the
 *      copy is on screen, not merely in storage.
 *   3. It survives the device entirely. The same payload is the row in
 *      record_conflicts on the server, which resolution never deletes; that is
 *      exactly why the conflict row outlives the decision. So even a phone that
 *      is wiped, lost, or dismissed too fast has not taken the last copy with
 *      it, and dismissResolutionNotice() says so before it asks.
 *
 * It is set only when the copy is actually being replaced by something
 * different. On a kept_client resolution the worker's own copy is what WON, so
 * there is nothing discarded, and telling them their data was dropped when it
 * was adopted would be its own kind of wrong.
 */
function toResolutionNotice(user, resolution, discarded, local) {
  // What the record said on the SERVER immediately before the decision replaced
  // it — as opposed to `discarded`, which is what THIS PHONE was holding.
  //
  // The server's copy is used rather than whatever this row holds, even though
  // resolutions now run before the record pages and the row is still untouched
  // at this point. The row may be several versions behind — a phone offline for
  // a week — and what it holds is then OLDER than what the decision replaced.
  // Showing that as "what the record said before" would put the wrong answers in
  // front of the worker. record_conflicts.superseded_payload is the exact
  // version the supervisor overrode.
  //
  // Kept only when it tells the worker something: not when it matches what the
  // record says now, and not when it would repeat the discarded copy shown
  // beside it.
  const superseded = resolution.superseded ?? null;
  const showSuperseded =
    superseded !== null &&
    !samePayload(superseded.payload, resolution.record.payload) &&
    !(discarded && samePayload(discarded.payload, superseded.payload));

  return {
    conflictId: resolution.conflictId,
    resolution: resolution.resolution,
    resolvedAt: resolution.resolvedAt,
    resolvedByName: resolution.resolvedByName ?? null,
    // Whether the copy under judgement was THIS user's push.
    //
    // The feed also reaches the worker who captured the record without having
    // submitted anything, and the two need opposite sentences: "a supervisor
    // kept your version" is false for the second, and telling somebody their
    // data won when it was never in question is how a notice stops being read.
    submittedByMe: resolution.submitted?.byId === user.userId,
    // Whether the copy under judgement was itself a deletion. "A supervisor kept
    // your version" is only a complete sentence when that version and the
    // record's current state agree about whether the household still exists.
    submittedDeleted: resolution.submitted?.deleted === true,
    // The decision put a deleted household back in the register.
    //
    // Worked out here rather than sent by the server, because record_conflicts
    // keeps what a resolution replaced but not whether the record was deleted
    // before it. This phone knows: resolutions run before the record pages, so
    // the row still shows the server's state as this phone last saw it — as the
    // tombstone beside a conflicted or unsent row, or as the synced row itself.
    // Only keep-worker can restore, so only keep-worker is credited with it.
    restored:
      resolution.resolution === "kept_client" &&
      resolution.record?.deletedAt == null &&
      heldAsDeleted(local),
    discardedPayload: discarded ? discarded.payload : null,
    discardedVersion: discarded ? discarded.version : null,
    supersededPayload: showSuperseded ? superseded.payload : null,
    supersededVersion: showSuperseded ? superseded.version : null,
    // Device clock, and only ever used to order notices on screen.
    noticedAt: Date.now(),
  };
}

// Whether this phone's row showed the record as deleted on the server.
function heldAsDeleted(local) {
  if (!local) return false;
  if (local.serverConflict?.deletedAt != null) return true;
  return local.syncState === SYNC_STATE.SYNCED && local.deletedAt != null;
}

/**
 * Applies one page of resolutions, in one Dexie transaction.
 *
 * Runs BEFORE the record pages of the same window, and the order matters. The
 * decision whether to tell a worker about a resolution turns on whether their
 * row still holds the version it replaced (see heldReplacedVersion() in
 * pullRules.js). Run after the records, the ordinary pull would already have
 * overwritten that row with the new version, and the evidence would be gone —
 * so every notice would either be lost or have to be guessed at.
 *
 * Nothing the record pages do afterwards undoes this: an adopted row is synced
 * at the server's version, so its record arrives as SKIP; a notified row keeps
 * its notice through an overwrite (toLocalRow carries it across); and a row
 * still locked for a different dispute only has its server copy refreshed.
 */
async function applyResolutions(user, resolutions, summary, deviceId) {
  if (resolutions.length === 0) return;

  await db.transaction("rw", db.records, async () => {
    for (const resolution of resolutions) {
      const local = await db.records.get(resolution.recordId);

      // Re-read inside the transaction and re-checked, exactly as the push
      // results are: the request took time, and the device may have changed
      // hands during it.
      if (local && local.createdBy !== user.userId) continue;

      const { action } = classifyResolution(local ?? null, resolution, deviceId);

      if (action === RESOLUTION_ACTION.SKIP) continue;

      if (action === RESOLUTION_ACTION.NOTIFY) {
        // The record is NOT touched. Only the notice is written, so a row
        // holding unsent work keeps it and a synced row is not churned.
        await db.records.update(local.id, {
          resolvedNotice: toResolutionNotice(user, resolution, null, local),
        });
        summary.resolutionsNoticed += 1;
        continue;
      }

      // ADOPT. The dispute is settled, so the server's copy becomes this
      // device's copy whole — payload, version, form identity and tombstone —
      // and syncedVersion advances to the server's version. That last field is
      // the entire point: it is the base the next push sends, and until it moves
      // every push from this row arrives stale and conflicts again.
      const replaced = !samePayload(local.payload, resolution.record.payload);

      await db.records.put({
        ...toLocalRow(resolution.record, user.organizationId, local),
        resolvedNotice: toResolutionNotice(user, resolution, replaced ? local : null, local),
      });
      summary.resolutionsApplied += 1;
    }
  });
}

/**
 * Walks the resolutions feed over one closed window, and returns that window's
 * upper edge for the record pull to reuse.
 *
 * It goes first, so it is the half that fixes the edge: its first page's
 * serverTime becomes `until` for every page of both feeds, and one sync reads
 * one interval across the pair.
 */
async function pullResolutions(user, summary, { since, deviceId }) {
  let until = null;
  let after = null;
  let pages = 0;

  for (;;) {
    const page = await resolutionPageWithRetry({
      since,
      until,
      after,
      limit: PULL_PAGE_SIZE,
    });

    until ??= page.serverTime;
    await applyResolutions(user, page.resolutions ?? [], summary, deviceId);
    pages += 1;

    if (!page.hasMore || !page.nextCursor) break;
    after = page.nextCursor;
  }

  summary.resolutionPages = pages;
  return until;
}

/**
 * Walks the record pages of a window whose edge the resolutions feed has
 * already fixed.
 */
async function pullRecords(user, summary, { since, until }) {
  let after = null;
  let pages = 0;

  for (;;) {
    const page = await pullPageWithRetry({
      since,
      until,
      after,
      limit: PULL_PAGE_SIZE,
    });

    await applyPulledPage(user, page.records ?? [], summary);
    pages += 1;

    // nextCursor missing while hasMore is set would loop forever on the same
    // page. Stopping leaves the cursor unmoved, so the window is simply re-read
    // next time rather than partially skipped.
    if (!page.hasMore || !page.nextCursor) break;
    after = page.nextCursor;
  }

  summary.pullPages = pages;
}

/**
 * Frees this user's rows still held by the old pull-side lock, now that the
 * window's resolutions have had their chance to adopt the real ones. See
 * releaseLegacyDeletionLock() in pullRules.js.
 *
 * Only the signed-in user's rows: the lock is released into the push queue, and
 * the push queue is per user. Another worker's flagged rows wait for them.
 */
async function releaseLegacyDeletionLocks(user, summary) {
  await db.transaction("rw", db.records, async () => {
    const locked = await db.records
      .where("[createdBy+syncState]")
      .equals([user.userId, SYNC_STATE.CONFLICT])
      .toArray();

    for (const row of locked) {
      const releaseTo = releaseLegacyDeletionLock(row);
      if (!releaseTo) continue;

      await db.records.update(row.id, {
        syncState: releaseTo,
        // Dexie's update() removes a key set to undefined, so the flag is gone
        // rather than left false for something to misread later.
        legacyDeletionLock: undefined,
      });
      summary.legacyLocksReleased += 1;
    }
  });
}

/**
 * Both halves of the delta window — resolutions, then records — and only then
 * the signed-in user's cursor.
 *
 * The cursor is written ONCE, after the final page of both. Advancing it any
 * earlier means an interrupted sync — a tunnel, a flat battery, a closed tab —
 * leaves it past something that was never fetched, and the next window starts
 * above it. Nothing retries it, because nothing knows it was missed; for a
 * resolution, that is a row locked for good. Leaving the cursor unmoved costs
 * one re-read of a window already applied, which the replay rules in
 * pullRules.js make harmless.
 */
async function pullChanges(user, summary) {
  const since = await getSyncCursor(user.userId);
  // Which phone this is, so the resolutions half can recognise the disputes
  // this phone raised. One value per install; read once per sync.
  const deviceId = await getDeviceId();

  const until = await pullResolutions(user, summary, { since, deviceId });

  // A response with no serverTime cannot be windowed. Stop with the cursor
  // unmoved rather than read records over an interval nobody fixed.
  if (!until) return;

  await pullRecords(user, summary, { since, until });

  // After BOTH halves, never before the resolutions: a flagged row that was a
  // real conflict already decided on the server must be adopted by its
  // resolution, not re-pushed into a second dispute. Released rows go up with
  // the next sync's push — one push phase per sync, before the pull, as always.
  await releaseLegacyDeletionLocks(user, summary);

  // Only forward. resolveWindow() already refuses to hand back an edge below
  // the cursor it was given, but a cursor that moves backwards re-delivers what
  // has been applied, so the device checks too rather than trusting a response
  // to be well-formed.
  if (!since || until > since) {
    await db.meta.put({ key: cursorKey(user.userId), value: until });
  }
  await db.meta.put({ key: lastSyncKey(user.userId), value: until });
}

function emptySummary() {
  return {
    attempted: 0,
    accepted: 0,
    conflicts: 0,
    rejected: 0,
    failed: 0,
    // Pull side. `pulled` is everything the window returned; `received` counts
    // only rows this device had never seen, which is the number a worker cares
    // about. `heldBack` is rows the server sent that were deliberately NOT
    // applied because this device holds unsent work for them.
    pulled: 0,
    applied: 0,
    received: 0,
    heldBack: 0,
    pullConflicts: 0,
    // Rows the server deleted while this device held unsent work for them. Kept
    // queued; the next push files each as a conflict for a supervisor.
    deletedOnServer: 0,
    // Rows freed from the old pull-side lock, back in the queue for next sync.
    legacyLocksReleased: 0,
    pullPages: 0,
    // Resolutions. `applied` are rows that LEFT conflict state and rejoined
    // normal operation — the deadlock exit actually firing. `noticed` are rows
    // that were not in conflict on this device and were only told what a
    // supervisor decided.
    resolutionsApplied: 0,
    resolutionsNoticed: 0,
    resolutionPages: 0,
    // The offline-login gap: tokens are null, so the server cannot be reached as
    // anybody. Not an error to show in red — an instruction.
    needsOnlineSignIn: false,
    transportError: null,
    signedOut: false,
  };
}

async function executeSync() {
  const summary = emptySummary();
  const user = await getCachedUser();

  if (!user) {
    summary.signedOut = true;
    return summary;
  }

  try {
    // PUSH, THEN PULL. Not a preference — the other order silently destroys
    // work.
    //
    // Pulling first hands this device the server's copy of rows it is about to
    // overwrite. Those copies are, by definition, older than the local edits
    // waiting to go out, so applying them either overwrites unsent work outright
    // or raises a conflict against data the device was seconds away from
    // superseding. The worker is then asked to reconcile their own record
    // against a version of it that no longer matters.
    //
    // Pushing first means the server has already accepted whatever this device
    // had to say before it answers the question "what changed?". Rows that come
    // back are genuinely other people's changes, and a row still pending after
    // the push is pending because the push failed — which pullRules.js treats as
    // the exception it is, rather than the normal case it would become.
    await pushPending(user, summary);
    await pullChanges(user, summary);
  } catch (error) {
    // THE OFFLINE-LOGIN GAP.
    //
    // A worker who signed in offline has a usable device and no tokens at all —
    // loginOffline() leaves them null on purpose, because a cached hash unlocks
    // local data and cannot create a server session. Every sync from that device
    // therefore fails here, at the first request, before a single record is
    // sent.
    //
    // Left alone this is silent: records pile up, the pending count climbs, and
    // nothing on screen explains that the one thing standing between a week of
    // household visits and the server is a password the worker knows. The
    // records are untouched — not failed, not rejected, still PENDING — and the
    // caller is told to ask for a sign-in.
    if (error instanceof NotAuthenticatedError) {
      summary.needsOnlineSignIn = true;
    } else if (error instanceof NetworkError) {
      // Out of retries, or offline the whole time. Every row is still pending,
      // which is exactly where it should be.
      summary.transportError = error.message;
    } else {
      // An ApiError or a bug. Rows stay pending; surface it rather than
      // swallowing it.
      summary.transportError = error.message;
      console.error("[sync] push failed", error);
    }
  }

  return summary;
}

let syncInFlight = null;

/**
 * Runs a sync, or joins the one already running.
 *
 * Single-flight, the same shape as refreshAccessToken() in lib/api.js. Two
 * overlapping runs would read the same PENDING rows and push both copies: the
 * second arrives with the same base version the first is still being answered
 * for, and the device ends up resolving a conflict against itself. A worker
 * tapping Sync twice, or tapping it as the "online" event fires, is the ordinary
 * case, not the exotic one.
 *
 * The second caller gets the first run's promise and its result. That is the
 * intent — it is the same work — so the summary a joiner sees describes the run
 * that was already going.
 */
export function runSync() {
  syncInFlight ??= executeSync().finally(() => {
    syncInFlight = null;
  });

  const current = syncInFlight;
  return current.then((summary) => {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: summary }));
    return summary;
  });
}

/**
 * Syncs when the browser reports the network is back.
 *
 * navigator.onLine and this event only know that an interface came up, not that
 * anything is reachable through it — captive portals and dead uplinks both
 * report online. That is tolerable here, unlike in login, where acting on a
 * false signal costs a failed attempt against the device lockout. The worst case
 * here is one request that times out and leaves every row pending.
 *
 * Background Sync is deliberately not registered yet: it would run this with no
 * tab open, which is where an unprompted failure becomes truly invisible.
 */
export function startSyncOnReconnect() {
  const onOnline = () => {
    // Nothing awaits this and a rejected promise here has nowhere to go, so the
    // result is dropped on purpose; executeSync already folds every expected
    // failure into the summary.
    void runSync().catch(() => {});
  };

  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}
