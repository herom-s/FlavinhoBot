/**
 * Registra o webhook e os menus de comandos ("/") no Telegram.
 * Uso: bun run set-webhook
 * Lê do .env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL e, se houver,
 * ADMIN_IDS e ADMIN_CHAT_ID (para o menu de admin).
 */
import { ADMIN_COMMANDS, GROUP_COMMANDS, toBotCommands, USER_COMMANDS } from "../src/commands";

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");

if (!token || !secret || !baseUrl) {
  console.error("Defina TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET e PUBLIC_BASE_URL no .env");
  process.exit(1);
}

async function call(method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

await call("setWebhook", {
  url: `${baseUrl}/webhook`,
  secret_token: secret,
  allowed_updates: [
    "message",
    "chat_join_request",
    "chat_member",
    "my_chat_member",
    "callback_query",
  ],
  drop_pending_updates: false,
});
console.log(`✅ Webhook: ${baseUrl}/webhook`);

const userCommands = toBotCommands(USER_COMMANDS);
const adminCommands = toBotCommands(ADMIN_COMMANDS);

// Menus por escopo: o Telegram usa o mais específico (chat > todos os privados/grupos).
await call("setMyCommands", { commands: userCommands, scope: { type: "all_private_chats" } });
await call("setMyCommands", {
  commands: userCommands,
  scope: { type: "all_private_chats" },
  language_code: "pt",
});
await call("setMyCommands", {
  commands: toBotCommands(GROUP_COMMANDS),
  scope: { type: "all_group_chats" },
});
console.log("✅ Menu de usuário e dos grupos registrado");

const ids = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^-?\d+$/.test(v) && v !== "0");

const adminChats = [...ids(process.env.ADMIN_CHAT_ID), ...ids(process.env.ADMIN_IDS)];
for (const chatId of new Set(adminChats)) {
  try {
    await call("setMyCommands", {
      commands: adminCommands,
      scope: { type: "chat", chat_id: chatId },
    });
    console.log(`✅ Menu de admin registrado no chat ${chatId}`);
  } catch (err) {
    // Acontece se o admin ainda não deu /start no bot; o /help continua funcionando.
    console.warn(`⚠️ Menu de admin no chat ${chatId}: ${(err as Error).message}`);
  }
}

console.log(await call("getWebhookInfo", {}));
