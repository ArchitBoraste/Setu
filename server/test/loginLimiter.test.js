import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_LIMITS,
  beginAttempt,
  createLimiterState,
  createLoginLimiter,
  normaliseLoginPhone,
  recordSuccess,
  releaseAttempt,
  retryAfterSeconds,
  sweep,
  tooManyAttemptsMessage,
} from "../utils/loginLimiter.js";

const MINUTE_MS = 60 * 1000;
const WINDOW_MS = LOGIN_LIMITS.perPhone.windowMs;
const PHONE = "8888888888";
const OTHER_PHONE = "7777777777";

// Any starting reading works: the limiter only ever subtracts clock readings.
const T0 = 1_000_000;

// `count` attempts for `phone`, one a second from `start`, each left standing
// as a failure (a wrong password makes no call after beginAttempt).
function fail(state, phone, count, start = T0) {
  for (let i = 0; i < count; i += 1) {
    const result = beginAttempt(state, phone, start + i * 1000);
    assert.equal(result.allowed, true, `attempt ${i + 1} for ${phone} should be let through`);
  }
}

// ---------------------------------------------------------------------------
// normaliseLoginPhone — the one spelling that is looked up and counted
// ---------------------------------------------------------------------------

describe("normaliseLoginPhone", () => {
  test("keeps ASCII digits, with or without a leading +", () => {
    assert.equal(normaliseLoginPhone("8888888888"), "8888888888");
    assert.equal(normaliseLoginPhone("+918888888888"), "+918888888888");
  });

  test("removes surrounding whitespace, so a pasted number with a stray space still counts as itself", () => {
    assert.equal(normaliseLoginPhone("  8888888888\t"), "8888888888");
  });

  // users.phone's collation matches these to "8888888888". Accepting them
  // would give one account endless spellings, each with a fresh count.
  test("refuses other scripts' digits that MySQL would match to the same account", () => {
    assert.equal(normaliseLoginPhone("८".repeat(10)), null); // Devanagari ८
    assert.equal(normaliseLoginPhone("８".repeat(10)), null); // fullwidth ８
    assert.equal(normaliseLoginPhone("88888८8888"), null);
  });

  // The device compares the phone exactly when it signs in offline.
  test("refuses inner spaces and dashes rather than stripping them", () => {
    assert.equal(normaliseLoginPhone("88888 88888"), null);
    assert.equal(normaliseLoginPhone("88888-88888"), null);
  });

  test("refuses anything else that cannot be a stored phone", () => {
    for (const bad of ["", "   ", "+", "++91", "91+88", "abc", "8".repeat(21), 8888888888, null, undefined]) {
      assert.equal(normaliseLoginPhone(bad), null, JSON.stringify(bad));
    }
  });

  test("accepts up to the column's 20 characters", () => {
    assert.equal(normaliseLoginPhone("8".repeat(20)), "8".repeat(20));
    assert.equal(normaliseLoginPhone(`+${"8".repeat(19)}`), `+${"8".repeat(19)}`);
    assert.equal(normaliseLoginPhone(`+${"8".repeat(20)}`), null);
  });
});

// ---------------------------------------------------------------------------
// The per-phone limit: five tries per 15 minutes
// ---------------------------------------------------------------------------

