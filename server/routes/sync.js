import express from "express";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  MAX_BATCH_RECORDS,
  PUSH_OUTCOME,
  REJECT_REASON,
  canonicalJson,
  classifyPush,
  validateEnvelope,
} from "../sync/pushRules.js";

const router = express.Router();

// PUSH BEFORE PULL, and this route is only the push half.
//
// A device sends everything it has changed before it asks for anything back. The
// other order loses work: pull first and the device overwrites its own unsent
// edits with the server's older copy of the same row, and the edit is gone
// before anyone knew it existed. Push first and the worst case is a conflict,
// which is a row two people can still look at. Step 11 adds the pull as a
// separate endpoint that the client calls after this one.

// Timestamps leave here as text in MySQL's own DATETIME format, produced by the
// server's clock and never parsed by a device.
//
// The device stores the value and sends it back as the delta cursor in step 11,
// so what matters is that it round-trips through MySQL unchanged. Handing back a
// JS Date instead would put it through the driver's timezone conversion in both
// directions, and a cursor that shifts by an offset either skips records or
// replays them forever. %f prints microseconds, which for a DATETIME(3) column
// is always three digits followed by three zeros — exact, not rounded.
const SERVER_TIME_FORMAT = "%Y-%m-%d %H:%i:%s.%f";

// Columns of the server's copy, aliased to camelCase for the API. Never
// SELECT *: password_hash is one join away and payloads are large.
const RECORD_COLUMNS = `
  id,
  organization_id AS organizationId,
  created_by      AS createdBy,
  device_id       AS deviceId,
  form_type       AS formType,
  form_version    AS formVersion,
  payload,
  version,
  DATE_FORMAT(created_at, '${SERVER_TIME_FORMAT}') AS createdAt,
  DATE_FORMAT(updated_at, '${SERVER_TIME_FORMAT}') AS updatedAt,
  DATE_FORMAT(deleted_at, '${SERVER_TIME_FORMAT}') AS deletedAt`;

// The three decision statuses the client acts on, plus one non-decision.
const PUSH_STATUS = {
  ACCEPTED: "accepted",
  CONFLICT: "conflict",
  REJECTED: "rejected",
  // Not a verdict on the record: the server failed to reach one. Split out from
  // "rejected" because the client must treat them oppositely — a rejection is
  // final and must never be retried, while this row is still pending work.
  FAILED: "failed",
};

function rejected(id, reason, message) {
  return { id, status: PUSH_STATUS.REJECTED, reason, message };
}

// What the client shows next to its own copy when a push loses a comparison.
function toServerCopy(stored) {
  return {
    id: stored.id,
    createdBy: stored.createdBy,
    deviceId: stored.deviceId,
    formType: stored.formType,
    formVersion: stored.formVersion,
    payload: stored.payload,
    version: stored.version,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
  };
}

/**
 * May this caller write this stored row?
 *
 * Organisation and role come from the verified JWT and never from the body. The
 * client decides what to render; the server decides what is allowed.
 */
function mayWrite(actor, stored) {
  if (stored.organizationId !== actor.organizationId) return false;
  // A field worker pushes their own captures and nothing else. Phones are shared
  // and a stolen token is a real thing, so ownership is re-checked per row
  // rather than assumed from the fact that the row reached this device.
  if (actor.role === "field_worker") return stored.createdBy === actor.id;
  return true;
}

/**
 * Files the losing copy in record_conflicts, unless an identical one is already
 * open.
 *
 * The guard is not decoration. A conflict response can be lost exactly like an
 * accept, and the device will retry the same push — so without it, one dropped
 * response becomes two rows in a supervisor's queue describing the same
 * disagreement, and a supervisor resolving one leaves a phantom behind.
 */
