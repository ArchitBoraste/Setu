import bcrypt from "bcryptjs";
import { db, getAuthRow } from "../db/index.js";
import { apiFetch, ApiError, NetworkError } from "../lib/api.js";
import { ensurePersistentStorage } from "../lib/storage.js";

// How long a hash cached from an online login keeps working offline. A lost or
// stolen phone should stop opening after this, whatever the thief tries.
export const OFFLINE_LOGIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// No server enforces a lockout offline, so the device has to.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60 * 1000;

const LOGIN_PATH = "/api/auth/login";
const LOGOUT_PATH = "/api/auth/logout";

// A failure whose message is safe and meant to be shown to the user.
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

// The only view of the cached row that leaves this module. It never includes
// hashes or tokens.
function toUser(row) {
  return {
    userId: row.userId,
    phone: row.phone,
    fullName: row.fullName,
    role: row.role,
    organizationId: row.organizationId,
    // Undefined on rows cached before areas existed; null means "no area".
    // Both read the same everywhere they are used.
    areaId: row.areaId ?? null,
    areaName: row.areaName ?? null,
  };
}

function isExpired(row, now = Date.now()) {
  const age = now - row.cachedAt;
  // A negative age means the device clock was moved back past the login time.
  // Treat that as expired so the clock cannot be rewound to keep the hash valid.
  return age < 0 || age > OFFLINE_LOGIN_MAX_AGE_MS;
}

function lockRemainingMs(row, now = Date.now()) {
  return Math.max(0, (row.lockedUntil ?? 0) - now);
}

// Clear, then add, in one transaction. authCache holds one row for the device's
// current user (see db/index.js), so the previous user's hash, tokens and lockout
// state all go. The transaction means there is never a moment with zero rows or
// with two.
async function replaceAuthRow(row) {
  await db.transaction("rw", db.authCache, async () => {
    await db.authCache.clear();
    await db.authCache.add(row);
  });
}

