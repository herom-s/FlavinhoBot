/**
 * Cron diário: expira pedidos pendentes, revalida membros na Intra, cobra membros antigos sem
 * verificação e limpa dados velhos. Tudo com orçamento de subrequests (Workers free = 50 por invocação).
 */
import type { MemberRecord } from "../db/repository";
import { decidirAcesso, type EligibilityResult } from "../domain/eligibility";
import { GRANDFATHER_KEY } from "../handlers/commands.admin";
import { errorMessage, hashId, log } from "../logger";
import { escapeHtml, motivoAdmin, msg } from "../messages";
import { refreshChatInfo } from "../services/access";
import {
  adminIds,
  eligibilityConfig,
  isAdmin,
  protectedChatIds,
  type Services,
} from "../services/context";
import { notifyAdmins, removeFromChats, safeDecline, sendDm } from "../services/telegram";

const AUDIT_RETENTION_DAYS = 90;
const DAY = 86_400_000;

/** Contador simples de subrequests restantes. */
export class Budget {
  constructor(private remaining: number) {}
  /** Reserva `n`; se não couber, não reserva nada e retorna false. */
  take(n: number): boolean {
    if (n > this.remaining) return false;
    this.remaining -= n;
    return true;
  }
  get left(): number {
    return this.remaining;
  }
}

/** Revalida um membro com token de app. Remove dos chats se AUTO_REMOVE estiver ligado. */
export async function reverifyMember(
  s: Services,
  member: MemberRecord,
): Promise<EligibilityResult> {
  const now = s.now();
  const nowIso = now.toISOString();
  const [user, override] = await Promise.all([
    s.intra.getUser(member.intraId),
    s.repo.getOverride(member.intraLogin),
  ]);
  const result: EligibilityResult = user
    ? decidirAcesso(user, override?.type ?? null, now, eligibilityConfig(s.config))
    : override?.type === "allow"
      ? { status: "PERMITIR", motivo: "override" }
      : { status: "NEGAR", motivo: "conta_nao_encontrada" };

  if (result.status === "PERMITIR") {
    await s.repo.updateMemberCheck(member.telegramId, nowIso, result.motivo, null);
    return result;
  }

  await s.repo.updateMemberCheck(member.telegramId, nowIso, null, result.motivo);
  await s.repo.audit(
    "revoked",
    { telegramId: member.telegramId, intraLogin: member.intraLogin, detail: result.motivo },
    nowIso,
  );
  if (s.config.autoRemove && !(await isAdmin(s, member.telegramId))) {
    await sendDm(s.api, member.telegramId, msg.removido);
    await removeFromChats(s, member.telegramId);
    await s.repo.audit(
      "removed",
      { telegramId: member.telegramId, intraLogin: member.intraLogin, detail: result.motivo },
      nowIso,
    );
  }
  return result;
}

export interface DailyReport {
  expiredRequests: number;
  reverified: number;
  revoked: string[];
  unverifiedAlerted: number;
  unverifiedRemoved: number;
  chatsRefreshed: number;
  budgetLeft: number;
}

