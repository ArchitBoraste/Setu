import { db, getAuthRow } from "../db/index.js";

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

async function requestNewTokens() {
  const row = await getAuthRow();
  if (!row?.sessionActive || !row.refreshToken) throw new NotAuthenticatedError();

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

let refreshInFlight = null;

// Requests that hit a 401 at the same time share one refresh. The server rotates
// refresh tokens, so a second parallel refresh would send a token the first one
// had just revoked, get a 401, and end a perfectly good session.
function refreshAccessToken() {
  refreshInFlight ??= requestNewTokens().finally(() => {
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
    const accessToken = await refreshAccessToken();
    return send(path, { method, body, accessToken });
  }
}
