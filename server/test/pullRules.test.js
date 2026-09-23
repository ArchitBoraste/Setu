import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PULL_LIMIT,
  EPOCH_CURSOR,
  MAX_PULL_LIMIT,
  keysetFrom,
  resolveWindow,
  sinceForScope,
  validatePullQuery,
  validateResolutionQuery,
} from "../sync/pullRules.js";

const RECORD_ID = "3d2c1b0a-9f8e-4d7c-b6a5-4f3e2d1c0b9a";

// Server timestamps, in the one shape DATE_FORMAT(..., SERVER_TIME_FORMAT) emits.
const CURSOR = "2026-09-22 15:10:00.000000";
const EARLIER_EDGE = "2026-09-22 15:15:00.000000";
const SAFE_NOW = "2026-09-22 15:20:00.000000";
// What a phone whose clock runs four minutes fast would call "now", written in
// the server's shape so it gets past every format check.
const FAST_PHONE_NOW = "2026-09-22 15:24:00.000000";

// The forms a device clock naturally takes: Date.now() and toISOString().
const DEVICE_CLOCK_FORMS = [
  "1790083255000",
  "2026-09-22T15:16:21.934Z",
  "2026-09-22T15:16:21.934",
  "2026-09-22 15:16:21",
  "2026-09-22 15:16:21.934",
  "2026-09-22",
];

// ---------------------------------------------------------------------------
// resolveWindow — the closed interval one sync reads
// ---------------------------------------------------------------------------

describe("resolveWindow", () => {
  test("a device that has never synced reads from the epoch", () => {
    for (const since of [null, undefined]) {
      assert.deepEqual(resolveWindow(since, null, SAFE_NOW), {
        since: EPOCH_CURSOR,
        until: SAFE_NOW,
      });
    }
  });

  test("the first page's upper edge is the server's safe clock", () => {
    assert.deepEqual(resolveWindow(CURSOR, null, SAFE_NOW), { since: CURSOR, until: SAFE_NOW });
  });

  // Regression: the device clock must never become the sync cursor. The edge
  // returned here is the value the device stores; a fast phone asking for its
  // own "now" would otherwise skip everything the server wrote in between.
  test("a phone whose clock runs fast cannot push the window's upper edge past the server's clock", () => {
    assert.deepEqual(resolveWindow(CURSOR, FAST_PHONE_NOW, SAFE_NOW), {
      since: CURSOR,
      until: SAFE_NOW,
    });
  });

  test("every later page of one sync keeps the upper edge its first page was given", () => {
    assert.deepEqual(resolveWindow(CURSOR, EARLIER_EDGE, SAFE_NOW), {
      since: CURSOR,
      until: EARLIER_EDGE,
    });
  });

  test("an upper edge equal to the server's safe clock is kept", () => {
    assert.equal(resolveWindow(CURSOR, SAFE_NOW, SAFE_NOW).until, SAFE_NOW);
  });

  test("an upper edge not in the server's own format is ignored in favour of the server's clock", () => {
    for (const until of [...DEVICE_CLOCK_FORMS, 1790083255000]) {
      assert.equal(resolveWindow(CURSOR, until, SAFE_NOW).until, SAFE_NOW, String(until));
    }
  });

  test("a lower edge not in the server's own format is read as the epoch, never guessed at", () => {
    for (const since of DEVICE_CLOCK_FORMS) {
      assert.equal(resolveWindow(since, null, SAFE_NOW).since, EPOCH_CURSOR, since);
    }
  });

  test("two syncs inside the commit-lag margin get an empty window, never a cursor that moves backwards", () => {
    // The previous sync's edge is AHEAD of this request's safe clock.
    const window = resolveWindow(SAFE_NOW, null, EARLIER_EDGE);
    assert.deepEqual(window, { since: SAFE_NOW, until: SAFE_NOW });
    assert.ok(window.until >= window.since);
  });
});

// ---------------------------------------------------------------------------
// validatePullQuery / validateResolutionQuery
// ---------------------------------------------------------------------------

