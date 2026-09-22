import express from "express";
import { pool } from "../db/index.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { RESOLVED_DEVICE_ID } from "../sync/pushRules.js";
import { RESOLUTION, planResolution } from "../sync/conflictRules.js";
import { SERVER_TIME_FORMAT } from "../sync/serverTime.js";

const router = express.Router();

// The supervisor's review surface. Every route here is
// requireAuth + requireRole("supervisor", "admin") — the role is read from the
// verified JWT and never from anything the request carries, because the client
// decides what to RENDER and the server decides what is ALLOWED. A field
// worker's bundle simply does not draw the screen; that is a UI choice, and it
// is not what keeps them out.
const requireSupervisor = [requireAuth, requireRole("supervisor", "admin")];

const DEFAULT_CONFLICT_LIMIT = 50;
const MAX_CONFLICT_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

// Both copies in one row: the conflict as filed, and the record as it stands
// NOW — not as it stood when the conflict was raised.
//
// Reading the record live is what keeps a queue honest when one record collects
// several conflicts. Resolving the first advances the record, and the second is
// then a disagreement with a version that has moved on; showing the supervisor
// the stored server_version instead of the current row would have them deciding
// against a copy nobody holds any more. server_version is still returned, as the
// version the losing device actually collided with.
//
// Never SELECT *: password_hash is one join away on both user joins.
const CONFLICT_COLUMNS = `
  rc.id,
  rc.record_id       AS recordId,
  rc.status,
  rc.resolution,
  rc.base_version    AS baseVersion,
  rc.server_version  AS serverVersion,
  rc.form_type       AS submittedFormType,
  rc.form_version    AS submittedFormVersion,
  rc.payload         AS submittedPayload,
  rc.submitted_by    AS submittedById,
  su.full_name       AS submittedByName,
  rc.device_id       AS submittedDeviceId,
  rc.resolved_by     AS resolvedById,
  ru.full_name       AS resolvedByName,
  DATE_FORMAT(rc.created_at,  '${SERVER_TIME_FORMAT}') AS createdAt,
  DATE_FORMAT(rc.resolved_at, '${SERVER_TIME_FORMAT}') AS resolvedAt,
  r.form_type        AS currentFormType,
  r.form_version     AS currentFormVersion,
  r.payload          AS currentPayload,
  r.version          AS currentVersion,
  r.device_id        AS currentDeviceId,
  r.created_by       AS currentCreatedById,
  cu.full_name       AS currentCreatedByName,
  DATE_FORMAT(r.created_at, '${SERVER_TIME_FORMAT}') AS currentCreatedAt,
  DATE_FORMAT(r.updated_at, '${SERVER_TIME_FORMAT}') AS currentUpdatedAt,
  DATE_FORMAT(r.deleted_at, '${SERVER_TIME_FORMAT}') AS currentDeletedAt`;

const CONFLICT_JOINS = `
    FROM record_conflicts rc
    JOIN records r  ON r.id  = rc.record_id
    JOIN users   su ON su.id = rc.submitted_by
    JOIN users   cu ON cu.id = r.created_by
    LEFT JOIN users ru ON ru.id = rc.resolved_by`;

// Oldest first, by the conflict's OWN age, for both tabs.
//
// Oldest first is the queue order the open tab needs: a disagreement about a
// household's answers that has sat for a week is more urgent than one raised
// this morning, and a newest-first queue buries exactly the rows that have been
// waiting. The resolved tab keeps the same ordering rather than a separate
// recency one, so there is a single keyset shape to get right instead of two —
// and it is the ordering (organization_id, status, created_at) already indexes.
//
// (created_at, id), not created_at alone: several conflicts can be filed inside
// one millisecond by one batch push, and a page boundary landing inside a tied
// group is resolved by whatever order the storage engine felt like, which skips
// rows or sends them twice. The primary key breaks every tie.
const CONFLICT_PAGE = `
   WHERE rc.organization_id = ?
     AND rc.status = ?
     AND (rc.created_at > ? OR (rc.created_at = ? AND rc.id > ?))
   ORDER BY rc.created_at ASC, rc.id ASC
   LIMIT ?`;

// Sorts before every value DATE_FORMAT can produce, so the first page needs no
// separate query shape — the keyset disjunct is simply dead weight on it.
const EPOCH_CURSOR = "1970-01-01 00:00:00.000000";

