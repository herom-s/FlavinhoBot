import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntraUser } from "../src/domain/eligibility";
import { resetHelpRateLimit } from "../src/handlers/help";
import { resetAuthRateLimits } from "../src/http/authRoutes";
import { runDailyJobs } from "../src/jobs/reverify";
import blackhole from "./fixtures/blackhole.json";
import cadete from "./fixtures/cadete.json";
import pisciner from "./fixtures/pisciner.json";
import {
  ADMIN_CHAT,
  ADMIN_ID,
  APP_TOKEN,
  BASE_URL,
  CHAT_A,
  CHAT_B,
  callbackQuery,
  groupCommand,
  Harness,
  joinRequestUpdate,
  privateCommand,
  stateFromCall,
  USER_TOKEN,
  WEBHOOK_SECRET,
} from "./helpers/harness";

const USER = 4242;
const clone = (f: unknown) => structuredClone(f) as IntraUser;

let logs: string[];
beforeEach(() => {
  resetAuthRateLimits();
  resetHelpRateLimit();
  logs = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

/** Join request → botão → /auth/start → /auth/callback. Retorna a resposta do callback. */
async function verifyViaJoinRequest(h: Harness, userId: number, chatId: number) {
  await h.update(joinRequestUpdate(userId, chatId));
  const state = stateFromCall(h.callsOf("sendMessage").at(-1));
  const start = await h.request(`${BASE_URL}/auth/start?state=${state}`);
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://api.intra.42.fr/oauth/authorize");
  expect(location.searchParams.get("state")).toBe(state);
  expect(location.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/auth/callback`);
  const callback = await h.request(`${BASE_URL}/auth/callback?code=abc&state=${state}`);
  return { state, callback };
}

describe("webhook", () => {
  it("retorna 401 sem o secret ou com secret errado", async () => {
    const h = new Harness();
    const body = JSON.stringify({ update_id: 1, ...privateCommand(USER, "/start") });
    expect((await h.request(`${BASE_URL}/webhook`, { method: "POST", body })).status).toBe(401);
    const wrong = await h.request(`${BASE_URL}/webhook`, {
      method: "POST",
      body,
      headers: { "x-telegram-bot-api-secret-token": `${WEBHOOK_SECRET}x` },
    });
    expect(wrong.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("aceita o secret certo e /health responde", async () => {
    const h = new Harness();
    expect((await h.update(privateCommand(USER, "/ajuda"))).status).toBe(200);
    expect(h.callsOf("sendMessage")).toHaveLength(1);
    expect((await h.request(`${BASE_URL}/health`)).status).toBe(200);
  });
});

describe("entrada via join request", () => {
  it("cadete ativo: DM com login, aprova após o callback e descarta o token", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await h.update(joinRequestUpdate(USER, CHAT_A));

    const dm = h.callsOf("sendMessage")[0]!;
    expect(dm.payload.chat_id).toBe(USER);
    expect(String(dm.payload.text)).toContain("elegante");
    expect(await h.repo.listJoinRequestsForUser(USER)).toHaveLength(1);

    const state = stateFromCall(dm);
    await h.request(`${BASE_URL}/auth/start?state=${state}`);
    const res = await h.request(`${BASE_URL}/auth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tudo certo");

    const member = await h.repo.getMember(USER);
    expect(member).toMatchObject({ intraLogin: "cadete", status: "cadete_ativo", campusId: 20 });
    expect(h.callsOf("approveChatJoinRequest")).toEqual([
      { method: "approveChatJoinRequest", payload: { chat_id: CHAT_A, user_id: USER } },
    ]);
    expect(await h.repo.listJoinRequestsForUser(USER)).toHaveLength(0);
    const welcome = h.callsOf("sendMessage").at(-1)!;
    expect(String(welcome.payload.text)).toContain("Agora sim");
    expect(String(welcome.payload.text)).not.toContain("elegante");

    // nenhum token no banco nem nos logs
    const dump = h.sqlite.dumpAll();
    expect(dump).not.toContain(USER_TOKEN);
    expect(dump).not.toContain(APP_TOKEN);
    expect(dump).not.toContain(state);
    expect(logs.join("\n")).not.toContain(USER_TOKEN);
    expect(logs.join("\n")).not.toContain(String(USER));
  });

  it("verificação única: segundo chat é aprovado direto, sem novo login", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    const before = h.callsOf("sendMessage").length;

    await h.update(joinRequestUpdate(USER, CHAT_B));
    expect(h.callsOf("approveChatJoinRequest").at(-1)!.payload).toEqual({
      chat_id: CHAT_B,
      user_id: USER,
    });
    const dms = h.callsOf("sendMessage").slice(before);
    expect(dms).toHaveLength(1);
    expect(String(dms[0]!.payload.text)).toContain("já te conheço");
  });

  it("pisciner é recusado com mensagem da Piscine", async () => {
    const h = new Harness();
    h.me = clone(pisciner);
    const { callback } = await verifyViaJoinRequest(h, USER, CHAT_A);
    expect(callback.status).toBe(403);
    expect(h.callsOf("declineChatJoinRequest")[0]!.payload).toEqual({
      chat_id: CHAT_A,
      user_id: USER,
    });
    expect(String(h.callsOf("sendMessage").at(-1)!.payload.text)).toContain("Piscine");
    expect(await h.repo.getMember(USER)).toBeNull();
  });

  it("blackhole vencido é recusado", async () => {
    const h = new Harness();
    h.me = clone(blackhole);
    const { callback } = await verifyViaJoinRequest(h, USER, CHAT_A);
    expect(callback.status).toBe(403);
    expect(h.callsOf("approveChatJoinRequest")).toHaveLength(0);
    expect(await h.repo.countAuditSince("denied", "2000-01-01")).toBe(1);
  });

  it("uma conta da Intra não libera dois Telegrams e avisa os admins", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    const { callback } = await verifyViaJoinRequest(h, USER + 1, CHAT_A);
    expect(callback.status).toBe(403);
    expect(await h.repo.getMember(USER + 1)).toBeNull();
    expect(h.callsOf("declineChatJoinRequest").at(-1)!.payload.user_id).toBe(USER + 1);
    const alert = h.callsOf("sendMessage").find((c) => c.payload.chat_id === ADMIN_CHAT);
    expect(String(alert?.payload.text)).toContain("compartilhamento");
  });

  it("state reutilizado é rejeitado", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    const { state } = await verifyViaJoinRequest(h, USER, CHAT_A);
    const again = await h.request(`${BASE_URL}/auth/callback?code=abc&state=${state}`);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("venceu");
    expect((await h.request(`${BASE_URL}/auth/start?state=${state}`)).status).toBe(400);
  });

  it("state expirado (>10 min) é rejeitado", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await h.update(joinRequestUpdate(USER, CHAT_A));
    const state = stateFromCall(h.callsOf("sendMessage")[0]);
    h.advance(10 * 60 * 1000 + 1);
    expect((await h.request(`${BASE_URL}/auth/start?state=${state}`)).status).toBe(400);
    expect((await h.request(`${BASE_URL}/auth/callback?code=abc&state=${state}`)).status).toBe(400);
    expect(h.intraCalls).toHaveLength(0);
  });

  it("state malformado nem chega no banco", async () => {
    const h = new Harness();
    expect((await h.request(`${BASE_URL}/auth/callback?code=x&state=' OR 1=1 --`)).status).toBe(
      400,
    );
  });

  it("aprovação idempotente: HIDE_REQUESTER_MISSING conta como sucesso", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    h.apiFailures.set("approveChatJoinRequest", {
      error_code: 400,
      description: "Bad Request: HIDE_REQUESTER_MISSING",
    });
    const res = await h.update(joinRequestUpdate(USER, CHAT_A));
    expect(res.status).toBe(200);
    expect(await h.repo.listJoinRequestsForUser(USER)).toHaveLength(0);
    expect(h.callsOf("sendMessage").some((c) => c.payload.chat_id === ADMIN_CHAT)).toBe(false);
  });

  it("denylist recusa direto", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    await h.update(privateCommand(ADMIN_ID, "/deny cadete compartilhou a conta"));
    expect(h.callsOf("unbanChatMember").map((c) => c.payload.chat_id)).toEqual([CHAT_A, CHAT_B]);

    await h.update(joinRequestUpdate(USER, CHAT_B));
    expect(h.callsOf("declineChatJoinRequest").at(-1)!.payload).toEqual({
      chat_id: CHAT_B,
      user_id: USER,
    });
  });

  it("ignora join requests de chats não protegidos", async () => {
    const h = new Harness();
    await h.update(joinRequestUpdate(USER, -999));
    expect(h.calls).toHaveLength(0);
  });
});

