import Dexie from "dexie";
import { toServerTimeString } from "../lib/time.js";

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

// Version 1 above is never edited, only added to. Devices in the field already
// hold v1 data, and IndexedDB replays the version chain to upgrade them in
// place. Changing v1 would make a phone that skipped this release open a
// database whose shape no longer matches what v1 declared.
db.version(2).stores({
  // Collected field data. Mirrors the server `records` table, plus three
  // local-only fields (syncState, localUpdatedAt, serverUpdatedAt).
  //
  // [createdBy+localUpdatedAt] lists one worker's records newest first. Phones
  // are shared, so every list query is scoped by createdBy, never global.
  // [createdBy+syncState] finds that worker's unsynced rows: the pending count
  // now, and the push queue in the sync step.
  //
  // deletedAt is deliberately not indexed. IndexedDB leaves a row out of an
  // index when the key is null, so an index on it would hide exactly the live
  // rows we want. Soft-deleted rows are filtered in JS instead.
  records: "id, [createdBy+localUpdatedAt], [createdBy+syncState]",
});

// Version 3 adds fields, not indexes, so it inherits v2's stores and only runs
// an upgrade. v2 is left exactly as it shipped: phones in the field are still
// on it, and IndexedDB replays the chain from whatever version a device holds.
//
// The backfill writes explicit nulls instead of leaving the fields undefined.
// The two are not interchangeable in IndexedDB: a row whose indexed field is
// undefined is dropped from that index entirely, and `where("syncedVersion")`
// style queries in the sync step would silently skip exactly the old rows that
// have never been synced.
db.version(3).upgrade((tx) =>
  tx
    .table("records")
    .toCollection()
    .modify((row) => {
      // Never synced, so there is no server-confirmed version yet.
      row.syncedVersion ??= null;
      // Everything captured before form versioning came from revision 1.
      row.formVersion ??= 1;
      // No rejected server copy waiting to be compared.
      row.serverConflict ??= null;
    })
);

// Version 4 adds fields and normalises one, so like v3 it inherits v2's stores
// and only runs an upgrade. v2 and v3 are left exactly as they shipped.
db.version(4).upgrade((tx) =>
  tx
    .table("records")
    .toCollection()
    .modify((row) => {
      // No supervisor decision has landed on this row.
      row.resolvedNotice ??= null;

      // THE MIXED-TYPE FIX.
      //
      // deletedAt held a device-clock NUMBER when the delete was made here and a
      // server date STRING when the row arrived through a pull. Both are on
      // phones in the field right now, in the same column, and a comparison
      // across the two does not throw — it coerces the string to NaN and returns
      // false for `>`, `<` and `===` alike. Every device is converted once, on
      // upgrade, so nothing downstream ever has to ask which kind it is holding.
      //
      // `??=` is deliberately not used: a live row's deletedAt is an explicit
      // null and must stay one, and only the numbers need converting.
      if (typeof row.deletedAt === "number") {
        row.deletedAt = toServerTimeString(row.deletedAt);
      }
    })
);

// Fired when another tab running newer code wants to upgrade the schema. Until
// this tab closes the database, that upgrade is blocked and the new tab hangs on
// an unopened database. Closing here unblocks it; this tab's own queries then
// fail, so it has to reload to come back with the new schema.
export const DATABASE_OUTDATED_EVENT = "setu:database-outdated";

let databaseOutdated = false;

// Closing is not enough on its own: Dexie reopens transparently on the next
// query, and it will happily attach to the upgraded database while still
// holding this tab's older schema. Writes from here would then be shaped for a
// schema nobody expects any more, so the write paths check this flag and refuse
// until the page reloads.
export function isDatabaseOutdated() {
  return databaseOutdated;
}

db.on("versionchange", () => {
  databaseOutdated = true;
  db.close();
  // A banner asking the user to reload, rather than a silent location.reload():
  // this tab may have a half-filled form on screen, and reloading under them is
  // the same mistake as an auto-updating service worker.
  window.dispatchEvent(new Event(DATABASE_OUTDATED_EVENT));
});

// authCache holds at most one row, so "the" row is simply the first one.
export function getAuthRow() {
  return db.authCache.toCollection().first();
}
