import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_ERROR,
  MAX_PASSWORD_BYTES,
  planUserUpdate,
  validateAreaName,
  validateNewUser,
  validatePassword,
  validateUserPatch,
} from "../admin/adminRules.js";

const ADMIN_ME = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ADMIN_OTHER = "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e";
const WORKER = "3c4d5e6f-7081-4c9d-8e1f-2a3b4c5d6e7f";
const WADGAON = "4d5e6f70-8192-4dae-9f20-3b4c5d6e7f80";
const SHIRUR = "5e6f7081-92a3-4ebf-8031-4c5d6e7f8091";

function newUser(overrides = {}) {
  return {
    fullName: "Sunita Pawar",
    phone: "9876543210",
    role: "field_worker",
    areaId: WADGAON,
    password: "Village@2026",
    ...overrides,
  };
}

function storedUser(overrides = {}) {
  return {
    id: WORKER,
    fullName: "Sunita Pawar",
    role: "field_worker",
    areaId: WADGAON,
    isActive: 1,
    ...overrides,
  };
}

function plan({ actorId = ADMIN_ME, target, patch, activeAdminCount = 2 }) {
  return planUserUpdate({ actorId, target: storedUser(target), patch, activeAdminCount });
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

describe("validateNewUser: fields", () => {
  test("a complete field worker is accepted with its values as they will be stored", () => {
    assert.deepEqual(validateNewUser(newUser({ fullName: "  Sunita   Pawar " })), {
      value: {
        fullName: "Sunita Pawar",
        phone: "9876543210",
        role: "field_worker",
        areaId: WADGAON,
        password: "Village@2026",
      },
    });
  });

  test("a body that is not an object is refused", () => {
    for (const body of [undefined, null, "user", [newUser()]]) {
      assert.equal(validateNewUser(body).error?.reason, ADMIN_ERROR.INVALID);
    }
  });

  test("a missing or blank name is refused", () => {
    for (const fullName of [undefined, "", "   ", 42]) {
      assert.equal(validateNewUser(newUser({ fullName })).error?.field, "fullName");
    }
  });

  test("a name longer than the column is refused, counted in characters not UTF-16 units", () => {
    assert.equal(validateNewUser(newUser({ fullName: "a".repeat(151) })).error?.field, "fullName");
    // 150 Devanagari letters: 150 characters, 450 bytes. Fits VARCHAR(150).
    assert.equal(validateNewUser(newUser({ fullName: "स".repeat(150) })).error, undefined);
  });

  test("the phone must be in the one spelling sign-in looks up", () => {
    assert.equal(validateNewUser(newUser({ phone: " 9876543210 " })).value.phone, "9876543210");
    assert.equal(validateNewUser(newUser({ phone: "+919876543210" })).value.phone, "+919876543210");
    // Devanagari and fullwidth digits would be matched by the collation and
    // give one account many spellings. Inner spaces would sign in online and
    // then fail offline. A number is not a string.
    for (const phone of ["९८७६५४३२१०", "９８７６５４３２１０", "98765 43210", "98765-43210", 9876543210, ""]) {
      assert.equal(validateNewUser(newUser({ phone })).error?.field, "phone", String(phone));
    }
  });

  test("the role must be one of the three", () => {
    for (const role of [undefined, "", "Admin", "superadmin", "worker"]) {
      assert.equal(validateNewUser(newUser({ role })).error?.field, "role", String(role));
    }
  });

  test("an area id that is not a UUID is refused before any database lookup", () => {
    assert.equal(validateNewUser(newUser({ areaId: "Wadgaon" })).error?.field, "areaId");
  });
});

describe("validatePassword", () => {
  test("at least eight characters", () => {
    assert.equal(validatePassword("Short@1").error?.field, "password");
    assert.equal(validatePassword("Exactly8").value, "Exactly8");
  });

  test("never trimmed, but a password of only spaces is refused because login could never accept it", () => {
    assert.equal(validatePassword("  spaced out  ").value, "  spaced out  ");
    assert.equal(validatePassword("          ").error?.field, "password");
  });

  test("nothing bcrypt would silently ignore: at most 72 bytes", () => {
    assert.equal(validatePassword("a".repeat(MAX_PASSWORD_BYTES)).error, undefined);
    assert.equal(validatePassword("a".repeat(MAX_PASSWORD_BYTES + 1)).error?.field, "password");
    // 25 Devanagari letters are 25 characters but 75 bytes.
    assert.equal(validatePassword("क".repeat(25)).error?.field, "password");
  });

  test("a non-string is refused rather than coerced", () => {
    for (const password of [undefined, null, 12345678, ["Village@2026"]]) {
      assert.equal(validatePassword(password).error?.field, "password");
    }
  });
});

describe("validateUserPatch", () => {
  test("only the fields present come back", () => {
    assert.deepEqual(validateUserPatch({ fullName: " Sunita  P. " }), {
      value: { fullName: "Sunita P." },
    });
    assert.deepEqual(validateUserPatch({ areaId: null }), { value: { areaId: null } });
  });

  test("a field this route does not change is refused, not ignored", () => {
    for (const body of [{ password: "Village@2026" }, { phone: "9999999999" }, { fullName: "A", id: WORKER }]) {
      assert.equal(validateUserPatch(body).error?.reason, ADMIN_ERROR.INVALID);
    }
  });

  test("an empty patch is refused", () => {
    assert.equal(validateUserPatch({}).error?.reason, ADMIN_ERROR.INVALID);
  });

  test("isActive must be a real boolean", () => {
    for (const isActive of ["false", 0, 1, null]) {
      assert.equal(validateUserPatch({ isActive }).error?.field, "isActive", String(isActive));
    }
    assert.deepEqual(validateUserPatch({ isActive: false }), { value: { isActive: false } });
  });
});

describe("validateAreaName", () => {
  test("trimmed, with runs of whitespace folded, so the unique key means what an admin expects", () => {
    assert.deepEqual(validateAreaName("  Shirur   Kasar "), { value: "Shirur Kasar" });
  });

  test("blank, missing and over-long names are refused", () => {
    for (const name of [undefined, "", "  ", 7, "x".repeat(151)]) {
      assert.equal(validateAreaName(name).error?.field, "name", String(name));
    }
  });
});

// ---------------------------------------------------------------------------
// Area required for a field worker
// ---------------------------------------------------------------------------

describe("area required for a field worker", () => {
  test("creating a field worker with no area is refused", () => {
    for (const areaId of [null, undefined]) {
      assert.equal(validateNewUser(newUser({ areaId })).error?.field, "areaId");
    }
  });

  test("creating a supervisor or admin with an area is refused; with none it is accepted", () => {
    for (const role of ["supervisor", "admin"]) {
      assert.equal(validateNewUser(newUser({ role })).error?.field, "areaId", role);
      assert.equal(validateNewUser(newUser({ role, areaId: null })).value.areaId, null, role);
    }
  });

  test("making a supervisor a field worker needs an area in the same request", () => {
    const target = { role: "supervisor", areaId: null };
    assert.equal(plan({ target, patch: { role: "field_worker" } }).error?.field, "areaId");
    assert.deepEqual(plan({ target, patch: { role: "field_worker", areaId: WADGAON } }).value.changes, {
      role: "field_worker",
      areaId: WADGAON,
    });
  });

  test("removing a field worker's area is refused", () => {
    assert.equal(plan({ target: {}, patch: { areaId: null } }).error?.field, "areaId");
  });

  test("moving a field worker to another area is just the area change", () => {
    assert.deepEqual(plan({ target: {}, patch: { areaId: SHIRUR } }).value, {
      changes: { areaId: SHIRUR },
      revokeSessions: false,
    });
  });

  test("leaving field work clears the area when the request does not name one", () => {
    assert.deepEqual(plan({ target: {}, patch: { role: "supervisor" } }).value.changes, {
      role: "supervisor",
      areaId: null,
    });
  });

  test("an area cannot be given to a supervisor", () => {
    const target = { role: "supervisor", areaId: null };
    assert.equal(plan({ target, patch: { areaId: WADGAON } }).error?.field, "areaId");
  });

  test("a field worker from before areas can still be renamed and deactivated without one", () => {
    const target = { areaId: null };
    assert.deepEqual(plan({ target, patch: { fullName: "Sunita P." } }).value.changes, {
      fullName: "Sunita P.",
    });
    assert.deepEqual(plan({ target, patch: { isActive: false } }).value, {
      changes: { isActive: false },
      revokeSessions: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Self-lockout
// ---------------------------------------------------------------------------

describe("self-lockout", () => {
  const me = { id: ADMIN_ME, role: "admin", areaId: null };

  test("an admin cannot deactivate themselves, however many admins there are", () => {
    for (const activeAdminCount of [1, 2, 10]) {
      const result = plan({ target: me, patch: { isActive: false }, activeAdminCount });
      assert.equal(result.error?.reason, ADMIN_ERROR.SELF_LOCKOUT, String(activeAdminCount));
    }
  });

  test("an admin cannot demote themselves to either other role", () => {
    for (const patch of [{ role: "supervisor" }, { role: "field_worker", areaId: WADGAON }]) {
      assert.equal(plan({ target: me, patch }).error?.reason, ADMIN_ERROR.SELF_LOCKOUT, patch.role);
    }
  });

  test("self-lockout is reported ahead of last-admin when both apply", () => {
    const result = plan({ target: me, patch: { isActive: false }, activeAdminCount: 1 });
    assert.equal(result.error?.reason, ADMIN_ERROR.SELF_LOCKOUT);
  });

  test("an admin may still rename themselves", () => {
    assert.deepEqual(plan({ target: me, patch: { fullName: "Archit B." } }).value.changes, {
      fullName: "Archit B.",
    });
  });

  test("another admin may deactivate them", () => {
    const result = plan({ actorId: ADMIN_OTHER, target: me, patch: { isActive: false } });
    assert.equal(result.value.revokeSessions, true);
  });
});

// ---------------------------------------------------------------------------
// Last active admin
// ---------------------------------------------------------------------------

describe("last active admin", () => {
  const other = { id: ADMIN_OTHER, role: "admin", areaId: null };

  test("the only active admin cannot be deactivated or demoted by anyone", () => {
    for (const patch of [{ isActive: false }, { role: "supervisor" }]) {
      const result = plan({ target: other, patch, activeAdminCount: 1 });
      assert.equal(result.error?.reason, ADMIN_ERROR.LAST_ADMIN, JSON.stringify(patch));
    }
  });

  test("with another active admin left, both are allowed", () => {
    assert.equal(plan({ target: other, patch: { isActive: false }, activeAdminCount: 2 }).error, undefined);
    assert.equal(plan({ target: other, patch: { role: "supervisor" }, activeAdminCount: 2 }).error, undefined);
  });

  test("an inactive admin is not counted, so changing one never trips the rule", () => {
    const inactive = { ...other, isActive: 0 };
    assert.equal(plan({ target: inactive, patch: { role: "supervisor" }, activeAdminCount: 1 }).error, undefined);
  });

  test("reactivating or promoting someone never trips it", () => {
    assert.equal(plan({ target: { ...other, isActive: 0 }, patch: { isActive: true }, activeAdminCount: 1 }).error, undefined);
    assert.equal(plan({ target: {}, patch: { role: "admin", areaId: null }, activeAdminCount: 1 }).error, undefined);
  });

  test("renaming the last admin is fine", () => {
    assert.equal(plan({ target: other, patch: { fullName: "Other Admin" }, activeAdminCount: 1 }).error, undefined);
  });
});

// ---------------------------------------------------------------------------
// What gets written
// ---------------------------------------------------------------------------

describe("planUserUpdate: changes and sessions", () => {
  test("only columns that differ are written; a patch repeating the stored values writes nothing", () => {
    const result = plan({ target: {}, patch: { fullName: "Sunita Pawar", areaId: WADGAON, isActive: true } });
    assert.deepEqual(result.value, { changes: {}, revokeSessions: false });
  });

  test("sessions are revoked on deactivation only, not on reactivation or a role change", () => {
    assert.equal(plan({ target: {}, patch: { isActive: false } }).value.revokeSessions, true);
    assert.equal(plan({ target: { isActive: 0 }, patch: { isActive: true } }).value.revokeSessions, false);
    assert.equal(plan({ target: {}, patch: { role: "supervisor" } }).value.revokeSessions, false);
  });

  test("an already inactive user being 'deactivated' again revokes nothing", () => {
    assert.deepEqual(plan({ target: { isActive: 0 }, patch: { isActive: false } }).value, {
      changes: {},
      revokeSessions: false,
    });
  });
});
