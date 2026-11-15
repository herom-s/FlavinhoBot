import { InlineKeyboard, type Bot } from "grammy";
import { membroVerificado } from "../domain/eligibility";
import { msg } from "../messages";
import { RateLimiter } from "../rateLimit";
import {
  approvePending,
  CB_INVITES,
  groupLines,
  isVerified,
  linksKeyboard,
  sendInvites,
  startVerification,
} from "../services/access";
import type { Services } from "../services/context";
import { removeFromChats, sendDm } from "../services/telegram";

const CB_DELETE_YES = "apagar:sim";
const CB_DELETE_NO = "apagar:nao";

const limiter = new RateLimiter(15, 60_000);

export const USER_COMMANDS = [
  { command: "start", description: "Verificar pela Intra e entrar na comunidade" },
  { command: "status", description: "Ver se você está verificado" },
  { command: "grupos", description: "Os grupos da comunidade e do que cada um trata" },
  { command: "links", description: "Links úteis da comunidade" },
  { command: "privacidade", description: "Quais dados eu guardo e por quê" },
  { command: "apagar_dados", description: "Apagar seus dados e sair dos grupos" },
  { command: "ajuda", description: "Como falar com um admin" },
] as const;

export function registerUserCommands(bot: Bot, s: Services): void {
  const priv = bot.chatType("private");

  // Rate limit por telegram_id em tudo que chega no privado (comandos e botões).
  priv.use(async (ctx, next) => {
    if (limiter.allow(String(ctx.from.id))) return next();
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg.rateLimited });
    else if (ctx.message?.text?.startsWith("/")) await sendDm(s.api, ctx.chat.id, msg.rateLimited);
  });

  priv.command("start", async (ctx) => {
    const user = ctx.from;
    if (await s.repo.isTelegramDenied(user.id)) {
      await sendDm(s.api, user.id, msg.negado("denylist"));
      return;
    }
    if (await isVerified(s, user.id)) {
      await approvePending(s, user.id);
      await sendDm(s.api, user.id, msg.jaVerificado);
      await sendInvites(s, user.id);
      return;
    }
    await sendDm(s.api, user.id, msg.start);
    const pending = (await s.repo.listJoinRequestsForUser(user.id)).map((r) => r.chatId);
    await startVerification(s, user, pending);
  });

  priv.command("status", async (ctx) => {
    const member = await s.repo.getMember(ctx.from.id);
    const denied = await s.repo.isTelegramDenied(ctx.from.id);
    if (!member) return void (await sendDm(s.api, ctx.chat.id, msg.statusNaoVerificado));
    if (denied || member.revokedReason) {
      return void (await sendDm(s.api, ctx.chat.id, msg.statusRevogado));
    }
    if (!membroVerificado(member, denied, s.now(), s.config.reverifyDays)) {
      return void (await sendDm(s.api, ctx.chat.id, msg.statusVencido(member.intraLogin)));
    }
    const ate = new Date(Date.parse(member.lastCheckedAt) + s.config.reverifyDays * 86_400_000);
    await sendDm(s.api, ctx.chat.id, msg.statusVerificado(member.intraLogin, member.status, ate));
  });

  priv.command("grupos", async (ctx) => {
    const chatIds = s.config.protectedChatIds;
    if (chatIds.length === 0)
      return void (await sendDm(s.api, ctx.chat.id, msg.semChatsProtegidos));
    const lines = groupLines(chatIds, await s.repo.getChatInfo(chatIds));
    const verified = await isVerified(s, ctx.from.id);

    // Quebra em várias mensagens se passar do limite de 4096 caracteres do Telegram.
    const chunks: string[] = [];
    let current: string = msg.grupos;
    for (const line of lines) {
      if (current.length + line.length + 2 > 3800) {
        chunks.push(current);
        current = line;
      } else {
        current += `\n\n${line}`;
      }
    }
    chunks.push(`${current}\n\n${verified ? msg.gruposVerificado : msg.gruposNaoVerificado}`);

    for (const [i, text] of chunks.entries()) {
      const last = i === chunks.length - 1;
      await sendDm(
        s.api,
        ctx.chat.id,
        text,
        last && verified
          ? { reply_markup: new InlineKeyboard().text(msg.botaoConvites, CB_INVITES) }
          : {},
      );
    }
  });

  priv.command("links", async (ctx) => {
    await sendDm(s.api, ctx.chat.id, msg.links, { reply_markup: linksKeyboard(false) });
  });

  priv.command("privacidade", async (ctx) => {
    await sendDm(s.api, ctx.chat.id, msg.privacidade);
  });

  priv.command("ajuda", async (ctx) => {
    await sendDm(s.api, ctx.chat.id, msg.ajuda);
  });

  priv.command("apagar_dados", async (ctx) => {
    await sendDm(s.api, ctx.chat.id, msg.apagarConfirmar, {
      reply_markup: new InlineKeyboard()
        .text(msg.botaoApagarSim, CB_DELETE_YES)
        .text(msg.botaoApagarNao, CB_DELETE_NO),
    });
  });

  priv.callbackQuery(CB_DELETE_YES, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const isAdminUser = s.config.adminIds.includes(userId);
    if (!isAdminUser) await removeFromChats(s, userId);
    for (const r of await s.repo.listJoinRequestsForUser(userId)) {
      await s.api.declineChatJoinRequest(r.chatId, userId).catch(() => undefined);
    }
    await s.repo.deleteUserData(userId);
    await s.repo.audit("data_deleted", { detail: "pedido do usuário" }, s.now().toISOString());
    await ctx.editMessageText(msg.apagado).catch(() => sendDm(s.api, userId, msg.apagado));
  });

  priv.callbackQuery(CB_DELETE_NO, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(msg.apagarCancelado).catch(() => undefined);
  });

  priv.callbackQuery(CB_INVITES, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await isVerified(s, ctx.from.id))) {
      await sendDm(s.api, ctx.from.id, msg.precisaVerificarAntes);
      return;
    }
    await sendInvites(s, ctx.from.id);
  });
}
