-- 0001_identity: users, permissions, sessions, one-time tokens, login events, audit log, settings.
-- SQLite port of the Postgres identity schema (branch feat/foundation, apps/api/src/db/schema.ts).
-- Conventions: ids are TEXT (UUIDv7 generated in code); every timestamp is INTEGER epoch milliseconds (UTC)
-- supplied by the application clock (no database defaults); booleans are INTEGER 0/1; JSON is TEXT.
-- The CHECK lists below mirror shared/roles.ts and shared/permissions.ts (a test fails if they drift).

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE
                   CHECK (email <> '' AND email = lower(trim(email)) COLLATE BINARY),
  password_hash    TEXT,
  full_name        TEXT NOT NULL,
  phone            TEXT,
  role             TEXT NOT NULL
                   CHECK (role IN ('super_manager', 'sub_manager', 'affiliate')),
  status           TEXT NOT NULL DEFAULT 'invited'
                   CHECK (status IN ('invited', 'active', 'suspended', 'deactivated')),
  is_owner         INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  totp_secret_enc  TEXT,
  totp_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  totp_last_step   INTEGER,
  failed_logins    INTEGER NOT NULL DEFAULT 0,
  locked_until     INTEGER,
  last_login_at    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (is_owner = 0 OR role = 'super_manager')
);

CREATE TABLE user_permissions (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission  TEXT NOT NULL
              CHECK (permission IN (
                'users.manage', 'orders.read', 'orders.write', 'orders.override', 'clients.merge',
                'catalog.write', 'stock.write', 'commissions.manage', 'payouts.manage', 'finance.read',
                'expenses.write', 'reports.export', 'settings.manage', 'audit.read'
              )),
  PRIMARY KEY (user_id, permission)
) WITHOUT ROWID;

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip            TEXT,
  user_agent    TEXT,
  remember      INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0, 1)),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('invite', 'password_reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX auth_tokens_user_id_idx ON auth_tokens (user_id);

CREATE TABLE login_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  email_tried TEXT NOT NULL COLLATE NOCASE,
  ip          TEXT,
  user_agent  TEXT,
  success     INTEGER NOT NULL CHECK (success IN (0, 1)),
  reason      TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX login_events_user_id_idx ON login_events (user_id);
CREATE INDEX login_events_at_idx ON login_events (at);
CREATE INDEX login_events_email_tried_at_idx ON login_events (email_tried, at);

-- Append-only: no foreign key on actor_user_id so rows outlive users; triggers forbid UPDATE and DELETE.
CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  before         TEXT CHECK (before IS NULL OR json_valid(before)),
  after          TEXT CHECK (after IS NULL OR json_valid(after)),
  reason         TEXT,
  ip             TEXT,
  request_id     TEXT,
  at             INTEGER NOT NULL
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
