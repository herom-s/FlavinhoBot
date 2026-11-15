import { Bot, type Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { IntraClient } from "./auth/intraClient";
import { redirectUri } from "./auth/oauth";
import type { Config } from "./config";
import type { Repository } from "./db/repository";
import { registerAdminCommands } from "./handlers/commands.admin";
import { registerUserCommands } from "./handlers/commands.user";
import { registerChatMember } from "./handlers/chatMember";
import { registerHelp } from "./handlers/help";
import { registerJoinRequest } from "./handlers/joinRequest";
import { registerProtection } from "./handlers/protection";
import type { Services } from "./services/context";
import { reportError } from "./services/telegram";

export interface AppOptions {
  config: Config;
  repo: Repository;
  intra?: IntraClient;
  botInfo?: UserFromGetMe;
  now?: () => Date;
  /** Hook para testes interceptarem chamadas à Bot API. */
  configureApi?: (api: Api) => void;
}

export interface App {
  bot: Bot;
  services: Services;
}

export function createApp(opts: AppOptions): App {
  const { config } = opts;
  const bot = new Bot(config.telegramBotToken, opts.botInfo ? { botInfo: opts.botInfo } : {});
  opts.configureApi?.(bot.api);

  const intra =
    opts.intra ??
    new IntraClient({
      baseUrl: config.intraApiBaseUrl,
      clientId: config.intraClientId,
      clientSecret: config.intraClientSecret,
      redirectUri: redirectUri(config.publicBaseUrl),
    });

  const services: Services = {
    config,
    repo: opts.repo,
    intra,
    api: bot.api,
    now: opts.now ?? (() => new Date()),
    botUsername: () => (bot.isInited() ? bot.botInfo.username : "FlavinhoBot"),
  };

  registerChatMember(bot, services); // primeiro: só observa e chama next()
  registerJoinRequest(bot, services);
  registerHelp(bot, services);
  registerProtection(bot, services);
  registerAdminCommands(bot, services);
  registerUserCommands(bot, services);

  bot.catch(async (err) => {
    await reportError(
      services,
      `update:${Object.keys(err.ctx.update).find((k) => k !== "update_id")}`,
      err.error,
    );
  });

  return { bot, services };
}
