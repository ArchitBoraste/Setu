// Window arithmetic and query validation for GET /api/sync/pull.
//
// Pure functions over plain values, for the same reason pushRules.js is: getting
// the delta window wrong does not throw, it silently stops delivering records,
// and a bug that quiet has to be testable without a database.

import { isScopeKey } from "./scopeRules.js";

export const DEFAULT_PULL_LIMIT = 100;
export const MAX_PULL_LIMIT = 500;

// Where a device that has never synced starts. Not null: the window arithmetic
// below is all string comparison, and a real value keeps every path the same.
export const EPOCH_CURSOR = "1970-01-01 00:00:00.000000";

/**
 * How far behind the server's clock the pull window's upper edge sits.
 *
 * This closes a hole the simple "upper bound = NOW(3)" rule leaves open, and it
 * is worth spelling out because the failure is permanent and silent.
 *
 * A push writes updated_at from a timestamp captured INSIDE its transaction,
 * then commits some milliseconds later. So this sequence is possible:
 *
 *   t=0ms   a push transaction reads NOW(3) and writes updated_at = t0
 *   t=20ms  a pull reads NOW(3) = T, where T > t0
 *   t=30ms  the pull's SELECT runs. The push has not committed, so its row is
 *           invisible to this query.
 *   t=50ms  the push commits. The row now exists with updated_at = t0.
 *
 * The device stores T as its cursor. Every future window asks for
 * updated_at > T, and that row's updated_at is t0, which is less than T. The
 * record is never returned again, to this device or any other that synced in
 * that instant. Nothing errors. A household visit simply stops existing on
 * every phone but the one that captured it.
 *
 * Holding the upper edge one second behind the clock means a row can only be
 * missed if its transaction stayed open longer than that. The push route's
 * transaction is a handful of statements on a locked row, so the margin is
 * three orders of magnitude. The cost is that a record becomes visible to other
 * devices up to a second later, which for a sync a worker triggers by hand is
 * not a cost at all.
 */
export const PULL_COMMIT_LAG_MS = 1_000;

// The exact shape DATE_FORMAT(..., '%Y-%m-%d %H:%i:%s.%f') produces. Fixed
// width, which is what makes the plain string comparisons below sound: for this
// format, lexicographic order IS chronological order, so the window can be
// reasoned about without ever parsing a timestamp into a local Date — the thing
// the whole cursor design exists to avoid.
const SERVER_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isServerTime(value) {
  return typeof value === "string" && SERVER_TIME_RE.test(value);
}

/**
 * Capped, not refused. A device asking for too much gets a smaller page and
 * another round trip, which is strictly better than an error it cannot act on —
 * and the cap is what stops one request loading an organisation's entire
 * history, payloads and all, into memory.
 */
function parsePageSize(limit) {
  if (limit === undefined) return { value: DEFAULT_PULL_LIMIT };

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: "limit must be a positive integer" };
  }
  return { value: Math.min(parsed, MAX_PULL_LIMIT) };
}

/**
 * Settles the closed interval this request covers.
 *
 * `requestedUntil` is the upper bound the client was given on the FIRST page of
 * a multi-page pull and hands back on every page after it. One sync therefore
 * reads one fixed window, however many round trips it takes. Letting each page
 * pick its own upper edge would make a single sync a moving target, and the
 * client's "store the cursor only after the last page" rule would then be
 * storing a bound that never applied to the earlier pages.
 *
 * It is clamped, never trusted. A client asking for an edge beyond the server's
 * own safe horizon would store that value as its cursor and skip everything
 * written in between — self-inflicted, but the server is the one holding the
 * clock, so it is the server that settles this.
 */
export function resolveWindow(since, requestedUntil, safeNow) {
  const lower = isServerTime(since) ? since : EPOCH_CURSOR;

  let upper = isServerTime(requestedUntil) && requestedUntil < safeNow
    ? requestedUntil
    : safeNow;

  // Two syncs inside the lag window leave the upper edge behind the lower one.
  // Collapsing to an empty interval is the only safe answer: the alternative is
  // handing back an upper bound older than the cursor the device already holds,
  // and a cursor that moves backwards re-delivers rows the device has applied.
  if (upper < lower) upper = lower;

  return { since: lower, until: upper };
}

/**
 * The lower edge a pull may honour, given the scope its cursor was advanced in.
 *
 * A cursor means "every row in ONE SET, changed up to here, is on this device".
 * It says nothing about any other set. When a worker is moved to another
 * village, the rows of the new one changed long before the cursor was last
 * moved, and a window starting at that cursor would never deliver them —
 * silently, and for good, because nothing re-offers what falls below a cursor.
 *
 * So the device sends back the scope key its cursor was stamped with, and the
 * cursor is honoured only if that is still this user's scope. Anything else — a
 * different area, a different role, a cursor from a build that did not stamp
 * one — starts the window from the beginning. A full replay is harmless on both
 * halves of the sync (see REPLAY SAFETY in client/src/sync/pullRules.js); a
 * window that skips rows is not.
 *
 * The comparison is made HERE, against scope read fresh from the database,
 * rather than trusted to the device. A phone does not learn it was moved until
 * the server tells it, and the first sync after a move is exactly when its
 * idea of its own scope is out of date.
 */
