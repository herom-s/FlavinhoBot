/**
 * Chamadas ao Telegram que precisam ser idempotentes ou tolerantes a falha.
 */
import { GrammyError, type Api } from "grammy";
import { errorMessage, hashId, log } from "../logger";
import { protectedChatIds, type Services } from "./context";

type SendOptions = Parameters<Api["sendMessage"]>[2];

/** Erros que significam "já está resolvido": o Telegram pode reenviar updates. */
const ALREADY_DONE =
  /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|already a participant|REQUEST_ALREADY_HANDLED/i;

async function joinRequestAction(
  action: "approve" | "decline",
  api: Api,
  chatId: number,
  userId: number,
): Promise<boolean> {
  try {
    if (action === "approve") await api.approveChatJoinRequest(chatId, userId);
    else await api.declineChatJoinRequest(chatId, userId);
    return true;
  } catch (err) {
    if (err instanceof GrammyError && ALREADY_DONE.test(err.description)) return true;
    log.warn(`join_request_${action}_failed`, {
      chat_id: chatId,
      tg: hashId(userId),
      error: errorMessage(err),
    });
    return false;
  }
}

export const safeApprove = (api: Api, chatId: number, userId: number) =>
  joinRequestAction("approve", api, chatId, userId);

export const safeDecline = (api: Api, chatId: number, userId: number) =>
  joinRequestAction("decline", api, chatId, userId);

/** DM que não derruba o fluxo se o usuário bloqueou o bot ou nunca deu /start. */
export async function sendDm(
  api: Api,
  chatId: number,
  text: string,
  options: SendOptions = {},
): Promise<boolean> {
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...options,
    });
    return true;
  } catch (err) {
    log.info("dm_failed", { tg: hashId(chatId), error: errorMessage(err) });
    return false;
  }
}

/** Remove (sem banir) de todos os chats protegidos. `unbanChatMember` sem `only_if_banned` expulsa membros atuais. */
export async function removeFromChats(s: Services, userId: number): Promise<number> {
  let removed = 0;
  for (const chatId of await protectedChatIds(s)) {
    try {
      await s.api.unbanChatMember(chatId, userId);
      removed++;
    } catch (err) {
      log.warn("remove_failed", { chat_id: chatId, tg: hashId(userId), error: errorMessage(err) });
    }
  }
  return removed;
}

export async function notifyAdmins(s: Services, text: string): Promise<void> {
  await sendDm(s.api, s.config.adminChatId, text);
}

const lastErrorReport = new Map<string, number>();
const ERROR_THROTTLE_MS = 10 * 60 * 1000;

/** Avisa os admins sobre erro inesperado, no máximo 1x a cada 10 min por origem. */
export async function reportError(s: Services, where: string, err: unknown): Promise<void> {
  const message = errorMessage(err);
  log.error("unexpected_error", { where, error: message });
  const now = Date.now();
  if ((lastErrorReport.get(where) ?? 0) + ERROR_THROTTLE_MS > now) return;
  lastErrorReport.set(where, now);
  await sendDm(
    s.api,
    s.config.adminChatId,
    `⚠️ Erro inesperado em <code>${where}</code>:\n<code>${message.replace(/[<>&]/g, "")}</code>`,
  );
}
