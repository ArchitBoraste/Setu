import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequireLiveRole, liveRoleRefusal } from "../utils/liveRole.js";

const SUPERVISOR = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const ORG = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

// The roles each surface allows: /api/conflicts and /api/admin.
const CONFLICT_ROLES = ["supervisor", "admin"];
const ADMIN_ROLES = ["admin"];

function account(overrides = {}) {
  return { role: "supervisor", isActive: 1, deleted: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe("liveRoleRefusal", () => {
  test("an active account that still holds an allowed role is let through", () => {
    assert.equal(liveRoleRefusal(account(), CONFLICT_ROLES), null);
    assert.equal(liveRoleRefusal(account({ role: "admin" }), ADMIN_ROLES), null);
    assert.equal(liveRoleRefusal(account({ isActive: true, deleted: false }), CONFLICT_ROLES), null);
  });

  test("a deactivated account is refused with 401, whatever its role", () => {
    for (const role of ["supervisor", "admin"]) {
      assert.deepEqual(liveRoleRefusal(account({ role, isActive: 0 }), CONFLICT_ROLES), {
        status: 401,
        error: "Account not found",
      });
    }
  });

  test("a deleted account, or none at all (removed, or moved organisation), is refused with 401", () => {
    assert.equal(liveRoleRefusal(account({ deleted: 1 }), CONFLICT_ROLES)?.status, 401);
    assert.equal(liveRoleRefusal(null, CONFLICT_ROLES)?.status, 401);
    assert.equal(liveRoleRefusal(undefined, CONFLICT_ROLES)?.status, 401);
  });

  test("a supervisor demoted to field worker is refused with 403", () => {
    assert.deepEqual(liveRoleRefusal(account({ role: "field_worker" }), CONFLICT_ROLES), {
      status: 403,
      error: "Forbidden",
    });
  });

  test("an admin demoted to supervisor keeps conflicts but loses admin", () => {
    const demoted = account({ role: "supervisor" });
    assert.equal(liveRoleRefusal(demoted, CONFLICT_ROLES), null);
    assert.equal(liveRoleRefusal(demoted, ADMIN_ROLES)?.status, 403);
  });

  test("fails closed when a column is missing or malformed, rather than letting everyone in", () => {
    for (const broken of [
      { role: "supervisor", deleted: 0 }, // isActive dropped from the SELECT
      { role: "supervisor", isActive: 1 }, // deleted dropped from the SELECT
      account({ isActive: "1" }),
      account({ deleted: null }),
    ]) {
      assert.equal(liveRoleRefusal(broken, CONFLICT_ROLES)?.status, 401, JSON.stringify(broken));
    }
  });
});

// ---------------------------------------------------------------------------
// The middleware, with the database read stubbed
// ---------------------------------------------------------------------------

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

// Runs the middleware once against an account the stub "reads", and reports
// what it did: answered (status/body), passed on (next with no argument), or
// handed an error to Express (next with one).
async function run(roles, readAccount) {
  const requireLiveRole = createRequireLiveRole(readAccount);
  const req = { user: { id: SUPERVISOR, role: "supervisor", organizationId: ORG } };
  const res = fakeResponse();
  const nextCalls = [];
  await requireLiveRole(...roles)(req, res, (...args) => nextCalls.push(args));
  return { res, nextCalls };
}

describe("requireLiveRole middleware", () => {
  test("reads the account named by the verified token: its id and organisation", async () => {
    let asked = null;
    await run(CONFLICT_ROLES, async (who) => {
      asked = who;
      return account();
    });
    assert.deepEqual(asked, { id: SUPERVISOR, organizationId: ORG });
  });

  test("passes a current supervisor through to the route", async () => {
    const { res, nextCalls } = await run(CONFLICT_ROLES, async () => account());
    assert.deepEqual(nextCalls, [[]]);
    assert.equal(res.statusCode, null);
  });

  test("a supervisor deactivated after their token was signed is stopped with 401 on the next request", async () => {
    // The token still says supervisor; requireRole would have let this through.
    const { res, nextCalls } = await run(CONFLICT_ROLES, async () => account({ isActive: 0 }));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Account not found" });
    assert.deepEqual(nextCalls, [], "the route must not run");
  });

  test("a supervisor demoted to field worker after their token was signed is stopped with 403", async () => {
    const { res, nextCalls } = await run(CONFLICT_ROLES, async () => account({ role: "field_worker" }));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Forbidden" });
    assert.deepEqual(nextCalls, []);
  });

  test("an account the read cannot find is stopped with 401", async () => {
    const { res, nextCalls } = await run(ADMIN_ROLES, async () => undefined);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(nextCalls, []);
  });

  test("a failed read goes to Express's error handler instead of escaping, and answers nothing", async () => {
    const failure = new Error("connection lost");
    const { res, nextCalls } = await run(CONFLICT_ROLES, async () => {
      throw failure;
    });
    assert.deepEqual(nextCalls, [[failure]]);
    assert.equal(res.statusCode, null);
  });
});
