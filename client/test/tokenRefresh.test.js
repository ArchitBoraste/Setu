import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  REFRESH_DECISION,
  REFRESH_LOCK_NAME,
  decideTokenRefresh,
} from "../src/lib/tokenRefresh.js";

const WORKER_A = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const WORKER_B = "6f5e4d3c-2b1a-4f9e-8d7c-5b4a3f2e1d0c";

// Opaque stand-ins: the decision only ever compares tokens for equality.
const R1 = "refresh-token-one";
const R2 = "refresh-token-two";
const A1 = "access-token-one";
const A2 = "access-token-two";

// The authCache row this tab's rejected request was sent with.
const STARTED_WITH = { userId: WORKER_A, accessToken: A1, refreshToken: R1, sessionActive: true };

// authCache as re-read under the lock.
function stored(overrides = {}) {
  return { ...STARTED_WITH, ...overrides };
}

describe("decideTokenRefresh: nobody else has refreshed", () => {
  test("the token this tab started with is still stored, so this tab refreshes", () => {
    assert.equal(decideTokenRefresh(STARTED_WITH, stored()), REFRESH_DECISION.REFRESH);
  });
});

describe("decideTokenRefresh: another tab already rotated", () => {
  // The tab ahead in the queue spent R1 and stored R2. Sending R1 again would
  // be taken for reuse and sign the user out everywhere.
  test("a different stored refresh token means use the stored tokens, not /refresh", () => {
    assert.equal(
      decideTokenRefresh(STARTED_WITH, stored({ accessToken: A2, refreshToken: R2 })),
      REFRESH_DECISION.ADOPT
    );
  });

  // Nothing writes one token without the other. If that state ever appears,
  // the answer is a sign-in, never a /refresh with a token that may be spent.
  test("a new refresh token with no access token beside it is refused, not refreshed", () => {
    for (const accessToken of [null, undefined, ""]) {
      assert.equal(
        decideTokenRefresh(STARTED_WITH, stored({ accessToken, refreshToken: R2 })),
        REFRESH_DECISION.SIGNED_OUT,
        String(accessToken)
      );
    }
  });
});

describe("decideTokenRefresh: no session left to continue", () => {
  test("the authCache row is gone (account removed from the device)", () => {
    assert.equal(decideTokenRefresh(STARTED_WITH, undefined), REFRESH_DECISION.SIGNED_OUT);
    assert.equal(decideTokenRefresh(STARTED_WITH, null), REFRESH_DECISION.SIGNED_OUT);
  });

  // logout() clears both tokens and sessionActive in one update.
  test("the user signed out in another tab while this one waited", () => {
    assert.equal(
      decideTokenRefresh(
        STARTED_WITH,
        stored({ accessToken: null, refreshToken: null, sessionActive: false })
      ),
      REFRESH_DECISION.SIGNED_OUT
    );
  });

  // Defensive: whatever tokens remain, a session marked inactive is not
  // continued.
  test("an inactive session is not refreshed even if its token still matches", () => {
    assert.equal(
      decideTokenRefresh(STARTED_WITH, stored({ sessionActive: false })),
      REFRESH_DECISION.SIGNED_OUT
    );
  });

  // An offline sign-in leaves both tokens null on purpose: a cached hash
  // unlocks local data, it cannot create a server session.
  test("signed in offline only, with no refresh token", () => {
    assert.equal(
      decideTokenRefresh(STARTED_WITH, stored({ accessToken: null, refreshToken: null })),
      REFRESH_DECISION.SIGNED_OUT
    );
  });
});

describe("decideTokenRefresh: a shared phone", () => {
  // Worker B signed in while worker A's sync was waiting. B's tokens are live
  // and different, which looks exactly like "another tab rotated". Adopting
  // them would push A's queued rows under B's identity.
  test("another person's tokens are never adopted", () => {
    assert.equal(
      decideTokenRefresh(
        STARTED_WITH,
        stored({ userId: WORKER_B, accessToken: A2, refreshToken: R2 })
      ),
      REFRESH_DECISION.SIGNED_OUT
    );
  });

  test("nor is another person's session refreshed, even if the token matched", () => {
    assert.equal(
      decideTokenRefresh(STARTED_WITH, stored({ userId: WORKER_B })),
      REFRESH_DECISION.SIGNED_OUT
    );
  });
});

describe("REFRESH_LOCK_NAME", () => {
  // An update leaves old and new builds open side by side. If the name changed
  // they would hold different locks, and refresh in parallel again.
  test("is the name every build has used", () => {
    assert.equal(REFRESH_LOCK_NAME, "setu-token-refresh");
  });
});
