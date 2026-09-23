-- ============================================================
-- 003 — let "we do not know" be stored as NULL, so 0 can mean what it says.
--
-- Migration 002 added record_conflicts.submitted_deleted as NOT NULL DEFAULT 0,
-- and every conflict filed before it got that 0. So a 0 meant one of two
-- different things: "the losing push was a live edit" (recorded) or "nobody
-- recorded whether it was a deletion" (every row older than 002). A resolution
-- could not tell them apart, so it could never act on a 0 — and keeping a
-- worker's live copy against a record the server had deleted left the household
-- deleted, with the worker's answers inside the tombstone and no way back.
--
-- After this migration the column says exactly what is known:
--
--   1      the losing push was a deletion       keep-worker deletes the record
--   0      the losing push was a live edit      keep-worker RESTORES it
--   NULL   not recorded                         keep-worker leaves it as it is
--
-- Existing 1s are kept. Only a deletion can have written a 1 — the default was
-- 0, and 002's filing code wrote 1 for a deleted push and nothing else — so a 1
-- is always a recorded fact.
--
-- Existing 0s become NULL, all of them. That includes the 0s written by 002's
-- filing code for genuine live edits, which WERE recorded — but in the column
-- they are indistinguishable from the default every older row received, and
-- the two cannot be separated after the fact. Demoting a known 0 to unknown
-- costs that conflict the ability to restore; promoting an unknown 0 to known
-- would let a column default resurrect a household that withdrew consent. The
-- first is the recoverable mistake.
--
-- New filings always write 0 or 1 explicitly (fileConflict in routes/sync.js).
-- The default becomes NULL, so anything that ever inserts without saying falls
-- to "unknown" — the value that can do nothing — rather than to a claim.
--
-- RUN ONCE. Both statements succeed if repeated, but a second run would demote
-- every 0 filed since the first to NULL: safe, and a quiet loss of restorability
-- for each of those conflicts.
--
-- Column position is unchanged (MODIFY keeps it), so a database migrated through
-- 001-002-003 ends up with exactly the table schema.sql creates from scratch.
-- ============================================================

ALTER TABLE record_conflicts
  MODIFY COLUMN submitted_deleted TINYINT(1) NULL DEFAULT NULL;

UPDATE record_conflicts
   SET submitted_deleted = NULL
 WHERE submitted_deleted = 0;
