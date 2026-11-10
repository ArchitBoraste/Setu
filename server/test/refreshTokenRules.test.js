import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  REFRESH_TOKEN_STATE,
  classifyRefreshToken,
  familyIdFor,
  hashRefreshToken,
  refreshExpiresAt,
} from "../utils/refreshTokenRules.js";

const FAMILY = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";
const NEW_TOKEN_ID = "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c";
const SUCCESSOR_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const DAY_MS = 24 * 60 * 60 * 1000;

// The database clock at the moment the token is presented.
const NOW = new Date("2026-11-10T06:15:00.500Z");

// A live token as rotateRefreshToken reads it: never rotated, never revoked,
// days from expiry, and its user still active. userActive is 1 because that is
// what MySQL returns for a true comparison.
function liveRow(overrides = {}) {
  return {
    replacedBy: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 20 * DAY_MS),
    userActive: 1,
    ...overrides,
  };
}

// Rotated: revoked, pointing at the token that replaced it.
function rotatedRow(overrides = {}) {
  return liveRow({
    replacedBy: SUCCESSOR_ID,
    revokedAt: new Date(NOW.getTime() - 60 * 1000),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// hashRefreshToken — the one encoding every insert and lookup agrees on
// ---------------------------------------------------------------------------

describe("hashRefreshToken", () => {
  test("is 64 lowercase hex characters, the shape of token_hash CHAR(64)", () => {
    assert.match(hashRefreshToken("a".repeat(96)), /^[0-9a-f]{64}$/);
  });

  test("is SHA-256, so rows hashed before this change still match", () => {
    assert.equal(
      hashRefreshToken("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("the same token always hashes the same, and different tokens differently", () => {
    assert.equal(hashRefreshToken("token-one"), hashRefreshToken("token-one"));
    assert.notEqual(hashRefreshToken("token-one"), hashRefreshToken("token-two"));
  });
});

// ---------------------------------------------------------------------------
// refreshExpiresAt — when a freshly minted token stops working
// ---------------------------------------------------------------------------

describe("refreshExpiresAt", () => {
  const NOW = new Date("2026-10-18T09:30:00.250Z");

  test("is the configured number of days after now, to the millisecond", () => {
    assert.equal(refreshExpiresAt(NOW, 30).getTime(), NOW.getTime() + 30 * DAY_MS);
  });

  test("accepts a fraction of a day", () => {
    assert.equal(refreshExpiresAt(NOW, 0.5).getTime(), NOW.getTime() + DAY_MS / 2);
  });

  test("does not move the date it was given", () => {
    const before = NOW.getTime();
    refreshExpiresAt(NOW, 30);
    assert.equal(NOW.getTime(), before);
  });

  // A token that expires as it is minted signs every user out at their next
  // refresh, with nothing in the logs to say why.
  test("refuses a lifetime that would mint dead tokens", () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, "30"]) {
      assert.throws(() => refreshExpiresAt(NOW, days), RangeError, String(days));
    }
  });
});

// ---------------------------------------------------------------------------
// familyIdFor — a sign-in starts a family, a rotation inherits one
// ---------------------------------------------------------------------------

describe("familyIdFor", () => {
  test("a sign-in names its family after its own first token, as migration 005 did", () => {
    assert.equal(familyIdFor(undefined, NEW_TOKEN_ID), NEW_TOKEN_ID);
    assert.equal(familyIdFor(null, NEW_TOKEN_ID), NEW_TOKEN_ID);
  });

  test("a rotation stays in the family of the token it replaces", () => {
    assert.equal(familyIdFor(FAMILY, NEW_TOKEN_ID), FAMILY);
  });

  // Reading "" as "no family" would split one session into two, and sign-out
  // would then revoke only one half of it.
  test("an empty or malformed inherited family is a bug, not a new sign-in", () => {
    for (const bad of ["", "not-a-uuid", 42, {}, `${FAMILY} `]) {
      assert.throws(() => familyIdFor(bad, NEW_TOKEN_ID), TypeError, String(bad));
    }
  });

  test("a sign-in with no usable token id is refused rather than stored", () => {
    assert.throws(() => familyIdFor(undefined, undefined), TypeError);
    assert.throws(() => familyIdFor(undefined, ""), TypeError);
  });
});

// ---------------------------------------------------------------------------
// classifyRefreshToken — what presenting a token amounts to
// ---------------------------------------------------------------------------

describe("classifyRefreshToken: a token the server never issued", () => {
  test("no row with that hash is unknown", () => {
    assert.equal(classifyRefreshToken(null, NOW), REFRESH_TOKEN_STATE.UNKNOWN);
    assert.equal(classifyRefreshToken(undefined, NOW), REFRESH_TOKEN_STATE.UNKNOWN);
  });

  // With no row there is no database clock to pass, and nothing to time.
  test("needs no clock to say so", () => {
    assert.equal(classifyRefreshToken(null, undefined), REFRESH_TOKEN_STATE.UNKNOWN);
  });
});

describe("classifyRefreshToken: a live token", () => {
  test("never rotated, never revoked, unexpired, active user is valid", () => {
    assert.equal(classifyRefreshToken(liveRow(), NOW), REFRESH_TOKEN_STATE.VALID);
  });

  test("is still valid one millisecond before it expires", () => {
    const row = liveRow({ expiresAt: new Date(NOW.getTime() + 1) });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.VALID);
  });

  test("a JavaScript true is as good as MySQL's 1 for an active user", () => {
    assert.equal(
      classifyRefreshToken(liveRow({ userActive: true }), NOW),
      REFRESH_TOKEN_STATE.VALID
    );
  });
});

describe("classifyRefreshToken: a token that was already rotated", () => {
  test("presented again is reuse", () => {
    assert.equal(classifyRefreshToken(rotatedRow(), NOW), REFRESH_TOKEN_STATE.REUSED);
  });

  // A thief's chain gets a fresh lifetime at every rotation. If the real
  // user's expired copy were only "expired", the thief's session would live on.
  test("is reuse even after it has expired", () => {
    const row = rotatedRow({ expiresAt: new Date(NOW.getTime() - DAY_MS) });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.REUSED);
  });

  // Disabling an account after a suspected compromise must not shield the
  // thief's chain from the revocation that reuse triggers.
  test("is reuse even when the user has since been deactivated", () => {
    for (const userActive of [0, false]) {
      assert.equal(
        classifyRefreshToken(rotatedRow({ userActive }), NOW),
        REFRESH_TOKEN_STATE.REUSED,
        String(userActive)
      );
    }
  });

  // Only a hand edit can clear revoked_at and leave replaced_by. A token that
  // already has a successor must not come back to life that way.
  test("is reuse even if revoked_at has been cleared", () => {
    const row = rotatedRow({ revokedAt: null });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.REUSED);
  });

  // Reuse is decided from the row alone, so it holds even if the caller had
  // no usable clock.
  test("needs no clock to be recognised", () => {
    assert.equal(classifyRefreshToken(rotatedRow(), undefined), REFRESH_TOKEN_STATE.REUSED);
  });
});

