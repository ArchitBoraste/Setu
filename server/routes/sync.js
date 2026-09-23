import express from "express";
import crypto from "crypto";
import { pool } from "../db/index.js";
import { loadArea, requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  MAX_BATCH_RECORDS,
  PUSH_OUTCOME,
  REJECT_REASON,
  canonicalJson,
  classifyPush,
  mayWrite,
  validateEnvelope,
} from "../sync/pushRules.js";
import {
  PULL_COMMIT_LAG_MS,
  keysetFrom,
  resolveWindow,
  sinceForScope,
  validatePullQuery,
  validateResolutionQuery,
} from "../sync/pullRules.js";
import { SCOPE_KIND, scopeFor } from "../sync/scopeRules.js";
import { SERVER_TIME_FORMAT } from "../sync/serverTime.js";

const router = express.Router();

// PUSH BEFORE PULL.
//
// A device sends everything it has changed before it asks for anything back. The
// other order loses work: pull first and the device overwrites its own unsent
// edits with the server's older copy of the same row, and the edit is gone
// before anyone knew it existed. Push first and the worst case is a conflict,
// which is a row two people can still look at.
//
// Both halves live here, but they are independent endpoints — the ORDER is the
// client's to keep, in runSync(), because only the client knows a sync is one
// thing rather than two requests.

// SERVER_TIME_FORMAT now lives in ../sync/serverTime.js, because the conflict
// routes hand back the same timestamps and two copies of the format string is
// two things to keep in step.

