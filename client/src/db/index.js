import Dexie from "dexie";

export const db = new Dexie("setu");

// Only primary keys are declared. Nothing is looked up by any other field yet,
// and every extra index is one more structure IndexedDB updates on each write.
db.version(1).stores({
  // Exactly one row, ever: the person who last signed in online on this device.
  // Field phones are often shared between workers, and this row holds an offline
  // password hash plus tokens that act on the server as that person. Keeping a
  // second user's row around would let whoever holds the phone attack a
  // colleague's hash offline, or sync data under the wrong identity. A new online
  // login therefore replaces the row instead of adding one.
  authCache: "userId",

  // Generic key/value store. Will hold the sync cursor in a later step.
  meta: "key",
});

// authCache holds at most one row, so "the" row is simply the first one.
export function getAuthRow() {
  return db.authCache.toCollection().first();
}