/** The API shape. Two copies, side by side, plus who and when for each. */
function toConflictView(row) {
  return {
    id: row.id,
    recordId: row.recordId,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedById
      ? { id: row.resolvedById, name: row.resolvedByName }
      : null,

    // The copy that lost. `receivedAt` is when the push was rejected, not when
    // the household was visited — record_conflicts has no capture time, and
    // naming it "received" keeps the screen from claiming one it does not have.
    submitted: {
      payload: row.submittedPayload,
      formType: row.submittedFormType,
      formVersion: row.submittedFormVersion,
      baseVersion: row.baseVersion,
      collidedWithVersion: row.serverVersion,
      byId: row.submittedById,
      byName: row.submittedByName,
      deviceId: row.submittedDeviceId,
      receivedAt: row.createdAt,
    },

    // The record as it stands now.
    current: {
      payload: row.currentPayload,
      formType: row.currentFormType,
      formVersion: row.currentFormVersion,
      version: row.currentVersion,
      deviceId: row.currentDeviceId,
      // A version written by a resolution has no authoring device; the screen
      // says "resolved on the server" rather than printing the nil UUID at a
      // supervisor as though a phone called itself that.
      writtenByResolution: row.currentDeviceId === RESOLVED_DEVICE_ID,
      capturedById: row.currentCreatedById,
      capturedByName: row.currentCreatedByName,
      capturedAt: row.currentCreatedAt,
      updatedAt: row.currentUpdatedAt,
      deletedAt: row.currentDeletedAt,
    },
  };
}

/**
 * The queue: conflicts for the caller's organisation, oldest first.
 *
 * Organisation comes from the verified token, so a supervisor cannot widen the
 * query by asking. Resolved conflicts stay listable rather than disappearing —
 * the losing payload is the audit trail for a decision taken about someone's
 * data, and a decision nobody can look at afterwards is not much of a record.
 */
router.get(
  "/",
  requireSupervisor,
  asyncHandler(async (req, res) => {
    const { status = "open", afterCreatedAt, afterId, limit } = req.query;

    if (status !== "open" && status !== "resolved") {
      return res.status(400).json({ error: "status must be open or resolved" });
    }

    // Half a keyset would silently restart the sequence at the top of the queue
    // and re-deliver every row before it.
    const hasAfter = afterCreatedAt !== undefined || afterId !== undefined;
    if (hasAfter) {
      if (typeof afterCreatedAt !== "string" || !SERVER_TIME_RE.test(afterCreatedAt)) {
        return res
          .status(400)
          .json({ error: "afterCreatedAt must be a server timestamp" });
      }
      if (typeof afterId !== "string" || !UUID_RE.test(afterId)) {
        return res.status(400).json({ error: "afterId must be a UUID" });
      }
    }

    let pageSize = DEFAULT_CONFLICT_LIMIT;
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      // Capped, not refused: a smaller page and another round trip beats an
      // error the screen cannot act on.
      pageSize = Math.min(parsed, MAX_CONFLICT_LIMIT);
    }

    const cursorAt = hasAfter ? afterCreatedAt : EPOCH_CURSOR;
    const cursorId = hasAfter ? afterId : "";

    // One row more than asked for. Its presence IS the hasMore answer, where a
    // separate COUNT would double the work and could disagree with the page it
    // describes.
    const [rows] = await pool.query(
      `SELECT ${CONFLICT_COLUMNS} ${CONFLICT_JOINS} ${CONFLICT_PAGE}`,
      [
        req.user.organizationId,
        status,
        cursorAt,
        cursorAt,
        cursorId,
        pageSize + 1,
      ]
    );

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const last = page[page.length - 1];

    res.json({
      conflicts: page.map(toConflictView),
      hasMore,
      nextCursor:
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    });
  })
);

/**
 * Close one open conflict.
 *
 * Online-only by construction — see the note at the top of sync/conflictRules.js
 * for why a queued, offline resolution is a conflict about a conflict and is
 * deliberately not built.
 *
 * The conflict row is never deleted, whichever way it goes. The losing payload
 * IS the audit trail for a decision taken about someone's data, and for a
 * kept_server resolution it is the only copy of that household visit the server
 * will ever hold.
 */
