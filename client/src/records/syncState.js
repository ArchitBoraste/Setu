// The four states a local record can be in, in a module of their own.
//
// Split out of recordService.js so the pull decision table in
// sync/pullRules.js can name them without importing recordService — which pulls
// in Dexie, which needs IndexedDB, which would make the single most dangerous
// function in the sync engine untestable outside a browser. recordService
// re-exports this, so every existing import keeps working.

export const SYNC_STATE = {
  // Local changes the server has not accepted yet.
  PENDING: "pending",
  // Server and device agree, as of serverUpdatedAt.
  SYNCED: "synced",
  // Both sides changed the row since the last sync. Needs a human or a rule.
  CONFLICT: "conflict",
  // The server refused the row outright — a malformed payload, a version it
  // never issued, a row belonging to someone else. Held apart from PENDING so
  // the push queue, which selects only PENDING, can never pick it up again:
  // nothing about resending an invalid record makes it valid. The reason lives
  // in the row's syncError, and the row itself is never deleted.
  REJECTED: "rejected",
};
