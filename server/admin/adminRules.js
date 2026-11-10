// The decisions behind /api/admin, kept apart from Express and MySQL for the
// same reason pushRules.js and refreshTokenRules.js are: the branch that gets
// one of these wrong does not throw. It leaves an organisation with nobody who
// can manage it, or a field worker who silently sees nothing, and both have to
// be testable with three literals and no database.
//
// Every function returns { value } or { error: { reason, message, field? } }.
// `message` is written for the admin reading the screen, and the client shows
// it as it is, so it says what to do rather than which check failed.

import { normaliseLoginPhone } from "../utils/loginLimiter.js";

export const ROLES = Object.freeze(["field_worker", "supervisor", "admin"]);

export const MIN_PASSWORD_LENGTH = 8;

// bcrypt reads only the first 72 bytes of a password and ignores the rest, so
// two long passwords sharing a 72-byte prefix are the same password. Refusing
// longer ones is better than accepting characters that do nothing. Bytes, not
// characters: one Devanagari letter is three bytes in UTF-8.
export const MAX_PASSWORD_BYTES = 72;

// The VARCHAR lengths of users.full_name and areas.name. Checked here so an
// over-long name is a sentence on the screen rather than a 500 from strict mode.
export const FULL_NAME_MAX_LENGTH = 150;
export const AREA_NAME_MAX_LENGTH = 150;

export const ADMIN_ERROR = {
  // A field is missing, malformed or contradicts another one.
  INVALID: "invalid",
  // An admin acting on their own account in a way that would lock them out.
  SELF_LOCKOUT: "self_lockout",
  // The change would leave the organisation with no active admin.
  LAST_ADMIN: "last_admin",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What PATCH /users/:id may change. Phone and password are deliberately absent:
// the phone is the sign-in identity a worker's phone compares offline, and a
// password has its own route that also ends every session.
const PATCHABLE_USER_FIELDS = ["fullName", "role", "areaId", "isActive"];

function fail(message, { reason = ADMIN_ERROR.INVALID, field } = {}) {
  return { error: { reason, message, ...(field ? { field } : {}) } };
}

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A person's or a place's name: trimmed, with every run of whitespace folded to
 * one space.
 *
 * Both columns use a NO PAD collation, so "Wadgaon " and "Wadgaon" would be two
 * different areas, and a double space typed by accident would be a second
 * "Shirur Kasar" that nobody can tell apart from the first in a list. Folding
 * here makes the unique key on areas.name mean what an admin expects it to.
 * Case and accents need nothing: utf8mb4_0900_ai_ci already treats "wadgaon"
 * as a duplicate of "Wadgaon".
 */
function cleanName(value, { label, field, maxLength }) {
  if (typeof value !== "string") return fail(`${label} is required.`, { field });
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "") return fail(`${label} is required.`, { field });
  // Code points, which is what VARCHAR(n) counts under utf8mb4. String length
  // would count an emoji or a rare script's letter as two.
  if ([...name].length > maxLength) {
    return fail(`${label} must be at most ${maxLength} characters.`, { field });
  }
  return { value: name };
}

export function validateFullName(value) {
  return cleanName(value, {
    label: "Full name",
    field: "fullName",
    maxLength: FULL_NAME_MAX_LENGTH,
  });
}

export function validateAreaName(value) {
  return cleanName(value, { label: "Area name", field: "name", maxLength: AREA_NAME_MAX_LENGTH });
}

/**
 * A password an admin sets, on creation or reset.
 *
 * Never trimmed: a password is exactly what was typed. But one made only of
 * spaces is refused, because the login route trims before deciding a password
 * was sent at all — such an account could be created and never signed into.
 */