describe("classifyRefreshToken: a token revoked without being rotated", () => {
  // Signed out, swept up when its family was revoked for reuse, or rotated
  // before migration 005, when no successor was recorded. None of these is
  // evidence of theft, so none may trigger a family revocation.
  test("is revoked, not reuse", () => {
    const row = liveRow({ revokedAt: new Date(NOW.getTime() - 1000) });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.REVOKED);
  });

  test("is revoked even after it has expired", () => {
    const row = liveRow({
      revokedAt: new Date(NOW.getTime() - 2 * DAY_MS),
      expiresAt: new Date(NOW.getTime() - DAY_MS),
    });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.REVOKED);
  });
});

describe("classifyRefreshToken: a token past its lifetime", () => {
  test("never rotated and past expiry is expired, not reuse", () => {
    const row = liveRow({ expiresAt: new Date(NOW.getTime() - DAY_MS) });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.EXPIRED);
  });

  // The old SQL accepted only expires_at > NOW(3).
  test("is already expired at the exact millisecond of expiry", () => {
    const row = liveRow({ expiresAt: new Date(NOW.getTime()) });
    assert.equal(classifyRefreshToken(row, NOW), REFRESH_TOKEN_STATE.EXPIRED);
  });
});

describe("classifyRefreshToken: a live token whose user can no longer sign in", () => {
  test("a deactivated or deleted user's token is refused", () => {
    for (const userActive of [0, false]) {
      assert.equal(
        classifyRefreshToken(liveRow({ userActive }), NOW),
        REFRESH_TOKEN_STATE.USER_INACTIVE,
        String(userActive)
      );
    }
  });

  // If a refactor dropped userActive from the SELECT, failing open would let
  // every deactivated user keep refreshing.
  test("anything but exactly 1 or true refuses rather than accepts", () => {
    for (const userActive of [undefined, null, "1", 2, {}]) {
      assert.equal(
        classifyRefreshToken(liveRow({ userActive }), NOW),
        REFRESH_TOKEN_STATE.USER_INACTIVE,
        String(userActive)
      );
    }
  });
});

describe("classifyRefreshToken: a caller bug", () => {
  // expires_at is NOT NULL. Calling a missing date "expired" would sign every
  // user out with nothing in the logs to say why.
  test("a live row with no usable expiresAt throws instead of guessing", () => {
    for (const expiresAt of [undefined, null, "2026-12-01", new Date("not a date")]) {
      assert.throws(
        () => classifyRefreshToken(liveRow({ expiresAt }), NOW),
        TypeError,
        String(expiresAt)
      );
    }
  });

  test("a live row with no usable clock throws instead of guessing", () => {
    for (const now of [undefined, null, NOW.getTime(), new Date("not a date")]) {
      assert.throws(() => classifyRefreshToken(liveRow(), now), TypeError, String(now));
    }
  });
});

describe("classifyRefreshToken: its answers", () => {
  // The route treats "not VALID" as 401 and REUSED as "revoke the family". A
  // misspelt state would silently fall into the plain 401 branch.
  test("are always one of REFRESH_TOKEN_STATE", () => {
    const allowed = new Set(Object.values(REFRESH_TOKEN_STATE));
    const rows = [
      null,
      liveRow(),
      rotatedRow(),
      liveRow({ revokedAt: NOW }),
      liveRow({ expiresAt: NOW }),
      liveRow({ userActive: 0 }),
    ];
    const seen = new Set(rows.map((row) => classifyRefreshToken(row, NOW)));
    for (const state of seen) assert.ok(allowed.has(state), state);
    // One row per state, so every state is reachable.
    assert.equal(seen.size, allowed.size);
  });
});
