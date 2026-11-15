/**
 * GET /auth/start   → valida o state e redireciona para a Intra.
 * GET /auth/callback → consome o state (uso único), troca o code, avalia e descarta o token.
 */
import { hashState, isWellFormedState } from "../auth/oauth";
import { errorMessage, log } from "../logger";
import { msg } from "../messages";
import { RateLimiter } from "../rateLimit";
import { completeVerification, usefulLinks } from "../services/access";
import type { Services } from "../services/context";
import { reportError } from "../services/telegram";
import { button, page, paragraph } from "./html";

const ipLimiter = new RateLimiter(30, 60_000);
const userLimiter = new RateLimiter(10, 60_000);

const clientIp = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, "");

const expiredPage = (s: Services) =>
  page(
    msg.paginaExpiradaTitulo,
    paragraph(stripHtml(msg.linkExpirado)) +
      button("Abrir o FlavinhoBot", `https://t.me/${s.botUsername()}?start=entrar`),
    400,
  );

export async function handleAuthStart(req: Request, s: Services): Promise<Response> {
  if (!ipLimiter.allow(`ip:${clientIp(req)}`)) {
    return page(msg.paginaErroTitulo, paragraph(msg.paginaRateLimited), 429);
  }
  const state = new URL(req.url).searchParams.get("state");
  if (!isWellFormedState(state)) return expiredPage(s);

  const record = await s.repo.peekOAuthState(await hashState(state), s.now().toISOString());
  if (!record) return expiredPage(s);
  if (!userLimiter.allow(`tg:${record.telegramId}`)) {
    return page(msg.paginaErroTitulo, paragraph(msg.paginaRateLimited), 429);
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: s.intra.authorizeUrl(state),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleAuthCallback(
  req: Request,
  s: Services,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  if (!ipLimiter.allow(`ip:${clientIp(req)}`)) {
    return page(msg.paginaErroTitulo, paragraph(msg.paginaRateLimited), 429);
  }
  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  if (!isWellFormedState(state)) return expiredPage(s);

  // Consumir antes de qualquer outra coisa: o state vale uma única vez, mesmo se o login falhar.
  const record = await s.repo.consumeOAuthState(await hashState(state), s.now().toISOString());
  if (!record) return expiredPage(s);

  if (params.get("error")) {
    return page(msg.paginaErroTitulo, paragraph(msg.paginaCancelada), 400);
  }
  const code = params.get("code");
  if (!code) return expiredPage(s);

  try {
    let token: string | null = await s.intra.exchangeCode(code);
    const user = await s.intra.getMe(token);
    token = null; // descartado: nunca persistido nem logado

    const outcome = await completeVerification(s, record, user);
    waitUntil(outcome.telegramWork().catch((err) => reportError(s, "auth_callback_telegram", err)));

    const botLink = `https://t.me/${s.botUsername()}?start=entrar`;
    if (outcome.result.status === "PERMITIR") {
      return page(
        msg.paginaSucessoTitulo,
        paragraph(msg.paginaSucesso) + button("Voltar ao Telegram", botLink),
        200,
        usefulLinks,
      );
    }
    return page(
      msg.paginaNegadaTitulo,
      paragraph(stripHtml(msg.negado(outcome.result.motivo))) +
        paragraph(msg.paginaNegada) +
        button("Voltar ao Telegram", botLink),
      403,
    );
  } catch (err) {
    log.error("auth_callback_failed", { error: errorMessage(err) });
    waitUntil(reportError(s, "auth_callback", err));
    return page(msg.paginaErroTitulo, paragraph(msg.paginaErro), 502);
  }
}