export async function runDailyJobs(s: Services, subrequestBudget = 45): Promise<DailyReport> {
  const budget = new Budget(subrequestBudget);
  const now = s.now();
  const nowIso = now.toISOString();
  const report: DailyReport = {
    expiredRequests: 0,
    reverified: 0,
    revoked: [],
    unverifiedAlerted: 0,
    unverifiedRemoved: 0,
    chatsRefreshed: 0,
    budgetLeft: 0,
  };
  const chatIdsNow = await protectedChatIds(s);
  const chatsCount = chatIdsNow.length;

  // 0. Limpeza (só D1, não gasta subrequest externo).
  await s.repo.purgeOAuthStates(nowIso);
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY).toISOString();
  for (const event of ["denied", "shared_account", "declined", "expired_request"] as const) {
    await s.repo.purgeAudit(event, cutoff);
  }

  // Reserva 1 subrequest para o resumo aos admins.
  budget.take(1);

  // 1. Pedidos pendentes expirados (5.3): recusa + DM.
  const expiredBefore = new Date(now.getTime() - s.config.joinRequestTimeoutHours * 3_600_000);
  const expired = await s.repo.listJoinRequestsBefore(expiredBefore.toISOString(), 10);
  for (const r of expired) {
    if (!budget.take(2)) break;
    await sendDm(s.api, r.telegramId, msg.pedidoExpirado);
    await safeDecline(s.api, r.chatId, r.telegramId);
    await s.repo.deleteJoinRequest(r.telegramId, r.chatId);
    await s.repo.audit(
      "expired_request",
      { telegramId: r.telegramId, detail: String(r.chatId) },
      nowIso,
    );
    report.expiredRequests++;
  }

  // 2. Revalidação na Intra.
  const staleBefore = new Date(now.getTime() - s.config.reverifyDays * DAY).toISOString();
  const members = await s.repo.listMembersToReverify(staleBefore, s.config.reverifyMaxPerRun);
  const removalCost = s.config.autoRemove ? chatsCount + 1 : 0;
  for (const member of members) {
    // Pior caso: token de app + GET /users/:id (+ retries) + remoção. Cobra só o que foi gasto.
    if (budget.left < 2 + s.intra.maxRetries + removalCost) break;
    const before = s.intra.requestCount;
    try {
      const r = await reverifyMember(s, member);
      report.reverified++;
      if (r.status === "NEGAR") {
        report.revoked.push(`${escapeHtml(member.intraLogin)} — ${motivoAdmin[r.motivo]}`);
        budget.take(removalCost);
      }
    } catch (err) {
      log.warn("reverify_failed", { tg: hashId(member.telegramId), error: errorMessage(err) });
      // Para no primeiro erro da API (ex.: 429 persistente) para não queimar o limite da Intra.
      break;
    } finally {
      budget.take(s.intra.requestCount - before);
    }
  }

  // 3. Membros antigos sem verificação após o prazo (13.12).
  const deadline = await s.repo.getSetting(GRANDFATHER_KEY);
  let unverifiedLines: string[] = [];
  if (deadline && deadline <= nowIso) {
    const admins = await adminIds(s);
    const unverified = (await s.repo.listUnverifiedSeen(200)).filter(
      (u) => !admins.includes(u.telegramId),
    );
    if (s.config.autoRemove) {
      for (const u of unverified) {
        if (!budget.take(chatsCount + 1)) break;
        await sendDm(s.api, u.telegramId, msg.removidoNaoVerificado);
        await removeFromChats(s, u.telegramId);
        await s.repo.deleteSeen(u.telegramId);
        await s.repo.audit(
          "removed",
          { telegramId: u.telegramId, detail: "nao_verificado" },
          nowIso,
        );
        report.unverifiedRemoved++;
      }
    } else {
      report.unverifiedAlerted = unverified.length;
      unverifiedLines = unverified
        .slice(0, 30)
        .map((u) =>
          u.telegramUsername
            ? `@${escapeHtml(u.telegramUsername)}`
            : `<a href="tg://user?id=${u.telegramId}">${u.telegramId}</a>`,
        );
    }
  }

  // 4. Atualiza título e descrição dos grupos com o orçamento que sobrou (o Telegram não avisa
  // quando a descrição muda). O que não couber hoje fica para amanhã.
  const toRefresh = chatIdsNow.slice(0, Math.max(0, budget.left));
  budget.take(toRefresh.length);
  report.chatsRefreshed = await refreshChatInfo(s, toRefresh);

  // 5. Resumo para os admins (só se houver algo relevante).
  const parts: string[] = [];
  if (report.revoked.length) {
    parts.push(
      `❌ <b>Deixaram de ser elegíveis</b>${s.config.autoRemove ? " (removidos)" : ""}:\n` +
        report.revoked.map((l) => `• ${l}`).join("\n"),
    );
  }
  if (report.unverifiedAlerted) {
    parts.push(
      `👀 <b>${report.unverifiedAlerted} membro(s) sem verificação após o prazo</b>:\n` +
        unverifiedLines.join(", ") +
        (report.unverifiedAlerted > unverifiedLines.length ? ", …" : "") +
        "\nVeja tudo com /nao_verificados.",
    );
  }
  if (report.unverifiedRemoved)
    parts.push(`🚪 Removidos por falta de verificação: ${report.unverifiedRemoved}`);
  if (parts.length) await notifyAdmins(s, `🗓️ <b>Revalidação diária</b>\n\n${parts.join("\n\n")}`);

  report.budgetLeft = budget.left;
  log.info("daily_jobs_done", {
    expired: report.expiredRequests,
    reverified: report.reverified,
    revoked: report.revoked.length,
    unverified_alerted: report.unverifiedAlerted,
    unverified_removed: report.unverifiedRemoved,
    budget_left: report.budgetLeft,
  });
  return report;
}
