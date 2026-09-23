-- ============================================================
-- Setu — schema v1 (authentication and organisation)
-- ============================================================

-- An NGO or health department. Everything else belongs to one.
CREATE TABLE organizations (
  id          CHAR(36)     NOT NULL,
  name        VARCHAR(200) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3)  NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- A village or ward. The unit field workers share records within: a worker
-- sees and changes the records of their own area, so a lost phone exposes one
-- area rather than the organisation. See migrations/004_areas.sql.
CREATE TABLE areas (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  name            VARCHAR(150) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One "Wadgaon" per organisation. Also what lets the seed be re-run safely.
  UNIQUE KEY uq_areas_org_name (organization_id, name),
  -- The target of the composite foreign keys on users and records, which is
  -- what stops anyone being placed in another organisation's area.
  UNIQUE KEY uq_areas_org_id (organization_id, id),
  CONSTRAINT fk_areas_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Field workers, supervisors, admins. Created online only.
CREATE TABLE users (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  phone           VARCHAR(20)  NOT NULL,          -- phone-first: field staff often have no email
  email           VARCHAR(200) NULL,
  password_hash   VARCHAR(255) NOT NULL,          -- bcrypt output, never the password
  role            ENUM('field_worker','supervisor','admin') NOT NULL DEFAULT 'field_worker',
  -- The area a field worker covers. NULL: no area, so they see only what they
  -- captured themselves. Ignored for supervisors and admins, who see the
  -- organisation. Read from here on every sync request, never from the token,
  -- so moving a worker takes effect without a new sign-in.
  area_id         CHAR(36)     NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at   DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_phone (phone),              -- login identifier, must be unique
  KEY idx_users_org (organization_id),
  KEY idx_users_org_area (organization_id, area_id),
  CONSTRAINT fk_users_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_users_area FOREIGN KEY (organization_id, area_id)
    REFERENCES areas (organization_id, id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Long-lived refresh tokens. Access tokens stay short-lived and are never stored.
CREATE TABLE refresh_tokens (
  id          CHAR(36)     NOT NULL,
  user_id     CHAR(36)     NOT NULL,
  token_hash  CHAR(64)     NOT NULL,              -- SHA-256 of the token, not the token itself
  expires_at  DATETIME(3)  NOT NULL,
  revoked_at  DATETIME(3)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- Collected field data. The first syncable table, so every later one copies
-- this shape:
--
--   id           the device generates the UUID. A phone with no network cannot
--                ask for an identifier, and two devices each taking "the next
--                number" would hand back the same id for different households.
--   version      counts writes to the row. The sync engine compares versions to
--                tell "this device is behind" from "both sides edited", which a
--                timestamp cannot do when two clocks disagree.
--   updated_at   the sync cursor. A device asks for everything changed since
--                the last value the SERVER gave it, so this column must be
--                written by the server's clock, never by a phone's.
--   deleted_at   deletes are soft. A row removed with DELETE simply stops
--                appearing in results, which an offline device reads as "no
--                change" and keeps its copy forever. A tombstone is a change it
--                can see and apply.
--   DATETIME(3)  millisecond precision. With second precision, several rows
--                saved in the same second share a timestamp, and a cursor of
--                "> last seen" either loses rows or returns them forever.
-- ============================================================
CREATE TABLE records (
  id              CHAR(36)     NOT NULL,          -- client-generated UUID
  organization_id CHAR(36)     NOT NULL,
  created_by      CHAR(36)     NOT NULL,          -- the worker who captured it
  -- Set by the server at first insert from the capturing user's area, and
  -- never changed by a push. NULL for records captured before areas existed or
  -- by a user with no area: visible only to their creator and to supervisors.
  area_id         CHAR(36)     NULL,
  -- Whose change the server last accepted: the pusher, or the resolver of a
  -- conflict. NULL means not recorded (rows written before migration 004).
  updated_by      CHAR(36)     NULL,
  device_id       CHAR(36)     NOT NULL,          -- which phone it came from, for audit and conflict attribution
  form_type       VARCHAR(64)  NOT NULL,          -- one table holds several survey kinds until the form builder lands
  form_version    INT          NOT NULL DEFAULT 1, -- which revision of that form produced the payload
  payload         JSON         NOT NULL,          -- the answers, shaped by form_type + form_version
  version         INT          NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  -- A supervisor's delta pull: everything in my org changed since my cursor.
  KEY idx_records_org_updated (organization_id, updated_at),
  -- A worker's own records with no area, the second half of a field worker's
  -- pull.
  KEY idx_records_user_updated (created_by, updated_at),
  -- A field worker's delta pull: everything in my area changed since my cursor.
  KEY idx_records_org_area_updated (organization_id, area_id, updated_at),
  KEY idx_records_updated_by (updated_by),
  CONSTRAINT fk_records_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  -- RESTRICT, not CASCADE: deleting a user must never silently destroy the
  -- field data they collected.
  CONSTRAINT fk_records_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE RESTRICT,
  -- Composite, so a record can never sit in another organisation's area.
  CONSTRAINT fk_records_area FOREIGN KEY (organization_id, area_id)
    REFERENCES areas (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_records_updated_by FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ============================================================
-- Rejected pushes, kept whole.
--
-- How the server decides, comparing the base_version a client sends (the last
-- version the SERVER confirmed to it) against records.version as stored:
--
--   base_version = records.version   the client edited from exactly what the
--                                    server still holds. Accept the write and
--                                    set version = version + 1.
--   base_version < records.version   somebody else's write landed in between.
--                                    Both sides changed the row from the same
--                                    ancestor, so this is a real conflict: keep
--                                    the stored row, write the incoming copy
--                                    here, and tell the client.
--   base_version > records.version   the client claims a version the server
--                                    never issued. Not a conflict but a bug or
--                                    a tampered payload — reject it, and do not
--                                    let it overwrite anything.
--
-- A separate table rather than a column on records, because a conflict has a
-- lifecycle of its own: raised, reviewed by a supervisor, resolved one way or
-- another. That is rows with their own status, timestamps and actor — which a
-- JSON blob hanging off the record cannot express, and cannot be queried
-- ("every open conflict in my organisation, oldest first") without scanning.
-- It also keeps one record's several conflicts apart instead of overwriting.
--
-- Nothing here is ever deleted on resolution. A rejected household visit is
-- collected data; losing a version compare is not a reason to destroy it.
--
-- And nothing a resolution REPLACES is destroyed either. `payload` is the copy
-- that lost the push; `superseded_*` is the copy the record held immediately
-- before a resolution overwrote it. Between them, both sides of every decision
-- survive the decision. See migrations/002_preserve_superseded.sql for why the
-- second half was added late, and why conflicts resolved before it cannot be
-- recovered.
-- ============================================================
CREATE TABLE record_conflicts (
  id              CHAR(36)     NOT NULL,
  record_id       CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,          -- denormalised so a supervisor's queue query never joins
  submitted_by    CHAR(36)     NOT NULL,          -- whose push was rejected
  device_id       CHAR(36)     NOT NULL,          -- and from which phone
  base_version    INT          NOT NULL,          -- the version that client edited from
  server_version  INT          NOT NULL,          -- what the server held at rejection time
  form_type       VARCHAR(64)  NOT NULL,
  form_version    INT          NOT NULL DEFAULT 1,
  payload         JSON         NOT NULL,          -- the rejected copy, verbatim
  -- Whether the rejected push was a deletion: 1 yes, 0 no, NULL not recorded
  -- (filed before migration 002, or 0 before 003 — see that migration for why
  -- those were demoted). A resolution acts on 1 and 0, and never on NULL.
  submitted_deleted TINYINT(1) NULL DEFAULT NULL,
  status          ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolution      ENUM('kept_server','kept_client','merged') NULL,
  resolved_by     CHAR(36)     NULL,
  resolved_at     DATETIME(3)  NULL,
  -- The record as it stood immediately before a resolution replaced it. NULL
  -- for kept_server (nothing replaced), for open conflicts, and for anything
  -- resolved before 002 — that content was overwritten with no copy kept.
  superseded_version      INT         NULL,
  superseded_form_type    VARCHAR(64) NULL,
  superseded_form_version INT         NULL,
  superseded_payload      JSON        NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The supervisor's queue: open conflicts in one organisation, oldest first.
  KEY idx_conflicts_org_status (organization_id, status, created_at),
  -- Every conflict on one record, for the compare view.
  KEY idx_conflicts_record (record_id),
  CONSTRAINT fk_conflicts_record FOREIGN KEY (record_id)
    REFERENCES records (id) ON DELETE RESTRICT,
  CONSTRAINT fk_conflicts_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_conflicts_user FOREIGN KEY (submitted_by)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_conflicts_resolver FOREIGN KEY (resolved_by)
    REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB;