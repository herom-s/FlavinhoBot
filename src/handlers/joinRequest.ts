import type { Bot } from "grammy";
import { hashId, log } from "../logger";
import { msg } from "../messages";
import { isVerified, startVerification } from "../services/access";
import { isProtectedChat, type Services } from "../services/context";
import { safeApprove, safeDecline, sendDm } from "../services/telegram";

export function registerJoinRequest(bot: Bot, s: Services): void {
  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    const chatId = req.chat.id;
    const user = req.from;
    if (!isProtectedChat(s, chatId)) return;

    const nowIso = s.now().toISOString();
    await s.repo.upsertChat(chatId, "title" in req.chat ? req.chat.title : null, nowIso);

    if (await s.repo.isTelegramDenied(user.id)) {
      await safeDecline(s.api, chatId, user.id);
      await s.repo.audit("declined", { telegramId: user.id, detail: "denylist" }, nowIso);
      return;
    }

    if (await isVerified(s, user.id)) {
      // DM antes de aprovar: a janela de DM via user_chat_id fecha quando o pedido é processado.
      await sendDm(s.api, req.user_chat_id, msg.jaVerificado);
      if (await safeApprove(s.api, chatId, user.id)) {
        await s.repo.audit("approved", { telegramId: user.id, detail: String(chatId) }, nowIso);
      }
      await s.repo.deleteJoinRequest(user.id, chatId);
      return;
    }

    await s.repo.addJoinRequest(user.id, chatId, nowIso);
    const pending = (await s.repo.listJoinRequestsForUser(user.id)).map((r) => r.chatId);
    const sent = await startVerification(s, user, pending, req.user_chat_id);
    log.info("join_request_pending", { tg: hashId(user.id), chat_id: chatId, dm_sent: sent });
  });
}
