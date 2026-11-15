/**
 * Orquestra o fluxo de acesso: iniciar verificação, concluir após o OAuth, aprovar pendências e convites.
 */
import { InlineKeyboard } from "grammy";
import links from "../../config/links.json";
import { authStartUrl, createState } from "../auth/oauth";
import type { ChatInfo, MemberRecord, OAuthStateRecord } from "../db/repository";
import {
  decidirAcesso,
  membroVerificado,
  type DenyReason,
  type EligibilityResult,
  type IntraUser,
} from "../domain/eligibility";
import { hashId, log } from "../logger";
import { escapeHtml, motivoAdmin, msg } from "../messages";
import { eligibilityConfig, protectedChatIds, type Services } from "./context";
import { notifyAdmins, safeApprove, safeDecline, sendDm } from "./telegram";

export const INVITE_TTL_MINUTES = 15;
export const CB_INVITES = "invites";

export interface UsefulLink {
  label: string;
  url: string;
}
export const usefulLinks: UsefulLink[] = links;

export function linksKeyboard(withInvites: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  usefulLinks.forEach((l, i) => {
    kb.url(l.label, l.url);
    if (i % 2 === 1) kb.row();
  });
  if (withInvites) kb.row().text(msg.botaoConvites, CB_INVITES);
  return kb;
}

/** O usuário está verificado agora (válido, dentro do prazo e fora da denylist)? */
export async function isVerified(s: Services, telegramId: number): Promise<boolean> {
  const [member, denied] = await Promise.all([
    s.repo.getMember(telegramId),
    s.repo.isTelegramDenied(telegramId),
  ]);
  return membroVerificado(member, denied, s.now(), s.config.reverifyDays);
}

/** Cria o `state` e manda o botão "Entrar com a Intra 42". */
export async function startVerification(
  s: Services,
  user: { id: number; username?: string | undefined },
  chatIds: number[],
  dmChatId: number = user.id,
): Promise<boolean> {
  const state = await createState(
    s.repo,
    { telegramId: user.id, telegramUsername: user.username ?? null, chatIds },
    s.now(),
  );
  return sendDm(s.api, dmChatId, msg.pedidoVerificacao, {
    reply_markup: new InlineKeyboard().url(
      msg.botaoEntrar,
      authStartUrl(s.config.publicBaseUrl, state),
    ),
  });
}

function pickCampus(user: IntraUser, allowed: number[]): number | null {
  const campi = user.campus_users ?? [];
  const pool = allowed.length ? campi.filter((c) => allowed.includes(c.campus_id)) : campi;
  return (pool.find((c) => c.is_primary) ?? pool[0] ?? campi[0])?.campus_id ?? null;
}

export interface VerificationOutcome {
  result: EligibilityResult;
  /** Ações no Telegram (DMs, aprovar/recusar pedidos). Podem rodar em `waitUntil`. */
  telegramWork: () => Promise<void>;
}

/** Decide e persiste o resultado do login na Intra. O token do usuário já foi descartado antes disto. */
export async function completeVerification(
  s: Services,
  state: OAuthStateRecord,
  user: IntraUser,
): Promise<VerificationOutcome> {
  const now = s.now();
  const nowIso = now.toISOString();
  const telegramId = state.telegramId;
  const override = await s.repo.getOverride(user.login);
  let result = decidirAcesso(user, override?.type ?? null, now, eligibilityConfig(s.config));

  if (result.status === "PERMITIR") {
    const owner = await s.repo.getMemberByIntraId(user.id);
    if (owner && owner.telegramId !== telegramId) {
      result = { status: "NEGAR", motivo: "conta_compartilhada" };
      await s.repo.audit(
        "shared_account",
        { telegramId, intraLogin: user.login, detail: `já ligada a ${hashId(owner.telegramId)}` },
        nowIso,
      );
    }
  }

  const protectedIds = await protectedChatIds(s);
  const pending = new Set<number>(state.chatIds.filter((id) => protectedIds.includes(id)));
  for (const r of await s.repo.listJoinRequestsForUser(telegramId)) pending.add(r.chatId);

  if (result.status === "NEGAR") {
    const motivo: DenyReason = result.motivo;
    await s.repo.audit("denied", { telegramId, intraLogin: user.login, detail: motivo }, nowIso);
    const existing = await s.repo.getMember(telegramId);
    if (existing) await s.repo.updateMemberCheck(telegramId, nowIso, null, motivo);
    log.info("verification_denied", { tg: hashId(telegramId), motivo });

    return {
      result,
      telegramWork: async () => {
        // DM antes de recusar: depois de processado, a janela de DM do join request fecha.
        await sendDm(s.api, telegramId, `${msg.negado(motivo)}`);
        for (const chatId of pending) {
          await safeDecline(s.api, chatId, telegramId);
          await s.repo.deleteJoinRequest(telegramId, chatId);
        }
        if (motivo === "conta_compartilhada") {
          await notifyAdmins(
            s,
            `🚨 Possível compartilhamento de conta: a Intra <b>${escapeHtml(user.login)}</b> ` +
              `já está ligada a outro Telegram e tentaram usá-la em <a href="tg://user?id=${telegramId}">outra conta</a>.`,
          );
        }
      },
    };
  }

  const member: MemberRecord = {
    telegramId,
    telegramUsername: state.telegramUsername,
    intraId: user.id,
    intraLogin: user.login,
    status: result.motivo,
    campusId: pickCampus(user, s.config.allowedCampusIds),
    verifiedAt: nowIso,
    lastCheckedAt: nowIso,
    consentAt: nowIso,
    revokedReason: null,
  };
  await s.repo.upsertMember(member);
  await s.repo.audit(
    "verified",
    { telegramId, intraLogin: user.login, detail: result.motivo },
    nowIso,
  );
  log.info("verification_allowed", { tg: hashId(telegramId), motivo: result.motivo });

  return {
    result,
    telegramWork: async () => {
      await sendDm(s.api, telegramId, msg.aprovado(user.login), {
        reply_markup: linksKeyboard(true),
      });
      await recordMemberships(
        s,
        telegramId,
        state.telegramUsername,
        protectedIds.filter((id) => !pending.has(id)),
      );
      for (const chatId of pending) {
        if (await safeApprove(s.api, chatId, telegramId)) {
          await s.repo.audit(
            "approved",
            { telegramId, intraLogin: user.login, detail: String(chatId) },
            s.now().toISOString(),
          );
        }
        await s.repo.deleteJoinRequest(telegramId, chatId);
      }
    },
  };
}

