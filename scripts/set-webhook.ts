/**
 * Registra o webhook e os comandos de usuário no Telegram.
 * Uso: bun run set-webhook   (lê TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET e PUBLIC_BASE_URL do .env)
 */
import { USER_COMMANDS } from "../src/handlers/commands.user";

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

await call("setMyCommands", {
  commands: USER_COMMANDS,
  scope: { type: "all_private_chats" },
  language_code: "pt",
});
await call("setMyCommands", { commands: USER_COMMANDS, scope: { type: "all_private_chats" } });
console.log("✅ Comandos de usuário registrados");

console.log(await call("getWebhookInfo", {}));