describe("fluxo /start", () => {
  it("verifica e depois gera convites de uso único para todos os chats", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await h.update(privateCommand(USER, "/start entrar"));
    const state = stateFromCall(h.callsOf("sendMessage").at(-1));
    expect((await h.request(`${BASE_URL}/auth/callback?code=abc&state=${state}`)).status).toBe(200);

    await h.update(callbackQuery(USER, "invites"));
    const invites = h.callsOf("createChatInviteLink");
    expect(invites.map((c) => c.payload.chat_id)).toEqual([CHAT_A, CHAT_B]);
    const expected = Math.floor(h.clock.getTime() / 1000) + 15 * 60;
    for (const c of invites) {
      expect(c.payload.member_limit).toBe(1);
      expect(c.payload.expire_date).toBe(expected);
    }
  });

  it("botão de convites exige verificação", async () => {
    const h = new Harness();
    await h.update(callbackQuery(USER, "invites"));
    expect(h.callsOf("createChatInviteLink")).toHaveLength(0);
    expect(String(h.callsOf("sendMessage")[0]!.payload.text)).toContain("elegante");
  });

  it("/apagar_dados apaga o membro e remove dos grupos", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    await h.update(privateCommand(USER, "/apagar_dados"));
    expect(await h.repo.getMember(USER)).not.toBeNull();
    await h.update(callbackQuery(USER, "apagar:sim"));
    expect(await h.repo.getMember(USER)).toBeNull();
    expect(h.callsOf("unbanChatMember")).toHaveLength(2);
    expect(h.sqlite.dumpAll()).not.toContain("cadete");
  });
});

