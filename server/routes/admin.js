import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { requireAuth, requireLiveRole, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { BCRYPT_ROUNDS } from "../utils/passwords.js";
import { SERVER_TIME_FORMAT } from "../sync/serverTime.js";
import adminFormsRoutes from "./adminForms.js";
import {
  ADMIN_ERROR,
  isUuid,
  planUserUpdate,
  validateAreaName,
  validateNewUser,
  validatePassword,
  validateUserPatch,
} from "../admin/adminRules.js";

// Users and areas, managed by an organisation's admins.
//
// ONLINE-ONLY, like the conflict routes and for a related reason: these are
// privileged writes about other people's access, and two admins doing them from
// two offline phones would produce changes nobody could order — one reactivating
// a worker the other just deactivated, each believing theirs stood. Nothing here
// touches capture; a field worker's path to saving a household visit never
// passes through this file.
//
// Every query is scoped to the caller's organisation, taken from the verified
// token. An id from another organisation is answered exactly like an id that
// does not exist, so this API cannot be used to learn what other organisations
// hold.

const router = express.Router();

// The token says "admin" for up to fifteen minutes after it was signed. That is
// not good enough here: an admin who has just been deactivated or demoted must
// not spend the rest of their token creating accounts and resetting passwords,
// so requireLiveRole asks the database on every request (utils/liveRole.js).
//
// requireRole first, so a field worker is refused from the token alone without
// costing a query, and the database check only runs for tokens that claim admin.
router.use(requireAuth, requireRole("admin"), requireLiveRole("admin"));

// Form versions. Mounted after the line above, so every forms route is behind
// the same live admin check; see routes/adminForms.js.
router.use("/forms", adminFormsRoutes);

// A failed rule, as the client shows it. INVALID is a bad request; the other
// two are refusals of a well-formed request because of who is asking or what
// the organisation would be left with, which is what 409 says.
function sendRuleError(res, error) {
  const status = error.reason === ADMIN_ERROR.INVALID ? 400 : 409;
  return res.status(status).json({
    error: error.message,
    reason: error.reason,
    ...(error.field ? { field: error.field } : {}),
  });
}

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------

// Named column by column, never SELECT *: password_hash sits in the same row,
// and a list of every user's hash is exactly what must never leave the server.
const USER_COLUMNS = `
  u.id,
  u.full_name AS fullName,
  u.phone,
  u.role,
  u.area_id   AS areaId,
  a.name      AS areaName,
  u.is_active AS isActive,
  DATE_FORMAT(u.last_login_at, '${SERVER_TIME_FORMAT}') AS lastLoginAt`;

const USER_FROM = `
    FROM users u
    LEFT JOIN areas a ON a.id = u.area_id`;

// deleted_at is honoured even though nothing here sets it: a soft-deleted user
// is gone as far as every other route is concerned, and must not reappear in
// the one list that can reactivate people.
const SELECT_USERS = `
  SELECT ${USER_COLUMNS} ${USER_FROM}
   WHERE u.organization_id = ? AND u.deleted_at IS NULL
   ORDER BY u.full_name ASC, u.id ASC`;

const SELECT_USER = `
  SELECT ${USER_COLUMNS} ${USER_FROM}
   WHERE u.id = ? AND u.organization_id = ? AND u.deleted_at IS NULL`;

function toUserView(row) {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    role: row.role,
    areaId: row.areaId ?? null,
    areaName: row.areaName ?? null,
    // TINYINT(1) arrives as 1/0. The API speaks booleans.
    isActive: row.isActive === 1,
    // Server time, in the same format as every other timestamp this API sends.
    lastLoginAt: row.lastLoginAt ?? null,
  };
}

async function readUserView(conn, organizationId, id) {
  const [[row]] = await conn.query(SELECT_USER, [id, organizationId]);
  return row ? toUserView(row) : null;
}

// Whether an area id names an area of THIS organisation. The composite foreign
// key on users already refuses another organisation's area, but as a 500-ish
// constraint error; asking first gives the admin a sentence. Areas are never
// deleted, so the answer cannot go stale before the write.
async function areaBelongsTo(organizationId, areaId) {
  const [[area]] = await pool.query(
    `SELECT id FROM areas WHERE id = ? AND organization_id = ?`,
    [areaId, organizationId]
  );
  return Boolean(area);
}

const AREA_NOT_FOUND = {
  reason: ADMIN_ERROR.INVALID,
  field: "areaId",
  message: "That area does not exist in your organisation. Reload and choose again.",
};

