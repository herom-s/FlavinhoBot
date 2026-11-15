import type { Update } from "grammy/types";
import { createApp, type App } from "./bot";
import { ConfigError, parseConfig, type Env } from "./config";
import { D1Repository } from "./db/d1Repository";
import { handleAuthCallback, handleAuthStart } from "./http/authRoutes";
import { runDailyJobs } from "./jobs/reverify";
import { errorMessage, log } from "./logger";
import { protectedChatIds } from "./services/context";
import { reportError } from "./services/telegram";

/** Comparação em tempo constante para o secret do webhook. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

type WaitUntil = (p: Promise<unknown>) => void;

/** Roteamento HTTP, separado do `export default` para ser testável com um App injetado. */
export async function handleRequest(
  req: Request,
  app: App,
  waitUntil: WaitUntil,
): Promise<Response> {
  const { pathname } = new URL(req.url);
  const s = app.services;

  if (pathname === "/health" && req.method === "GET") {
    const chats = (await protectedChatIds(s)).length;
    return json({ ok: true, bot: s.botUsername(), chats });
  }

  if (pathname === "/webhook") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(secret, s.config.webhookSecret)) return json({ error: "unauthorized" }, 401);
    let update: Update;
    try {
      update = (await req.json()) as Update;
    } catch {
      return json({ error: "bad request" }, 400);
    }
    // Responde já; o processamento continua em background (Telegram espera resposta rápida).
    waitUntil(
      (async () => {
        await app.bot.init();
        await app.bot.handleUpdate(update);
      })().catch((err) => reportError(s, "webhook", err)),
    );
    return json({ ok: true });
  }

  if (req.method === "GET" && pathname === "/auth/start") {
    await app.bot.init().catch(() => undefined);
    return handleAuthStart(req, s);
  }
  if (req.method === "GET" && pathname === "/auth/callback") {
    await app.bot.init().catch(() => undefined);
    return handleAuthCallback(req, s, waitUntil);
  }

  return json({ error: "not found" }, 404);
}

let cached: { token: string; db: D1Database; app: App } | null = null;

/** Um App por isolate: reaproveita getMe, token de app da Intra e caches em memória. */
function getApp(env: Env): App {
  if (cached && cached.token === env.TELEGRAM_BOT_TOKEN && cached.db === env.DB) return cached.app;
  const config = parseConfig(env);
  const app = createApp({ config, repo: new D1Repository(env.DB) });
  cached = { token: env.TELEGRAM_BOT_TOKEN, db: env.DB, app };
  return app;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let app: App;
    try {
      app = getApp(env);
    } catch (err) {
      log.error("config_invalid", {
        error: err instanceof ConfigError ? err.message : errorMessage(err),
      });
      return json({ ok: false, error: "configuração inválida — veja os logs do Worker" }, 500);
    }
    try {
      return await handleRequest(req, app, (p) => ctx.waitUntil(p));
    } catch (err) {
      ctx.waitUntil(reportError(app.services, "fetch", err));
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const app = getApp(env);
    try {
      await runDailyJobs(app.services);
    } catch (err) {
      await reportError(app.services, "cron", err);
    }
  },
} satisfies ExportedHandler<Env>;
