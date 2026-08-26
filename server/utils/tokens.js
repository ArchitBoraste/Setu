import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { config } from "../config/env.js";

// Access token: short-lived, never stored in the DB. The signature IS the proof.
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      org: user.organization_id,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessTtl }
  );
}

// Refresh token: long-lived, stored hashed so a DB leak is useless to an attacker.
export async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString("hex"); // raw value, shown once
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const expiresAt = new Date(
    Date.now() + config.jwt.refreshDays * 24 * 60 * 60 * 1000
  );

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), userId, tokenHash, expiresAt]
  );

  return token;
}

// Look up a refresh token by its hash, and make sure it is still usable.
export async function findValidRefreshToken(token) {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const [[row]] = await pool.query(
    `SELECT rt.*, u.role, u.organization_id, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ?
        AND rt.revoked_at IS NULL
        AND rt.expires_at > NOW(3)
        AND u.deleted_at IS NULL`,
    [tokenHash]
  );

  return row && row.is_active ? row : null;
}

export async function revokeRefreshToken(token) {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(3) WHERE token_hash = ?`,
    [tokenHash]
  );
}