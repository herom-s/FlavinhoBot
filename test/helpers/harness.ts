import type { UserFromGetMe } from "grammy/types";
import { IntraClient } from "../../src/auth/intraClient";
import { createApp, type App } from "../../src/bot";
import { parseConfig, type Config, type Env } from "../../src/config";
import { D1Repository } from "../../src/db/d1Repository";
import type { IntraUser } from "../../src/domain/eligibility";
import { handleRequest } from "../../src/index";
import { SqliteD1 } from "./sqliteD1";

export const BOT_TOKEN = "123456:TEST-token_abc";
export const WEBHOOK_SECRET = "webhook-secret-123456";
export const USER_TOKEN = "intra-user-token-SUPER-SECRET";
export const APP_TOKEN = "intra-app-token-SUPER-SECRET";
export const ADMIN_ID = 1;
export const ADMIN_CHAT = -100500;
export const CHAT_A = -1001;
export const CHAT_B = -1002;
export const BASE_URL = "https://flavinho.test";

export const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Flavinho",
  username: "FlavinhoBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export const baseEnv: Partial<Record<keyof Env, string>> = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  INTRA_CLIENT_ID: "uid",
  INTRA_CLIENT_SECRET: "intra-client-secret",
  PUBLIC_BASE_URL: BASE_URL,
  PROTECTED_CHAT_IDS: `${CHAT_A},${CHAT_B}`,
  ADMIN_CHAT_ID: String(ADMIN_CHAT),
  ADMIN_IDS: String(ADMIN_ID),
  ALLOWED_CAMPUS_IDS: "20",
  ALLOW_STAFF: "true",
};

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

type ApiFailure = { error_code: number; description: string };

export class Harness {
  readonly sqlite = new SqliteD1();
  readonly repo = new D1Repository(this.sqlite.asD1());
  readonly calls: ApiCall[] = [];
  readonly intraCalls: string[] = [];
  readonly sleeps: number[] = [];
  /** Usuário retornado por GET /v2/me. */
  me: IntraUser | null = null;
  /** Usuários retornados por GET /v2/users/:id. */
  readonly intraUsers = new Map<number, IntraUser>();
  /** Respostas forçadas para a Intra (ex.: 429), consumidas em ordem. */
  readonly intraQueue: Response[] = [];
  /** Falhas forçadas por método da Bot API. */
  readonly apiFailures = new Map<string, ApiFailure>();
  clock = new Date("2026-11-15T12:00:00.000Z");
  readonly config: Config;
  readonly app: App;
  private messageId = 1;

  constructor(envOverrides: Partial<Record<keyof Env, string>> = {}) {
    this.config = parseConfig({ ...baseEnv, ...envOverrides });
    const intra = new IntraClient({
      baseUrl: this.config.intraApiBaseUrl,
      clientId: this.config.intraClientId,
      clientSecret: this.config.intraClientSecret,
      redirectUri: `${BASE_URL}/auth/callback`,
      minIntervalMs: 0,
      sleep: async (ms) => void this.sleeps.push(ms),
      fetchFn: async (input, init) => this.intraFetch(String(input), init),
    });
    this.app = createApp({
      config: this.config,
      repo: this.repo,
      intra,
      botInfo,
      now: () => this.clock,
      configureApi: (api) =>
        api.config.use(async (_prev, method, payload) => {
          const p = (payload ?? {}) as Record<string, unknown>;
          this.calls.push({ method, payload: p });
          const fail = this.apiFailures.get(method);
          if (fail) return { ok: false, ...fail } as never;
          return { ok: true, result: this.fakeResult(method, p) } as never;
        }),
    });
  }

  private intraFetch(url: string, init?: RequestInit): Response {
    this.intraCalls.push(url);
    const queued = this.intraQueue.shift();
    if (queued) return queued;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const path = new URL(url).pathname;
    if (path === "/oauth/token") {
      const isApp = String(init?.body ?? "").includes("grant_type=client_credentials");
      return json({ access_token: isApp ? APP_TOKEN : USER_TOKEN, expires_in: 7200 });
    }
    if (path === "/v2/me") return this.me ? json(this.me) : json({}, 401);
    const m = path.match(/^\/v2\/users\/(\d+)$/);
    if (m) {
      const u = this.intraUsers.get(Number(m[1]));
      return u ? json(u) : json({}, 404);
    }
    return json({}, 404);
  }

