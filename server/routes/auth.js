import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createLoginLimiter,
  normaliseLoginPhone,
  retryAfterSeconds,
  tooManyAttemptsMessage,
} from "../utils/loginLimiter.js";
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshFamily,
} from "../utils/tokens.js";

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// What a sign-in for a phone with no account compares the password against,
// so that it costs one bcrypt.compare like a wrong password does. Skipping the
// compare answered in milliseconds instead of the half second a compare takes
// with bcryptjs, and that difference told anyone which phone numbers are
// registered.
//
// A real hash of a random password nobody knows, made once at startup at the
// same cost as real accounts: bcrypt's running time is set by the cost stored
// in the hash. db/demoData.js hashes the seeded accounts at 12 too. If the two
// costs ever drift apart, unknown numbers and real ones become distinguishable
// again.
const DUMMY_PASSWORD_HASH = await bcrypt.hash(
  crypto.randomBytes(32).toString("hex"),
  BCRYPT_ROUNDS
);

// One limiter for this process. See utils/loginLimiter.js for why it lives in
// memory and counts per phone number rather than per IP address.
const loginLimiter = createLoginLimiter();

// JSON lets a client send a number, boolean, object or array anywhere we expect
// a string. bcrypt and crypto both throw on a non-string input, so credentials
// get their type checked here instead of blowing up deeper in the stack.
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// The one public shape of a user, shared by /login and /me so they cannot drift.
// Built field by field rather than spreading the row, so internal columns such
// as passwordHash and isActive can never leak into a response.
function toProfile(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    organizationId: user.organizationId,
    // Null for a user with no area — every supervisor and admin, and any field
    // worker not yet assigned one. The device uses it only to decide what to
    // SHOW; sync scope is read from the database on every request.
    areaId: user.areaId ?? null,
    areaName: user.areaName ?? null,
  };
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { phone: rawPhone, password } = req.body ?? {};

    if (!isNonEmptyString(rawPhone) || !isNonEmptyString(password)) {
      return res
        .status(400)
        .json({ error: "Phone and password are required, as strings" });
    }

    // Answered at once, with no bcrypt, and that is safe: every stored phone
    // is in this form, so a phone that is not cannot be anyone's, and saying
    // so reveals nothing about who is registered. See normaliseLoginPhone for
    // why other scripts' digits are refused rather than looked up.
    const phone = normaliseLoginPhone(rawPhone);
    if (!phone) {
      return res
        .status(400)
        .json({ error: "Enter the phone number using the digits 0-9 only" });
    }

    // Before the database and before bcrypt: a refused request costs nothing.
    // Whether the phone is registered plays no part in the decision, so a
    // 429 cannot be used to find out.
    const gate = loginLimiter.begin(phone);
    if (!gate.allowed) {
      res.set("Retry-After", String(retryAfterSeconds(gate.retryAfterMs)));
      return res
        .status(429)
        .json({ error: tooManyAttemptsMessage(gate.retryAfterMs) });
    }

    let user;
    let passwordMatches;
    try {
      const [rows] = await pool.query(
        `SELECT u.id, u.full_name AS fullName, u.phone, u.role,
                u.organization_id AS organizationId,
                u.area_id AS areaId, a.name AS areaName,
                u.password_hash AS passwordHash, u.is_active AS isActive
           FROM users u
           LEFT JOIN areas a ON a.id = u.area_id
          WHERE u.phone = ? AND u.deleted_at IS NULL`,
        [phone]
      );
      user = rows[0];

      // Always exactly one compare, whoever the phone belongs to, so "no such
      // user", "disabled user" and "wrong password" take the same time.
      passwordMatches = await bcrypt.compare(
        password,
        user?.passwordHash ?? DUMMY_PASSWORD_HASH
      );
    } catch (error) {
      // Broke before the password was judged, so this was no guess. Counting
      // it would lock workers out for retrying while the database was down.
      loginLimiter.release(gate.attempt);
      throw error;
    }

    // One answer for all three, so the response does not reveal which phone
    // numbers are registered or which accounts are disabled. No limiter call:
    // the attempt was counted when it began, and now stands as the failure.
    if (!user || !user.isActive || !passwordMatches) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    loginLimiter.succeeded(gate.attempt);

    await pool.query(`UPDATE users SET last_login_at = NOW(3) WHERE id = ?`, [
      user.id,
    ]);

    // a separate hash for this device to check against when there is no network
    const offlineHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // A sign-in starts a new token family: the session that sign-out ends.
    const { token: refreshToken } = await issueRefreshToken(user.id);

    res.json({
      accessToken: signAccessToken(user),
      refreshToken,
      offlineHash,
      profile: toProfile(user),
    });
  })
);

// Called when the 15-minute access token expires.
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (!isNonEmptyString(refreshToken)) {
      return res.status(400).json({ error: "Missing token" });
    }

    // rotate: the old token dies the moment it is used, so a stolen copy is
    // useless once the real user refreshes. Check, revoke and re-issue are one
    // transaction, so two refreshes racing with the same token cannot both win.
    //
    // Presenting a token that was already rotated is taken as theft and ends
    // the whole session, the winner's new token included. That covers the
    // loser of such a race too: two browser tabs refreshing at the same moment
    // sign the user out. The client shares one refresh within a tab, not
    // across tabs.
    //
    // Reuse, expiry, sign-out and an unknown token all get the same 401, so
    // the answer never tells a caller which tokens exist or what became of
    // them.
    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) return res.status(401).json({ error: "Invalid refresh token" });

    res.json({
      accessToken: signAccessToken(rotated.user),
      refreshToken: rotated.token,
    });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    // The whole session, not just the token presented, so a successor that a
    // refresh still in flight has just minted cannot outlive the sign-out. 200
    // whether or not the token matched anything, so this cannot test tokens.
    if (isNonEmptyString(refreshToken)) await revokeRefreshFamily(refreshToken);
    res.json({ success: true });
  })
);

// Lets the client confirm a stored token is still good.
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const [[user]] = await pool.query(
      `SELECT u.id, u.full_name AS fullName, u.phone, u.role,
              u.organization_id AS organizationId,
              u.area_id AS areaId, a.name AS areaName
         FROM users u
         LEFT JOIN areas a ON a.id = u.area_id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [req.user.id]
    );

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(toProfile(user));
  })
);

export default router;