describe("validatePullQuery", () => {
  test("a first sync with no query at all reads the whole history, one default page at a time", () => {
    for (const query of [undefined, null, {}]) {
      assert.deepEqual(validatePullQuery(query).value, {
        since: EPOCH_CURSOR,
        requestedUntil: null,
        afterUpdatedAt: null,
        afterId: null,
        pageSize: DEFAULT_PULL_LIMIT,
        requestedScope: null,
      });
    }
  });

  // Regression: the device clock must never become the sync cursor.
  test("a cursor in the device clock's own formats is refused, not coerced", () => {
    for (const since of DEVICE_CLOCK_FORMS) {
      assert.ok(validatePullQuery({ since }).error, `since ${since}`);
    }
    // Express hands a repeated parameter over as an array.
    assert.ok(validatePullQuery({ since: [CURSOR, CURSOR] }).error);
  });

  test("an upper edge the server did not mint is refused", () => {
    for (const until of DEVICE_CLOCK_FORMS) {
      assert.ok(validatePullQuery({ since: CURSOR, until }).error, `until ${until}`);
    }
  });

  test("a server-minted cursor and upper edge pass through byte for byte", () => {
    assert.deepEqual(validatePullQuery({ since: CURSOR, until: EARLIER_EDGE }).value, {
      since: CURSOR,
      requestedUntil: EARLIER_EDGE,
      afterUpdatedAt: null,
      afterId: null,
      pageSize: DEFAULT_PULL_LIMIT,
      requestedScope: null,
    });
  });

  test("half a page position is refused rather than silently restarting the window", () => {
    assert.ok(validatePullQuery({ since: CURSOR, afterUpdatedAt: EARLIER_EDGE }).error);
    assert.ok(validatePullQuery({ since: CURSOR, afterId: RECORD_ID }).error);
  });

  test("a page position with a malformed time or id is refused", () => {
    assert.ok(
      validatePullQuery({ afterUpdatedAt: "2026-09-22T15:15:00Z", afterId: RECORD_ID }).error
    );
    assert.ok(validatePullQuery({ afterUpdatedAt: EARLIER_EDGE, afterId: "row-12" }).error);
  });

  test("a complete page position is passed through", () => {
    const { value } = validatePullQuery({
      since: CURSOR,
      afterUpdatedAt: EARLIER_EDGE,
      afterId: RECORD_ID,
    });
    assert.equal(value.afterUpdatedAt, EARLIER_EDGE);
    assert.equal(value.afterId, RECORD_ID);
  });

  test("a resolutions-feed position sent to the record feed is refused, not used", () => {
    assert.ok(validatePullQuery({ afterResolvedAt: EARLIER_EDGE, afterId: RECORD_ID }).error);
  });

  test("a page size that is not a positive whole number is refused", () => {
    for (const limit of ["0", "-1", "1.5", "abc", "", ["10", "20"]]) {
      assert.ok(validatePullQuery({ limit }).error, `limit ${JSON.stringify(limit)}`);
    }
  });

  test("a page size above the cap is reduced to the cap, not refused", () => {
    assert.equal(validatePullQuery({ limit: "100000" }).value.pageSize, MAX_PULL_LIMIT);
    assert.equal(validatePullQuery({ limit: String(MAX_PULL_LIMIT) }).value.pageSize, MAX_PULL_LIMIT);
    assert.equal(validatePullQuery({ limit: "1" }).value.pageSize, 1);
  });
});

