import express from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  signAccessToken,
  issueRefreshToken,
  findValidRefreshToken,
  revokeRefreshToken,
} from "../utils/tokens.js";

const router = express.Router();

const BCRYPT_ROUNDS = 12;

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
    const { phone, password } = req.body ?? {};

    if (!isNonEmptyString(phone) || !isNonEmptyString(password)) {
      return res
        .status(400)
        .json({ error: "Phone and password are required, as strings" });
    }

    const [[user]] = await pool.query(
      `SELECT u.id, u.full_name AS fullName, u.phone, u.role,
              u.organization_id AS organizationId,
              u.area_id AS areaId, a.name AS areaName,
              u.password_hash AS passwordHash, u.is_active AS isActive
         FROM users u
         LEFT JOIN areas a ON a.id = u.area_id
        WHERE u.phone = ? AND u.deleted_at IS NULL`,
      [phone]
    );

    // same message for "no such user" and "wrong password" so nobody can
    // discover which phone numbers are registered
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok || !user.isActive) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await pool.query(`UPDATE users SET last_login_at = NOW(3) WHERE id = ?`, [
      user.id,
    ]);

    // a separate hash for this device to check against when there is no network
    const offlineHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: await issueRefreshToken(user.id),
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

    const row = await findValidRefreshToken(refreshToken);
    if (!row) return res.status(401).json({ error: "Invalid refresh token" });

    // rotate: the old token dies the moment it is used, so a stolen copy is
    // useless once the real user refreshes
    await revokeRefreshToken(refreshToken);

    const user = {
      id: row.userId,
      role: row.role,
      organizationId: row.organizationId,
    };

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: await issueRefreshToken(user.id),
    });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (isNonEmptyString(refreshToken)) await revokeRefreshToken(refreshToken);
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