describe("descrição dos grupos", () => {
  it("/grupos explica cada grupo com a descrição do Telegram (atualizada no /sincronizar)", async () => {
    const h = new Harness();
    await h.update(privateCommand(ADMIN_ID, "/sincronizar"));
    await h.update(privateCommand(USER, "/grupos"));
    const reply = h.callsOf("sendMessage").at(-1)!;
    const text = String(reply.payload.text);
    expect(text).toContain(`<b>Chat ${CHAT_A}</b>\nSobre o chat ${CHAT_A}`);
    expect(text).toContain(`<b>Chat ${CHAT_B}</b>\nSobre o chat ${CHAT_B}`);
    expect(text).toContain("/start");
    expect(reply.payload.reply_markup).toBeUndefined();
  });

  it("grupo sem descrição aparece como tal, e verificado ganha o botão de convites", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await verifyViaJoinRequest(h, USER, CHAT_A);
    await h.update(privateCommand(USER, "/grupos"));
    const reply = h.callsOf("sendMessage").at(-1)!;
    expect(String(reply.payload.text)).toContain("sem descrição ainda");
    expect(JSON.stringify(reply.payload.reply_markup)).toContain('"callback_data":"invites"');
  });

  it("a mensagem de convites também explica os grupos", async () => {
    const h = new Harness();
    h.me = clone(cadete);
    await h.update(privateCommand(ADMIN_ID, "/sincronizar"));
    await verifyViaJoinRequest(h, USER, CHAT_A);
    await h.update(callbackQuery(USER, "invites"));
    const invites = h.callsOf("sendMessage").at(-1)!;
    expect(String(invites.payload.text)).toContain(`Sobre o chat ${CHAT_B}`);
  });

  it("o cron atualiza as descrições com o orçamento que sobra", async () => {
    const h = new Harness();
    const report = await runDailyJobs(h.app.services);
    expect(report.chatsRefreshed).toBe(2);
    const info = await h.repo.getChatInfo([CHAT_A]);
    expect(info.get(CHAT_A)?.description).toBe(`Sobre o chat ${CHAT_A}`);
  });
});

