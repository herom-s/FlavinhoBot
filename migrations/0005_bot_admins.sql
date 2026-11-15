-- Admins do bot adicionados/removidos pelo Telegram (/novo_admin, /remover_admin, botões).
-- Os IDs de ADMIN_IDS (env) são donos fixos e não podem ser removidos por aqui.
CREATE TABLE bot_admins (
  telegram_id INTEGER PRIMARY KEY,
  active      INTEGER NOT NULL,   -- 1 = admin, 0 = removido
  label       TEXT,               -- @username ou nome, só para exibir na lista
  changed_by  INTEGER NOT NULL,
  changed_at  TEXT NOT NULL
);
