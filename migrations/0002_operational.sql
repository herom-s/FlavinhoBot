-- Tabelas/colunas operacionais exigidas pelos fluxos da spec.

-- Revalidação (seção 8): membro que deixou de ser elegível, sem remoção automática,
-- não pode continuar sendo aprovado direto. NULL = acesso válido.
ALTER TABLE members ADD COLUMN revoked_reason TEXT;
CREATE INDEX idx_members_last_checked ON members (last_checked_at);
CREATE INDEX idx_members_login ON members (intra_login);
CREATE INDEX idx_members_username ON members (telegram_username);

CREATE INDEX idx_join_requests_requested ON join_requests (requested_at);
CREATE INDEX idx_audit_event_created ON audit_log (event, created_at);

-- `state` do OAuth (seção 6). Guardamos só o SHA-256 do state; consumo atômico via DELETE ... RETURNING.
CREATE TABLE oauth_states (
  state_hash        TEXT PRIMARY KEY,
  telegram_id       INTEGER NOT NULL,
  telegram_username TEXT,
  chat_ids          TEXT NOT NULL,        -- JSON array
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expires ON oauth_states (expires_at);

-- Quem foi visto nos chats protegidos (a Bot API não lista membros de grupos). Seção 13.12.
CREATE TABLE seen_members (
  telegram_id       INTEGER NOT NULL,
  chat_id           INTEGER NOT NULL,
  telegram_username TEXT,
  first_seen_at     TEXT NOT NULL,
  PRIMARY KEY (telegram_id, chat_id)
);

-- Título dos chats (para nomear convites sem gastar chamadas à API).
CREATE TABLE chats (
  chat_id    INTEGER PRIMARY KEY,
  title      TEXT,
  updated_at TEXT NOT NULL
);

-- Configurações de runtime (ex.: prazo dos membros antigos).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