describe("validateResolutionQuery", () => {
  test("a first sync with no query reads every resolution, one default page at a time", () => {
    assert.deepEqual(validateResolutionQuery({}).value, {
      since: EPOCH_CURSOR,
      requestedUntil: null,
      afterResolvedAt: null,
      afterId: null,
      pageSize: DEFAULT_PULL_LIMIT,
      requestedScope: null,
    });
  });

  test("a cursor or upper edge in the device clock's own formats is refused", () => {
    for (const value of DEVICE_CLOCK_FORMS) {
      assert.ok(validateResolutionQuery({ since: value }).error, `since ${value}`);
      assert.ok(validateResolutionQuery({ until: value }).error, `until ${value}`);
    }
  });

  test("a record-feed position sent to the resolutions feed is refused, not used", () => {
    assert.ok(
      validateResolutionQuery({ afterUpdatedAt: EARLIER_EDGE, afterId: RECORD_ID }).error
    );
  });

  test("half a resolutions position is refused", () => {
    assert.ok(validateResolutionQuery({ afterResolvedAt: EARLIER_EDGE }).error);
    assert.ok(validateResolutionQuery({ afterId: RECORD_ID }).error);
  });

  test("a complete resolutions position and page size are passed through", () => {
    const { value } = validateResolutionQuery({
      since: CURSOR,
      until: EARLIER_EDGE,
      afterResolvedAt: EARLIER_EDGE,
      afterId: RECORD_ID,
      limit: "7",
    });
    assert.deepEqual(value, {
      since: CURSOR,
      requestedUntil: EARLIER_EDGE,
      afterResolvedAt: EARLIER_EDGE,
      afterId: RECORD_ID,
      pageSize: 7,
      requestedScope: null,
    });
  });

  test("a bad page size is refused and an oversized one is capped", () => {
    assert.ok(validateResolutionQuery({ limit: "0" }).error);
    assert.equal(validateResolutionQuery({ limit: "9999" }).value.pageSize, MAX_PULL_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// keysetFrom
// ---------------------------------------------------------------------------

describe("keysetFrom", () => {
  test("the first page starts at the window's lower edge, before every id", () => {
    const keyset = keysetFrom({ since: CURSOR, afterUpdatedAt: null, afterId: null });
    assert.deepEqual(keyset, { updatedAt: CURSOR, id: "" });
    // "" has to sort below every UUID for the first page's disjunct to be inert.
    assert.ok("" < "00000000-0000-4000-8000-000000000000");
  });

  test("a later page starts exactly after the last row the previous page returned", () => {
    assert.deepEqual(
      keysetFrom({ since: CURSOR, afterUpdatedAt: EARLIER_EDGE, afterId: RECORD_ID }),
      { updatedAt: EARLIER_EDGE, id: RECORD_ID }
    );
  });
});

// ---------------------------------------------------------------------------
// Keyset pagination, walked end to end.
//
// The window predicate and ORDER BY below are a transcription of PULL_WINDOW
// and PULL_ORDER in routes/sync.js, and the page loop is the route's probe /
// hasMore / nextCursor logic together with pullRecords() on the client. What
// this proves is that validatePullQuery, resolveWindow and keysetFrom compose
// into a walk with no skips and no repeats. It cannot prove the SQL text still
// says the same thing — that needs the integration suite against MySQL.
// ---------------------------------------------------------------------------

function inWindowPage(rows, { since, until, keyset, limit }) {
  return rows
    .filter(
      (row) =>
        row.updatedAt > since &&
        row.updatedAt <= until &&
        (row.updatedAt > keyset.updatedAt ||
          (row.updatedAt === keyset.updatedAt && row.id > keyset.id))
    )
    .sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.id < b.id ? -1 : 1
        : a.updatedAt < b.updatedAt ? -1 : 1
    )
    .slice(0, limit);
}

/** One whole sync's pull: every page of one window, as the device walks it. */
function pullWindow(rows, { cursor, safeNow, limit }) {
  const delivered = [];
  let until = null;
  let after = null;

  for (let pages = 0; ; pages += 1) {
    assert.ok(pages < 1000, "pagination never terminated");

    const query = { limit: String(limit) };
    if (cursor) query.since = cursor;
    if (until) query.until = until;
    if (after) {
      query.afterUpdatedAt = after.updatedAt;
      query.afterId = after.id;
    }

    const parsed = validatePullQuery(query);
    assert.equal(parsed.error, undefined);
    const { since, requestedUntil, afterUpdatedAt, afterId, pageSize } = parsed.value;

    const window = resolveWindow(since, requestedUntil, safeNow);
    const keyset = keysetFrom({ since: window.since, afterUpdatedAt, afterId });
    const probe = inWindowPage(rows, { ...window, keyset, limit: pageSize + 1 });

    const hasMore = probe.length > pageSize;
    const page = hasMore ? probe.slice(0, pageSize) : probe;
    delivered.push(...page.map((row) => row.id));
    until ??= window.until;

    if (!hasMore) return { delivered, cursor: until };
    const last = page[page.length - 1];
    after = { updatedAt: last.updatedAt, id: last.id };
  }
}

const BEFORE = "2026-09-22 09:00:00.000000";
const LOWER = "2026-09-22 10:00:00.000000";
// One batch push stamps every row it writes with a single NOW(3) reading, so a
// run of rows sharing one updated_at is routine.
const TIED = "2026-09-22 10:30:00.125000";
const LATER = "2026-09-22 11:00:00.000000";
const EDGE = "2026-09-22 12:00:00.000000";
const AFTER_EDGE = "2026-09-22 12:00:00.001000";

// Ids deliberately out of insertion order, so the id tiebreak is exercised.
const ROWS = [
  { id: "f1e2d3c4-0000-4000-8000-000000000001", updatedAt: BEFORE },
  { id: "0a0b0c0d-0000-4000-8000-000000000002", updatedAt: LOWER },
  { id: "c3000000-0000-4000-8000-000000000003", updatedAt: TIED },
  { id: "1b000000-0000-4000-8000-000000000004", updatedAt: TIED },
  { id: "e5000000-0000-4000-8000-000000000005", updatedAt: TIED },
  { id: "2a000000-0000-4000-8000-000000000006", updatedAt: TIED },
  { id: "9d000000-0000-4000-8000-000000000007", updatedAt: TIED },
  { id: "4f000000-0000-4000-8000-000000000008", updatedAt: TIED },
  { id: "b7000000-0000-4000-8000-000000000009", updatedAt: LATER },
  { id: "05000000-0000-4000-8000-000000000010", updatedAt: LATER },
  { id: "d8000000-0000-4000-8000-000000000011", updatedAt: EDGE },
  { id: "6c000000-0000-4000-8000-000000000012", updatedAt: AFTER_EDGE },
];

function expectedIn(since, until) {
  return inWindowPage(ROWS, {
    since,
    until,
    keyset: { updatedAt: since, id: "" },
    limit: Infinity,
  }).map((row) => row.id);
}

describe("keyset pagination over one window", () => {
  // Regression: a page boundary landing inside a run of tied updated_at values
  // skipped or re-sent rows before the id tiebreak was added.
  test("paging through rows that share one updated_at skips none and repeats none", () => {
    const expected = expectedIn(LOWER, EDGE);
    assert.equal(expected.length, 9);

    // Every page size from one row up to more than the window holds, so page
    // boundaries land at every position inside the tied run.
    for (let limit = 1; limit <= expected.length + 1; limit += 1) {
      const { delivered } = pullWindow(ROWS, { cursor: LOWER, safeNow: EDGE, limit });
      assert.deepEqual(delivered, expected, `page size ${limit}`);
      assert.equal(new Set(delivered).size, delivered.length, `duplicates at page size ${limit}`);
    }
  });

  test("a row stamped exactly at the previous cursor is not re-sent, and one exactly at the edge is included", () => {
    const { delivered } = pullWindow(ROWS, { cursor: LOWER, safeNow: EDGE, limit: 2 });
    assert.ok(!delivered.includes("0a0b0c0d-0000-4000-8000-000000000002"));
    assert.ok(delivered.includes("d8000000-0000-4000-8000-000000000011"));
    assert.ok(!delivered.includes("6c000000-0000-4000-8000-000000000012"));
  });

  test("consecutive syncs tile: every row is delivered exactly once across windows", () => {
    // First sync ever, with the server's edge falling inside the tied run's
    // timestamp; the second picks up from the cursor the first stored.
    const first = pullWindow(ROWS, { cursor: null, safeNow: TIED, limit: 2 });
    assert.equal(first.cursor, TIED);
    const second = pullWindow(ROWS, { cursor: first.cursor, safeNow: AFTER_EDGE, limit: 2 });

    const all = [...first.delivered, ...second.delivered];
    assert.equal(new Set(all).size, all.length, "a row was delivered twice");
    assert.deepEqual([...all].sort(), ROWS.map((row) => row.id).sort());
  });
});

// ---------------------------------------------------------------------------
// sinceForScope — a cursor is honoured only in the scope it was advanced in
// ---------------------------------------------------------------------------

const WADGAON_SCOPE = "area:2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e";
const SHIRUR_SCOPE = "area:8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a";

describe("sinceForScope", () => {
  test("a cursor from the caller's current scope is honoured", () => {
    const since = sinceForScope({
      since: CURSOR,
      requestedScope: WADGAON_SCOPE,
      scopeKey: WADGAON_SCOPE,
    });
    assert.equal(since, CURSOR);
  });

  // The failure this exists for: a worker moved to Shirur, still holding a
  // Wadgaon cursor, would otherwise never be sent Shirur's older records.
  test("a cursor from another area starts the window from the beginning", () => {
    const since = sinceForScope({
      since: CURSOR,
      requestedScope: WADGAON_SCOPE,
      scopeKey: SHIRUR_SCOPE,
    });
    assert.equal(since, EPOCH_CURSOR);
  });

  test("a cursor that names no scope starts the window from the beginning", () => {
    const since = sinceForScope({ since: CURSOR, requestedScope: null, scopeKey: WADGAON_SCOPE });
    assert.equal(since, EPOCH_CURSOR);
  });
});

describe("the cursor's scope on the query string", () => {
  test("a scope key the server minted is passed through by both feeds", () => {
    for (const validate of [validatePullQuery, validateResolutionQuery]) {
      const { value } = validate({ since: CURSOR, scope: WADGAON_SCOPE });
      assert.equal(value.requestedScope, WADGAON_SCOPE);
    }
  });

  test("anything else is refused by both feeds rather than guessed at", () => {
    for (const validate of [validatePullQuery, validateResolutionQuery]) {
      for (const scope of ["", "wadgaon", "area:", `${WADGAON_SCOPE},x`, [WADGAON_SCOPE]]) {
        assert.ok(validate({ scope }).error, `scope ${JSON.stringify(scope)}`);
      }
    }
  });
});
