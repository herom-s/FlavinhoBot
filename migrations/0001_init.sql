-- Esquema base (seção 7 da spec)
CREATE TABLE members (
  telegram_id       INTEGER PRIMARY KEY,
  telegram_username TEXT,
  intra_id          INTEGER NOT NULL UNIQUE,
  intra_login       TEXT NOT NULL,
  status            TEXT NOT NULL,        -- 'cadete_ativo' | 'alumni' | 'staff' | 'override'
  campus_id         INTEGER,
  verified_at       TEXT NOT NULL,        -- ISO 8601
  last_checked_at   TEXT NOT NULL,
  consent_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE join_requests (
  telegram_id  INTEGER NOT NULL,
  chat_id      INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (telegram_id, chat_id)
);

CREATE TABLE overrides (
  intra_login TEXT PRIMARY KEY,
  type        TEXT NOT NULL,             -- 'allow' | 'deny'
  reason      TEXT,
  added_by    INTEGER NOT NULL,          -- telegram_id do admin
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL,             -- 'verified', 'denied', 'approved', 'removed', 'override' ...
  telegram_id INTEGER,
  intra_login TEXT,
  detail      TEXT,                      -- motivo, sem dados sensíveis
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
