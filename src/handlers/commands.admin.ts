import type { Bot, Context } from "grammy";
import type { MemberRecord, OverrideRecord } from "../db/repository";
import {
  avaliarElegibilidade,
  decidirAcesso,
  type AllowReason,
  type DenyReason,
  type EligibilityResult,
  type IntraUser,
} from "../domain/eligibility";
import { reverifyMember } from "../jobs/reverify";
import { escapeHtml, motivoAdmin, msg } from "../messages";
import {
  adminIds,
  eligibilityConfig,
  isAdmin,
  protectedChatIds,
  type Services,
} from "../services/context";
import { removeFromChats, safeDecline, sendDm } from "../services/telegram";
import { adminReply, adminScope } from "./adminScope";

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

/**
 * Membros por grupo: o total vem do Telegram (getChatMemberCount); "com cordão" são os que o bot
 * sabe que estão no grupo e têm verificação válida. A API não lista membros, então quem nunca
 * falou nem verificou só aparece no total.
 */
async function groupCounts(s: Services): Promise<string[]> {
  const ids = await protectedChatIds(s);
  if (ids.length === 0) return ["Nenhum grupo protegido."];
  const [titles, seen] = await Promise.all([s.repo.getChatTitles(ids), s.repo.countSeenByChat()]);
  const lines: string[] = [];
  for (const chatId of ids) {
    const title = escapeHtml(titles.get(chatId) ?? String(chatId));
    try {
      const total = Math.max(0, (await s.api.getChatMemberCount(chatId)) - 1); // sem o próprio bot
      const known = seen.get(chatId) ?? { seen: 0, verified: 0 };
      const withCord = Math.min(known.verified, total);
      lines.push(
        `• <b>${title}</b>: ${total} membros · ✅ ${withCord} com cordão · ❌ ${total - withCord} sem cordão`,
      );
    } catch {
      lines.push(`• <b>${title}</b>: não consegui contar (rode /sincronizar)`);
    }
  }
  lines.push(
    "<i>“Sem cordão” inclui quem nunca falou nem verificou; mande /avisar para chamá-los.</i>",
  );
  return lines;
}

const ALLOW_LABEL: Record<AllowReason, string> = {
  cadete_ativo: "cadete ativo",
  alumni: "alumni",
  staff: "staff",
  override: "liberação manual (/allow)",
};

const CURSUS_NAME: Record<number, string> = { 9: "C Piscine" };

const decisionText = (r: EligibilityResult): string =>
  r.status === "PERMITIR"
    ? `✅ Pode entrar: ${ALLOW_LABEL[r.motivo]}`
    : `❌ Não entra: ${motivoAdmin[r.motivo]}`;

const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/** "já passou há 37 dias" / "faltam 12 dias" / "hoje". */
function relative(iso: string, now: Date): string {
  const days = Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);
  if (days === 0) return "hoje";
  return days < 0 ? `já passou há ${-days} dias` : `faltam ${days} dias`;
}

function describeIntraUser(
  user: IntraUser,
  override: OverrideRecord | null,
  now: Date,
  s: Services,
): string {
  const cfg = eligibilityConfig(s.config);
  const result = decidirAcesso(user, override?.type ?? null, now, cfg);
  const rulesOnly = avaliarElegibilidade(user, now, cfg);
  const yes = (v: boolean | undefined, sim: string, nao: string) => (v ? sim : nao);

  const lines = [
    `🔎 <b>${escapeHtml(user.login)}</b>  <i>intra ${user.id}</i>`,
    "",
    `<b>${escapeHtml(decisionText(result))}</b>`,
  ];
  if (override) {
    lines.push(
      `<i>Sem a liberação manual: ${escapeHtml(decisionText(rulesOnly))}</i>`,
      `<i>Motivo da liberação: ${escapeHtml(override.reason ?? "—")}</i>`,
    );
  }

  const campi = (user.campus_users ?? []).map((c) => {
    const ok = !cfg.allowedCampusIds.length || cfg.allowedCampusIds.includes(c.campus_id);
    return `${c.campus_id}${c.is_primary ? " (principal)" : ""}${ok ? " ✓" : " ✗"}`;
  });
  lines.push(
    "",
    `<b>Conta</b>: ${yes(user["active?"], "ativa", "inativa")} · ${yes(user["alumni?"], "alumni", "não é alumni")} · ${yes(user["staff?"], "staff", "não é staff")}`,
    `<b>Campus</b>: ${campi.join(", ") || "—"}`,
    "",
    "📚 <b>Cursus</b>",
  );

  const cursus = [...(user.cursus_users ?? [])].sort(
    (a, b) => Number(b.cursus_id === cfg.mainCursusId) - Number(a.cursus_id === cfg.mainCursusId),
  );
  for (const c of cursus) {
    const name =
      c.cursus_id === cfg.mainCursusId
        ? "42cursus"
        : (CURSUS_NAME[c.cursus_id] ?? `Cursus ${c.cursus_id}`);
    lines.push(`<b>${name}</b>${c.grade ? ` · ${escapeHtml(c.grade)}` : ""}`);
    if (c.begin_at) lines.push(`   início ${dateOnly(c.begin_at)}`);
    if (c.end_date) lines.push(`   fim ${dateOnly(c.end_date)} (${relative(c.end_date, now)})`);
    if (c.blackholed_at) {
      const passed = Date.parse(c.blackholed_at) <= now.getTime();
      lines.push(
        `   ${passed ? "⚫" : "⏳"} blackhole ${dateOnly(c.blackholed_at)} (${relative(c.blackholed_at, now)})`,
      );
    }
  }
  if (cursus.length === 0) lines.push("nenhum");
  return lines.join("\n");
}

