// Throttles failed sign-ins on POST /api/auth/login.
//
// No imports, on purpose: the decisions are plain functions over a state
// object and a clock reading, so they can be unit-tested without .env, a
// database or real time passing (the same reason refreshTokenRules.js exists).
//
// IN MEMORY AND PER PROCESS. A restart forgets every count, and if the server
// ever runs as several processes each one keeps its own counts, so a phone gets
// five tries per process. That is fine for the one Node process this project
// runs. Running more than one would need the counts in a shared store (Redis,
// or a MySQL table) first.
//
// KEYED BY PHONE NUMBER, NOT IP ADDRESS. Behind the Vite preview proxy and the
// Cloudflare tunnel every request arrives from 127.0.0.1, so an IP key would
// put every field worker in the demo in one bucket, and five typos from anyone
// would lock out all of them. The phone is also what an attacker guessing a
// password has to hold fixed.

const MINUTE_MS = 60 * 1000;

export const LOGIN_LIMITS = Object.freeze({
  // Five tries per number per 15 minutes, counted over a sliding window.
  perPhone: Object.freeze({ max: 5, windowMs: 15 * MINUTE_MS }),
  // A brake on spraying one common password across many numbers, which the
  // per-phone limit cannot see because each number is tried once. It refuses
  // EVERY sign-in while it is engaged, correct passwords included: without
  // running bcrypt there is no telling them apart, and running bcrypt is what
  // the brake exists to avoid.
  global: Object.freeze({ max: 100, windowMs: MINUTE_MS }),
  // How often a request also clears out numbers whose attempts have all aged
  // out of the window. See sweep().
  sweepEveryMs: MINUTE_MS,
});

// users.phone is VARCHAR(20).
const PHONE_MAX_LENGTH = 20;
const CANONICAL_PHONE = /^\+?[0-9]+$/;

/**
 * The one spelling of a phone number that sign-in looks up and counts
 * attempts against, or null if `raw` is not a phone number.
 *
 * ASCII digits only, with an optional leading "+". users.phone uses
 * utf8mb4_0900_ai_ci, which matches Devanagari "८८८८८८८८८८" and fullwidth
 * "８８８８８８８８８８" to the row for "8888888888". If the lookup accepted
 * those, one account could be reached under a practically unlimited number of
 * spellings, each with a count of its own, and the per-phone limit would never
 * engage. So the lookup and the count both use this string, and nothing else
 * reaches the database.
 *
 * Only surrounding whitespace is removed. Inner spaces or dashes are refused
 * rather than stripped: the device compares the phone exactly when it signs in
 * offline, so a server that quietly accepted "88888 88888" would let a worker
 * sign in online with a spelling that then fails offline.
 */
export function normaliseLoginPhone(raw) {
  if (typeof raw !== "string") return null;
  const phone = raw.trim();
  if (phone.length > PHONE_MAX_LENGTH || !CANONICAL_PHONE.test(phone)) return null;
  return phone;
}

/**
 * Empty limiter state. `now` is the clock reading it is created at, so the
 * first sweep happens a full interval later rather than on the first request.
 */
export function createLimiterState(now) {
  return {
    // phone -> ascending timestamps of its attempts still inside the window,
    // never more than perPhone.max of them.
    phones: new Map(),
    // Ascending timestamps of attempts, across all phones, still inside the
    // global window and not yet known to have succeeded.
    global: [],
    lastSweepAt: now,
  };
}

// An attempt counts while now < at + windowMs. At exactly at + windowMs it has
// aged out, which is the moment Retry-After pointed the client to.
function dropExpired(log, now, windowMs) {
  let expired = 0;
  while (expired < log.length && log[expired] + windowMs <= now) expired += 1;
  if (expired > 0) log.splice(0, expired);
}

// Removes one entry with this timestamp. Two attempts in the same millisecond
// are interchangeable, so it does not matter which one goes.
function removeOne(log, at) {
  const index = log.lastIndexOf(at);
  if (index !== -1) log.splice(index, 1);
}

// How long until enough attempts age out for one more to be allowed. With
// `max` entries in the log that is when its oldest one leaves the window.
function waitMs(log, { max, windowMs }, now) {
  return log[log.length - max] + windowMs - now;
}