// Ends every session the user has, on the caller's transaction. revoked_at with
// no replaced_by is what classifyRefreshToken reads as signed out, so the next
// refresh from any of their devices gets a 401 and the device asks for a fresh
// sign-in. Access tokens already issued live out their fifteen minutes on routes
// that only verify the signature; the sync routes re-read is_active through
// loadArea and stop at once.
async function revokeAllSessions(conn, userId) {
  const [result] = await conn.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(3)
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId]
  );
  return result.affectedRows;
}

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    // No pagination: an organisation's staff list is tens of people, and the
    // screen needs all of them to offer areas and spot duplicates anyway.
    const [rows] = await pool.query(SELECT_USERS, [req.user.organizationId]);
    res.json({ users: rows.map(toUserView) });
  })
);

router.post(
  "/users",
  asyncHandler(async (req, res) => {
    const parsed = validateNewUser(req.body);
    if (parsed.error) return sendRuleError(res, parsed.error);

    const { fullName, phone, role, areaId, password } = parsed.value;
    const organizationId = req.user.organizationId;

    if (areaId !== null && !(await areaBelongsTo(organizationId, areaId))) {
      return sendRuleError(res, AREA_NOT_FOUND);
    }

    // Hashed before the INSERT and outside any transaction: at this cost bcrypt
    // takes a quarter of a second, and nothing should hold a connection for it.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    // A server-made UUID like every other key. Users are created only online,
    // but the column has the same shape as the syncable tables' keys.
    const id = crypto.randomUUID();

    try {
      await pool.query(
        `INSERT INTO users
           (id, organization_id, full_name, phone, password_hash, role, area_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, organizationId, fullName, phone, passwordHash, role, areaId]
      );
    } catch (error) {
      // The unique key is the check, not a SELECT beforehand: two admins adding
      // the same number at once would both pass a SELECT. It is global, across
      // organisations and deleted users alike, because sign-in finds an account
      // by phone alone — two people with one number could not both sign in.
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          error: "This phone number is already registered to another account.",
          reason: ADMIN_ERROR.INVALID,
          field: "phone",
        });
      }
      throw error;
    }

    res.status(201).json(await readUserView(pool, organizationId, id));
  })
);

router.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: "User not found." });

    const parsed = validateUserPatch(req.body);
    if (parsed.error) return sendRuleError(res, parsed.error);
    const patch = parsed.value;
    const organizationId = req.user.organizationId;

    if (patch.areaId && !(await areaBelongsTo(organizationId, patch.areaId))) {
      return sendRuleError(res, AREA_NOT_FOUND);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        // The organisation's active admins, LOCKED, before the target. Two
        // admins demoting each other at once both queue here, and the second
        // reads the first one's commit — so the caller check below refuses it,
        // and the count handed to the last-admin rule is never stale. Always
        // this set first and the target second, in every request, so two of
        // these can never hold each other's rows.
        const [admins] = await conn.query(
          `SELECT id FROM users
            WHERE organization_id = ? AND role = 'admin'
              AND is_active = 1 AND deleted_at IS NULL
              FOR UPDATE`,
          [organizationId]
        );

        // The middleware checked this, but before the lock. Re-checked here so
        // an admin demoted by the request this one queued behind cannot act on
        // the strength of a read that has since been overturned.
        if (!admins.some((admin) => admin.id === req.user.id)) {
          await conn.rollback();
          return res.status(403).json({ error: "Forbidden" });
        }

        const [[target]] = await conn.query(
          `SELECT id, full_name AS fullName, role, area_id AS areaId,
                  is_active AS isActive
             FROM users
            WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
              FOR UPDATE`,
          [id, organizationId]
        );
        if (!target) {
          await conn.rollback();
          return res.status(404).json({ error: "User not found." });
        }

        const plan = planUserUpdate({
          actorId: req.user.id,
          target,
          patch,
          activeAdminCount: admins.length,
        });
        if (plan.error) {
          await conn.rollback();
          return sendRuleError(res, plan.error);
        }

        const { changes, revokeSessions } = plan.value;

        if (Object.keys(changes).length > 0) {
          // One fixed statement writing all four columns, the unchanged ones
          // with their stored values, rather than a SET clause assembled from
          // whichever fields changed. users.updated_at still only moves when a
          // value really differs.
          await conn.query(
            `UPDATE users
                SET full_name = ?, role = ?, area_id = ?, is_active = ?
              WHERE id = ?`,
            [
              changes.fullName ?? target.fullName,
              changes.role ?? target.role,
              "areaId" in changes ? changes.areaId : target.areaId,
              "isActive" in changes ? changes.isActive : target.isActive === 1,
              target.id,
            ]
          );
        }

        // Same transaction as is_active = 0. If either fails, neither happens:
        // there is no moment at which the account is off but a phone can still
        // refresh its way back in.
        const sessionsRevoked = revokeSessions ? await revokeAllSessions(conn, target.id) : 0;

        await conn.commit();

        res.json({
          user: await readUserView(conn, organizationId, target.id),
          changed: Object.keys(changes),
          sessionsRevoked,
        });
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    } finally {
      conn.release();
    }
  })
);

router.post(
  "/users/:id/reset-password",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: "User not found." });

    const password = validatePassword(req.body?.password);
    if (password.error) return sendRuleError(res, password.error);

    const passwordHash = await bcrypt.hash(password.value, BCRYPT_ROUNDS);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        const [updated] = await conn.query(
          `UPDATE users SET password_hash = ?
            WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
          [passwordHash, id, req.user.organizationId]
        );
        if (updated.affectedRows !== 1) {
          await conn.rollback();
          return res.status(404).json({ error: "User not found." });
        }

        // A reset usually means the old password is known to someone it should
        // not be. Every session signed in with it ends here, in the same
        // transaction, so a phone holding a stolen refresh token is not left
        // with a working session after the password it was taken under is gone.
        const sessionsRevoked = await revokeAllSessions(conn, id);

        await conn.commit();
        res.json({ id, sessionsRevoked, self: id === req.user.id });
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    } finally {
      conn.release();
    }
  })
);