router.post(
  "/:id/resolve",
  requireSupervisor,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return res.status(400).json({ error: "conflict id must be a UUID" });
    }

    const { resolution, payload } = req.body ?? {};

    const conn = await pool.getConnection();
    try {
      // An unlocked read first, only to learn which record this is about.
      // Nothing is decided on it — every value used below is re-read under the
      // lock — and it exists so the locks can be taken records-first, the same
      // order the push route takes them in. Two paths that lock the same two
      // tables in opposite orders is how a deadlock gets built.
      const [[peek]] = await conn.query(
        `SELECT record_id AS recordId, organization_id AS organizationId
           FROM record_conflicts WHERE id = ?`,
        [id]
      );

      // One code for "no such conflict" and "another organisation's conflict".
      // Which of the two it is, is itself none of this caller's business.
      if (!peek || peek.organizationId !== req.user.organizationId) {
        return res.status(404).json({ error: "Conflict not found." });
      }

      await conn.beginTransaction();
      try {
        const [[record]] = await conn.query(
          `SELECT id, organization_id AS organizationId, form_type AS formType,
                  form_version AS formVersion, payload, version
             FROM records WHERE id = ? FOR UPDATE`,
          [peek.recordId]
        );

        // record_conflicts.record_id is a RESTRICT foreign key, so the record
        // cannot have gone; if it has, the database is not in a state worth
        // writing to.
        if (!record || record.organizationId !== req.user.organizationId) {
          await conn.rollback();
          return res.status(404).json({ error: "Conflict not found." });
        }

        // Re-read under the lock. This is the double-apply guard: two
        // supervisors pressing the same button at the same moment serialise
        // here, and the second one reads the status the first committed.
        const [[conflict]] = await conn.query(
          `SELECT id, record_id AS recordId, status, form_type AS formType,
                  form_version AS formVersion, payload
             FROM record_conflicts WHERE id = ? FOR UPDATE`,
          [id]
        );

        if (!conflict || conflict.recordId !== record.id) {
          await conn.rollback();
          return res.status(404).json({ error: "Conflict not found." });
        }

        if (conflict.status !== "open") {
          // Refused, not re-applied. Applying a second time would write another
          // version, move updated_at again, and overwrite whatever the FIRST
          // resolution decided — a decision undone by a double-tap.
          await conn.rollback();
          return res.status(409).json({
            error: "This conflict has already been resolved.",
            status: conflict.status,
          });
        }

        const plan = planResolution({
          resolution,
          conflict,
          record,
          mergedPayload: payload,
        });

        if (plan.error) {
          await conn.rollback();
          return res
            .status(400)
            .json({ error: plan.error.message, reason: plan.error.reason });
        }

        // One read of the server's clock, reused for the record write and the
        // conflict's resolved_at. They describe one act, so they are one instant
        // — and it is what lets a device pick up both in the same delta window
        // instead of the record in this sync and the resolution in the next.
        const [[{ serverNow }]] = await conn.query(
          `SELECT DATE_FORMAT(NOW(3), '${SERVER_TIME_FORMAT}') AS serverNow`
        );

        const write = plan.value.write;
        if (write) {
          await conn.query(
            // The same write rules the push route follows, not a privileged
            // shortcut past them:
            //
            //   version + 1   a resolution is a write to the row like any other,
            //                 and a device that does not see the version move
            //                 has no way to know its base is stale.
            //
            //   updated_at    set EXPLICITLY, never left to the column's ON
            //                 UPDATE clause. MySQL does not fire that clause when
            //                 an UPDATE writes values identical to the ones
            //                 stored, and a merge that happens to reproduce the
            //                 stored payload is exactly such a write — it would
            //                 keep its old updated_at, fall outside every later
            //                 delta window, and never reach another device again.
            //                 This is the "first write that keeps its content"
            //                 the push route's comment warned was coming.
            //
            //   device_id     the reserved id. See RESOLVED_DEVICE_ID in
            //                 pushRules.js: it is what stops a device that never
            //                 saw this decision from pushing a stale base, being
            //                 read as its own echo, and overwriting a
            //                 supervisor's judgement with nothing raised.
            //
            //   deleted_at    untouched, deliberately. See the closing note in
            //                 conflictRules.js — a resolution decides content,
            //                 never whether the household exists.
            `UPDATE records
                SET form_type = ?, form_version = ?, payload = CAST(? AS JSON),
                    version = ?, device_id = ?, updated_at = ?
              WHERE id = ?`,
            [
              write.formType,
              write.formVersion,
              write.payloadText,
              write.version,
              RESOLVED_DEVICE_ID,
              serverNow,
              record.id,
            ]
          );
        }

        const [result] = await conn.query(
          // AND status = 'open' as well as the locked re-read above. The lock is
          // what makes it correct; this is what makes it correct even if someone
          // later moves the read.
          `UPDATE record_conflicts
              SET status = 'resolved', resolution = ?, resolved_by = ?,
                  resolved_at = ?
            WHERE id = ? AND status = 'open'`,
          [plan.value.resolution, req.user.id, serverNow, id]
        );

        if (result.affectedRows !== 1) {
          await conn.rollback();
          return res
            .status(409)
            .json({ error: "This conflict has already been resolved." });
        }

        await conn.commit();

        // Other open conflicts on this record are deliberately left open. Each
        // one is a separate disagreement raised by a separate device about
        // someone's data, and closing them as a side effect would decide them
        // without anybody looking. They stay in the queue and are shown against
        // the record's NEW current version, which is what CONFLICT_COLUMNS
        // reading the record live already gives them.
        res.json({
          id,
          status: "resolved",
          resolution: plan.value.resolution,
          resolvedAt: serverNow,
          recordId: record.id,
          version: write ? write.version : record.version,
          recordChanged: Boolean(write),
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

export default router;