async function recordFailedAttempt(userId) {
  await db.transaction("rw", db.authCache, async () => {
    const row = await db.authCache.get(userId);
    if (!row) return;

    const failedAttempts = row.failedAttempts + 1;
    // Only a successful login resets the count. Once past the limit, every further
    // wrong guess locks the device again, so guessing stays at about one per minute.
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS
        ? Date.now() + LOCKOUT_DURATION_MS
        : row.lockedUntil;

    await db.authCache.update(userId, { failedAttempts, lockedUntil });
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function loginOnline({ phone, password }) {
  const { accessToken, refreshToken, offlineHash, profile } = await apiFetch(
    LOGIN_PATH,
    { method: "POST", body: { phone, password }, auth: false }
  );

  const row = {
    userId: profile.id,
    phone: profile.phone,
    fullName: profile.fullName,
    role: profile.role,
    organizationId: profile.organizationId,
    // What the list shows a field worker: records of this area. Only a display
    // decision — the server reads the area from its own database on every sync
    // — and kept current by each sync (see updateCachedArea) so a worker moved
    // to another village does not have to sign out to see it.
    areaId: profile.areaId ?? null,
    areaName: profile.areaName ?? null,
    offlineHash,
    accessToken,
    refreshToken,
    cachedAt: Date.now(),
    failedAttempts: 0,
    lockedUntil: 0,
    sessionActive: true,
  };

  await replaceAuthRow(row);

  // Not awaited: signing in must not wait on a permission check, and a refusal
  // changes nothing about this login. See lib/storage.js for why the request
  // happens here rather than at startup.
  void ensurePersistentStorage();

  return toUser(row);
}

async function passwordMatches(row, password) {
  // bcrypt.compare(), never a string comparison against a freshly made hash.
  // Every bcrypt hash has its own random salt built in, so hashing the same
  // password twice gives two different strings and an equality check would always
  // fail. compare() reads the salt out of the stored hash, hashes the attempt with
  // that same salt, and compares the results in constant time.
  return bcrypt.compare(password, row.offlineHash);
}

async function loginOffline({ phone, password }) {
  const row = await getAuthRow();

  if (!row) {
    throw new AuthError(
      "You're offline. Sign in once with an internet connection to enable offline sign-in on this device."
    );
  }

  const lockMs = lockRemainingMs(row);
  if (lockMs > 0) {
    throw new AuthError(
      `Too many failed attempts. Try again in ${Math.ceil(lockMs / 1000)} seconds.`
    );
  }

  if (row.phone !== phone) {
    throw new AuthError(
      "You're offline. Offline sign-in only works for the last person who signed in online on this device."
    );
  }

  if (isExpired(row)) {
    throw new AuthError(
      "Offline sign-in has expired. Connect to the internet and sign in again."
    );
  }

  if (!(await passwordMatches(row, password))) {
    await recordFailedAttempt(row.userId);
    throw new AuthError("Incorrect phone number or password.");
  }

  // Tokens stay null: an offline login unlocks local data only. The server
  // session needs an online login.
  await db.authCache.update(row.userId, {
    failedAttempts: 0,
    lockedUntil: 0,
    sessionActive: true,
  });
  return toUser(row);
}

function toUserFacingError(error) {
  if (error instanceof ApiError && error.status === 401) {
    return new AuthError("Incorrect phone number or password.");
  }
  if (error instanceof ApiError) {
    return new AuthError(`Sign-in failed: ${error.message}`);
  }
  return error;
}

/**
 * Tries the server first and falls back to the cached hash only when the server
 * could not be reached. Resolves to { user, mode: "online" | "offline" }.
 */
export async function login(phone, password) {
  const credentials = { phone: phone.trim(), password };
  if (!credentials.phone || !credentials.password) {
    throw new AuthError("Enter your phone number and password.");
  }

  try {
    return { user: await loginOnline(credentials), mode: "online" };
  } catch (error) {
    // Only "never reached the server" (NetworkError: a fetch TypeError, a timeout,
    // or a proxy reporting the server down) may fall back. A 401 is the server
    // actively rejecting these credentials, maybe because the account was
    // disabled or the password changed since this device cached its hash. The
    // stale hash would still accept the old password, so falling back would
    // override the server and let a removed worker back in.
    if (error instanceof NetworkError) {
      return { user: await loginOffline(credentials), mode: "offline" };
    }
    throw toUserFacingError(error);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function revokeRefreshTokenQuietly(refreshToken) {
  try {
    await apiFetch(LOGOUT_PATH, {
      method: "POST",
      body: { refreshToken },
      auth: false,
    });
  } catch {
    // Deliberately ignored. The token is already gone from this device, and being
    // offline must never stop anyone from signing out. If the call fails, the
    // server copy simply expires on its own schedule.
  }
}

/**
 * Signs out. Tokens are deleted right away. The offline hash, profile, cachedAt
 * and lockout state stay, so the same person can sign in again offline. cachedAt
 * is left alone on purpose: resetting it would give a stolen phone a fresh 7 days.
 */
export async function logout() {
  const row = await getAuthRow();
  if (!row) return;

  // Delete locally first, before touching the network, so a slow or dead
  // connection can never leave tokens behind after sign-out.
  await db.authCache.update(row.userId, {
    accessToken: null,
    refreshToken: null,
    sessionActive: false,
  });

  if (row.refreshToken) {
    // Not awaited: on a dead uplink this could take the whole request timeout,
    // and sign-out is already complete locally.
    void revokeRefreshTokenQuietly(row.refreshToken);
  }
}

/**
 * Wipes every local table, not just authCache, so the next person to use a shared
 * phone cannot see the previous worker's data. This includes tables added in later
 * steps (collected records), because it goes through db.tables.
 */
export async function removeAccountFromDevice() {
  const row = await getAuthRow();

  await db.transaction("rw", db.tables, () =>
    Promise.all(db.tables.map((table) => table.clear()))
  );

  if (row?.refreshToken) void revokeRefreshTokenQuietly(row.refreshToken);
}

/**
 * Records the area the server says this user is in now.
 *
 * Called by the sync engine with the scope each pull reports. Guarded on the
 * user id, inside a transaction: authCache holds only the person signed in on
 * this device, and a sync that finishes after someone else has signed in must
 * not write the previous user's area onto the new user's row.
 */
export async function updateCachedArea(userId, { areaId, areaName }) {
  await db.transaction("rw", db.authCache, async () => {
    const row = await db.authCache.get(userId);
    if (!row) return;
    if (row.areaId === areaId && row.areaName === areaName) return;
    await db.authCache.update(userId, { areaId, areaName });
  });
}

/**
 * The signed-in user to restore on app start, or null. A signed-out or expired
 * row returns null, so the UI never renders a role that no one has signed in as.
 */
export async function getCachedUser() {
  const row = await getAuthRow();
  if (!row?.sessionActive || isExpired(row)) return null;
  return toUser(row);
}
