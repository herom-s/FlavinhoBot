/**
 * Logs estruturados em JSON, sem PII: telegram_id vira um hash curto, tokens nunca entram.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined>;

/** FNV-1a 32 bits: só para correlacionar linhas de log sem expor o ID cru. */
export function hashId(id: number | string): string {
  let h = 0x811c9dc5;
  const s = `flavinho:${id}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function emit(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/** Mensagem de erro sem stack nem payloads (que podem conter tokens). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/(bot\d+:)[\w-]+/g, "$1***").slice(0, 300);
}
