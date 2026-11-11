import express from "express";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SERVER_TIME_FORMAT } from "../sync/serverTime.js";
import { isUuid } from "../admin/adminRules.js";
import {
  DEFINITION_ERROR,
  FORM_TYPE_RE,
  checkKeyStability,
  latestPublished,
  planPublish,
  validateDefinition,
} from "../forms/formRules.js";

// Form versions, built by an organisation's admins. Mounted inside the admin
// router, after its requireAuth + requireRole("admin") + requireLiveRole("admin"),
// so every route here is admin-only and re-checked against the database.
//
// ONLINE-ONLY, like the rest of admin: two admins publishing from two offline
// phones would each mint "version 3", and there is no merging two forms.
//
// THE LIFECYCLE
//
//   New version   a draft copied from the latest published version, numbered
//                 one above it. At most one draft per form type, so there is
//                 never a question of which draft becomes the next version.
//   Edit / delete only while a draft. A draft has never reached a device, so
//                 deleting it is a plain DELETE and loses nobody's data.
//   Publish       the draft becomes immutable and goes to every device on its
//                 next sync. Nothing here updates or deletes a published row:
//                 records captured under it are validated against it for ever.
//
// THE LOCK. Creating and publishing both start by locking every published row
// of the form type (SELECT ... FOR UPDATE). Those rows never change, so the
// lock protects nothing about them; it is a mutex per form type, so two admins
// creating a draft, or publishing, queue behind each other and the second sees
// what the first committed. The unique key on (organisation, form type,
// version) is the backstop. Editing locks only the draft row.

const router = express.Router();

const DEFINITION_COLUMNS = `
  d.id,
  d.form_type AS formType,
  d.version,
  d.title,
  d.fields,
  d.status,
  u.full_name AS createdByName,
  DATE_FORMAT(d.created_at, '${SERVER_TIME_FORMAT}') AS createdAt,
  DATE_FORMAT(d.published_at, '${SERVER_TIME_FORMAT}') AS publishedAt`;

const DEFINITION_FROM = `
    FROM form_definitions d
    LEFT JOIN users u ON u.id = d.created_by`;

function toView(row) {
  return {
    id: row.id,
    formType: row.formType,
    version: row.version,
    title: row.title,
    fields: row.fields,
    status: row.status,
    // NULL for the version that was built into the app before.
    createdByName: row.createdByName ?? null,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt ?? null,
  };
}

async function readView(conn, organizationId, id) {
  const [[row]] = await conn.query(
    `SELECT ${DEFINITION_COLUMNS} ${DEFINITION_FROM}
      WHERE d.id = ? AND d.organization_id = ?`,
    [id, organizationId]
  );
  return row ? toView(row) : null;
}

// Every problem, each with the position of the field it concerns, so the
// builder can show it beside that field. See validateDefinition.
function sendDefinitionError(res, error) {
  return res.status(400).json({
    error: error.message,
    reason: error.reason,
    errors: error.errors ?? [],
  });
}

const NOT_FOUND = { error: "Form version not found." };
const READ_ONLY = {
  error: "This version is published and can no longer be changed. Start a new version instead.",
};

async function lockPublished(conn, organizationId, formType) {
  const [rows] = await conn.query(
    `SELECT version, fields FROM form_definitions
      WHERE organization_id = ? AND form_type = ? AND status = 'published'
      ORDER BY version ASC
        FOR UPDATE`,
    [organizationId, formType]
  );
  return rows;
}

// The unique key on (organisation, form type, version) refusing a second
// "version N". The lock above makes this unreachable in practice; if it is ever
// reached, the admin is told to look again rather than shown a 500.
function isDuplicateVersion(error) {
  return error?.code === "ER_DUP_ENTRY";
}

const VERSION_TAKEN = {
  error: "Another admin changed this form at the same moment. Refresh and try again.",
};

// Runs fn inside a transaction on one pooled connection, rolling back on any
// error or early return the callback marks with `rollback: true`.
async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const outcome = await fn(conn);
      if (outcome?.rollback) await conn.rollback();
      else await conn.commit();
      return outcome;
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------