describe("per-phone limit", () => {
  test("under the limit: four failures, and the fifth try is still let through", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 4);
    assert.equal(beginAttempt(state, PHONE, T0 + 10_000).allowed, true);
  });

  test("at the limit: the sixth try is refused, with the wait until the first failure ages out", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5); // at T0 .. T0 + 4s

    const now = T0 + 10_000;
    const result = beginAttempt(state, PHONE, now);
    assert.deepEqual(result, { allowed: false, retryAfterMs: T0 + WINDOW_MS - now });
  });

  test("a correct password is refused too while the phone is locked", () => {
    // The limiter is consulted before the password is looked at, so it cannot
    // tell a correct one from a wrong one. That is the point: it is what makes
    // a locked phone worthless to someone guessing.
    const state = createLimiterState(T0);
    fail(state, PHONE, 5);
    assert.equal(beginAttempt(state, PHONE, T0 + 60_000).allowed, false);
  });

  test("refused tries are not counted, so retrying while locked does not extend the lock", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5);

    for (let t = T0 + MINUTE_MS; t < T0 + WINDOW_MS; t += MINUTE_MS) {
      const result = beginAttempt(state, PHONE, t);
      assert.equal(result.allowed, false);
      assert.equal(result.retryAfterMs, T0 + WINDOW_MS - t);
    }
    assert.equal(state.phones.get(PHONE).length, 5);
  });

  test("window expiry: allowed again the moment the oldest failure is 15 minutes old", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5); // at T0 .. T0 + 4s

    assert.equal(beginAttempt(state, PHONE, T0 + WINDOW_MS - 1).allowed, false);
    assert.equal(beginAttempt(state, PHONE, T0 + WINDOW_MS).allowed, true);
  });

  test("the window slides: one failure ageing out frees one try, not five", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5); // at T0 .. T0 + 4s

    // The first failure has aged out; this try fails and takes its place.
    assert.equal(beginAttempt(state, PHONE, T0 + WINDOW_MS).allowed, true);
    // The second failure (T0 + 1s) is still inside the window.
    const result = beginAttempt(state, PHONE, T0 + WINDOW_MS + 500);
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterMs, 500);
  });

  test("a different phone is unaffected by one that is locked", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5);
    assert.equal(beginAttempt(state, OTHER_PHONE, T0 + 10_000).allowed, true);
  });

  test("success resets: a correct password clears the phone's failures", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 4);

    const result = beginAttempt(state, PHONE, T0 + 10_000);
    recordSuccess(state, result.attempt);

    assert.equal(state.phones.has(PHONE), false);
    fail(state, PHONE, 5, T0 + 20_000);
    assert.equal(beginAttempt(state, PHONE, T0 + 30_000).allowed, false);
  });

  test("success clears only its own phone", () => {
    const state = createLimiterState(T0);
    fail(state, OTHER_PHONE, 3);

    const result = beginAttempt(state, PHONE, T0 + 10_000);
    recordSuccess(state, result.attempt);

    assert.equal(state.phones.get(OTHER_PHONE).length, 3);
  });

  // Counting only once bcrypt had said "wrong" would let every request fired
  // before the first answer through.
  test("tries still in flight count, so a burst of concurrent guesses gets only five through", () => {
    const state = createLimiterState(T0);
    const results = Array.from({ length: 50 }, () => beginAttempt(state, PHONE, T0));
    assert.equal(results.filter((r) => r.allowed).length, 5);
  });

  test("a try that broke before the password was judged is released and does not count", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 4);

    const result = beginAttempt(state, PHONE, T0 + 10_000);
    releaseAttempt(state, result.attempt);

    assert.equal(state.phones.get(PHONE).length, 4);
    assert.equal(state.global.length, 4);
    assert.equal(beginAttempt(state, PHONE, T0 + 11_000).allowed, true);
  });

  test("releasing a phone's only try leaves no entry behind", () => {
    const state = createLimiterState(T0);
    const result = beginAttempt(state, PHONE, T0);
    releaseAttempt(state, result.attempt);
    assert.equal(state.phones.has(PHONE), false);
    assert.deepEqual(state.global, []);
  });
});

// ---------------------------------------------------------------------------
// The global cap: 100 failures a minute across every phone
// ---------------------------------------------------------------------------

describe("global cap", () => {
  const MAX = LOGIN_LIMITS.global.max;

  // One failure on each of `count` different numbers, as a password spray
  // would make them, each 100 ms apart from `start`.
  function spray(state, count, start = T0) {
    for (let i = 0; i < count; i += 1) {
      const result = beginAttempt(state, `9000${String(i).padStart(6, "0")}`, start + i * 100);
      assert.equal(result.allowed, true, `spray attempt ${i + 1}`);
    }
  }

  test("100 failures on 100 different numbers within a minute refuse the next sign-in, whatever its number", () => {
    const state = createLimiterState(T0);
    spray(state, MAX); // at T0 .. T0 + 9.9s

    const now = T0 + 20_000;
    const result = beginAttempt(state, PHONE, now);
    assert.deepEqual(result, { allowed: false, retryAfterMs: T0 + MINUTE_MS - now });
    // A number refused by the cap gets no entry of its own.
    assert.equal(state.phones.has(PHONE), false);
  });

  test("lifts as the spray's failures age out of the minute", () => {
    const state = createLimiterState(T0);
    spray(state, MAX);
    assert.equal(beginAttempt(state, PHONE, T0 + MINUTE_MS - 1).allowed, false);
    assert.equal(beginAttempt(state, PHONE, T0 + MINUTE_MS).allowed, true);
  });

  test("successful sign-ins do not count toward it", () => {
    const state = createLimiterState(T0);
    for (let i = 0; i < MAX * 2; i += 1) {
      const result = beginAttempt(state, `9000${String(i).padStart(6, "0")}`, T0 + i);
      assert.equal(result.allowed, true);
      recordSuccess(state, result.attempt);
    }
    assert.deepEqual(state.global, []);
  });

  test("when both limits apply, the wait reported is the longer one", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 5); // the phone is locked until T0 + 15 min
    spray(state, MAX - 5, T0 + 10_000); // and the minute's cap is now full

    const result = beginAttempt(state, PHONE, T0 + 30_000);
    assert.equal(result.retryAfterMs, T0 + WINDOW_MS - (T0 + 30_000));
  });
});

// ---------------------------------------------------------------------------
// Pruning — the map cannot grow forever
// ---------------------------------------------------------------------------