/**
 * Drops every attempt that has aged out of its window, and every phone left
 * with none.
 *
 * Without this the map would keep one entry for every number ever tried. With
 * it, an entry outlives its phone's last attempt by at most windowMs plus
 * sweepEveryMs. New entries come only from attempts the global cap let through,
 * and an attempt that succeeds deletes its phone's entry, so at most about
 * 100 failed attempts a minute × 16 minutes ≈ 1,600 phones are held at once,
 * each with no more than five numbers.
 */
export function sweep(state, now, limits = LOGIN_LIMITS) {
  // Deleting the entry being visited is safe during a Map's for...of.
  for (const [phone, log] of state.phones) {
    dropExpired(log, now, limits.perPhone.windowMs);
    if (log.length === 0) state.phones.delete(phone);
  }
  dropExpired(state.global, now, limits.global.windowMs);
  state.lastSweepAt = now;
}

/**
 * Decides whether a sign-in for `phone` may check its password at `now`.
 *
 * Returns { allowed: false, retryAfterMs } when it may not, and records
 * nothing: a refused request never reached bcrypt, so it is not a failed
 * guess. In particular a worker retrying while locked out does not push their
 * own lockout further away.
 *
 * Returns { allowed: true, attempt } when it may, and the attempt is counted
 * NOW, before the password is checked, not once it fails. Counting on failure
 * would let a caller fire fifty guesses at once: all fifty would pass this
 * check before the first bcrypt finished and recorded anything. Counted up
 * front, the sixth concurrent request is refused. The caller then reports how
 * the attempt ended:
 *   - a wrong password needs no call; the attempt already counts as the failure
 *   - recordSuccess() when the password was right
 *   - releaseAttempt() when the request broke before the password was judged
 */
export function beginAttempt(state, phone, now, limits = LOGIN_LIMITS) {
  if (now - state.lastSweepAt >= limits.sweepEveryMs) sweep(state, now, limits);

  const phoneLog = state.phones.get(phone) ?? [];
  dropExpired(phoneLog, now, limits.perPhone.windowMs);
  dropExpired(state.global, now, limits.global.windowMs);

  const waits = [];
  if (phoneLog.length >= limits.perPhone.max) {
    waits.push(waitMs(phoneLog, limits.perPhone, now));
  }
  if (state.global.length >= limits.global.max) {
    waits.push(waitMs(state.global, limits.global, now));
  }

  if (waits.length > 0) {
    // dropExpired may have just emptied an existing entry; do not keep it.
    if (phoneLog.length === 0) state.phones.delete(phone);
    // Both limits have to clear before the request would be let through.
    return { allowed: false, retryAfterMs: Math.max(...waits) };
  }

  phoneLog.push(now);
  state.phones.set(phone, phoneLog);
  state.global.push(now);
  return { allowed: true, attempt: { phone, at: now } };
}

/**
 * The password was right. The phone starts again from zero, and the attempt no
 * longer counts toward the global cap, which is about FAILED sign-ins: a busy
 * morning of correct logins must not trip it.
 */
export function recordSuccess(state, attempt) {
  state.phones.delete(attempt.phone);
  removeOne(state.global, attempt.at);
}

/**
 * The request failed before the password was judged (the database was down,
 * say). That tells us nothing about the password, so it must not count:
 * otherwise five retries during an outage would lock a worker out for
 * 15 minutes after it ended.
 */
export function releaseAttempt(state, attempt) {
  const log = state.phones.get(attempt.phone);
  if (log) {
    removeOne(log, attempt.at);
    if (log.length === 0) state.phones.delete(attempt.phone);
  }
  removeOne(state.global, attempt.at);
}

/** Whole seconds for the Retry-After header, never 0 while still refused. */
export function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** What the sign-in screen shows. Rounded up, so it never says "0 minutes". */
export function tooManyAttemptsMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / MINUTE_MS));
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * The limiter the login route holds: the functions above bound to one state
 * object and a clock.
 *
 * The default clock is performance.now(), which only ever moves forward. These
 * timestamps are never stored or compared with anything outside this process,
 * so wall-clock time has nothing to add, and an NTP correction stepping
 * Date.now() back would stretch every lockout by that much.
 */
export function createLoginLimiter({ limits = LOGIN_LIMITS, now = () => performance.now() } = {}) {
  const state = createLimiterState(now());
  return {
    begin: (phone) => beginAttempt(state, phone, now(), limits),
    succeeded: (attempt) => recordSuccess(state, attempt),
    release: (attempt) => releaseAttempt(state, attempt),
  };
}
