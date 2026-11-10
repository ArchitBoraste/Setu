import crypto from "crypto";

// The decisions behind refresh tokens, kept apart from tokens.js so they can be
// tested without a database. tokens.js imports the pool and config, and config
// exits the process when .env is missing — neither belongs in a unit test.

const DAY_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SHA-256 of a raw refresh token, as 64 hex characters — the shape of
 * refresh_tokens.token_hash. Every insert and every lookup goes through this
 * one function: if two call sites ever disagreed about the encoding, every
 * token would quietly stop matching its own row.
 */
export function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * When a token minted at `now` stops working.
 *
 * Every rotation gets a full lifetime from the moment it is minted, so a
 * session lasts as long as the device keeps refreshing within the window. A
 * non-positive or non-numeric lifetime is refused rather than computed: it
 * would mint tokens that are dead on arrival, and the only symptom would be
 * every user being signed out at their next refresh.
 */
export function refreshExpiresAt(now, days) {
  if (!Number.isFinite(days) || days <= 0) {
    throw new RangeError(`refresh token lifetime must be a positive number of days, got ${days}`);
  }
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Which family a newly minted token joins.
 *
 * A rotation passes the family of the token it replaces and inherits it. A
 * sign-in passes nothing and starts a family named after its own first token —
 * the convention migration 005 used for every older row, so on every row the
 * root of a family is the one whose id equals its family_id.
 *
 * Anything that is not a UUID is a bug in the caller and throws. In particular
 * an empty string must never be read as "start a new family": a rotation that
 * lost its family would split the session in two, and sign-out would revoke
 * only half of it.
 */
export function familyIdFor(inheritedFamilyId, newTokenId) {
  const familyId = inheritedFamilyId ?? newTokenId;
  if (typeof familyId !== "string" || !UUID_RE.test(familyId)) {
    throw new TypeError(`refresh token family must be a UUID, got ${familyId}`);
  }
  return familyId;
}

/**
 * What presenting a refresh token amounts to. Only VALID may be rotated, and
 * only REUSED changes anything else: it revokes the token's whole family.
 * Everything that is not VALID gets the same 401, so the client is never told
 * which of these it was.
 */
export const REFRESH_TOKEN_STATE = {
  VALID: "valid",
  // Rotated once already, and presented again. See classifyRefreshToken.
  REUSED: "reused",
  // Revoked without being rotated: signed out, caught in a family revoked for
  // reuse, or rotated before migration 005, when nothing recorded a successor.
  REVOKED: "revoked",
  EXPIRED: "expired",
  // No row has this hash: never issued, mistyped, or wiped by demo:reset.
  UNKNOWN: "unknown",
  // A live token whose user has been deactivated or deleted since sign-in.
  USER_INACTIVE: "user_inactive",
};

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Classifies the refresh_tokens row a presented token hashed to.
 *
 * `row` is null when no row matched, else
 *   { replacedBy, revokedAt, expiresAt, userActive }
 * with userActive the database's 1/0 for "is_active = 1 AND deleted_at IS
 * NULL". `now` is consulted only for expiry; the caller passes the database's
 * clock so the cut-off is the same one `expires_at > NOW(3)` used to apply.
 *
 * Reuse is checked first, ahead of expiry and the user's state, because each
 * of those would otherwise hide a theft. Say an attacker rotated a stolen token
 * and kept refreshing. Every rotation mints a fresh lifetime, so the
 * attacker's chain is live long after the copy the real user still holds has
 * expired. If that copy were classed as "expired", it would be refused and the
 * attacker's session would carry on. The same goes for an account disabled
 * after a suspected compromise: once someone re-enables it, the attacker's
 * chain works again unless the reuse revoked it.
 *
 * A non-null replacedBy alone counts as reuse, whether or not revokedAt is
 * set. Rotation writes the two in one UPDATE, so only a hand edit can separate
 * them, and clearing revoked_at must never make a token that already has a
 * successor usable again.
 *
 * userActive must be exactly 1 or true. Anything else, including a column
 * dropped from the SELECT by a refactor, refuses the token rather than
 * accepting it.
 */
export function classifyRefreshToken(row, now) {
  if (row == null) return REFRESH_TOKEN_STATE.UNKNOWN;

  if (row.replacedBy != null) return REFRESH_TOKEN_STATE.REUSED;
  if (row.revokedAt != null) return REFRESH_TOKEN_STATE.REVOKED;

  // expires_at is NOT NULL and `now` is always passed, so a missing date is a
  // bug in the caller. Say so loudly. Reading it as "expired" would sign every
  // user out with nothing in the logs to say why.
  if (!isValidDate(row.expiresAt)) {
    throw new TypeError(`refresh token row needs expiresAt as a Date, got ${row.expiresAt}`);
  }
  if (!isValidDate(now)) {
    throw new TypeError(`classifying a refresh token needs now as a Date, got ${now}`);
  }
  // At the exact millisecond of expiry the token is already dead, as it was
  // under `expires_at > NOW(3)`.
  if (row.expiresAt.getTime() <= now.getTime()) return REFRESH_TOKEN_STATE.EXPIRED;

  if (row.userActive !== 1 && row.userActive !== true) {
    return REFRESH_TOKEN_STATE.USER_INACTIVE;
  }

  return REFRESH_TOKEN_STATE.VALID;
}
