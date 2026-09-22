import { db } from "../db/index.js";
import { getCachedUser } from "../auth/authService.js";
import {
  NetworkError,
  NotAuthenticatedError,
  apiFetch,
} from "../lib/api.js";
import { SYNC_STATE } from "../records/recordService.js";

// The only file in client/src that talks to the server about records. Capture
// writes to IndexedDB and returns; this moves what is there to the server on its
// own schedule, and nothing on the capture path waits for it.
//
// PUSH BEFORE PULL. This step is push only, but the order is decided here
// because reversing it later would lose data: a pull applied first overwrites
// rows this device has changed but not yet sent, and the edit disappears without
// anyone seeing a conflict. Step 11 adds pullChanges() and calls it from
// runSync() AFTER pushPending(), which is why runSync is a sequence of phases
// rather than a single function body.

const PUSH_PATH = "/api/sync/push";

// Well under the server's 200 cap. Smaller batches finish inside the short
// connectivity windows a field phone actually gets, and a dropped response costs
// one batch of uncertainty rather than the whole queue's.
const PUSH_BATCH_SIZE = 50;

const MAX_PUSH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// The device clock, stored for display only. It is NOT a cursor and must never
// become one: step 11's delta cursor is the server's timestamp, kept separately,
// because a phone whose clock runs fast would skip records forever.
const LAST_SYNC_META_KEY = "lastSyncAt";

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

export async function getLastSyncAt() {
  const row = await db.meta.get(LAST_SYNC_META_KEY);
  return row?.value ?? null;
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
function toWire(row) {
  return {
    id: row.id,
    deviceId: row.deviceId,
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

  for (;;) {
    const batch = await collectPendingBatch(user, seen);
    if (batch.length === 0) return;

    const sentById = new Map(batch.map((row) => [row.id, row]));
    summary.attempted += batch.length;

    const response = await pushBatchWithRetry(batch.map(toWire));
    await applyResults(user, sentById, response.results ?? [], summary);

    // Marked seen whatever the answer was, including the rows that stayed
    // pending, so this run cannot loop on them.
    for (const row of batch) seen.add(row.id);
  }
}

function emptySummary() {
  return {
    attempted: 0,
    accepted: 0,
    conflicts: 0,
    rejected: 0,
    failed: 0,
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
    await pushPending(user, summary);

    // Step 11 pulls here, after the push has finished. See the note at the top
    // of this file for why the order is not negotiable.

    // Only set once the server has actually answered. "Last synced" is a claim
    // that data reached the server, and a run that never got that far must not
    // make it.
    if (summary.attempted > 0) {
      await db.meta.put({ key: LAST_SYNC_META_KEY, value: Date.now() });
    }
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
