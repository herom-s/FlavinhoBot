/**
 * `state` do OAuth: 32 bytes aleatórios, TTL de 10 min, uso único. No banco fica só o SHA-256.
 */
import type { OAuthStateRecord, Repository } from "../db/repository";

export const STATE_TTL_MS = 10 * 60 * 1000;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function generateState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return toBase64Url(new Uint8Array(digest));
}

/** Formato aceito para o state recebido de fora (evita lixo/injeção antes de tocar no banco). */
export const isWellFormedState = (s: string | null): s is string =>
  s !== null && /^[A-Za-z0-9_-]{43}$/.test(s);

export async function createState(
  repo: Repository,
  data: { telegramId: number; telegramUsername: string | null; chatIds: number[] },
  now: Date,
): Promise<string> {
  const state = generateState();
  const record: OAuthStateRecord = {
    ...data,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  };
  await repo.saveOAuthState(await hashState(state), record);
  return state;
}

export const authStartUrl = (publicBaseUrl: string, state: string): string =>
  `${publicBaseUrl}/auth/start?state=${encodeURIComponent(state)}`;

export const redirectUri = (publicBaseUrl: string): string => `${publicBaseUrl}/auth/callback`;
