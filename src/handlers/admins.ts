import { InlineKeyboard, type Bot, type Context } from "grammy";
import { ADMIN_COMMANDS, toBotCommands } from "../commands";
import { msg } from "../messages";
import { invalidateAdmins, isAdmin, isOwner, type Services } from "../services/context";
import { sendDm } from "../services/telegram";
import { adminReply, adminScope } from "./adminScope";

const CALLBACK_RE = /^(addadmin|rmadmin):(\d+)$/;

export const addAdminKeyboard = (userId: number): InlineKeyboard =>
  new InlineKeyboard().text(msg.botaoTornarAdmin, `addadmin:${userId}`);

const nameOf = (ctx: Context): string =>
  ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "admin");

/** Menu "/" de admin no privado da pessoa (ou o menu padrão de volta, ao remover). */
async function syncAdminMenu(s: Services, userId: number, admin: boolean): Promise<void> {
  const scope = { type: "chat" as const, chat_id: userId };
  try {
    if (admin) await s.api.setMyCommands(toBotCommands(ADMIN_COMMANDS), { scope });
    else await s.api.deleteMyCommands({ scope });
  } catch {
    // A pessoa ainda não deu /start no bot: o menu aparece no próximo deploy; os comandos já funcionam.
  }
}

export async function setAdmin(
  s: Services,
  userId: number,
  makeAdmin: boolean,
  label: string | null,
  byId: number,
  byName: string,
): Promise<string> {
  if (!makeAdmin && isOwner(s, userId)) return msg.naoRemoverDono;
  await s.repo.setBotAdmin(userId, makeAdmin, label, byId, s.now().toISOString());
  invalidateAdmins(s);
  await syncAdminMenu(s, userId, makeAdmin);
  const who = label ?? String(userId);
  return makeAdmin ? msg.adminAdicionado(who, userId, byName) : msg.adminRemovido(who, byName);
}

/** Descobre de quem se trata: resposta a uma mensagem, telegram_id ou @username. */
async function resolveTarget(
  s: Services,
  ctx: Context,
): Promise<{ id: number; label: string | null } | null> {
  const replied = ctx.message?.reply_to_message?.from;
  if (replied && !replied.is_bot) {
    return {
      id: replied.id,
      label: replied.username ? `@${replied.username}` : replied.first_name,
    };
  }
  const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/)[0] ?? "";
  if (/^\d+$/.test(arg)) return { id: Number(arg), label: null };
  if (arg.startsWith("@") && arg.length > 1) {
    const id = await s.repo.findTelegramIdByUsername(arg.slice(1));
    return id ? { id, label: arg } : null;
  }
  return null;
}

export function registerAdmins(bot: Bot, s: Services): void {
  bot.callbackQuery(CALLBACK_RE, async (ctx) => {
    if (!(await isAdmin(s, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: msg.soAdmins, show_alert: true });
      return;
    }
    const [, action, rawId] = ctx.match;
    const userId = Number(rawId);
    await ctx.answerCallbackQuery();
    // O botão vem na resposta ao /help da pessoa: pega o nome da mensagem original.
    const original = ctx.callbackQuery.message?.reply_to_message?.from;
    const label =
      original?.id === userId
        ? original.username
          ? `@${original.username}`
          : original.first_name
        : ((await s.repo.listBotAdmins()).find((a) => a.telegramId === userId)?.label ?? null);
    const text = await setAdmin(s, userId, action === "addadmin", label, ctx.from.id, nameOf(ctx));
    await ctx
      .editMessageText(text, { parse_mode: "HTML" })
      .catch(() => sendDm(s.api, ctx.chat?.id ?? s.config.adminChatId, text));
  });

  const admin = bot.filter(adminScope(s));

  admin.command("admins", async (ctx) => {
    const added = (await s.repo.listBotAdmins()).filter(
      (a) => a.active && !isOwner(s, a.telegramId),
    );
    const owners = s.config.adminIds.map((id) => `• <code>${id}</code> (dono)`);
    const others = added.map((a) => `• ${a.label ?? ""} <code>${a.telegramId}</code>`);
    const kb = new InlineKeyboard();
    for (const a of added)
      kb.text(`🗑️ ${a.label ?? a.telegramId}`, `rmadmin:${a.telegramId}`).row();
    await adminReply(s, ctx, msg.listaAdmins([...owners, ...others]), {
      reply_markup: added.length ? kb : undefined,
    });
  });

  admin.command("novo_admin", async (ctx) => {
    const target = await resolveTarget(s, ctx);
    if (!target) return void (await adminReply(s, ctx, msg.usoNovoAdmin));
    if (await isAdmin(s, target.id)) {
      return void (await adminReply(s, ctx, msg.jaEhAdmin(target.label ?? String(target.id))));
    }
    const text = await setAdmin(s, target.id, true, target.label, ctx.from!.id, nameOf(ctx));
    await adminReply(s, ctx, text);
  });

  admin.command("remover_admin", async (ctx) => {
    const target = await resolveTarget(s, ctx);
    if (!target) return void (await adminReply(s, ctx, msg.usoRemoverAdmin));
    const text = await setAdmin(s, target.id, false, target.label, ctx.from!.id, nameOf(ctx));
    await adminReply(s, ctx, text);
  });
}