describe("/help", () => {
  const lastText = (h: Harness) => String(h.callsOf("sendMessage").at(-1)?.payload.text ?? "");

  it("admin no privado recebe os comandos de admin", async () => {
    const h = new Harness();
    await h.update(privateCommand(ADMIN_ID, "/help"));
    expect(lastText(h)).toContain("Comandos de admin");
    expect(lastText(h)).toContain("/allow &lt;login&gt; &lt;motivo&gt;");
    expect(lastText(h)).not.toContain("/allow@");
  });

  it("admin no chat de admins recebe os comandos com o @ do bot", async () => {
    const h = new Harness();
    await h.update(groupCommand(ADMIN_ID, ADMIN_CHAT, "/help@FlavinhoBot"));
    const reply = h.callsOf("sendMessage").at(-1)!;
    expect(reply.payload.chat_id).toBe(ADMIN_CHAT);
    expect(lastText(h)).toContain("/stats@FlavinhoBot");
  });

  it("membro no privado recebe só os comandos de usuário", async () => {
    const h = new Harness();
    await h.update(privateCommand(USER, "/help"));
    expect(lastText(h)).toContain("/grupos");
    expect(lastText(h)).not.toContain("/allow");
  });

  it("no grupo protegido explica o bot, respondendo à mensagem, no máximo 1x por minuto", async () => {
    const h = new Harness();
    await h.update(groupCommand(USER, CHAT_A, "/help"));
    const reply = h.callsOf("sendMessage").at(-1)!;
    expect(reply.payload.chat_id).toBe(CHAT_A);
    expect(reply.payload.reply_parameters).toMatchObject({ message_id: 50 });
    expect(lastText(h)).toContain("porteiro");
    expect(lastText(h)).toContain("@FlavinhoBot");
    expect(lastText(h)).not.toContain("/allow");

    await h.update(groupCommand(USER + 1, CHAT_A, "/help"));
    expect(h.callsOf("sendMessage")).toHaveLength(1);
  });

  it("admin pedindo /help num grupo protegido recebe a explicação pública, não a de admin", async () => {
    const h = new Harness();
    await h.update(groupCommand(ADMIN_ID, CHAT_B, "/help"));
    expect(lastText(h)).toContain("porteiro");
    expect(lastText(h)).not.toContain("Comandos de admin");
  });

  it("ignora /help em grupos que não são da comunidade", async () => {
    const h = new Harness();
    await h.update(groupCommand(USER, -777, "/help"));
    expect(h.calls).toHaveLength(0);
  });
});

describe("comandos de admin", () => {
  it("não funcionam para não-admins", async () => {
    const h = new Harness();
    for (const cmd of [
      "/stats",
      "/allow fulano motivo",
      "/deny fulano motivo",
      "/pendentes",
      "/sincronizar",
    ]) {
      await h.update(privateCommand(USER, cmd));
    }
    expect(h.calls).toHaveLength(0);
    expect(await h.repo.getOverride("fulano")).toBeNull();
  });

  it("funcionam para admins", async () => {
    const h = new Harness();
    await h.update(privateCommand(ADMIN_ID, "/stats"));
    expect(String(h.callsOf("sendMessage")[0]!.payload.text)).toContain("Estatísticas");
    await h.update(privateCommand(ADMIN_ID, "/allow fulano caso especial"));
    expect(await h.repo.getOverride("fulano")).toMatchObject({ type: "allow", addedBy: ADMIN_ID });
  });

  it("allowlist libera pisciner aprovado pelos admins", async () => {
    const h = new Harness();
    h.me = clone(pisciner);
    await h.update(privateCommand(ADMIN_ID, "/allow pisciner monitor da piscine"));
    const { callback } = await verifyViaJoinRequest(h, USER, CHAT_A);
    expect(callback.status).toBe(200);
    expect((await h.repo.getMember(USER))?.status).toBe("override");
  });

  it("/sincronizar confere permissões em todos os chats", async () => {
    const h = new Harness();
    await h.update(privateCommand(ADMIN_ID, "/sincronizar"));
    expect(h.callsOf("getChatMember")).toHaveLength(2);
    const text = String(h.callsOf("sendMessage").at(-1)!.payload.text);
    expect(text.match(/✅/g)).toHaveLength(2);
  });
});

