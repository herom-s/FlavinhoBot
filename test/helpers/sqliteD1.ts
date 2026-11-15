/**
 * Adaptador mínimo da API do D1 sobre `node:sqlite`, para testar o D1Repository e as migrations reais.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params as SQLInputValue[]);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: this.db.prepare(this.sql).all(...this.params) as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }
}

export class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    const dir = join(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      this.db.exec(readFileSync(join(dir, file), "utf8"));
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }

  async batch(stmts: Statement[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Despeja todas as tabelas como texto (para garantir que nenhum token foi salvo). */
  dumpAll(): string {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    return tables
      .map((t) => JSON.stringify(this.db.prepare(`SELECT * FROM "${t.name}"`).all()))
      .join("\n");
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