async function fileConflict(conn, actor, stored, incoming) {
  const [existing] = await conn.query(
    `SELECT id, payload
       FROM record_conflicts
      WHERE record_id = ? AND submitted_by = ? AND device_id = ?
        AND base_version = ? AND server_version = ? AND status = 'open'
      ORDER BY created_at DESC
      LIMIT 5`,
    [
      stored.id,
      actor.id,
      incoming.deviceId,
      incoming.baseVersion ?? 0,
      stored.version,
    ]
  );

  const incomingJson = canonicalJson(incoming.payload);
  const duplicate = existing.find((row) => canonicalJson(row.payload) === incomingJson);
  if (duplicate) return duplicate.id;

  const conflictId = crypto.randomUUID();
  await conn.query(
    `INSERT INTO record_conflicts
       (id, record_id, organization_id, submitted_by, device_id,
        base_version, server_version, form_type, form_version, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
    [
      conflictId,
      stored.id,
      // The stored row's organisation, which mayWrite has already checked equals
      // the caller's. Taken from the row so the queue can never be polluted with
      // a value that came off the wire.
      stored.organizationId,
      actor.id,
      incoming.deviceId,
      incoming.baseVersion ?? 0,
      stored.version,
      incoming.formType,
      incoming.formVersion,
      incoming.payloadText,
    ]
  );
  return conflictId;
}

/**
 * One record: lock, compare, write, commit.
 *
 * The row is taken with SELECT ... FOR UPDATE, not read and then written. Two
 * devices syncing the same household at the same moment would otherwise both
 * read version 3, both decide "accept", and both write version 4 — and the
 * second write would silently replace the first with no conflict raised and no
 * trace that a visit had been overwritten. The lock makes the second transaction
 * wait until the first commits, so it reads version 4 and correctly sees itself
 * as behind.
 *
 * Each record gets its OWN transaction rather than one around the batch, so a
 * conflict on record 3 cannot roll back the nine accepted rows around it.
 */
async function applyOne(conn, actor, incoming) {
  await conn.beginTransaction();
  try {
    const [[stored]] = await conn.query(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE id = ? FOR UPDATE`,
      [incoming.id]
    );

    if (stored && !mayWrite(actor, stored)) {
      await conn.rollback();
      // One code for "another organisation's row" and "another worker's row".
      // Which of the two it is, is itself none of this caller's business.
      return rejected(
        incoming.id,
        REJECT_REASON.FORBIDDEN,
        "This record belongs to someone else."
      );
    }

    const verdict = classifyPush(
      incoming.baseVersion,
      stored && {
        version: stored.version,
        deviceId: stored.deviceId,
        formType: stored.formType,
        formVersion: stored.formVersion,
        payload: stored.payload,
        deleted: stored.deletedAt !== null,
      },
      incoming
    );

    if (verdict.outcome === PUSH_OUTCOME.REJECT) {
      await conn.rollback();
      return rejected(
        incoming.id,
        verdict.reason,
        verdict.reason === REJECT_REASON.UNKNOWN_RECORD
          ? "The server has no record with this id."
          : "This device claims a version the server never issued."
      );
    }

    if (verdict.outcome === PUSH_OUTCOME.CONFLICT) {
      const conflictId = await fileConflict(conn, actor, stored, incoming);
      await conn.commit();
      return {
        id: incoming.id,
        status: PUSH_STATUS.CONFLICT,
        conflictId,
        server: toServerCopy(stored),
      };
    }

    if (verdict.outcome === PUSH_OUTCOME.REPLAY) {
      // A retry of a push that already landed. Nothing is written — see the
      // idempotency note in sync/pushRules.js — and the client is handed exactly
      // what it would have been handed the first time.
      await conn.commit();
      return {
        id: incoming.id,
        status: PUSH_STATUS.ACCEPTED,
        version: stored.version,
        serverUpdatedAt: stored.updatedAt,
        replayed: true,
      };
    }

    // One read of the server's clock, reused for every timestamp this write
    // touches, so created_at, updated_at and deleted_at on a new row are the same
    // instant rather than three statement times a millisecond apart.
    const [[{ serverNow }]] = await conn.query(
      `SELECT DATE_FORMAT(NOW(3), '${SERVER_TIME_FORMAT}') AS serverNow`
    );

    if (verdict.outcome === PUSH_OUTCOME.INSERT) {
      await conn.query(
        `INSERT INTO records
           (id, organization_id, created_by, device_id, form_type, form_version,
            payload, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
        [
          incoming.id,
          // Organisation and owner come from the verified token. A body may name
          // any user it likes; it is simply not read here.
          actor.organizationId,
          actor.id,
          incoming.deviceId,
          incoming.formType,
          incoming.formVersion,
          incoming.payloadText,
          verdict.version,
          serverNow,
          serverNow,
          incoming.deleted ? serverNow : null,
        ]
      );
    } else {
      // A tombstone keeps the time it was first raised. Re-pushing a deleted row
      // must not move that instant, or a device pulling later sees the deletion
      // as newer than the edit it already applied.
      const deletedAt = incoming.deleted ? (stored.deletedAt ?? serverNow) : null;

      await conn.query(
        // updated_at is set EXPLICITLY, and not left to the column's ON UPDATE
        // CURRENT_TIMESTAMP(3).
        //
        // MySQL does not fire that clause when an UPDATE writes values identical
        // to the ones already stored: it sees zero changed rows and skips the
        // timestamp entirely. A row written again with the same content would
        // keep its old updated_at, fall outside every later delta window, and
        // never reach another device again — a silent, permanent disappearance
        // from sync, on a column that is the cursor itself.
        //
        // Today the version increment alone would always change the row, so the
        // clause would in fact fire. That is precisely why this must not be left
        // implicit: the guarantee would be resting on an incidental property of
        // one branch, and the first write that keeps a version — a conflict
        // resolution that confirms the server's copy, say — would lose it with
        // nothing failing to show it. Setting it here also makes the timestamp
        // returned to the device exactly the one stored, rather than a value
        // read back and hoped to match.
        `UPDATE records
            SET device_id = ?, form_type = ?, form_version = ?,
                payload = CAST(? AS JSON), version = ?,
                deleted_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          incoming.deviceId,
          incoming.formType,
          incoming.formVersion,
          incoming.payloadText,
          verdict.version,
          deletedAt,
          serverNow,
          incoming.id,
        ]
      );
    }

    await conn.commit();
    return {
      id: incoming.id,
      status: PUSH_STATUS.ACCEPTED,
      version: verdict.version,
      serverUpdatedAt: serverNow,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

async function pushOne(conn, actor, item) {
  const envelope = validateEnvelope(item);
  if (envelope.error) {
    // id may be absent or garbage here, which is why it is echoed as-is: the
    // client matches results back to rows by it, and inventing one would orphan
    // the row on the device.
    return rejected(item?.id ?? null, envelope.error.reason, envelope.error.message);
  }

  try {
    return await applyOne(conn, actor, envelope.value);
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      // Two devices raced to insert the same id: SELECT ... FOR UPDATE found
      // nothing for both, then one INSERT lost. The second pass finds the row
      // the winner committed and takes the normal comparison ladder, which is
      // where that situation belongs.
      return applyOne(conn, actor, envelope.value);
    }

    // A deadlock, a dropped connection, a bug. Not a verdict on the record, so
    // it must not come back as "rejected" — the client would stop retrying a row
    // that is perfectly valid. It stays pending and goes again next sync.
    console.error(`[sync/push] ${envelope.value.id} failed`, error);
    return {
      id: envelope.value.id,
      status: PUSH_STATUS.FAILED,
      message: "The server could not process this record. It will be retried.",
    };
  }
}

/**
 * A batch of records from one device.
 *
 * Per-record results, never all-or-nothing: a worker with one malformed row from
 * an old build must still get the other forty-nine visits onto the server.
 */
router.post(
  "/push",
  requireAuth,
  asyncHandler(async (req, res) => {
    const batch = req.body?.records;

    if (!Array.isArray(batch)) {
      return res.status(400).json({ error: "records must be an array" });
    }
    if (batch.length > MAX_BATCH_RECORDS) {
      // A cap on count, paired with the per-record payload cap in pushRules.js.
      // Without it one device can hand the server a body it has to hold in
      // memory, parse, and then walk row by row under a row lock.
      return res
        .status(413)
        .json({ error: `A push may carry at most ${MAX_BATCH_RECORDS} records` });
    }
    if (batch.length === 0) return res.json({ results: [] });

    // One pooled connection for the whole batch, with the per-record
    // transactions run on it in sequence. Taking a connection per record would
    // let a single large push drain a ten-connection pool and stall every other
    // request on the server.
    const conn = await pool.getConnection();
    try {
      const results = [];
      for (const item of batch) {
        results.push(await pushOne(conn, req.user, item));
      }
      res.json({ results });
    } finally {
      conn.release();
    }
  })
);

export default router;
