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

-- Field workers, supervisors, admins. Created online only.
CREATE TABLE users (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  phone           VARCHAR(20)  NOT NULL,          -- phone-first: field staff often have no email
  email           VARCHAR(200) NULL,
  password_hash   VARCHAR(255) NOT NULL,          -- bcrypt output, never the password
  role            ENUM('field_worker','supervisor','admin') NOT NULL DEFAULT 'field_worker',
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at   DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_phone (phone),              -- login identifier, must be unique
  KEY idx_users_org (organization_id),
  CONSTRAINT fk_users_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT
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