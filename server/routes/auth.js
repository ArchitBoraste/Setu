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
      `SELECT * FROM users WHERE phone = ? AND deleted_at IS NULL`,
      [phone]
    );

    // same message for "no such user" and "wrong password" so nobody can
    // discover which phone numbers are registered
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok || !user.is_active) {
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
      profile: {
        id: user.id,
        fullName: user.full_name,
        phone: user.phone,
        role: user.role,
        organizationId: user.organization_id,
      },
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
      id: row.user_id,
      role: row.role,
      organization_id: row.organization_id,
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
      `SELECT id, full_name, phone, role, organization_id
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.user.id]
    );

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  })
);

export default router;