export function registerAdminCommands(bot: Bot, s: Services): void {
  // Admin em qualquer chat: só para descobrir IDs durante o setup.
  bot
    .filter((ctx) => isAdmin(s, ctx.from?.id))
    .command("chatid", async (ctx) => {
      await sendDm(s.api, ctx.chat.id, `chat_id: <code>${ctx.chat.id}</code>`);
    });

  // Demais comandos: admin no privado, no chat de admins ou num grupo protegido (resposta no privado).
  const admin = bot.filter(adminScope(s));
  const reply = (ctx: Context, text: string) => adminReply(s, ctx, text);

  admin.command("stats", async (ctx) => {
    const now = s.now();
    const [byStatus, pendentes, negados, naoVerificados] = await Promise.all([
      s.repo.countMembersByStatus(),
      s.repo.countJoinRequests(),
      s.repo.countAuditSince("denied", new Date(now.getTime() - 7 * 86_400_000).toISOString()),
      s.repo.listUnverifiedSeen(1000),
    ]);
    const admins = await adminIds(s);
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
        `Vistos sem verificação: ${naoVerificados.filter((u) => !admins.includes(u.telegramId)).length}`,
        "",
        "👥 <b>Por grupo</b>",
        ...(await groupCounts(s)),
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
      detail = `Removido de ${removed}/${(await protectedChatIds(s)).length} chat(s).`;
    }
    await reply(ctx, `⛔ <b>${escapeHtml(login)}</b> na denylist. ${detail}`);
  };
  admin.command("allow", overrideCommand("allow"));
  admin.command("deny", overrideCommand("deny"));

  // Diagnóstico: o que a Intra devolve para um login e o que o bot decidiria. Não grava nada.
  admin.command("intra", async (ctx) => {
    const [login] = args(ctx);
    if (!login || !LOGIN_RE.test(login))
      return void (await reply(ctx, "Uso: /intra &lt;login&gt;"));
    let user: IntraUser | null;
    try {
      user = await s.intra.getUser(login.toLowerCase());
    } catch (err) {
      return void (await reply(
        ctx,
        `Erro ao consultar a Intra: ${escapeHtml(String(err).slice(0, 120))}`,
      ));
    }
    if (!user) return void (await reply(ctx, `Não achei <b>${escapeHtml(login)}</b> na Intra.`));
    const override = await s.repo.getOverride(user.login);
    await reply(ctx, describeIntraUser(user, override, s.now(), s));
  });

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
    const ids = await protectedChatIds(s);
    if (ids.length === 0) {
      return void (await reply(ctx, "Nenhum grupo protegido ainda. Use /proteger."));
    }
    const nowIso = s.now().toISOString();
    const lines: string[] = [];
    for (const chatId of ids) {
      try {
        const chat = await s.api.getChat(chatId);
        const title = "title" in chat && chat.title ? chat.title : String(chatId);
        await s.repo.upsertChat(chatId, title, nowIso);
        await s.repo.setChatDescription(chatId, chat.description?.trim() || null, nowIso);
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
            : `✅ ${escapeHtml(title)} (<code>${chatId}</code>)${pub}${extra}${chat.description ? "" : " · sem descrição"}`,
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
    const admins = await adminIds(s);
    const list = (await s.repo.listUnverifiedSeen(60)).filter(
      (u) => !admins.includes(u.telegramId),
    );
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
    const chatIds = await protectedChatIds(s);
    for (const chatId of chatIds) {
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
      `📌 Aviso enviado em ${ok}/${chatIds.length} chat(s). Prazo: ${fmt(deadline.toISOString())}.`,
    );
  });
}
