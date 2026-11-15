/**
 * Cliente da API da 42 com espaçamento entre chamadas e retry com backoff em 429/5xx.
 * Limite padrão de um app na Intra: 2 req/s e 1200 req/h — por isso o intervalo mínimo de 600 ms.
 */
import type { IntraUser } from "../domain/eligibility";

export class IntraError extends Error {
  override name = "IntraError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface IntraClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export class IntraClient {
  /** Quantidade de requisições HTTP feitas (para respeitar o limite de subrequests do Worker). */
  requestCount = 0;
  private lastRequestAt = 0;
  private appToken: { token: string; expiresAt: number } | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  readonly maxRetries: number;

  constructor(private readonly opts: IntraClientOptions) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.minIntervalMs = opts.minIntervalMs ?? 600;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  authorizeUrl(state: string): string {
    const u = new URL(`${this.opts.baseUrl}/oauth/authorize`);
    u.searchParams.set("client_id", this.opts.clientId);
    u.searchParams.set("redirect_uri", this.opts.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "public");
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** Troca o `code` por um token do usuário. O token NÃO deve ser persistido. */
  async exchangeCode(code: string): Promise<string> {
    const res = await this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.redirectUri,
    });
    return res.access_token;
  }

  async getMe(userToken: string): Promise<IntraUser> {
    const res = await this.request("/v2/me", userToken);
    if (!res.ok) throw new IntraError(`GET /v2/me falhou`, res.status);
    return (await res.json()) as IntraUser;
  }

  /** Usa token de app (client_credentials). Retorna `null` se o usuário não existe. */
  async getUser(idOrLogin: number | string): Promise<IntraUser | null> {
    const key = encodeURIComponent(String(idOrLogin));
    const res = await this.request(`/v2/users/${key}`, await this.getAppToken());
    if (res.status === 404) return null;
    if (!res.ok) throw new IntraError(`GET /v2/users/:id falhou`, res.status);
    return (await res.json()) as IntraUser;
  }

  private async getAppToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > Date.now() + 60_000) return this.appToken.token;
    const res = await this.token({ grant_type: "client_credentials", scope: "public" });
    this.appToken = {
      token: res.access_token,
      expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
    };
    return res.access_token;
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({
      ...params,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const res = await this.send(`${this.opts.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok)
      throw new IntraError(`POST /oauth/token falhou (${params.grant_type})`, res.status);
    const json = (await res.json()) as Partial<TokenResponse>;
    if (typeof json.access_token !== "string") throw new IntraError("token ausente", res.status);
    return json as TokenResponse;
  }

  private request(path: string, bearer: string): Promise<Response> {
    return this.send(`${this.opts.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      this.requestCount++;

      const res = await this.fetchFn(url, init);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) return res;

      const retryAfter = Number(res.headers.get("retry-after"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 30) * 1000
          : 1000 * 2 ** attempt;
      await res.body?.cancel();
      await this.sleep(delay);
    }
  }
}