// Columns of the server's copy, aliased to camelCase for the API. Never
// SELECT *: password_hash is one join away and payloads are large.
const RECORD_COLUMNS = `
  id,
  organization_id AS organizationId,
  created_by      AS createdBy,
  area_id         AS areaId,
  updated_by      AS updatedBy,
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
    areaId: stored.areaId,
    updatedBy: stored.updatedBy,
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
 * Files the losing copy in record_conflicts, unless an identical one is already
 * open.
 *
 * The guard is not decoration. A conflict response can be lost exactly like an
 * accept, and the device will retry the same push — so without it, one dropped
 * response becomes two rows in a supervisor's queue describing the same
 * disagreement, and a supervisor resolving one leaves a phantom behind.
 */
async function fileConflict(conn, actor, stored, incoming) {
  const submittedDeleted = incoming.deleted ? 1 : 0;

  const [existing] = await conn.query(
    // submitted_deleted is part of what makes two pushes "the same push". A
    // deletion carrying the same answers as an earlier edit is a different act —
    // the difference between a household staying in the register and leaving it
    // — and folding it into the edit's open conflict would file the deletion as
    // an edit. The supervisor would be shown no deletion to decide on, and
    // keeping "the worker's version" would keep the household.
    //
    // A conflict whose value was never recorded (NULL: filed before 002, or a 0
    // demoted by 003) matches too, and is taught the value below. Those rows
    // carry no fact for this push to contradict, and refusing to match them
    // would turn every retry of an older conflict — including the re-push that
    // releases a row from the old pull-side lock — into a duplicate dispute in
    // the supervisor's queue. A row that recorded a fact is matched only by the
    // same fact, and is preferred when both kinds exist.
    `SELECT id, payload, submitted_deleted AS submittedDeleted
       FROM record_conflicts
      WHERE record_id = ? AND submitted_by = ? AND device_id = ?
        AND base_version = ? AND server_version = ?
        AND (submitted_deleted = ? OR submitted_deleted IS NULL)
        AND status = 'open'
      ORDER BY (submitted_deleted IS NULL) ASC, created_at DESC
      LIMIT 5`,
    [
      stored.id,
      actor.id,
      incoming.deviceId,
      incoming.baseVersion ?? 0,
      stored.version,
      submittedDeleted,
    ]
  );

  const incomingJson = canonicalJson(incoming.payload);
  const duplicate = existing.find((row) => canonicalJson(row.payload) === incomingJson);
  if (duplicate) {
    if (duplicate.submittedDeleted === null) {
      // The same push, from the same phone and base with the same answers,
      // arriving again — and this time the server hears whether it deleted. That
      // is exactly the fact the row was missing, and recording it is what lets
      // keep-worker restore (or delete) this household rather than leave it as
      // it is for want of a value. Conditional on still being NULL, so two
      // retries racing cannot overwrite a value one of them already wrote.
      await conn.query(
        `UPDATE record_conflicts SET submitted_deleted = ?
          WHERE id = ? AND submitted_deleted IS NULL`,
        [submittedDeleted, duplicate.id]
      );
    }
    return duplicate.id;
  }

  const conflictId = crypto.randomUUID();
  await conn.query(
    `INSERT INTO record_conflicts
       (id, record_id, organization_id, submitted_by, device_id,
        base_version, server_version, form_type, form_version, payload,
        submitted_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
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
      // Whether the losing push was a deletion, ALWAYS written as 0 or 1. The
      // payload alone cannot say — a deleted row still carries its last answers
      // — and since migration 003 a NULL here would mean "not recorded", which
      // keep-worker treats as "do not touch existence". A live edit filed as NULL
      // could never restore the household it was about. validateEnvelope has
      // already required `deleted` to be a real boolean.
      submittedDeleted,
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
      // One code for "another organisation's row" and "another area's row".
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
        // See the note beside deletedAt on the accept below: the device holds a
        // provisional, device-clock tombstone date until the server answers with
        // the real one, and a replay is an answer like any other.
        deletedAt: stored.deletedAt,
        areaId: stored.areaId,
        replayed: true,
      };
    }

    // One read of the server's clock, reused for every timestamp this write
    // touches, so created_at, updated_at and deleted_at on a new row are the same
    // instant rather than three statement times a millisecond apart.
    const [[{ serverNow }]] = await conn.query(
      `SELECT DATE_FORMAT(NOW(3), '${SERVER_TIME_FORMAT}') AS serverNow`
    );

    // A tombstone keeps the time it was first raised. Re-pushing a deleted row
    // must not move that instant, or a device pulling later sees the deletion as
    // newer than the edit it already applied. `stored` is null on an insert, so
    // a row that arrives already deleted is dated now.
    const deletedAt = incoming.deleted ? (stored?.deletedAt ?? serverNow) : null;

    // The record's area: fixed once, here, and never touched by a later push. A
    // household does not change village because a different worker edited it.
    const areaId = stored ? stored.areaId : actor.areaId;

    if (verdict.outcome === PUSH_OUTCOME.INSERT) {
      await conn.query(
        `INSERT INTO records
           (id, organization_id, created_by, area_id, updated_by, device_id,
            form_type, form_version, payload, version, created_at, updated_at,
            deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
        [
          incoming.id,
          // Organisation and owner come from the verified token. A body may name
          // any user it likes; it is simply not read here.
          actor.organizationId,
          actor.id,
          // The capturing user's area as the database holds it on THIS request
          // (see loadArea), not whatever the device believed when it captured
          // offline. NULL for a user with no area.
          actor.areaId,
          actor.id,
          incoming.deviceId,
          incoming.formType,
          incoming.formVersion,
          incoming.payloadText,
          verdict.version,
          serverNow,
          serverNow,
          deletedAt,
        ]
      );
    } else {
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
        //
        // updated_by is the verified caller: whose change this version is. It is
        // what lets every device say who last changed a household's record, now
        // that it need not be the person who captured it.
        `UPDATE records
            SET device_id = ?, updated_by = ?, form_type = ?, form_version = ?,
                payload = CAST(? AS JSON), version = ?,
                deleted_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          incoming.deviceId,
          actor.id,
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
      // Handed back so the device can stop dating its own tombstones.
      //
      // A local soft delete has to write SOME date before it can be sent, and
      // the only clock it has is its own — which may be years off, and is in
      // whatever zone the phone is set to, while this column is in the server's.
      // Returning the authoritative value means that guess survives exactly
      // until the first successful push and is then replaced, instead of staying
      // on the device forever as the row's permanent answer.
      deletedAt,
      // The same for the area. A capture made offline carries the area the
      // device last knew; the server set the real one just now, and the device
      // should not have to wait for a pull to learn it.
      areaId,
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
  loadArea,
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

// ---------------------------------------------------------------------------
// PULL
// ---------------------------------------------------------------------------

// What a device receives. organization_id is deliberately absent: the device
// belongs to exactly one organisation and already knows which, so sending it
// back is one more field on a phone that can be lost.
//
// The creator's and last editor's names ride along so a shared list can say
// whose household visit each row is and who changed it last. A device cannot
// look them up itself: it holds exactly one user, the person signed in on it.
//
// areaId is sent, unlike organization_id, because the device needs it to decide
// what to SHOW: a phone shared by workers from two villages holds both
// villages' rows, and each worker may be shown only their own.
const PULL_COLUMNS = `
  r.id,
  r.created_by   AS createdBy,
  cu.full_name   AS createdByName,
  r.updated_by   AS updatedBy,
  uu.full_name   AS updatedByName,
  r.area_id      AS areaId,
  r.device_id    AS deviceId,
  r.form_type    AS formType,
  r.form_version AS formVersion,
  r.payload,
  r.version,
  DATE_FORMAT(r.created_at, '${SERVER_TIME_FORMAT}') AS createdAt,
  DATE_FORMAT(r.updated_at, '${SERVER_TIME_FORMAT}') AS updatedAt,
  DATE_FORMAT(r.deleted_at, '${SERVER_TIME_FORMAT}') AS deletedAt`;

// Every column is qualified with r. below: users has its own id and updated_at,
// and an unqualified one in the window would be ambiguous. The editor join is
// LEFT because updated_by is NULL on rows written before migration 004.
const PULL_FROM = `
    FROM records r
    JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by`;

// The window and the keyset, identical in both queries below.
//
//   updated_at >  ?   the lower edge, EXCLUSIVE, and always a timestamp this
//                     server minted. Never the device's clock: a phone running
//                     four minutes fast would store its own time as the cursor,
//                     and every row the server wrote in those four minutes falls
//                     below the next window's floor forever. Cursors only move
//                     forward, so nothing ever goes back for them.
//
//   updated_at <= ?   the upper edge, INCLUSIVE, so consecutive windows tile:
//                     (a, b] then (b, c] covers every instant exactly once, with
//                     no gap to fall through and no overlap to re-deliver.
//                     Without an upper edge, a row committed by another worker
//                     while this query is running can land after the rows it
//                     selected but before the clock the device will store —
//                     outside this window and below every future one.
//
//   (updated_at, id)  the keyset. See ORDER BY.
//
// Soft-deleted rows are NOT filtered out. A tombstone is a change like any
// other, and it is the only way a device with no network learns that a record
// is gone: a row that merely stops appearing reads as "no change", and the
// device keeps its copy and pushes it back.
const PULL_WINDOW = `
     r.updated_at >  ?
 AND r.updated_at <= ?
 AND (r.updated_at > ? OR (r.updated_at = ? AND r.id > ?))`;

// ORDER BY both columns, and paginate by keyset rather than OFFSET.
//
// updated_at alone is not a total order. A batch push writes several rows from
// one NOW(3) reading, so ties inside a single millisecond are routine rather
// than exotic — and a page boundary landing in the middle of a tied group is
// resolved by whatever order the storage engine felt like, which differs between
// the two queries. Rows in that group get skipped or sent twice. Adding the
// primary key breaks every tie, and the order becomes total and stable.
//
// OFFSET is wrong here for a different reason: it counts rows rather than naming
// one. The set being paged over is live — this is a sync engine, other devices
// are pushing into the same window as the pages are fetched — so a row inserted
// before the offset shifts everything after it down by one, and the row that was
// about to be read is stepped over. Asking for "the 200 rows after this exact
// (timestamp, id)" cannot skip anything, because it names a position in the data
// instead of a count of rows someone else can change. It also stays fast at any
// depth, where OFFSET 50000 makes MySQL walk and discard fifty thousand rows.
const PULL_ORDER = `ORDER BY r.updated_at ASC, r.id ASC LIMIT ?`;

// A field worker pulls their area — plus any record with no area that they
// captured themselves. A supervisor pulls the organisation. This is the rule in
// sync/scopeRules.js, written as a WHERE clause.
//
// This is a containment boundary, not a convenience. A field phone is the most
// losable object in the system — pockets, buses, rivers — and the scoping means
// the worst case for one is one village's households, not an organisation's
// entire register. The role is read from the verified JWT and the area from the
// database on this request, never from anything the request carries, so a
// device cannot widen its own blast radius by asking.
//
// For a worker with no area the first disjunct binds NULL, which matches
// nothing, and the pull is exactly their own unassigned captures.
//
// The OR costs this statement a clean single-index plan: MySQL answers it from
// the (organization_id, area_id, updated_at) and (created_by, updated_at) keys
// and sorts the union. At a village's size that sort is small; if an area grows
// to tens of thousands of rows, split this into a UNION ALL of two ordered,
// limited halves.
const PULL_AREA = `
  SELECT ${PULL_COLUMNS}
   ${PULL_FROM}
   WHERE r.organization_id = ?
     AND (r.area_id = ? OR (r.area_id IS NULL AND r.created_by = ?))
     AND ${PULL_WINDOW}
   ${PULL_ORDER}`;

const PULL_ORGANIZATION = `
  SELECT ${PULL_COLUMNS}
   ${PULL_FROM}
   WHERE r.organization_id = ?
     AND ${PULL_WINDOW}
   ${PULL_ORDER}`;

/**
 * What a device is told about the scope it was just served.
 *
 * `key` is what it stamps its cursor with and sends back next time (see
 * sinceForScope). The area is how a phone learns it was moved: the list is
 * filtered by it, and a phone told only at sign-in would keep showing the old
 * village until somebody signed out.
 */
function scopeView(actor, scope) {
  return {
    key: scope.key,
    areaId: actor.areaId ?? null,
    areaName: actor.areaName ?? null,
  };
}

/**
 * Everything in scope that changed inside one closed time window.
 *
 * A first sync sends no cursor, which makes the window (epoch, now] — the whole
 * dataset — so the response is paginated and the client walks it page by page.
 * So does a cursor stamped with a scope the caller is no longer in.
 */
router.get(
  "/pull",
  requireAuth,
  loadArea,
  asyncHandler(async (req, res) => {
    const parsed = validatePullQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { requestedUntil, afterUpdatedAt, afterId, pageSize, requestedScope } =
      parsed.value;
    const scope = scopeFor(req.user);
    const since = sinceForScope({
      since: parsed.value.since,
      requestedScope,
      scopeKey: scope.key,
    });

    // BEFORE the rows are selected, never after. Reading the clock afterwards
    // would hand back an edge later than the snapshot the query actually saw,
    // and everything committed in between would fall into no window at all.
    //
    // Held PULL_COMMIT_LAG_MS behind the real clock so a transaction that was
    // open when this ran cannot commit a row underneath the edge afterwards —
    // see the note on that constant for why that particular gap is permanent.
    const [[{ safeNow }]] = await pool.query(
      `SELECT DATE_FORMAT(DATE_SUB(NOW(3), INTERVAL ? MICROSECOND), '${SERVER_TIME_FORMAT}') AS safeNow`,
      [PULL_COMMIT_LAG_MS * 1000]
    );

    const { since: from, until } = resolveWindow(since, requestedUntil, safeNow);
    const keyset = keysetFrom({ since: from, afterUpdatedAt, afterId });

    const windowParams = [from, until, keyset.updatedAt, keyset.updatedAt, keyset.id];

    // One row more than asked for. Its presence is the hasMore answer, which
    // costs nothing, where a separate COUNT over the same window would double the
    // work and could disagree with the page it describes.
    const probeSize = pageSize + 1;

    // Two complete statements chosen by scope, rather than one assembled from
    // fragments. Both are fully parameterised.
    const [rows] =
      scope.kind === SCOPE_KIND.ORGANISATION
        ? await pool.query(PULL_ORGANIZATION, [
            req.user.organizationId,
            ...windowParams,
            probeSize,
          ])
        : await pool.query(PULL_AREA, [
            req.user.organizationId,
            req.user.areaId,
            req.user.id,
            ...windowParams,
            probeSize,
          ]);

    const hasMore = rows.length > pageSize;
    const records = hasMore ? rows.slice(0, pageSize) : rows;
    const last = records[records.length - 1];

    res.json({
      records,
      // The upper edge in force for THIS window. The client sends it back on
      // every following page so one sync reads one fixed interval, and stores it
      // as the next cursor only once the last page has been applied.
      serverTime: until,
      scope: scopeView(req.user, scope),
      hasMore,
      nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    });
  })
);

// ---------------------------------------------------------------------------
// RESOLUTIONS — the deadlock exit
//
// A conflicted row is frozen. Its syncedVersion is never advanced by push or
// pull, so its base stays permanently stale, and it is excluded from the push
// queue so it cannot collide again. That is deliberate, and without a way out it
// is permanent: those rows accumulate on a phone forever.
//
// The way out cannot be the record alone. A kept_server resolution writes
// nothing to `records` — correctly, because nothing about the record changed —
// so its updated_at does not move and the row falls into no future delta window.
// The device would wait for news that structurally cannot arrive.
//
// So closure travels on the conflict's own lifecycle, which is the thing that
// actually changed. This feed answers "which disagreements that concern me were
// settled in this window", and it carries the record's CURRENT copy with each
// one, so a device can rejoin normal operation from a single response whether or
// not the record itself moved.
//
// SCOPE, for a field worker: every settled conflict about a record they can
// see — their area, plus their own unassigned captures. Exactly the pull's
// scope, so the feed can never hand a phone a record (and resolutions carry the
// whole record) that its pull would not.
//
// That is wider than "conflicts I raised or records I captured", which is what
// this used to be, and it has to be. Workers now change each other's records:
//
//   the worker whose version a supervisor just overrode may be neither the one
//   who raised the conflict nor the one who captured the household. Their
//   device holds the replaced version, and a record silently becoming
//   something else on it is exactly what this feed is here to prevent.
//
//   on a phone shared within a village, the row locked by one worker's
//   conflict is unlocked by the next worker's sync, instead of staying locked
//   until the first one comes back.
//
// The device decides what each resolution means for it (classifyResolution in
// client/src/sync/pullRules.js): only its own dispute is adopted, and a notice
// is raised only where the phone held the version that was replaced. A
// resolution about a row a phone never held, or has moved past, is skipped.
//
// For a supervisor or admin: conflicts they raised, plus conflicts about
// records they captured — unchanged. Their pull is the whole organisation, and
// every resolution in it would be a stream of notices about decisions their own
// role makes.
// ---------------------------------------------------------------------------

const RESOLUTION_COLUMNS = `
  rc.id              AS conflictId,
  rc.record_id       AS recordId,
  rc.resolution,
  rc.base_version    AS baseVersion,
  rc.server_version  AS collidedWithVersion,
  rc.form_type       AS submittedFormType,
  rc.form_version    AS submittedFormVersion,
  rc.payload         AS submittedPayload,
  rc.submitted_deleted AS submittedDeleted,
  rc.submitted_by    AS submittedById,
  rc.device_id       AS submittedDeviceId,
  ru.full_name       AS resolvedByName,
  DATE_FORMAT(rc.resolved_at, '${SERVER_TIME_FORMAT}') AS resolvedAt,
  rc.superseded_version      AS supersededVersion,
  rc.superseded_form_type    AS supersededFormType,
  rc.superseded_form_version AS supersededFormVersion,
  rc.superseded_payload      AS supersededPayload,
  r.created_by   AS createdBy,
  cu.full_name   AS createdByName,
  r.updated_by   AS updatedBy,
  uu.full_name   AS updatedByName,
  r.area_id      AS areaId,
  r.device_id    AS deviceId,
  r.form_type    AS formType,
  r.form_version AS formVersion,
  r.payload,
  r.version,
  DATE_FORMAT(r.created_at, '${SERVER_TIME_FORMAT}') AS createdAt,
  DATE_FORMAT(r.updated_at, '${SERVER_TIME_FORMAT}') AS updatedAt,
  DATE_FORMAT(r.deleted_at, '${SERVER_TIME_FORMAT}') AS deletedAt`;

// The window and keyset are the pull's, on resolved_at instead of updated_at:
// exclusive lower edge, inclusive upper edge so consecutive windows tile, and
// (resolved_at, id) because one supervisor closing several conflicts in a
// millisecond is ordinary, not exotic.
const RESOLUTIONS_FROM = `
    FROM record_conflicts rc
    JOIN records r ON r.id = rc.record_id
    JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by
    LEFT JOIN users ru ON ru.id = rc.resolved_by`;

const RESOLUTIONS_WINDOW = `
     AND rc.resolved_at >  ?
     AND rc.resolved_at <= ?
     AND (rc.resolved_at > ? OR (rc.resolved_at = ? AND rc.id > ?))
   ORDER BY rc.resolved_at ASC, rc.id ASC
   LIMIT ?`;

// Supervisors and admins: what they raised, or what they captured.
const RESOLUTIONS_OWN_STAKE = `
  SELECT ${RESOLUTION_COLUMNS}
   ${RESOLUTIONS_FROM}
   WHERE rc.organization_id = ?
     AND rc.status = 'resolved'
     AND (rc.submitted_by = ? OR r.created_by = ?)
   ${RESOLUTIONS_WINDOW}`;

// Field workers: every record their pull would give them. The same predicate
// as PULL_AREA, so the two can only ever widen together.
const RESOLUTIONS_AREA = `
  SELECT ${RESOLUTION_COLUMNS}
   ${RESOLUTIONS_FROM}
   WHERE rc.organization_id = ?
     AND rc.status = 'resolved'
     AND (r.area_id = ? OR (r.area_id IS NULL AND r.created_by = ?))
   ${RESOLUTIONS_WINDOW}`;

/** One settled disagreement, plus what the record says now. */
function toResolutionView(row) {
  return {
    conflictId: row.conflictId,
    recordId: row.recordId,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    // May be null if the resolving account was later removed. A decision
    // outlives the person who made it, and the row is still the audit trail.
    resolvedByName: row.resolvedByName,

    // The copy that was filed against this record, echoed back. For a
    // kept_server resolution this is the only place that payload still exists
    // outside record_conflicts itself, and the device is about to overwrite its
    // own copy of it.
    submitted: {
      payload: row.submittedPayload,
      // true, false, or null when not recorded — never collapsed to false.
      deleted: row.submittedDeleted === null ? null : row.submittedDeleted === 1,
      formType: row.submittedFormType,
      formVersion: row.submittedFormVersion,
      baseVersion: row.baseVersion,
      collidedWithVersion: row.collidedWithVersion,
      byId: row.submittedById,
      // Which phone raised this dispute. Together with baseVersion it is how a
      // device recognises the resolution of ITS OWN conflict, as opposed to one
      // about the same record raised somewhere else — see classifyResolution()
      // in client/src/sync/pullRules.js. Not new information to the recipient:
      // device ids already travel on every pulled record.
      deviceId: row.submittedDeviceId,
    },

    // What the record said immediately before this resolution replaced it.
    //
    // This is the copy that used to be destroyed. It belonged to whoever wrote
    // the version the supervisor overrode — any worker in the record's area, or
    // a supervisor. By the time this reaches their device, the record pull may
    // already have overwritten their local copy, so the device cannot keep it
    // itself; the server has to hand it back.
    //
    // It travels under the scope this feed already has — for a field worker,
    // records their own pull delivers — and no wider. A device that cannot see
    // the record never receives a resolution for it, so it never receives the
    // replaced answers either. Null for kept_server, and for resolutions made
    // before migration 002, whose replaced version was not kept.
    superseded:
      row.supersededPayload === null
        ? null
        : {
            payload: row.supersededPayload,
            version: row.supersededVersion,
            formType: row.supersededFormType,
            formVersion: row.supersededFormVersion,
          },

    // Shaped exactly like a pulled record, so the device applies it through the
    // same path a pull uses rather than a second, parallel one that can drift.
    record: {
      id: row.recordId,
      createdBy: row.createdBy,
      createdByName: row.createdByName,
      updatedBy: row.updatedBy,
      updatedByName: row.updatedByName,
      areaId: row.areaId,
      deviceId: row.deviceId,
      formType: row.formType,
      formVersion: row.formVersion,
      payload: row.payload,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    },
  };
}

router.get(
  "/resolutions",
  requireAuth,
  loadArea,
  asyncHandler(async (req, res) => {
    const parsed = validateResolutionQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { requestedUntil, afterResolvedAt, afterId, pageSize, requestedScope } =
      parsed.value;
    // The same scope check as the pull: both halves share one cursor, so a
    // cursor from another scope restarts both from the beginning.
    const scope = scopeFor(req.user);
    const since = sinceForScope({
      since: parsed.value.since,
      requestedScope,
      scopeKey: scope.key,
    });

    // Read before the rows are selected and held behind the clock, for the same
    // reason the pull does it — see PULL_COMMIT_LAG_MS. A resolution commits
    // some milliseconds after it stamps resolved_at, and a window edge taken
    // from the raw clock would step over one that was still in flight, leaving a
    // device stuck in conflict forever with nothing to show it.
    const [[{ safeNow }]] = await pool.query(
      `SELECT DATE_FORMAT(DATE_SUB(NOW(3), INTERVAL ? MICROSECOND), '${SERVER_TIME_FORMAT}') AS safeNow`,
      [PULL_COMMIT_LAG_MS * 1000]
    );

    const { since: from, until } = resolveWindow(since, requestedUntil, safeNow);
    // keysetFrom names the column afterUpdatedAt because the record pull is
    // where it started; here the position it carries is a resolved_at.
    const keyset = keysetFrom({
      since: from,
      afterUpdatedAt: afterResolvedAt,
      afterId,
    });

    const windowParams = [
      from,
      until,
      keyset.updatedAt,
      keyset.updatedAt,
      keyset.id,
      pageSize + 1,
    ];

    const [rows] =
      scope.kind === SCOPE_KIND.ORGANISATION
        ? await pool.query(RESOLUTIONS_OWN_STAKE, [
            req.user.organizationId,
            req.user.id,
            req.user.id,
            ...windowParams,
          ])
        : await pool.query(RESOLUTIONS_AREA, [
            req.user.organizationId,
            req.user.areaId,
            req.user.id,
            ...windowParams,
          ]);

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const last = page[page.length - 1];

    res.json({
      resolutions: page.map(toResolutionView),
      serverTime: until,
      scope: scopeView(req.user, scope),
      hasMore,
      nextCursor:
        hasMore && last ? { resolvedAt: last.resolvedAt, id: last.conflictId } : null,
    });
  })
);

export default router;
