import { z } from "zod";

/** Bindings e variáveis do Worker (wrangler.toml + secrets). */
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTRA_CLIENT_ID: string;
  INTRA_CLIENT_SECRET: string;
  PUBLIC_BASE_URL: string;
  PROTECTED_CHAT_IDS: string;
  ADMIN_CHAT_ID: string;
  ADMIN_IDS: string;
  ALLOWED_CAMPUS_IDS?: string;
  ALLOW_STAFF?: string;
  REVERIFY_DAYS?: string;
  AUTO_REMOVE?: string;
  JOIN_REQUEST_TIMEOUT_HOURS?: string;
  GRANDFATHER_DAYS?: string;
  INTRA_API_BASE_URL?: string;
  INTRA_MAIN_CURSUS_ID?: string;
  REVERIFY_MAX_PER_RUN?: string;
}

const intList = (name: string) =>
  z
    .string()
    .default("")
    .transform((s, ctx) => {
      const parts = s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const nums = parts.map(Number);
      if (nums.some((n) => !Number.isSafeInteger(n))) {
        ctx.addIssue({ code: "custom", message: `${name} deve ser uma lista de inteiros` });
        return z.NEVER;
      }
      return nums;
    });

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const posInt = (def: number) =>
  z
    .string()
    .default(String(def))
    .transform((v) => (v.trim() === "" ? def : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, "token do @BotFather inválido"),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, "use 16-256 caracteres [A-Za-z0-9_-]"),
  INTRA_CLIENT_ID: z.string().min(1),
  INTRA_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z
    .url()
    .refine((u) => u.startsWith("https://") || u.startsWith("http://localhost"), "use https")
    .transform((u) => u.replace(/\/+$/, "")),
  PROTECTED_CHAT_IDS: intList("PROTECTED_CHAT_IDS"),
  ADMIN_CHAT_ID: z
    .string()
    .trim()
    .regex(/^-?\d+$/, "ADMIN_CHAT_ID inválido")
    .transform(Number),
  ADMIN_IDS: intList("ADMIN_IDS").refine((l) => l.length > 0, "informe pelo menos um admin"),
  ALLOWED_CAMPUS_IDS: intList("ALLOWED_CAMPUS_IDS"),
  ALLOW_STAFF: bool,
  REVERIFY_DAYS: posInt(30),
  AUTO_REMOVE: bool,
  JOIN_REQUEST_TIMEOUT_HOURS: posInt(24),
  GRANDFATHER_DAYS: posInt(14),
  INTRA_API_BASE_URL: z
    .url()
    .default("https://api.intra.42.fr")
    .transform((u) => u.replace(/\/+$/, "")),
  INTRA_MAIN_CURSUS_ID: posInt(21),
  REVERIFY_MAX_PER_RUN: posInt(30),
});

export interface Config {
  telegramBotToken: string;
  webhookSecret: string;
  intraClientId: string;
  intraClientSecret: string;
  publicBaseUrl: string;
  protectedChatIds: number[];
  adminChatId: number;
  adminIds: number[];
  allowedCampusIds: number[];
  allowStaff: boolean;
  reverifyDays: number;
  autoRemove: boolean;
  joinRequestTimeoutHours: number;
  grandfatherDays: number;
  intraApiBaseUrl: string;
  mainCursusId: number;
  reverifyMaxPerRun: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(env: Partial<Record<keyof Env, unknown>>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const detalhes = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Configuração inválida:\n${detalhes}`);
  }
  const e = result.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
    intraClientId: e.INTRA_CLIENT_ID,
    intraClientSecret: e.INTRA_CLIENT_SECRET,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    protectedChatIds: e.PROTECTED_CHAT_IDS,
    adminChatId: e.ADMIN_CHAT_ID,
    adminIds: e.ADMIN_IDS,
    allowedCampusIds: e.ALLOWED_CAMPUS_IDS,
    allowStaff: e.ALLOW_STAFF,
    reverifyDays: e.REVERIFY_DAYS,
    autoRemove: e.AUTO_REMOVE,
    joinRequestTimeoutHours: e.JOIN_REQUEST_TIMEOUT_HOURS,
    grandfatherDays: e.GRANDFATHER_DAYS,
    intraApiBaseUrl: e.INTRA_API_BASE_URL,
    mainCursusId: e.INTRA_MAIN_CURSUS_ID,
    reverifyMaxPerRun: e.REVERIFY_MAX_PER_RUN,
  };
}
