import { describe, test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { isServerTime, shortTime, toServerTimeString, toStoredTime } from "../src/lib/time.js";

// A zone far from UTC, so a formatter that quietly switched to the UTC getters
// would fail here rather than only on a phone in the field. Node re-reads TZ on
// assignment, and every test file runs in its own process.
process.env.TZ = "Asia/Kolkata";

// 15:16:21.934 in India, 09:46:21.934 UTC.
const AT = Date.UTC(2026, 8, 22, 9, 46, 21, 934);

describe("toServerTimeString", () => {
  test("a deletion made offline is dated in the device's wall time, in the server's shape", () => {
    assert.equal(toServerTimeString(AT), "2026-09-22 15:16:21.934000");
  });

  test("single-digit months, days, hours and milliseconds are zero-padded to fixed width", () => {
    const early = Date.UTC(2026, 0, 4, 21, 34, 5, 7); // 2026-01-05 03:04:05.007 IST
    assert.equal(toServerTimeString(early), "2026-01-05 03:04:05.007000");
  });

  test("without an argument it reads the device clock", (t) => {
    t.mock.method(Date, "now", () => AT);
    assert.equal(toServerTimeString(), "2026-09-22 15:16:21.934000");
  });

  test("every value it produces is in the exact shape the server emits", () => {
    for (const ms of [AT, 0, Date.UTC(2026, 11, 31, 18, 29, 59, 999)]) {
      assert.ok(isServerTime(toServerTimeString(ms)), toServerTimeString(ms));
    }
  });

  // Regression: device-clock numbers and server strings in one column did not
  // compare at all; everything must now sort chronologically as plain text.
  test("device-dated and server-dated tombstones sort chronologically as plain strings", () => {
    const localDeletion = toServerTimeString(AT);
    const serverDeletion = "2026-09-22 15:16:22.000000";
    assert.ok(localDeletion < serverDeletion);

    // Without padding, "2026-9-..." would sort after "2026-10-...".
    const september = toServerTimeString(Date.UTC(2026, 8, 9, 3, 0, 0, 0));
    const october = toServerTimeString(Date.UTC(2026, 9, 10, 3, 0, 0, 0));
    assert.ok(september < october);
  });
});

describe("isServerTime", () => {
  test("the server's own timestamp shape is recognised", () => {
    assert.ok(isServerTime("2026-09-22 15:16:21.934000"));
  });

  test("the device clock's own formats are not mistaken for a server timestamp", () => {
    for (const value of [
      1790083255000,
      "1790083255000",
      "2026-09-22T15:16:21.934Z",
      "2026-09-22 15:16:21",
      "2026-09-22 15:16:21.934",
      "2026-09-22",
      null,
      undefined,
    ]) {
      assert.equal(isServerTime(value), false, String(value));
    }
  });
});

describe("toStoredTime", () => {
  test("a live row's missing deletion stays missing", () => {
    assert.equal(toStoredTime(null), null);
    assert.equal(toStoredTime(undefined), null);
  });

  test("a device-clock number left on a phone by an old build becomes the server's shape", () => {
    assert.equal(toStoredTime(AT), "2026-09-22 15:16:21.934000");
  });

  test("a server timestamp is kept byte for byte, never reparsed into this phone's zone", () => {
    const fromServer = "2026-09-22 03:00:00.123000";
    assert.equal(toStoredTime(fromServer), fromServer);
  });
});

describe("shortTime", () => {
  test("a server timestamp is shown to the minute exactly as the server wrote it", () => {
    // Were this reparsed with new Date(), the phone's zone would shift it.
    assert.equal(shortTime("2026-09-22 15:16:21.934000"), "2026-09-22 15:16");
  });

  test("a missing or non-text value shows nothing rather than a guess", () => {
    for (const value of [null, undefined, 1790083255000]) {
      assert.equal(shortTime(value), null);
    }
  });
});
