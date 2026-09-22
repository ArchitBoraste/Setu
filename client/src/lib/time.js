// ONE REPRESENTATION FOR EVERY TIMESTAMP THAT CAN COME FROM EITHER SIDE.
//
// The problem this closes: deletedAt used to hold a number when a worker deleted
// a row here (Date.now()) and a server date string when the same row arrived
// through a pull. Nothing compared them, because deletedAt was only ever tested
// against null — but `1790083255000 > "2026-09-22 15:16:21.934000"` is false,
// and so is `<`, because JS coerces the string to NaN. A screen that sorts or
// filters by that column would not throw, would not warn, and would quietly put
// half the tombstones in the wrong place. That is the kind of wrong answer
// nobody finds.
//
// The representation is the SERVER's: "YYYY-MM-DD HH:MM:SS.ffffff", exactly the
// shape DATE_FORMAT(..., '%Y-%m-%d %H:%i:%s.%f') produces. Three reasons it wins
// over epoch millis:
//
//   1. It is the only lossless choice. Converting the server's string to a
//      number means parsing it, and it carries no timezone — so new Date(...)
//      reads it in whatever zone the phone is set to. A device that crosses a
//      border, or whose owner changes the region setting, would silently shift
//      every tombstone it holds by hours. Storing the string keeps the value the
//      server minted, byte for byte, the same rule the sync cursor follows.
//
//   2. Fixed width means lexicographic order IS chronological order, so sorting
//      and filtering are plain string comparisons and no Date is ever built.
//
//   3. It already matches serverUpdatedAt and the server copy held in
//      serverConflict, so the sync-facing fields on a row read alike.
//
// THE LOCAL SIDE IS PROVISIONAL, AND SAYS SO.
//
// A soft delete offline has to write some date before it can be sent, and the
// only clock the device has is its own. toServerTimeString() formats that clock
// in the device's own wall time, which is the closest a phone can get to what
// the server would have written — the server's DATETIME(3) columns are in the
// server's local zone, not UTC, so formatting as UTC would be wrong by the
// server's offset every single time.
//
// That value survives exactly until the first successful push: POST
// /api/sync/push now returns the authoritative deletedAt, and applyResults()
// overwrites the guess with it. So a device-clock date is only ever the answer
// while a deletion is unsent — and during that window it affects the local list
// order and nothing else, because sync orders by `version` and the server's
// updated_at, never by this.

// The exact shape the server produces. Six fractional digits: DATETIME(3) gives
// three significant ones followed by three zeros.
const SERVER_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

export function isServerTime(value) {
  return typeof value === "string" && SERVER_TIME_RE.test(value);
}

const pad = (value, width = 2) => String(value).padStart(width, "0");

/**
 * The device clock, written in the server's timestamp shape.
 *
 * Local getters, not the UTC ones, for the reason above: the column this
 * imitates is in the server's local zone. Padded to six fractional digits so
 * every value in the field is the same width and string comparison stays sound.
 */
export function toServerTimeString(ms = Date.now()) {
  const at = new Date(ms);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.` +
    `${pad(at.getMilliseconds(), 3)}000`
  );
}

/**
 * Accepts either representation and returns the server shape.
 *
 * Only for the v4 upgrade and for defence at write boundaries. Everything
 * written after this release is already a string; this is what converts the
 * numbers sitting on phones in the field today.
 */
export function toStoredTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return toServerTimeString(value);
  return value;
}

/**
 * For display: "2026-09-22 15:16:21.934000" -> "2026-09-22 15:16".
 *
 * Sliced, never passed through new Date(). The string carries no timezone, so
 * reparsing it would render it in the phone's zone and show a confident, wrong
 * time for something that happened on another machine. Sync stopped depending on
 * this device's clock; a label should not quietly put it back.
 */
export function shortTime(value) {
  return typeof value === "string" ? value.slice(0, 16) : null;
}