// ---------------------------------------------------------------------------
// AREAS
// ---------------------------------------------------------------------------

// Counts of who works an area and what is filed under it, so an admin renaming
// or choosing one can see what it holds. Active users only, and live records
// only: an inactive account works nowhere, and a tombstone is not a household.
// Each subquery is answered from an (organization_id, area_id, …) index.
const AREA_COLUMNS = `
  a.id,
  a.name,
  (SELECT COUNT(*) FROM users u
    WHERE u.organization_id = a.organization_id AND u.area_id = a.id
      AND u.is_active = 1 AND u.deleted_at IS NULL) AS userCount,
  (SELECT COUNT(*) FROM records r
    WHERE r.organization_id = a.organization_id AND r.area_id = a.id
      AND r.deleted_at IS NULL) AS recordCount`;

const SELECT_AREAS = `
  SELECT ${AREA_COLUMNS} FROM areas a
   WHERE a.organization_id = ?
   ORDER BY a.name ASC, a.id ASC`;

const SELECT_AREA = `
  SELECT ${AREA_COLUMNS} FROM areas a
   WHERE a.id = ? AND a.organization_id = ?`;

function toAreaView(row) {
  return {
    id: row.id,
    name: row.name,
    userCount: Number(row.userCount),
    recordCount: Number(row.recordCount),
  };
}

function duplicateAreaName(res, name) {
  // Case and accents count as the same name here: the collation of areas.name
  // makes "wadgaon" a duplicate of "Wadgaon", which is what an admin means.
  return res.status(409).json({
    error: `An area called "${name}" already exists.`,
    reason: ADMIN_ERROR.INVALID,
    field: "name",
  });
}

router.get(
  "/areas",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(SELECT_AREAS, [req.user.organizationId]);
    res.json({ areas: rows.map(toAreaView) });
  })
);

router.post(
  "/areas",
  asyncHandler(async (req, res) => {
    const name = validateAreaName(req.body?.name);
    if (name.error) return sendRuleError(res, name.error);

    const id = crypto.randomUUID();
    try {
      // uq_areas_org_name is the uniqueness check, for the same race reason
      // as the phone number on users.
      await pool.query(`INSERT INTO areas (id, organization_id, name) VALUES (?, ?, ?)`, [
        id,
        req.user.organizationId,
        name.value,
      ]);
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return duplicateAreaName(res, name.value);
      throw error;
    }

    const [[row]] = await pool.query(SELECT_AREA, [id, req.user.organizationId]);
    res.status(201).json(toAreaView(row));
  })
);

// Rename only. There is no delete: users and records point at areas through
// RESTRICT foreign keys, and an area that ever held a household is part of
// where that household's history says it was.
//
// A rename reaches devices on their next sync: they hold the area's id, and
// the name a worker sees comes from the scope every pull reports.
router.patch(
  "/areas/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ error: "Area not found." });

    const name = validateAreaName(req.body?.name);
    if (name.error) return sendRuleError(res, name.error);

    try {
      const [result] = await pool.query(
        `UPDATE areas SET name = ? WHERE id = ? AND organization_id = ?`,
        [name.value, id, req.user.organizationId]
      );
      // affectedRows counts matched rows here, so renaming to the current name
      // is a 200 that changes nothing, not a 404.
      if (result.affectedRows !== 1) {
        return res.status(404).json({ error: "Area not found." });
      }
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return duplicateAreaName(res, name.value);
      throw error;
    }

    const [[row]] = await pool.query(SELECT_AREA, [id, req.user.organizationId]);
    res.json(toAreaView(row));
  })
);

export default router;
