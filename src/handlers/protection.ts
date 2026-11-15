import { InlineKeyboard, type Bot, type Context } from "grammy";
import { msg } from "../messages";
import { refreshChatInfo } from "../services/access";
import {
  invalidateProtectedChats,
  isAdmin,
  protectedChatIds,
  type Services,
} from "../services/context";
import { sendDm } from "../services/telegram";
import { adminReply, adminScope } from "./adminScope";

const CB_PROTECT = "proteger";
const CB_UNPROTECT = "desproteger";
const CB_IGNORE = "ignorar";
const CALLBACK_RE = /^(proteger|desproteger|ignorar):(-?\d+)$/;

/** Botões da mensagem "Fui adicionado ao chat X". */
export const protectKeyboard = (chatId: number): InlineKeyboard =>
  new InlineKeyboard()
    .text(msg.botaoProteger, `${CB_PROTECT}:${chatId}`)
    .text(msg.botaoIgnorar, `${CB_IGNORE}:${chatId}`);

async function chatTitle(s: Services, chatId: number): Promise<string> {
  return (await s.repo.getChatTitles([chatId])).get(chatId) ?? String(chatId);
}

/** Protege ou desprotege um grupo. Retorna o texto de confirmação para os admins. */
export async function setProtection(
  s: Services,
  chatId: number,
  protect: boolean,
  adminId: number,
  adminName: string,
): Promise<string> {
  if (protect && chatId === s.config.adminChatId) return msg.naoProtegerAdmin;
  await s.repo.setChatProtection(chatId, protect, adminId, s.now().toISOString());
  invalidateProtectedChats(s);
  if (protect) await refreshChatInfo(s, [chatId]);
  const title = await chatTitle(s, chatId);
  return protect ? msg.protegido(title, adminName) : msg.desprotegido(title, adminName);
}

const adminName = (ctx: Context): string =>
  ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "admin");

export function registerProtection(bot: Bot, s: Services): void {
  // Botões: qualquer admin, em qualquer chat (normalmente o chat de admins).
  bot.callbackQuery(CALLBACK_RE, async (ctx) => {
    if (!(await isAdmin(s, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: msg.soAdmins, show_alert: true });
      return;
    }
    const [, action, rawId] = ctx.match;
    const chatId = Number(rawId);
    await ctx.answerCallbackQuery();
    const text =
      action === CB_IGNORE
        ? msg.ignorado(await chatTitle(s, chatId), adminName(ctx))
        : await setProtection(s, chatId, action === CB_PROTECT, ctx.from.id, adminName(ctx));
    // Troca a mensagem original pelo resultado (some com os botões, evita clique duplo).
    await ctx
      .editMessageText(text, { parse_mode: "HTML" })
      .catch(() => sendDm(s.api, ctx.chat?.id ?? s.config.adminChatId, text));
  });

  const admin = bot.filter(adminScope(s));

  // /proteger: lista os grupos conhecidos ainda não protegidos, com um botão para cada.
  admin.command("proteger", async (ctx) => {
    const protectedIds = await protectedChatIds(s);
    const candidates = (await s.repo.listKnownChats()).filter(
      (c) => !protectedIds.includes(c.chatId) && c.chatId !== s.config.adminChatId,
    );
    if (candidates.length === 0) {
      return void (await adminReply(s, ctx, msg.nenhumParaProteger));
    }
    const kb = new InlineKeyboard();
    for (const c of candidates) {
      kb.text(`✅ ${c.title ?? c.chatId}`, `${CB_PROTECT}:${c.chatId}`).row();
    }
    await adminReply(s, ctx, msg.escolhaProteger, { reply_markup: kb });
  });

  // /desproteger: lista os grupos protegidos, com um botão para cada.
  admin.command("desproteger", async (ctx) => {
    const ids = await protectedChatIds(s);
    if (ids.length === 0) return void (await adminReply(s, ctx, msg.nenhumProtegido));
    const titles = await s.repo.getChatTitles(ids);
    const kb = new InlineKeyboard();
    for (const id of ids) kb.text(`🔓 ${titles.get(id) ?? id}`, `${CB_UNPROTECT}:${id}`).row();
    await adminReply(s, ctx, msg.escolhaDesproteger, { reply_markup: kb });
  });
}