  private fakeResult(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "sendMessage":
        return {
          message_id: this.messageId++,
          date: 0,
          chat: { id: p.chat_id, type: "private", first_name: "x" },
          text: p.text,
        };
      case "createChatInviteLink":
        return {
          invite_link: `https://t.me/+invite${this.messageId++}`,
          creator: botInfo,
          creates_join_request: false,
          is_primary: false,
          is_revoked: false,
          member_limit: p.member_limit,
          expire_date: p.expire_date,
        };
      case "getChat":
        return {
          id: p.chat_id,
          type: "supergroup",
          title: `Chat ${p.chat_id}`,
          description: `Sobre o chat ${p.chat_id}`,
          accent_color_id: 0,
          max_reaction_count: 0,
          accepted_gift_types: {},
        };
      case "getChatMember":
        return {
          status: "administrator",
          user: botInfo,
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: true,
          can_manage_video_chats: true,
          can_restrict_members: true,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: true,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
        };
      default:
        return true;
    }
  }

  callsOf(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Processa um update como o webhook faria e espera todo o trabalho em background. */
  async update(update: Record<string, unknown>): Promise<Response> {
    return this.request(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ update_id: this.messageId++, ...update }),
    });
  }

  async request(url: string, init?: RequestInit): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const res = await handleRequest(new Request(url, init), this.app, (p) => pending.push(p));
    await Promise.all(pending);
    return res;
  }

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }
}

// ---------- fábricas de updates ----------

export const tgUser = (id: number, username?: string) => ({
  id,
  is_bot: false,
  first_name: `User${id}`,
  ...(username ? { username } : {}),
});

export const joinRequestUpdate = (userId: number, chatId: number) => ({
  chat_join_request: {
    chat: { id: chatId, type: "supergroup", title: `Chat ${chatId}` },
    from: tgUser(userId, `user${userId}`),
    user_chat_id: userId,
    date: 0,
  },
});

export const privateCommand = (userId: number, text: string) => {
  const cmd = text.split(" ")[0]!;
  return {
    message: {
      message_id: 1,
      date: 0,
      chat: { id: userId, type: "private", first_name: "x" },
      from: tgUser(userId, `user${userId}`),
      text,
      entities: [{ type: "bot_command", offset: 0, length: cmd.length }],
    },
  };
};

export const groupCommand = (userId: number, chatId: number, text: string) => {
  const cmd = text.split(" ")[0]!;
  return {
    message: {
      message_id: 50,
      date: 0,
      chat: { id: chatId, type: "supergroup", title: `Chat ${chatId}` },
      from: tgUser(userId, `user${userId}`),
      text,
      entities: [{ type: "bot_command", offset: 0, length: cmd.length }],
    },
  };
};

/** O bot virou admin (ou deixou de ser) num grupo. */
export const botPromoted = (chatId: number, title: string, promoted = true) => {
  const member = { user: botInfo, status: "member" };
  const admin = {
    user: botInfo,
    status: "administrator",
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: true,
    can_restrict_members: true,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
  };
  return {
    my_chat_member: {
      chat: { id: chatId, type: "supergroup", title },
      from: tgUser(ADMIN_ID),
      date: 0,
      old_chat_member: promoted ? member : admin,
      new_chat_member: promoted ? admin : member,
    },
  };
};

export const callbackQuery = (userId: number, data: string) => ({
  callback_query: {
    id: "cb1",
    from: tgUser(userId),
    chat_instance: "ci",
    data,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: userId, type: "private", first_name: "x" },
      text: "x",
    },
  },
});

/** Extrai o `state` do botão "Entrar com a Intra" de um sendMessage. */
export function stateFromCall(call: ApiCall | undefined): string {
  const markup = call?.payload.reply_markup as
    { inline_keyboard: { url?: string }[][] } | undefined;
  const url = markup?.inline_keyboard.flat().find((b) => b.url?.includes("/auth/start"))?.url;
  if (!url) throw new Error("botão de login não encontrado");
  return new URL(url).searchParams.get("state")!;
}