// Every version of every form, drafts included. Small: a few form types, a
// handful of versions each, and the builder needs the fields of all of them to
// show what changed and which keys are taken.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT ${DEFINITION_COLUMNS} ${DEFINITION_FROM}
        WHERE d.organization_id = ?
        ORDER BY d.form_type ASC, d.version ASC`,
      [req.user.organizationId]
    );
    res.json({ definitions: rows.map(toView) });
  })
);

// "New version": a draft copied from the latest published version.
router.post(
  "/:formType/drafts",
  asyncHandler(async (req, res) => {
    const { formType } = req.params;
    if (!FORM_TYPE_RE.test(formType)) return res.status(404).json(NOT_FOUND);
    const organizationId = req.user.organizationId;

    let outcome;
    try {
      outcome = await inTransaction(async (conn) => {
        const published = await lockPublished(conn, organizationId, formType);
        const latest = latestPublished(published);
        if (!latest) {
          return {
            rollback: true,
            status: 404,
            body: { error: "This form has no published version to start from." },
          };
        }

        // A locking read, so it sees a draft another admin committed while this
        // request waited for the lock above.
        const [[draft]] = await conn.query(
          `SELECT id, version FROM form_definitions
            WHERE organization_id = ? AND form_type = ? AND status = 'draft'
              FOR UPDATE`,
          [organizationId, formType]
        );
        if (draft) {
          return {
            rollback: true,
            status: 409,
            body: {
              error: `A draft of version ${draft.version} already exists. Edit or delete it first.`,
              draftId: draft.id,
            },
          };
        }

        const [[source]] = await conn.query(
          `SELECT title FROM form_definitions
            WHERE organization_id = ? AND form_type = ? AND version = ?`,
          [organizationId, formType, latest.version]
        );

        const id = crypto.randomUUID();
        await conn.query(
          `INSERT INTO form_definitions
             (id, organization_id, form_type, version, title, fields, status, created_by)
           VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'draft', ?)`,
          [
            id,
            organizationId,
            formType,
            latest.version + 1,
            source.title,
            JSON.stringify(latest.fields),
            req.user.id,
          ]
        );
        return { status: 201, body: await readView(conn, organizationId, id) };
      });
    } catch (error) {
      if (isDuplicateVersion(error)) return res.status(409).json(VERSION_TAKEN);
      throw error;
    }

    res.status(outcome.status).json(outcome.body);
  })
);

// Edit a draft: its title and the whole field list, replaced together.
//
// Every rule publish applies is applied here too, key stability included, so
// a draft that is saved is a draft that can be published, and the admin hears
// about a problem while the field is still in front of them.
router.put(
  "/drafts/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json(NOT_FOUND);

    const checked = validateDefinition(req.body);
    if (checked.error) return sendDefinitionError(res, checked.error);
    const organizationId = req.user.organizationId;

    const outcome = await inTransaction(async (conn) => {
      const [[draft]] = await conn.query(
        `SELECT form_type AS formType, status FROM form_definitions
          WHERE id = ? AND organization_id = ?
            FOR UPDATE`,
        [id, organizationId]
      );
      if (!draft) return { rollback: true, status: 404, body: NOT_FOUND };
      if (draft.status !== "draft") return { rollback: true, status: 409, body: READ_ONLY };

      // Not locked: only publishing this very draft adds a published version,
      // and that waits for the draft row this transaction holds.
      const [published] = await conn.query(
        `SELECT version, fields FROM form_definitions
          WHERE organization_id = ? AND form_type = ? AND status = 'published'`,
        [organizationId, draft.formType]
      );
      const unstable = checkKeyStability(published, checked.value.fields);
      if (unstable.length > 0) {
        return {
          rollback: true,
          status: 400,
          body: {
            error:
              unstable.length === 1
                ? unstable[0].message
                : `This form has ${unstable.length} problems. Each is shown next to what it concerns.`,
            reason: DEFINITION_ERROR,
            errors: unstable,
          },
        };
      }

      await conn.query(
        `UPDATE form_definitions SET title = ?, fields = CAST(? AS JSON)
          WHERE id = ? AND status = 'draft'`,
        [checked.value.title, JSON.stringify(checked.value.fields), id]
      );
      return { status: 200, body: await readView(conn, organizationId, id) };
    });

    res.status(outcome.status).json(outcome.body);
  })
);

// Delete a draft. A hard DELETE, unlike everything syncable: a draft never
// reached a device, so there is no copy anywhere that needs a tombstone to
// learn it is gone.
router.delete(
  "/drafts/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json(NOT_FOUND);

    const [result] = await pool.query(
      `DELETE FROM form_definitions
        WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      [id, req.user.organizationId]
    );
    if (result.affectedRows === 1) return res.json({ id, deleted: true });

    // Nothing deleted: say whether it was missing or published.
    const existing = await readView(pool, req.user.organizationId, id);
    if (!existing) return res.status(404).json(NOT_FOUND);
    return res.status(409).json({
      error: "This version is published and can never be deleted: records may use it.",
    });
  })
);

// Publish a draft: it becomes the next version, read-only, and reaches every
// device in the organisation on its next sync.
router.post(
  "/drafts/:id/publish",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json(NOT_FOUND);
    const organizationId = req.user.organizationId;

    // Unlocked, only to learn which form type's lock to take. Everything
    // decided below is re-read under it.
    const [[peek]] = await pool.query(
      `SELECT form_type AS formType FROM form_definitions
        WHERE id = ? AND organization_id = ?`,
      [id, organizationId]
    );
    if (!peek) return res.status(404).json(NOT_FOUND);

    let outcome;
    try {
      outcome = await inTransaction(async (conn) => {
        // Published rows first, then the draft: the same order "New version"
        // takes, so the two can never hold each other's locks.
        const published = await lockPublished(conn, organizationId, peek.formType);

        const [[draft]] = await conn.query(
          `SELECT title, fields, status FROM form_definitions
            WHERE id = ? AND organization_id = ?
              FOR UPDATE`,
          [id, organizationId]
        );
        if (!draft) return { rollback: true, status: 404, body: NOT_FOUND };
        if (draft.status !== "draft") return { rollback: true, status: 409, body: READ_ONLY };

        const plan = planPublish({ draft: { title: draft.title, fields: draft.fields }, published });
        if (plan.error) {
          return {
            rollback: true,
            status: 400,
            body: { error: plan.error.message, reason: plan.error.reason, errors: plan.error.errors },
          };
        }

        // The version is re-assigned, not trusted from the draft: it is one above
        // the latest published version as read under the lock, which is what
        // "next" means. They agree in practice, since only one draft exists.
        await conn.query(
          `UPDATE form_definitions
              SET status = 'published', version = ?, title = ?, fields = CAST(? AS JSON),
                  published_at = NOW(3)
            WHERE id = ? AND status = 'draft'`,
          [plan.value.version, plan.value.title, JSON.stringify(plan.value.fields), id]
        );
        return { status: 200, body: await readView(conn, organizationId, id) };
      });
    } catch (error) {
      if (isDuplicateVersion(error)) return res.status(409).json(VERSION_TAKEN);
      throw error;
    }

    res.status(outcome.status).json(outcome.body);
  })
);

export default router;
