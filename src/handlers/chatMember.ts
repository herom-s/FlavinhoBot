import type { Bot } from "grammy";
import { escapeHtml } from "../messages";
import { refreshChatInfo } from "../services/access";
import { isProtectedChat, type Services } from "../services/context";
import { notifyAdmins } from "../services/telegram";

/** Cache por isolate para não regravar no D1 a cada mensagem de quem já foi visto. */
const seenCache = new Set<string>();

async function markSeen(s: Services, userId: number, chatId: number, username?: string) {
  const key = `${chatId}:${userId}:${username ?? ""}`;
  if (seenCache.has(key)) return;
  if (seenCache.size > 20_000) seenCache.clear();
  await s.repo.markSeen(userId, chatId, username ?? null, s.now().toISOString());
  seenCache.add(key);
}

export function registerChatMember(bot: Bot, s: Services): void {
  // Bot adicionado/promovido/removido em algum chat.
  bot.on("my_chat_member", async (ctx) => {
    const { chat, old_chat_member: oldM, new_chat_member: newM } = ctx.myChatMember;
    if (chat.type === "private" || chat.type === "channel") return;
    const title = chat.title;
    await s.repo.upsertChat(chat.id, title, s.now().toISOString());
    const isProtected = isProtectedChat(s, chat.id);
    const label = `<b>${escapeHtml(title)}</b> (id <code>${chat.id}</code>)`;

    if (newM.status === "administrator" && oldM.status !== "administrator") {
      await refreshChatInfo(s, [chat.id]);
      await notifyAdmins(
        s,
        isProtected
          ? `✅ Fui promovido a admin no chat protegido ${label}. Roda /sincronizar pra conferir as permissões.`
          : `🆕 Fui adicionado ao chat ${label}. Incluir em PROTECTED_CHAT_IDS?`,
      );
    } else if (isProtected && oldM.status === "administrator" && newM.status !== "administrator") {
      await notifyAdmins(
        s,
        `🚨 Perdi o admin no chat protegido ${label}! Sem isso não consigo controlar a entrada.`,
      );
    }
  });

  // Entradas nos chats protegidos (inclui membros antigos, via chat_member).
  bot.on("chat_member", async (ctx) => {
    const { chat, new_chat_member: newM } = ctx.chatMember;
    if (!isProtectedChat(s, chat.id)) return;
    if (newM.user.is_bot) return;
    if (newM.status === "member" || newM.status === "restricted") {
      await markSeen(s, newM.user.id, chat.id, newM.user.username);
    }
    // status "left"/"kicked": o registro continua no banco; se voltar verificado, é aprovado direto.
  });

  // Quem fala nos chats protegidos (o bot admin recebe as mensagens mesmo com privacy mode ligado).
  bot.on("message", async (ctx, next) => {
    const from = ctx.from;
    if (ctx.chat.type !== "private" && isProtectedChat(s, ctx.chat.id) && from && !from.is_bot) {
      await markSeen(s, from.id, ctx.chat.id, from.username);
    }
    await next();
  });
}
