-- Descrição definida pelos admins com /descricao. Vale por cima da descrição do Telegram, que a
-- Bot API não devolve para grupos que fazem parte de uma Comunidade do Telegram.
ALTER TABLE chats ADD COLUMN custom_description TEXT;
