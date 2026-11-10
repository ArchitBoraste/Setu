-- ============================================================
-- 005 — refresh-token families, and what each token was rotated into.
--
-- Until now a refresh token row knew nothing about the sign-in it came from.
-- Every /refresh revoked the token it was given and minted an unrelated one, so
-- the server could not answer "which tokens belong to this session?" — and
-- without that, sign-out could only revoke the one token presented, and a
-- stolen token that had already been rotated could not be traced to the live
-- token its theft put at risk.
--
-- family_id names the SESSION. A sign-in starts a family; every token rotated
-- from it carries the same family_id. Revoking a session is then one UPDATE by
-- family, whichever of its tokens the caller holds. A family is named after the
-- token that started it (family_id = that token's id), so the root of any
-- family is the row where id = family_id.
--
-- replaced_by is the id of the token minted when this one was rotated. NULL
-- means the token was never rotated: still live, expired unused, or revoked by
-- sign-out. It is what lets the server tell "a token that was already
-- exchanged is being presented again" (reuse, which signals theft) apart from
-- "a token that was signed out", and it lets an audit walk a session's chain.
-- Deliberately not a foreign key: it is an audit pointer, and a table that
-- references itself would make the user cascade and demo:reset's bulk DELETE
-- depend on the order rows happen to be deleted in.
--
-- EXISTING ROWS each become the root of their own family: family_id = id. Old
-- tokens were never linked to one another and nothing recorded which were
-- rotated from which, so there is no truer family to give them. Their
-- replaced_by stays NULL for the same reason — the chain was never written
-- down. A pre-005 token still live on a phone carries on as an ordinary
-- session: rotating it after 005 adds the new token to its family, and signing
-- out then revokes both. Already-revoked old rows are history and stay so.
--
-- family_id is added NULL, backfilled, then made NOT NULL, so that the column
-- ends with no DEFAULT. Every insert must say which session it belongs to;
-- forgetting to is an error rather than a silent new family.
--
-- STOP THE SERVER FIRST. The old code inserts tokens without family_id, which
-- fails once the column is NOT NULL, and the new code needs the column to
-- exist. Run this, then start the new code.
--
-- Columns are placed with AFTER so a database migrated from 004 ends up with
-- exactly the table schema.sql creates from scratch.
--
-- RUN ONCE. A second run fails at the first ALTER TABLE (duplicate column
-- family_id) and changes nothing.
-- ============================================================

ALTER TABLE refresh_tokens
  ADD COLUMN family_id   CHAR(36) NULL AFTER user_id,
  ADD COLUMN replaced_by CHAR(36) NULL AFTER revoked_at;

UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL;

ALTER TABLE refresh_tokens
  MODIFY COLUMN family_id CHAR(36) NOT NULL AFTER user_id,
  -- Sign-out revokes a whole family: every token sharing one family_id.
  ADD KEY idx_refresh_family (family_id);