describe("pruning", () => {
  test("sweep drops phones whose every try has aged out, and keeps the rest", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 3, T0);
    fail(state, OTHER_PHONE, 2, T0 + 10 * MINUTE_MS);

    sweep(state, T0 + WINDOW_MS + 10_000);

    assert.equal(state.phones.has(PHONE), false);
    assert.deepEqual(state.phones.get(OTHER_PHONE), [T0 + 10 * MINUTE_MS, T0 + 10 * MINUTE_MS + 1000]);
  });

  test("sweep trims the aged-out part of a phone that still has recent tries", () => {
    const state = createLimiterState(T0);
    fail(state, PHONE, 1, T0);
    fail(state, PHONE, 1, T0 + 10 * MINUTE_MS);

    sweep(state, T0 + WINDOW_MS);

    assert.deepEqual(state.phones.get(PHONE), [T0 + 10 * MINUTE_MS]);
  });

  test("runs by itself from a sign-in once the interval has passed, and not before", () => {
    const state = createLimiterState(T0);
    for (let i = 0; i < 50; i += 1) fail(state, `9000${String(i).padStart(6, "0")}`, 1, T0 + i);
    assert.equal(state.phones.size, 50);

    // A sweep just before they age out keeps all 50...
    const lastSweep = T0 + WINDOW_MS - 1;
    sweep(state, lastSweep);
    assert.equal(state.phones.size, 50);

    // ...and although every one has aged out by now, the next is not due yet...
    beginAttempt(state, PHONE, lastSweep + LOGIN_LIMITS.sweepEveryMs - 1);
    assert.equal(state.phones.size, 51);

    // ...so it is the first sign-in after the interval that clears them.
    beginAttempt(state, OTHER_PHONE, lastSweep + LOGIN_LIMITS.sweepEveryMs);
    assert.deepEqual([...state.phones.keys()].sort(), [OTHER_PHONE, PHONE].sort());
  });

  // 100 new numbers every minute for two hours, as fast as the global cap
  // allows. Without pruning the map would end with 12,000 entries.
  test("a sustained spray of fresh numbers holds about 16 minutes' worth of phones, not all of them", () => {
    const state = createLimiterState(T0);
    let peak = 0;
    for (let minute = 0; minute < 120; minute += 1) {
      for (let i = 0; i < LOGIN_LIMITS.global.max; i += 1) {
        const now = T0 + minute * MINUTE_MS + i * 100;
        assert.equal(beginAttempt(state, `${minute}-${i}`, now).allowed, true);
        peak = Math.max(peak, state.phones.size);
      }
    }
    assert.ok(peak <= LOGIN_LIMITS.global.max * 17, `peak ${peak}`);
    assert.ok(state.phones.size <= LOGIN_LIMITS.global.max * 17, `final ${state.phones.size}`);
  });
});

// ---------------------------------------------------------------------------
// What the client is told
// ---------------------------------------------------------------------------

describe("retryAfterSeconds and tooManyAttemptsMessage", () => {
  test("round up, so the client is never told to retry before it may", () => {
    assert.equal(retryAfterSeconds(1), 1);
    assert.equal(retryAfterSeconds(1000), 1);
    assert.equal(retryAfterSeconds(1001), 2);
    assert.equal(retryAfterSeconds(WINDOW_MS), 900);
  });

  test("never say zero while still refusing", () => {
    assert.equal(retryAfterSeconds(0.4), 1);
    assert.equal(tooManyAttemptsMessage(400), "Too many attempts. Try again in 1 minute.");
  });

  test("say whole minutes, rounded up", () => {
    assert.equal(tooManyAttemptsMessage(WINDOW_MS), "Too many attempts. Try again in 15 minutes.");
    assert.equal(tooManyAttemptsMessage(14 * MINUTE_MS + 1), "Too many attempts. Try again in 15 minutes.");
    assert.equal(tooManyAttemptsMessage(MINUTE_MS), "Too many attempts. Try again in 1 minute.");
    assert.equal(tooManyAttemptsMessage(MINUTE_MS + 1), "Too many attempts. Try again in 2 minutes.");
  });
});

// ---------------------------------------------------------------------------
// createLoginLimiter — the functions bound to one state and an injected clock
// ---------------------------------------------------------------------------

describe("createLoginLimiter", () => {
  test("locks, unlocks and resets on success through the clock it is given", () => {
    let now = T0;
    const limiter = createLoginLimiter({ now: () => now });

    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.begin(PHONE).allowed, true);
      now += 1000;
    }
    const refused = limiter.begin(PHONE);
    assert.equal(refused.allowed, false);
    assert.equal(retryAfterSeconds(refused.retryAfterMs), 895);

    now = T0 + WINDOW_MS;
    const allowed = limiter.begin(PHONE);
    assert.equal(allowed.allowed, true);
    limiter.succeeded(allowed.attempt);

    for (let i = 0; i < 5; i += 1) assert.equal(limiter.begin(PHONE).allowed, true);
  });

  test("defaults to a clock that works without being given one", () => {
    const limiter = createLoginLimiter();
    const result = limiter.begin(PHONE);
    assert.equal(result.allowed, true);
    limiter.release(result.attempt);
  });
});
