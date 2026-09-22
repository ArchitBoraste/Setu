-- ============================================================
-- 002 — keep what a resolution replaces, and whether the losing push deleted.
--
-- Two holes in record_conflicts, both found after step 12 shipped.
--
-- 1. A resolution that changes the record destroyed the version it replaced.
--
--    record_conflicts.payload holds the LOSING push — the copy the server
--    refused. It never held the copy the server was keeping. So when a
--    supervisor chose kept_client or merged, the server's previous payload was
--    overwritten in `records`, which has no history; every device that held it
--    was synced and overwrote its own copy on the next pull; and the conflict
--    row held only the other side. A worker's accepted, collected answers
--    existed nowhere at all, and a mis-click on the wrong button could not be
--    undone by anyone.
--
--    The superseded_* columns hold the record's content IMMEDIATELY BEFORE the
--    resolution replaced it: payload, the version number it carried, and the
--    form identity it was captured under (a kept_client resolution adopts the
--    losing copy's form revision, so the replaced payload may belong to a
--    different one, and a payload read against the wrong revision is
--    uninterpretable). They are NULL for kept_server, which replaces nothing,
--    and NULL while a conflict is still open.
--
-- 2. The server could not tell whether the copy that lost was a deletion.
--
--    The push carries `deleted` as a boolean, but filing a conflict dropped it.
--    A worker deleting a household record — because the family withdrew
--    consent, or it was entered twice — and losing the compare had that
--    intent silently discarded: keeping "the worker's version" adopted their
--    payload and left the record alive.
--
-- HISTORICAL ROWS ARE GENUINELY UNRECOVERABLE, and this migration does not
-- pretend otherwise.
--
--   Conflicts resolved as kept_client or merged BEFORE this migration keep
--   superseded_* = NULL forever. The content those resolutions replaced was
--   overwritten in `records` at the time, by an UPDATE with no history table
--   behind it, and every device holding it has since pulled the new version
--   over it. There is no source left to backfill from — not the database, not
--   a phone, not a log. NULL here means "replaced and not kept", which is the
--   truth about those rows, and the review screen says so rather than showing
--   an empty comparison as if nothing had been lost.
--
--   Conflicts filed before this migration get submitted_deleted = 0. On those
--   rows 0 means UNKNOWN, not "the losing push was an edit": the flag was never
--   recorded, and a deletion lost before today cannot be told apart from an
--   edit. That is safe only because of how the value is used — a resolution
--   acts on submitted_deleted = 1 and never on 0 (see conflictRules.js), so an
--   unknown can never delete a record, and can never resurrect one either.
--
-- Columns are placed with AFTER so a database migrated from 001 ends up with
-- exactly the table schema.sql creates from scratch, column for column. Two
-- routes to one shape is the only way "the schema" means one thing.
-- ============================================================

ALTER TABLE record_conflicts
  ADD COLUMN submitted_deleted       TINYINT(1)  NOT NULL DEFAULT 0 AFTER payload,
  ADD COLUMN superseded_version      INT         NULL AFTER resolved_at,
  ADD COLUMN superseded_form_type    VARCHAR(64) NULL AFTER superseded_version,
  ADD COLUMN superseded_form_version INT         NULL AFTER superseded_form_type,
  ADD COLUMN superseded_payload      JSON        NULL AFTER superseded_form_version;
