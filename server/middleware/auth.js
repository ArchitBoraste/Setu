import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

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