export function sinceForScope({ since, requestedScope, scopeKey }) {
  return requestedScope === scopeKey ? since : EPOCH_CURSOR;
}

// The scope a cursor was stamped with, as a device sends it back. Absent is
// allowed — a first sync, or an older build — and simply matches nothing.
function parseScope(scope) {
  if (scope === undefined) return { value: null };
  if (!isScopeKey(scope)) {
    return { error: "scope must be a scope key previously returned by /pull" };
  }
  return { value: scope };
}

/**
 * Validates the query string and returns the values the route will bind.
 *
 * Every timestamp here was minted by this server and handed to the device as an
 * opaque string. A value that does not match that shape did not come from here,
 * so it is refused rather than coerced — coercing it would mean guessing at a
 * cursor, and a wrong guess skips records.
 */
export function validatePullQuery(query) {
  const fail = (message) => ({ error: message });

  const { since, until, afterUpdatedAt, afterId, limit, scope } = query ?? {};

  if (since !== undefined && !isServerTime(since)) {
    return fail("since must be a server timestamp previously returned by /pull");
  }
  if (until !== undefined && !isServerTime(until)) {
    return fail("until must be a server timestamp previously returned by /pull");
  }
  const requestedScope = parseScope(scope);
  if (requestedScope.error) return fail(requestedScope.error);

  // The keyset position is two values that only mean anything together. Half of
  // one would silently restart the page sequence at the top of the window and
  // re-deliver everything before it.
  const hasAfter = afterUpdatedAt !== undefined || afterId !== undefined;
  if (hasAfter) {
    if (!isServerTime(afterUpdatedAt)) {
      return fail("afterUpdatedAt must be a server timestamp");
    }
    if (typeof afterId !== "string" || !UUID_RE.test(afterId)) {
      return fail("afterId must be a UUID");
    }
  }

  const page = parsePageSize(limit);
  if (page.error) return fail(page.error);
  const pageSize = page.value;

  return {
    value: {
      since: since ?? EPOCH_CURSOR,
      requestedUntil: until ?? null,
      afterUpdatedAt: hasAfter ? afterUpdatedAt : null,
      afterId: hasAfter ? afterId : null,
      pageSize,
      requestedScope: requestedScope.value,
    },
  };
}

/**
 * The same window, asked of GET /api/sync/resolutions.
 *
 * Deliberately the same shape as validatePullQuery — one closed interval, one
 * keyset, one page size — because a device runs both halves inside ONE sync and
 * stores ONE cursor for the pair. The only difference is which column the keyset
 * names: resolutions are ordered by record_conflicts.resolved_at, records by
 * records.updated_at, and mixing the two parameter names up would silently page
 * one feed with the other's position.
 *
 * Both columns are written from the same NOW(3) inside the resolve
 * transaction, so a resolution and the record write it caused land on the same
 * side of any window edge. A device never sees one without the other.
 */
export function validateResolutionQuery(query) {
  const fail = (message) => ({ error: message });

  const { since, until, afterResolvedAt, afterId, limit, scope } = query ?? {};

  if (since !== undefined && !isServerTime(since)) {
    return fail("since must be a server timestamp previously returned by /pull");
  }
  if (until !== undefined && !isServerTime(until)) {
    return fail("until must be a server timestamp previously returned by /pull");
  }
  const requestedScope = parseScope(scope);
  if (requestedScope.error) return fail(requestedScope.error);

  const hasAfter = afterResolvedAt !== undefined || afterId !== undefined;
  if (hasAfter) {
    if (!isServerTime(afterResolvedAt)) {
      return fail("afterResolvedAt must be a server timestamp");
    }
    if (typeof afterId !== "string" || !UUID_RE.test(afterId)) {
      return fail("afterId must be a UUID");
    }
  }

  const page = parsePageSize(limit);
  if (page.error) return fail(page.error);

  return {
    value: {
      since: since ?? EPOCH_CURSOR,
      requestedUntil: until ?? null,
      afterResolvedAt: hasAfter ? afterResolvedAt : null,
      afterId: hasAfter ? afterId : null,
      pageSize: page.value,
      requestedScope: requestedScope.value,
    },
  };
}

/**
 * The keyset position a page starts from.
 *
 * On the first page there is no previous row, so the position is the window's
 * lower edge paired with an id that sorts before every UUID. That disjunct is
 * then dead weight — `updated_at > since` in the WHERE already excludes
 * everything at exactly `since` — which is precisely the point: one query shape
 * serves both the first page and every page after it, with no branch to get
 * wrong.
 */
export function keysetFrom({ since, afterUpdatedAt, afterId }) {
  return {
    updatedAt: afterUpdatedAt ?? since,
    id: afterId ?? "",
  };
}