/**
 * Registra em quais grupos protegidos a pessoa já está (quem entrou antes do bot e verificou
 * pelo /start nunca passou por um join request). Alimenta a contagem "com cordão" do /stats.
 */
async function recordMemberships(
  s: Services,
  telegramId: number,
  username: string | null,
  chatIds: number[],
): Promise<void> {
  const nowIso = s.now().toISOString();
  for (const chatId of chatIds) {
    try {
      const m = await s.api.getChatMember(chatId, telegramId);
      const inside =
        m.status === "member" ||
        m.status === "administrator" ||
        m.status === "creator" ||
        (m.status === "restricted" && m.is_member);
      if (inside) await s.repo.markSeen(telegramId, chatId, username, nowIso);
    } catch {
      // sem acesso ao grupo: o /sincronizar mostra o problema
    }
  }
}

/** Aprova direto todos os pedidos pendentes de quem já está verificado. */
export async function approvePending(s: Services, telegramId: number): Promise<void> {
  for (const r of await s.repo.listJoinRequestsForUser(telegramId)) {
    await safeApprove(s.api, r.chatId, telegramId);
    await s.repo.deleteJoinRequest(telegramId, r.chatId);
  }
}

/** Busca título e descrição atuais de cada grupo no Telegram (1 chamada por grupo). */
export async function refreshChatInfo(s: Services, chatIds: number[]): Promise<number> {
  let refreshed = 0;
  const nowIso = s.now().toISOString();
  for (const chatId of chatIds) {
    try {
      const chat = await s.api.getChat(chatId);
      const title = "title" in chat && chat.title ? chat.title : null;
      await s.repo.upsertChat(chatId, title, nowIso);
      await s.repo.setChatDescription(chatId, chat.description?.trim() || null, nowIso);
      refreshed++;
    } catch (err) {
      log.warn("chat_refresh_failed", { chat_id: chatId, error: String(err).slice(0, 200) });
    }
  }
  return refreshed;
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Uma linha por grupo: nome em negrito e a descrição do grupo no Telegram. */
export function groupLines(
  chatIds: number[],
  info: Map<number, ChatInfo>,
  maxDescription = 3000,
): string[] {
  return chatIds.map((chatId) => {
    const chat = info.get(chatId);
    const title = escapeHtml(chat?.title ?? `Grupo ${chatId}`);
    const description = chat?.description
      ? escapeHtml(truncate(chat.description, maxDescription))
      : msg.semDescricao;
    return `• <b>${title}</b>\n${description}`;
  });
}

/** Gera um convite de uso único (15 min) para cada chat protegido e manda no privado. */
export async function sendInvites(s: Services, telegramId: number): Promise<void> {
  const chatIds = await protectedChatIds(s);
  if (chatIds.length === 0) {
    await sendDm(s.api, telegramId, msg.semChatsProtegidos);
    return;
  }
  const info = await s.repo.getChatInfo(chatIds);
  const expireDate = Math.floor(s.now().getTime() / 1000) + INVITE_TTL_MINUTES * 60;
  const kb = new InlineKeyboard();
  const created: number[] = [];
  for (const chatId of chatIds) {
    try {
      const link = await s.api.createChatInviteLink(chatId, {
        member_limit: 1,
        expire_date: expireDate,
        name: `flavinho ${hashId(telegramId)}`,
      });
      kb.url(info.get(chatId)?.title ?? `Grupo ${chatId}`, link.invite_link).row();
      created.push(chatId);
    } catch (err) {
      log.warn("invite_failed", { chat_id: chatId, error: String(err).slice(0, 200) });
    }
  }
  const failed = chatIds.length - created.length;
  if (created.length > 0) {
    // Descrições encurtadas para caber numa mensagem só (limite de 4096 caracteres).
    const lines = groupLines(created, info, 120);
    await sendDm(
      s.api,
      telegramId,
      `${msg.convites(INVITE_TTL_MINUTES)}\n\n${lines.join("\n\n")}`,
      {
        reply_markup: kb,
      },
    );
  }
  if (failed > 0) {
    await sendDm(s.api, telegramId, msg.conviteFalhou(failed));
    await notifyAdmins(
      s,
      `⚠️ Falhei ao gerar ${failed} convite(s). Roda /sincronizar pra conferir permissões.`,
    );
  }
}

export const motivoTexto = (m: DenyReason): string => motivoAdmin[m];
