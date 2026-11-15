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
 * Cache por isolate das listas efetivas (consultadas a cada mensagem de grupo e a cada comando).
 * Uma mudança feita em outro isolate aparece aqui em até LIST_CACHE_MS.
 */
const LIST_CACHE_MS = 60_000;
type Cached = { ids: number[]; expiresAt: number };
const protectedCache = new WeakMap<Repository, Cached>();
const adminCache = new WeakMap<Repository, Cached>();

async function cachedList(
  s: Services,
  cache: WeakMap<Repository, Cached>,
  load: () => Promise<number[]>,
): Promise<number[]> {
  const hit = cache.get(s.repo);
  if (hit && hit.expiresAt > Date.now()) return hit.ids;
  const ids = await load();
  cache.set(s.repo, { ids, expiresAt: Date.now() + LIST_CACHE_MS });
  return ids;
}

/** Grupos protegidos: PROTECTED_CHAT_IDS (env) + protegidos pelo Telegram − desprotegidos pelo Telegram. */
export const protectedChatIds = (s: Services): Promise<number[]> =>
  cachedList(s, protectedCache, async () => {
    const ids = new Set(s.config.protectedChatIds);
    for (const p of await s.repo.listChatProtections()) {
      if (p.protected) ids.add(p.chatId);
      else ids.delete(p.chatId);
    }
    return [...ids];
  });

export const invalidateProtectedChats = (s: Services): void => {
  protectedCache.delete(s.repo);
};

export const isProtectedChat = async (s: Services, chatId: number): Promise<boolean> =>
  (await protectedChatIds(s)).includes(chatId);

/** Donos: ADMIN_IDS do env. Sempre admins, não podem ser removidos pelo Telegram. */
export const isOwner = (s: Services, userId: number | undefined): boolean =>
  userId !== undefined && s.config.adminIds.includes(userId);

/** Admins: donos (env) + adicionados pelo Telegram que continuam ativos. */
export const adminIds = (s: Services): Promise<number[]> =>
  cachedList(s, adminCache, async () => {
    const ids = new Set(s.config.adminIds);
    for (const a of await s.repo.listBotAdmins()) if (a.active) ids.add(a.telegramId);
    return [...ids];
  });

export const invalidateAdmins = (s: Services): void => {
  adminCache.delete(s.repo);
};

export const isAdmin = async (s: Services, userId: number | undefined): Promise<boolean> =>
  userId !== undefined && (await adminIds(s)).includes(userId);
