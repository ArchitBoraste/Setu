import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { pool } from "../db/index.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    // throws if expired or if even one character was tampered with
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = {
      id: payload.sub,
      role: payload.role,
      organizationId: payload.org,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Role comes from the verified token, never from anything the client claims.
export const requireRole =
  (...allowedRoles) =>
  (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

/**
 * Reads the caller's area from the database, on every request it guards.
 *
 * Area decides which households a field worker sees and may change, and it is
 * deliberately NOT a claim in the token. A token lives fifteen minutes and a
 * device keeps refreshing it without anyone signing in again, so a worker moved
 * to another village would keep the old one's records for as long as they
 * never signed out. Read here, a reassignment takes effect on the next request.
 *
 * Runs after requireAuth. A user who no longer exists, was deactivated, or has
 * moved organisation since the token was signed is refused with 401, which
 * sends the client through a token refresh: a moved account comes back with a
 * token for its new organisation, and a removed or deactivated one fails the
 * refresh too and is told to sign in again.
 */
export const loadArea = asyncHandler(async (req, res, next) => {
  const [[row]] = await pool.query(
    `SELECT u.area_id AS areaId, a.name AS areaName
       FROM users u
       LEFT JOIN areas a ON a.id = u.area_id
      WHERE u.id = ? AND u.organization_id = ?
        AND u.deleted_at IS NULL AND u.is_active = 1`,
    [req.user.id, req.user.organizationId]
  );

  if (!row) return res.status(401).json({ error: "Account not found" });

  req.user.areaId = row.areaId;
  req.user.areaName = row.areaName;
  next();
});
