-- Grupos protegidos/desprotegidos pelos admins direto no Telegram (botões e /proteger, /desproteger).
-- A lista efetiva é: PROTECTED_CHAT_IDS (env) + protected = 1 − protected = 0.
CREATE TABLE protected_chats (
  chat_id    INTEGER PRIMARY KEY,
  protected  INTEGER NOT NULL,   -- 1 = protegido, 0 = desprotegido (vence o env)
  changed_by INTEGER NOT NULL,   -- telegram_id do admin
  changed_at TEXT NOT NULL
);
