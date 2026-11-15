import type { Api } from "grammy";
import type { IntraClient } from "../auth/intraClient";
import type { Config } from "../config";
import type { Repository } from "../db/repository";
import type { EligibilityConfig } from "../domain/eligibility";

/** Dependências compartilhadas por handlers, rotas HTTP e jobs (injetáveis nos testes). */
export interface Services {
  config: Config;
  repo: Repository;
  intra: IntraClient;
  api: Api;
  now: () => Date;
  /** Username do bot (sem @), conhecido depois do getMe. */
  botUsername: () => string;
}

export const eligibilityConfig = (c: Config): EligibilityConfig => ({
  allowedCampusIds: c.allowedCampusIds,
  allowStaff: c.allowStaff,
  mainCursusId: c.mainCursusId,
});

/**
 * Cache por isolate da lista efetiva (o handler de mensagens consulta a cada mensagem de grupo).
 * Uma mudança feita em outro isolate aparece aqui em até PROTECTED_CACHE_MS.
 */
const PROTECTED_CACHE_MS = 60_000;
const protectedCache = new WeakMap<Repository, { ids: number[]; expiresAt: number }>();

/** Lista efetiva: PROTECTED_CHAT_IDS (env) + protegidos pelo Telegram − desprotegidos pelo Telegram. */
export async function protectedChatIds(s: Services): Promise<number[]> {
  const cached = protectedCache.get(s.repo);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;
  const ids = new Set(s.config.protectedChatIds);
  for (const p of await s.repo.listChatProtections()) {
    if (p.protected) ids.add(p.chatId);
    else ids.delete(p.chatId);
  }
  const list = [...ids];
  protectedCache.set(s.repo, { ids: list, expiresAt: Date.now() + PROTECTED_CACHE_MS });
  return list;
}

export const invalidateProtectedChats = (s: Services): void => {
  protectedCache.delete(s.repo);
};

export const isProtectedChat = async (s: Services, chatId: number): Promise<boolean> =>
  (await protectedChatIds(s)).includes(chatId);

export const isAdmin = (s: Services, userId: number | undefined): boolean =>
  userId !== undefined && s.config.adminIds.includes(userId);
