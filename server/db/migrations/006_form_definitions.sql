-- ============================================================
-- 006 — form definitions: the forms an admin builds, version by version.
--
-- Until now the household survey was written into the capture screen, and the
-- server knew only the TYPE of each of its fields. Every record already carries
-- (form_type, form_version); this table is what those two columns now point at.
--
-- A row is one version of one form type in one organisation:
--
--   draft       being edited by an admin. Never sent to a device, and a push
--               claiming its number is refused as a draft. It carries the
--               version number it will be published as, so a screen can say
--               "draft of version 3"; at most one exists per form type, which
--               the admin routes enforce under a lock.
--   published   immutable. Sent to every device in the organisation, and the
--               definition every record claiming that version is validated
--               against — on push, and on a supervisor's merge — for ever.
--               Nothing updates or deletes a published row: records captured
--               under it would become unreadable.
--
-- Not a syncable table in the records sense. Devices do not edit it; they
-- download every published row whole (GET /api/forms), so it needs no
-- version/updated_at/deleted_at cursor columns. A server-made UUID like users
-- and areas, which are also created online only.
--
-- created_by is NULL for a version nobody built in the admin screen: the
-- household survey seeded below, which was written into the app before.
--
-- The CHECK makes "published" and "has a publication time" the same fact, so
-- no code path can publish a row without dating it, or date a draft.
--
-- SEED: every organisation gets household_survey version 1, published,
-- matching the form that was built into the capture screen exactly (see
-- server/forms/householdSurveyV1.js, which a test holds this JSON to). Every
-- record that exists today claims (household_survey, 1), so without this row
-- the next push of any of them would be refused.
--
-- APPLY THIS BEFORE STARTING THE NEW SERVER CODE. The new push route reads this
-- table; the old code ignores it, so applying it under the old server is safe.
--
-- RUN ONCE. A second run fails at CREATE TABLE and changes nothing.
-- ============================================================

CREATE TABLE form_definitions (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  form_type       VARCHAR(64)  NOT NULL,          -- the slug records.form_type holds
  version         INT          NOT NULL,          -- what records.form_version holds
  title           VARCHAR(200) NOT NULL,
  fields          JSON         NOT NULL,          -- [{ key, label, type, required, ... }]
  status          ENUM('draft','published') NOT NULL DEFAULT 'draft',
  created_by      CHAR(36)     NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at    DATETIME(3)  NULL,
  PRIMARY KEY (id),
  -- One version 3 of a form per organisation, draft or published. Also the
  -- backstop if two publishes ever raced past the route's lock.
  UNIQUE KEY uq_form_definitions_version (organization_id, form_type, version),
  KEY idx_form_definitions_org_status (organization_id, status),
  CONSTRAINT fk_form_definitions_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_form_definitions_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_form_definitions_published
    CHECK ((status = 'published') = (published_at IS NOT NULL))
) ENGINE=InnoDB;

-- form-definition:household_survey:1
INSERT INTO form_definitions
  (id, organization_id, form_type, version, title, fields, status, created_by, published_at)
SELECT UUID(), o.id, 'household_survey', 1, 'Household survey',
       CAST('[{"key":"householdName","label":"Household name","type":"text","required":false},{"key":"memberCount","label":"Members in household","type":"number","required":false,"min":0,"integer":true},{"key":"childrenUnderFive","label":"Children under five","type":"number","required":false,"min":0,"integer":true},{"key":"visitDate","label":"Visit date","type":"date","required":false},{"key":"waterSource","label":"Main water source","type":"select","required":false,"options":["Piped","Handpump","Well","Tanker","Other"]},{"key":"notes","label":"Notes","type":"text","required":false,"multiline":true}]' AS JSON),
       'published', NULL, NOW(3)
  FROM organizations o;
