import { apiFetch } from "../lib/api.js";

// THE ONE ONLINE-ONLY SURFACE IN client/src, AND WHY IT IS ALLOWED TO BE.
//
// Everything else in this folder tree reads and writes IndexedDB and lets the
// sync layer move data later, because a field worker's ability to record a
// household visit must not depend on a network that is not there. This file
// breaks that pattern on purpose, and the reason is written out at the top of
// server/sync/conflictRules.js: resolving a conflict is a privileged decision
// taken by one person about two versions of someone else's data, and two
// supervisors resolving the same conflict from two offline devices is a conflict
// about a conflict, which the version ladder cannot order and human judgement
// does not merge.
//
// What that costs, and what it does not:
//
//   it does not touch capture.   No path a field worker uses to save, edit or
//                                sync a record passes through here. A supervisor
//                                with no signal still captures records exactly
//                                like anybody else.
//   it fails loudly, not oddly.  The screen reports that it needs a connection
//                                and shows nothing stale. It never renders a
//                                cached queue that a supervisor might act on,
//                                because the act would be taken against a
//                                version of the world that has moved.
//   nothing is lost by waiting.  An unresolved conflict is two whole copies,
//                                both safe. A decision deferred is the correct
//                                failure here; a decision taken twice is not.
//
// Every call goes through apiFetch on a relative /api/ path, so the Vite dev
// proxy and production Nginx both route it — an absolute URL would bypass both.

const CONFLICTS_PATH = "/api/conflicts";

/**
 * One page of the organisation's queue, oldest first.
 *
 * @param {object}  options
 * @param {string}  options.status  "open" | "resolved"
 * @param {object=} options.after   { createdAt, id } from a previous page
 */
export function listConflicts({ status = "open", after = null, limit = 50 } = {}) {
  const params = new URLSearchParams({ status, limit: String(limit) });
  if (after) {
    // Both halves of the keyset or neither: half of one would restart the
    // sequence at the top of the queue and repeat every row before it.
    params.set("afterCreatedAt", after.createdAt);
    params.set("afterId", after.id);
  }
  return apiFetch(`${CONFLICTS_PATH}?${params.toString()}`);
}

/**
 * Closes one conflict.
 *
 * `payload` is sent only for a merge. The server decides everything else — which
 * version wins, what the new version number is, what the timestamp is — because
 * the client decides what to RENDER and the server decides what is ALLOWED, and
 * a resolution is a write to somebody's collected data.
 *
 * Not retried on failure, unlike a push. A push is idempotent by design and a
 * lost response costs a duplicate the server recognises; this is not, and a
 * retried resolution that actually landed the first time would be refused as
 * already-resolved anyway. A supervisor pressing the button again is a person
 * deciding to, which is the right way for this particular request to repeat.
 */
export function resolveConflict(conflictId, resolution, payload) {
  return apiFetch(`${CONFLICTS_PATH}/${conflictId}/resolve`, {
    method: "POST",
    body: payload === undefined ? { resolution } : { resolution, payload },
  });
}
