import type { Bot, Context } from "grammy";
import type { MemberRecord } from "../db/repository";
import type { DenyReason } from "../domain/eligibility";
import { reverifyMember } from "../jobs/reverify";
import { escapeHtml, motivoAdmin, msg } from "../messages";
import { isAdmin, type Services } from "../services/context";
import { removeFromChats, safeDecline, sendDm } from "../services/telegram";

export const GRANDFATHER_KEY = "grandfather_deadline";

const REQUIRED_PERMS = ["can_invite_users", "can_restrict_members", "can_delete_messages"] as const;

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

const userLink = (id: number, username: string | null) =>
  username ? `@${escapeHtml(username)}` : `<a href="tg://user?id=${id}">${id}</a>`;

const LOGIN_RE = /^[a-z0-9_-]{1,32}$/i;

function args(ctx: Context): string[] {
  const m = typeof ctx.match === "string" ? ctx.match : "";
  return m.trim().split(/\s+/).filter(Boolean);
}

function describeMember(m: MemberRecord, denied: boolean, override: string | null): string {
  return [
    `👤 <b>${escapeHtml(m.intraLogin)}</b> (intra ${m.intraId})`,
    `Telegram: ${userLink(m.telegramId, m.telegramUsername)} · <code>${m.telegramId}</code>`,
    `Status: ${escapeHtml(m.status)}${m.revokedReason ? ` · ❌ revogado (${escapeHtml(m.revokedReason)})` : ""}${denied ? " · ⛔ denylist" : ""}`,
    `Verificado em: ${fmt(m.verifiedAt)}`,
    `Última checagem: ${fmt(m.lastCheckedAt)}`,
    override ? `Override: ${escapeHtml(override)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerAdminCommands(bot: Bot, s: Services): void {
  // Admin em qualquer chat: só para descobrir IDs durante o setup.
  bot
    .filter((ctx) => isAdmin(s, ctx.from?.id))
    .command("chatid", async (ctx) => {
      await sendDm(s.api, ctx.chat.id, `chat_id: <code>${ctx.chat.id}</code>`);
    });

  // Demais comandos: admin + (privado ou chat de admins). Não-admin cai fora sem resposta.
  const admin = bot.filter(
    (ctx) =>
      isAdmin(s, ctx.from?.id) &&
      (ctx.chat?.type === "private" || ctx.chat?.id === s.config.adminChatId),
  );
  const reply = (ctx: Context, text: string) => sendDm(s.api, ctx.chat!.id, text);

  admin.command("stats", async (ctx) => {
    const now = s.now();
    const [byStatus, pendentes, negados, naoVerificados] = await Promise.all([
      s.repo.countMembersByStatus(),
      s.repo.countJoinRequests(),
      s.repo.countAuditSince("denied", new Date(now.getTime() - 7 * 86_400_000).toISOString()),
      s.repo.listUnverifiedSeen(1000),
    ]);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    await reply(
      ctx,
      [
        "📊 <b>Estatísticas</b>",
        `Membros verificados: <b>${total - (byStatus.revogado ?? 0)}</b>`,
        `  • cadetes: ${byStatus.cadete_ativo ?? 0}`,
        `  • alumni: ${byStatus.alumni ?? 0}`,
        `  • staff: ${byStatus.staff ?? 0}`,
        `  • liberação manual: ${byStatus.override ?? 0}`,
        `Revogados: ${byStatus.revogado ?? 0}`,
        `Pedidos pendentes: ${pendentes}`,
        `Negados (7 dias): ${negados}`,
        `Vistos sem verificação: ${naoVerificados.filter((u) => !isAdmin(s, u.telegramId)).length}`,
      ].join("\n"),
    );
  });

  admin.command("quem", async (ctx) => {
    const [target] = args(ctx);
    if (!target) return void (await reply(ctx, "Uso: /quem &lt;@user ou login&gt;"));
    const member = target.startsWith("@")
      ? await s.repo.getMemberByUsername(target.slice(1))
      : /^\d+$/.test(target) && target.length > 6
        ? await s.repo.getMember(Number(target))
        : await s.repo.getMemberByLogin(target);
    if (!member) {
      const ov = target.startsWith("@") ? null : await s.repo.getOverride(target);
      return void (await reply(
        ctx,
        `Não achei ninguém verificado como <b>${escapeHtml(target)}</b>.` +
          (ov ? `\nOverride: ${ov.type} (${escapeHtml(ov.reason ?? "")})` : ""),
      ));
    }
    const [denied, ov] = await Promise.all([
      s.repo.isTelegramDenied(member.telegramId),
      s.repo.getOverride(member.intraLogin),
    ]);
    await reply(ctx, describeMember(member, denied, ov ? `${ov.type} — ${ov.reason ?? ""}` : null));
  });

  const overrideCommand = (type: "allow" | "deny") => async (ctx: Context) => {
    const [login, ...rest] = args(ctx);
    const reason = rest.join(" ");
    if (!login || !LOGIN_RE.test(login) || !reason) {
      return void (await reply(ctx, `Uso: /${type} &lt;login&gt; &lt;motivo&gt;`));
    }
    const nowIso = s.now().toISOString();
    await s.repo.setOverride({ intraLogin: login, type, reason, addedBy: ctx.from!.id }, nowIso);
    await s.repo.audit("override", { intraLogin: login, detail: `${type}: ${reason}` }, nowIso);

    if (type === "allow") {
      return void (await reply(
        ctx,
        `✅ <b>${escapeHtml(login)}</b> na allowlist. A pessoa ainda precisa fazer login pela Intra (/start) pra provar que é ela.`,
      ));
    }
    const member = await s.repo.getMemberByLogin(login);
    let detail = "Ninguém verificado com esse login ainda; fica bloqueado se tentar.";
    if (member) {
      const removed = await removeFromChats(s, member.telegramId);
      for (const r of await s.repo.listJoinRequestsForUser(member.telegramId)) {
        await safeDecline(s.api, r.chatId, member.telegramId);
        await s.repo.deleteJoinRequest(member.telegramId, r.chatId);
      }
      await s.repo.audit(
        "removed",
        { telegramId: member.telegramId, intraLogin: login, detail: "denylist" },
        nowIso,
      );
      detail = `Removido de ${removed}/${s.config.protectedChatIds.length} chat(s).`;
    }
    await reply(ctx, `⛔ <b>${escapeHtml(login)}</b> na denylist. ${detail}`);
  };
  admin.command("allow", overrideCommand("allow"));
  admin.command("deny", overrideCommand("deny"));

  admin.command("reverificar", async (ctx) => {
    const [login] = args(ctx);
    if (!login) return void (await reply(ctx, "Uso: /reverificar &lt;login&gt;"));
    const member = await s.repo.getMemberByLogin(login);
    if (!member) return void (await reply(ctx, `Não achei <b>${escapeHtml(login)}</b>.`));
    const r = await reverifyMember(s, member);
    await reply(
      ctx,
      r.status === "PERMITIR"
        ? `✅ <b>${escapeHtml(login)}</b> continua elegível (${r.motivo}).`
        : `❌ <b>${escapeHtml(login)}</b> não é mais elegível: ${motivoAdmin[r.motivo as DenyReason]}` +
            (s.config.autoRemove
              ? " — removido dos chats."
              : " — AUTO_REMOVE desligado, nada removido."),
    );
  });

  admin.command("pendentes", async (ctx) => {
    const list = await s.repo.listJoinRequests(30);
    if (list.length === 0) return void (await reply(ctx, "Nenhum pedido pendente 🎉"));
    const titles = await s.repo.getChatTitles([...new Set(list.map((r) => r.chatId))]);
    const lines = list.map(
      (r) =>
        `• ${userLink(r.telegramId, null)} → ${escapeHtml(titles.get(r.chatId) ?? String(r.chatId))} (${fmt(r.requestedAt)})`,
    );
    const total = await s.repo.countJoinRequests();
    await reply(ctx, `⏳ <b>Pedidos pendentes (${total})</b>\n${lines.join("\n")}`);
  });

  admin.command("sincronizar", async (ctx) => {
    const ids = s.config.protectedChatIds;
    if (ids.length === 0) return void (await reply(ctx, "PROTECTED_CHAT_IDS está vazio."));
    const nowIso = s.now().toISOString();
    const lines: string[] = [];
    for (const chatId of ids) {
      try {
        const chat = await s.api.getChat(chatId);
        const title = "title" in chat && chat.title ? chat.title : String(chatId);
        await s.repo.upsertChat(chatId, title, nowIso);
        const me = await s.api.getChatMember(chatId, ctx.me.id);
        if (me.status !== "administrator") {
          lines.push(`❌ ${escapeHtml(title)} (<code>${chatId}</code>): não sou admin`);
          continue;
        }
        const missing = REQUIRED_PERMS.filter((p) => !me[p]);
        const extra = chat.type !== "supergroup" && chat.type !== "group" ? " · não é grupo" : "";
        const pub =
          "username" in chat && chat.username ? " · ⚠️ grupo público (deve ser privado)" : "";
        lines.push(
          missing.length
            ? `⚠️ ${escapeHtml(title)} (<code>${chatId}</code>): falta ${missing.join(", ")}${pub}${extra}`
            : `✅ ${escapeHtml(title)} (<code>${chatId}</code>)${pub}${extra}`,
        );
      } catch (err) {
        lines.push(
          `❌ <code>${chatId}</code>: sem acesso (${escapeHtml(String(err).slice(0, 80))})`,
        );
      }
    }
    await reply(ctx, `🔄 <b>Chats protegidos</b>\n${lines.join("\n")}`);
  });

  admin.command("nao_verificados", async (ctx) => {
    const list = (await s.repo.listUnverifiedSeen(60)).filter((u) => !isAdmin(s, u.telegramId));
    if (list.length === 0)
      return void (await reply(ctx, "Todo mundo que eu vi está verificado ✅"));
    const deadline = await s.repo.getSetting(GRANDFATHER_KEY);
    const lines = list
      .slice(0, 50)
      .map(
        (u) =>
          `• ${userLink(u.telegramId, u.telegramUsername)} — ${u.chatIds.length} chat(s), visto em ${fmt(u.firstSeenAt)}`,
      );
    await reply(
      ctx,
      `👀 <b>Vistos sem verificação</b>${deadline ? ` (prazo: ${fmt(deadline)})` : ""}\n${lines.join("\n")}` +
        (list.length > 50 ? "\n…" : ""),
    );
  });

  admin.command("avisar", async (ctx) => {
    const deadline = new Date(s.now().getTime() + s.config.grandfatherDays * 86_400_000);
    await s.repo.setSetting(GRANDFATHER_KEY, deadline.toISOString());
    let ok = 0;
    for (const chatId of s.config.protectedChatIds) {
      try {
        const sent = await s.api.sendMessage(
          chatId,
          msg.avisoGrandfather(deadline, ctx.me.username),
          {
            parse_mode: "HTML",
          },
        );
        await s.api.pinChatMessage(chatId, sent.message_id).catch(() => undefined);
        ok++;
      } catch {
        // segue para o próximo chat; o total abaixo mostra quantos falharam
      }
    }
    await reply(
      ctx,
      `📌 Aviso enviado em ${ok}/${s.config.protectedChatIds.length} chat(s). Prazo: ${fmt(deadline.toISOString())}.`,
    );
  });
}
