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

export const isProtectedChat = (s: Services, chatId: number): boolean =>
  s.config.protectedChatIds.includes(chatId);

export const isAdmin = (s: Services, userId: number | undefined): boolean =>
  userId !== undefined && s.config.adminIds.includes(userId);
