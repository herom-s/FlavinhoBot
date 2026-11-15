import type { Bot } from "grammy";
import { ADMIN_COMMANDS, USER_COMMANDS } from "../commands";
import { help } from "../messages";
import { RateLimiter } from "../rateLimit";
import { isAdmin, isProtectedChat, type Services } from "../services/context";
import { sendDm } from "../services/telegram";

/** Nos grupos a resposta é pública: no máximo 1 por pessoa por grupo por minuto. */
const groupLimiter = new RateLimiter(1, 60_000);

/**
 * /help muda conforme onde e quem pede:
 * - chat de admins, ou privado de um admin → comandos de admin
 * - chat de admins, por quem não está em ADMIN_IDS → avisa e mostra o ID para incluir
 * - privado de um membro → comandos de usuário
 * - grupo protegido → o que é o bot e como usá-lo (responde no grupo)
 * - qualquer outro grupo → ignora
 */
export function registerHelp(bot: Bot, s: Services): void {
  bot.command("help", async (ctx) => {
    const chat = ctx.chat;
    const fromAdmin = isAdmin(s, ctx.from?.id);
    const username = ctx.me.username;

    if (chat.id === s.config.adminChatId) {
      await sendDm(
        s.api,
        chat.id,
        fromAdmin
          ? help.admin(ADMIN_COMMANDS, username, true)
          : help.naoAdmin(ctx.from?.id ?? 0, ctx.from?.first_name ?? "jovem"),
        { reply_parameters: { message_id: ctx.msgId, allow_sending_without_reply: true } },
      );
      return;
    }
    if (chat.type === "private") {
      await sendDm(
        s.api,
        chat.id,
        fromAdmin ? help.admin(ADMIN_COMMANDS, username, false) : help.usuario(USER_COMMANDS),
      );
      return;
    }
    if ((await isProtectedChat(s, chat.id)) && groupLimiter.allow(`${chat.id}:${ctx.from?.id}`)) {
      await sendDm(s.api, chat.id, help.grupo(username), {
        reply_parameters: { message_id: ctx.msgId, allow_sending_without_reply: true },
      });
    }
  });
}

export const resetHelpRateLimit = (): void => groupLimiter.clear();
