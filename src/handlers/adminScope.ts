/**
 * Onde os comandos de admin funcionam e para onde vai a resposta:
 * - privado com o bot e chat de admins → responde ali mesmo
 * - grupo protegido → apaga o comando do grupo e responde no privado do admin
 *   (as respostas têm logins, IDs e motivos que não devem aparecer para o grupo)
 */
import type { Bot, Context } from "grammy";
import { ADMIN_COMMANDS } from "../commands";
import { msg } from "../messages";
import { isAdmin, isProtectedChat, type Services } from "../services/context";
import { sendDm } from "../services/telegram";

type SendOptions = Parameters<typeof sendDm>[3];

/** Comandos que continuam respondendo no próprio grupo (resposta pública e sem dados sensíveis). */
const PUBLIC_IN_GROUP = new Set(["help", "chatid"]);
const PRIVATE_COMMANDS = new Set(
  ADMIN_COMMANDS.map((c) => c.command).filter((c) => !PUBLIC_IN_GROUP.has(c)),
);

const inGroupScope = (s: Services, ctx: Context): boolean =>
  ctx.chat?.type !== "private" && ctx.chat?.id !== s.config.adminChatId;

/** Predicado dos handlers de admin: é admin e está num lugar onde os comandos valem. */
export const adminScope =
  (s: Services) =>
  async (ctx: Context): Promise<boolean> => {
    if (!(await isAdmin(s, ctx.from?.id))) return false;
    if (!inGroupScope(s, ctx)) return true;
    return ctx.chat !== undefined && (await isProtectedChat(s, ctx.chat.id));
  };

/** Para onde a resposta de um comando de admin deve ir. */
export const adminReplyChat = (s: Services, ctx: Context): number =>
  inGroupScope(s, ctx) ? ctx.from!.id : ctx.chat!.id;

/**
 * Responde um comando de admin. Se veio de um grupo e o privado falhar (o admin nunca deu
 * /start no bot), avisa no grupo sem nenhum dado, só pedindo para abrir o privado.
 */
export async function adminReply(
  s: Services,
  ctx: Context,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const target = adminReplyChat(s, ctx);
  const sent = await sendDm(s.api, target, text, options);
  if (!sent && target !== ctx.chat?.id && ctx.chat) {
    await sendDm(s.api, ctx.chat.id, msg.abraPrivado(ctx.me.username));
  }
}

/** Nome do comando de uma mensagem ("/stats@Bot args" → "stats"), ou null. */
function commandName(ctx: Context): string | null {
  const entity = ctx.message?.entities?.[0];
  if (!ctx.message?.text || entity?.type !== "bot_command" || entity.offset !== 0) return null;
  const [name, mention] = ctx.message.text.slice(1, entity.length).split("@");
  if (mention && mention.toLowerCase() !== ctx.me.username.toLowerCase()) return null;
  return name?.toLowerCase() ?? null;
}

/** Apaga do grupo protegido o comando de admin antes de o handler rodar. */
export function registerAdminGroupCleanup(bot: Bot, s: Services): void {
  bot.on("message", async (ctx, next) => {
    const name = commandName(ctx);
    if (name && PRIVATE_COMMANDS.has(name) && inGroupScope(s, ctx) && (await adminScope(s)(ctx))) {
      await s.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
    }
    await next();
  });
}