export function validatePassword(password) {
  const field = "password";
  if (typeof password !== "string" || password.trim() === "") {
    return fail("A password is required.", { field });
  }
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`, { field });
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return fail(
      `The password is too long. Keep it under ${MAX_PASSWORD_BYTES} bytes (fewer characters if it uses Devanagari).`,
      { field }
    );
  }
  return { value: password };
}

function validateRole(role) {
  if (!ROLES.includes(role)) {
    return fail(`Role must be one of ${ROLES.join(", ")}.`, { field: "role" });
  }
  return { value: role };
}

// null and an omitted value both mean "no area". Anything else must look like
// an id; whether it is THIS organisation's area is the route's question, since
// only the database knows.
function parseAreaId(value) {
  if (value === null || value === undefined) return { value: null };
  if (!isUuid(value)) return fail("Choose an area from the list.", { field: "areaId" });
  return { value };
}

/**
 * Whether a role and an area belong together.
 *
 * A field worker is scoped by area (server/sync/scopeRules.js). One with no
 * area sees only their own captures and shares nothing with the colleague in
 * the next lane, which exists today only as a leftover from before areas — not
 * a state to create on purpose.
 *
 * A supervisor or admin sees the whole organisation whatever area they hold, so
 * an area on them means nothing now, and would quietly start meaning something
 * the day they were made a field worker: they would land in a village nobody
 * chose for them at that moment.
 */
function checkAreaForRole(role, areaId) {
  if (role === "field_worker" && areaId === null) {
    return fail("A field worker needs an area.", { field: "areaId" });
  }
  if (role !== "field_worker" && areaId !== null) {
    return fail("Only field workers have an area. Leave it empty for supervisors and admins.", {
      field: "areaId",
    });
  }
  return null;
}

/**
 * The body of POST /users, checked whole. Returns the values to insert, phone
 * in the one spelling sign-in looks up (see normaliseLoginPhone).
 */
export function validateNewUser(body) {
  if (!isPlainObject(body)) return fail("Send the new user as a JSON object.");

  const fullName = validateFullName(body.fullName);
  if (fullName.error) return fullName;

  // The same function login uses, so an account can only be created under a
  // spelling sign-in will find. A number stored any other way could never be
  // signed into, and a Devanagari one would reopen the rate-limit bypass that
  // function exists to close.
  const phone = normaliseLoginPhone(body.phone);
  if (!phone) {
    return fail("Enter the phone number using the digits 0-9 only, with an optional leading +.", {
      field: "phone",
    });
  }

  const role = validateRole(body.role);
  if (role.error) return role;

  const areaId = parseAreaId(body.areaId);
  if (areaId.error) return areaId;

  const areaError = checkAreaForRole(role.value, areaId.value);
  if (areaError) return areaError;

  const password = validatePassword(body.password);
  if (password.error) return password;

  return {
    value: {
      fullName: fullName.value,
      phone,
      role: role.value,
      areaId: areaId.value,
      password: password.value,
    },
  };
}

/**
 * The body of PATCH /users/:id: only the fields present, each checked on its
 * own. Whether they make sense together, and for this user, is planUserUpdate's
 * job, because that needs the stored row.
 *
 * An unknown field is refused rather than ignored. An admin whose client sent
 * `password` here would otherwise be told "saved" about a password that never
 * changed.
 */
export function validateUserPatch(body) {
  if (!isPlainObject(body)) return fail("Send the fields to change as a JSON object.");

  const keys = Object.keys(body);
  const unknown = keys.filter((key) => !PATCHABLE_USER_FIELDS.includes(key));
  if (unknown.length > 0) {
    return fail(
      `These fields cannot be changed here: ${unknown.join(", ")}. ` +
        "A password has its own reset, and a phone number cannot be changed."
    );
  }
  if (keys.length === 0) return fail("Nothing to change.");

  const patch = {};

  if ("fullName" in body) {
    const fullName = validateFullName(body.fullName);
    if (fullName.error) return fullName;
    patch.fullName = fullName.value;
  }
  if ("role" in body) {
    const role = validateRole(body.role);
    if (role.error) return role;
    patch.role = role.value;
  }
  if ("areaId" in body) {
    const areaId = parseAreaId(body.areaId);
    if (areaId.error) return areaId;
    patch.areaId = areaId.value;
  }
  if ("isActive" in body) {
    // Strictly a boolean. "false" is a truthy string, and 0/1 invite the
    // question of what 2 means; deactivating someone deserves an unambiguous yes.
    if (typeof body.isActive !== "boolean") {
      return fail("isActive must be true or false.", { field: "isActive" });
    }
    patch.isActive = body.isActive;
  }

  return { value: patch };
}

/**
 * What a validated patch does to one stored user, decided before anything is
 * written.
 *
 * @param {object} args
 * @param {string} args.actorId           the admin making the change, from the verified token
 * @param {object} args.target            the stored user, read under lock:
 *                                        { id, fullName, role, areaId, isActive }
 *                                        isActive as MySQL's 1/0 or a boolean
 * @param {object} args.patch             from validateUserPatch
 * @param {number} args.activeAdminCount  active admins in the organisation, the
 *                                        target included if it is one, counted
 *                                        under the same lock
 *
 * Returns { value: { changes, revokeSessions } }. `changes` holds only the
 * columns that actually differ, so an empty object means "nothing to write".
 * `revokeSessions` is true exactly when this deactivates the user.
 */
export function planUserUpdate({ actorId, target, patch, activeAdminCount }) {
  const wasActive = target.isActive === true || target.isActive === 1;
  const currentAreaId = target.areaId ?? null;

  const role = patch.role ?? target.role;
  const isActive = patch.isActive ?? wasActive;

  // Leaving field work clears the area unless the request names one. An area
  // means nothing to an organisation-wide role, and kept, it would put them
  // back in that village unasked if they were ever made a field worker again.
  let areaId = "areaId" in patch ? patch.areaId : currentAreaId;
  if (role !== "field_worker" && !("areaId" in patch)) areaId = null;

  // SELF-LOCKOUT. Checked first, so an admin trying to demote themselves is
  // told that, rather than "last admin" when they also happen to be the last.
  // The cure is the same either way: another admin has to do it, so that
  // losing admin rights is never one person's mis-click on their own row.
  if (target.id === actorId) {
    if (!isActive) {
      return fail("You cannot deactivate your own account. Ask another admin to do it.", {
        reason: ADMIN_ERROR.SELF_LOCKOUT,
        field: "isActive",
      });
    }
    if (role !== "admin") {
      return fail("You cannot remove your own admin role. Ask another admin to do it.", {
        reason: ADMIN_ERROR.SELF_LOCKOUT,
        field: "role",
      });
    }
  }

  // LAST ADMIN. With the self rule above and a caller who is an active admin,
  // removing someone else's admin status always leaves the caller, so through
  // today's route this cannot fire: two admins demoting each other at once are
  // serialised by the route's lock, and the second is refused because its
  // caller is no longer an admin. It is stated here anyway because it is THE
  // invariant, and the self rule plus a route-level check only add up to it by
  // coincidence. A future caller that is not a signed-in admin — a script, a
  // bulk import, a "deactivate everyone in this area" action — gets it for
  // free. Broken, it leaves an organisation that only a hand-written UPDATE can
  // give an admin again.
  const wasActiveAdmin = target.role === "admin" && wasActive;
  const staysActiveAdmin = role === "admin" && isActive;
  if (wasActiveAdmin && !staysActiveAdmin && activeAdminCount <= 1) {
    return fail(
      "This is the organisation's only active admin. Make someone else an admin first.",
      { reason: ADMIN_ERROR.LAST_ADMIN }
    );
  }

  // The area rule applies when this request decides something about role or
  // area — not on a rename or a (de)activation. Field workers created before
  // areas existed have none, and they must stay renamable and deactivatable
  // without first being placed in a village.
  if ("role" in patch || "areaId" in patch) {
    const areaError = checkAreaForRole(role, areaId);
    if (areaError) return areaError;
  }

  const changes = {};
  if (patch.fullName !== undefined && patch.fullName !== target.fullName) {
    changes.fullName = patch.fullName;
  }
  if (role !== target.role) changes.role = role;
  if (areaId !== currentAreaId) changes.areaId = areaId;
  if (isActive !== wasActive) changes.isActive = isActive;

  return {
    value: {
      changes,
      // A deactivated account must stop syncing now, not when a refresh token
      // a month from expiry finally lapses. Reactivation revokes nothing: the
      // person signs in again, which starts a fresh session.
      revokeSessions: wasActive && !isActive,
    },
  };
}
