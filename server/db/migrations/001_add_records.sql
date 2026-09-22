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
  device_id       CHAR(36)     NOT NULL,          -- which phone it came from, for audit and conflict attribution
  form_type       VARCHAR(64)  NOT NULL,          -- one table holds several survey kinds until the form builder lands
  form_version    INT          NOT NULL DEFAULT 1, -- which revision of that form produced the payload
  payload         JSON         NOT NULL,          -- the answers, shaped by form_type + form_version
  version         INT          NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  -- The delta pull: everything in my org changed since my cursor.
  KEY idx_records_org_updated (organization_id, updated_at),
  -- One worker's own records, which is all a field worker's device ever pulls.
  KEY idx_records_user_updated (created_by, updated_at),
  CONSTRAINT fk_records_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT,
  -- RESTRICT, not CASCADE: deleting a user must never silently destroy the
  -- field data they collected.
  CONSTRAINT fk_records_user FOREIGN KEY (created_by)
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
  status          ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolution      ENUM('kept_server','kept_client','merged') NULL,
  resolved_by     CHAR(36)     NULL,
  resolved_at     DATETIME(3)  NULL,
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