describe("cron diário", () => {
  async function seedMember(h: Harness, user: IntraUser, telegramId: number, checkedAt: string) {
    await h.repo.upsertMember({
      telegramId,
      telegramUsername: null,
      intraId: user.id,
      intraLogin: user.login,
      status: "cadete_ativo",
      campusId: 20,
      verifiedAt: checkedAt,
      lastCheckedAt: checkedAt,
      consentAt: checkedAt,
      revokedReason: null,
    });
    h.intraUsers.set(user.id, user);
  }

  it("revoga quem caiu no blackhole e avisa os admins (AUTO_REMOVE=false)", async () => {
    const h = new Harness();
    await seedMember(h, clone(blackhole), USER, "2026-09-01T00:00:00.000Z");
    await seedMember(h, clone(cadete), USER + 1, "2026-09-01T00:00:00.000Z");
    await runDailyJobs(h.app.services);

    expect((await h.repo.getMember(USER))?.revokedReason).toBe("blackhole");
    expect((await h.repo.getMember(USER + 1))?.revokedReason).toBeNull();
    expect((await h.repo.getMember(USER + 1))?.lastCheckedAt).toBe(h.clock.toISOString());
    expect(h.callsOf("unbanChatMember")).toHaveLength(0);
    const alert = h.callsOf("sendMessage").find((c) => c.payload.chat_id === ADMIN_CHAT);
    expect(String(alert?.payload.text)).toContain("blackhole");

    // revogado não é aprovado direto
    await h.update(joinRequestUpdate(USER, CHAT_A));
    expect(h.callsOf("approveChatJoinRequest")).toHaveLength(0);
  });

  it("remove sem banir quando AUTO_REMOVE=true", async () => {
    const h = new Harness({ AUTO_REMOVE: "true" });
    await seedMember(h, clone(blackhole), USER, "2026-09-01T00:00:00.000Z");
    await runDailyJobs(h.app.services);
    expect(h.callsOf("unbanChatMember").map((c) => c.payload)).toEqual([
      { chat_id: CHAT_A, user_id: USER },
      { chat_id: CHAT_B, user_id: USER },
    ]);
    expect(h.callsOf("banChatMember")).toHaveLength(0);
  });

  it("respeita o orçamento de subrequests e o máximo por execução", async () => {
    const h = new Harness({ REVERIFY_MAX_PER_RUN: "100" });
    for (let i = 0; i < 100; i++) {
      await seedMember(
        h,
        { ...clone(cadete), id: 1000 + i, login: `c${i}` },
        10_000 + i,
        "2026-01-01T00:00:00.000Z",
      );
    }
    const report = await runDailyJobs(h.app.services, 45);
    expect(h.intraCalls.length).toBeLessThanOrEqual(45);
    expect(report.reverified).toBeGreaterThan(30);
    expect(report.reverified).toBeLessThan(100);
  });

  it("faz retry com backoff em 429", async () => {
    const h = new Harness();
    await seedMember(h, clone(cadete), USER, "2026-09-01T00:00:00.000Z");
    // token ok, depois 429 com Retry-After; a próxima tentativa cai no mock normal (200)
    h.intraQueue.push(
      new Response(JSON.stringify({ access_token: APP_TOKEN, expires_in: 7200 }), { status: 200 }),
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    );
    const report = await runDailyJobs(h.app.services);
    expect(report.reverified).toBe(1);
    expect(h.sleeps).toContain(2000);
    expect((await h.repo.getMember(USER))?.revokedReason).toBeNull();
  });

  it("recusa pedidos pendentes expirados", async () => {
    const h = new Harness();
    await h.update(joinRequestUpdate(USER, CHAT_A));
    h.advance(25 * 3_600_000);
    await runDailyJobs(h.app.services);
    expect(h.callsOf("declineChatJoinRequest")[0]!.payload).toEqual({
      chat_id: CHAT_A,
      user_id: USER,
    });
    expect(await h.repo.countJoinRequests()).toBe(0);
  });

  it("apaga registros de negados com mais de 90 dias", async () => {
    const h = new Harness();
    await h.repo.audit(
      "denied",
      { telegramId: 1, detail: "blackhole" },
      "2026-07-01T00:00:00.000Z",
    );
    await h.repo.audit(
      "denied",
      { telegramId: 2, detail: "blackhole" },
      "2026-11-01T00:00:00.000Z",
    );
    await runDailyJobs(h.app.services);
    expect(await h.repo.countAuditSince("denied", "2000-01-01")).toBe(1);
  });
});
