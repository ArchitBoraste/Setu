import { db, getAuthRow } from "../db/index.js";
import {
  REFRESH_DECISION,
  REFRESH_LOCK_NAME,
  decideTokenRefresh,
} from "./tokenRefresh.js";

// A dead uplink (wifi connected, internet not) often makes fetch() hang for
// minutes instead of failing, so we give up ourselves after this long.
const REQUEST_TIMEOUT_MS = 15_000;

const REFRESH_PATH = "/api/auth/refresh";

// What a reverse proxy answers when our server behind it is down: Vite's dev
// proxy sends 502, Nginx sends 502 or 504. None of these means the server
// looked at the request, so they count as "unreachable", not as a rejection.
const UPSTREAM_UNREACHABLE_STATUSES = new Set([502, 503, 504]);

// We never got an answer from the server. The only error callers may treat as
// "offline".
export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NetworkError";
  }
}

// The server answered, and the answer was not 2xx.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// There is no usable token on this device (signed out, signed in offline only,
// or the refresh token was rejected). Needs a fresh online login.
export class NotAuthenticatedError extends Error {
  constructor(message = "Not signed in to the server") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

// One HTTP round trip: no auth logic, just turns every failure into a typed error.
async function send(path, { method = "GET", body, accessToken } = {}) {
  // Relative /api paths only: the Vite dev proxy and production Nginx both route
  // on that prefix, and an absolute URL would bypass them.
  if (!path.startsWith("/api/")) {
    throw new Error(`apiFetch expects a relative /api/ path, got "${path}"`);
  }

  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch() rejects with a TypeError when no connection could be made, and with
    // a TimeoutError when our timeout fires. Both mean we never heard back.
    // navigator.onLine is not consulted: it only knows whether a network
    // interface is up, not whether the internet is reachable through it.
    if (error instanceof TypeError || error.name === "TimeoutError") {
      throw new NetworkError("Could not reach the server", { cause: error });
    }
    throw error;
  }

  if (UPSTREAM_UNREACHABLE_STATUSES.has(response.status)) {
    throw new NetworkError(`Server unreachable (HTTP ${response.status})`);
  }

  const data = await parseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error ?? `Request failed (HTTP ${response.status})`
    );
  }
  return data;
}

// Runs with the refresh lock held, where there is one (see withRefreshLock).
// `startedWith` is the auth row the rejected request was sent with.
async function requestNewTokens(startedWith) {
  // Re-read now, not before the lock. The tab ahead of this one in the queue
  // may have rotated the token this tab is holding.
  const row = await db.authCache.get(startedWith.userId);

  const decision = decideTokenRefresh(startedWith, row);
  if (decision === REFRESH_DECISION.SIGNED_OUT) throw new NotAuthenticatedError();
  if (decision === REFRESH_DECISION.ADOPT) return row.accessToken;

  let tokens;
  try {
    tokens = await send(REFRESH_PATH, {
      method: "POST",
      body: { refreshToken: row.refreshToken },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new NotAuthenticatedError("Session expired. Please sign in again.");
    }
    throw error;
  }

  // The server has already revoked the refresh token we just sent, so the new
  // pair has to be saved or this device loses its server session.
  await db.transaction("rw", db.authCache, async () => {
    const current = await db.authCache.get(row.userId);
    // The user may have signed out while the request was in flight. Writing the
    // new tokens now would bring back credentials that sign-out deleted.
    if (!current?.sessionActive || current.refreshToken !== row.refreshToken) {
      throw new NotAuthenticatedError();
    }
    await db.authCache.update(row.userId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  return tokens.accessToken;
}

// One refresh at a time across every tab of this app on the device. The server
// takes a refresh token presented twice for a stolen one and revokes the whole
// session, so two tabs refreshing with the same token would sign the user out
// everywhere. Tabs queue here, and each re-reads authCache once it is its turn.
//
// The lock is held across the /refresh round trip and the authCache write, so
// the next tab in line sees the new tokens. send()'s timeout bounds how long
// that can take. A tab that closes mid-refresh releases the lock with it.
//
// Web Locks exist only in secure contexts: HTTPS, localhost and 127.0.0.1, so
// the dev servers, the preview and the HTTPS tunnel all have them. A phone
// opening the app over plain http on a LAN address does not. There the refresh
// runs unlocked, as it always did, and the re-read in requestNewTokens still
// catches a rotation another tab has already finished. Only two refreshes
// truly at the same moment can collide.
function withRefreshLock(task) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return task();
  return locks.request(REFRESH_LOCK_NAME, task);
}

let refreshInFlight = null;

// Within one tab, requests that hit a 401 at the same time share one refresh
// rather than queueing for the lock one behind another. The first caller's
// auth row is the one the refresh starts from. Any later caller joining it was
// sent with the same tokens, because nothing in this tab rotates them while a
// refresh is in flight.
function refreshAccessToken(startedWith) {
  refreshInFlight ??= withRefreshLock(() => requestNewTokens(startedWith)).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Every server request goes through here.
 * Pass `auth: false` for endpoints that must not carry or refresh a token (login,
 * refresh, logout). For those a 401 means "credentials rejected", not "token
 * expired".
 */
export async function apiFetch(path, { method, body, auth = true } = {}) {
  if (!auth) return send(path, { method, body });

  const row = await getAuthRow();
  if (!row?.sessionActive || !row.accessToken) throw new NotAuthenticatedError();

  try {
    return await send(path, { method, body, accessToken: row.accessToken });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;

    // Retry exactly once. If a freshly issued access token is also refused, the
    // problem is not expiry (the account was disabled or the token revoked), and
    // refreshing again would get the same answer forever.
    // The row this request was sent with. If authCache holds anything else by
    // the time the refresh lock is free, another tab got there first.
    const accessToken = await refreshAccessToken(row);
    return send(path, { method, body, accessToken });
  }
}
