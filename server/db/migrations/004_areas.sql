-- ============================================================
-- 004 — areas, and who made the last accepted change to a record.
--
-- Until now a field worker pulled and pushed only the records they captured.
-- That breaks the most ordinary thing field work does: two workers covering one
-- village, where either may be the one at the door when a household's answers
-- change. The unit of sharing becomes the AREA — a village or ward:
--
--   a field worker   sees and changes the records of their own area, plus any
--                    record with no area that they captured themselves
--   a supervisor     sees and changes the whole organisation, as before
--
-- This is also what the containment argument needs. A lost field worker's phone
-- exposes one area, not the organisation's register.
--
-- THE AREA OF A RECORD IS FIXED AT FIRST INSERT, by the server, from the
-- capturing user's area as the database holds it at that moment. No push ever
-- changes it, and nothing the device sends is read to set it. A household does
-- not move village because a different worker edited it.
--
-- EXISTING RECORDS KEEP area_id = NULL. They are deliberately not backfilled
-- from their creator's area: no user has an area when this runs, and even after
-- the seed assigns some, guessing an area for old rows would widen who can see
-- them without anybody having decided that. A NULL-area record stays visible
-- exactly as before — to its creator and to supervisors.
--
-- updated_by records the user whose change the server last ACCEPTED: the
-- pusher on an insert or accepted edit, the resolver on a resolution that
-- writes. Existing rows keep NULL, which means "not recorded" — created_by is
-- not a safe guess, because supervisors could already push other people's
-- records. Filling it in would also be an UPDATE, which moves updated_at
-- through ON UPDATE and re-delivers every record to every device.
--
-- SAME-ORGANISATION BY CONSTRUCTION. users.area_id and records.area_id point at
-- areas through a composite key, (organization_id, area_id) ->
-- areas (organization_id, id), so a user or a record can never be placed in
-- another organisation's area — the database refuses it, rather than every
-- query having to remember to. MySQL skips the check while area_id is NULL,
-- which is exactly the "no area" case.
--
-- Columns are placed with AFTER so a database migrated from 003 ends up with
-- exactly the tables schema.sql creates from scratch.
--
-- RUN ONCE. A second run fails at CREATE TABLE and changes nothing.
-- ============================================================

CREATE TABLE areas (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  name            VARCHAR(150) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One "Wadgaon" per organisation. Also what lets the seed be re-run safely.
  UNIQUE KEY uq_areas_org_name (organization_id, name),
  -- The target of the composite foreign keys below.
  UNIQUE KEY uq_areas_org_id (organization_id, id),
  CONSTRAINT fk_areas_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

ALTER TABLE users
  ADD COLUMN area_id CHAR(36) NULL AFTER role,
  ADD KEY idx_users_org_area (organization_id, area_id),
  ADD CONSTRAINT fk_users_area FOREIGN KEY (organization_id, area_id)
    REFERENCES areas (organization_id, id) ON DELETE RESTRICT;

ALTER TABLE records
  ADD COLUMN area_id    CHAR(36) NULL AFTER created_by,
  ADD COLUMN updated_by CHAR(36) NULL AFTER area_id,
  -- A field worker's delta pull: everything in my area changed since my cursor.
  ADD KEY idx_records_org_area_updated (organization_id, area_id, updated_at),
  ADD KEY idx_records_updated_by (updated_by),
  ADD CONSTRAINT fk_records_area FOREIGN KEY (organization_id, area_id)
    REFERENCES areas (organization_id, id) ON DELETE RESTRICT,
  -- RESTRICT, like created_by: removing a user must never quietly rewrite the
  -- history of who changed a household's record.
  ADD CONSTRAINT fk_records_updated_by FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE RESTRICT;
