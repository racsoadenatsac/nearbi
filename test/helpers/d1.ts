// Minimal D1Database stand-in backed by node:sqlite, so tests run the real SQL migrations
// without miniflare. Covers the subset of the D1 API this app uses: prepare/bind/first/all/run, batch, exec.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Value = string | number | null | bigint | Uint8Array;

class Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values.map((v) => (v === undefined ? null : (v as Value))));
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    const isQuery = /^\s*(select|with)|returning/i.test(this.sql);
    return isQuery ? { results: this.db.prepare(this.sql).all(...this.params) } : this.db.prepare(this.sql).run(...this.params);
  }
}

export function createTestD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  const api = {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return api as unknown as D1Database & { raw: DatabaseSync };
}
