/**
 * Platform seam — everything the on-device backend needs from the outside
 * world: HTTP without CORS, a SQLite database, the FinBERT model, and a few
 * device services. The Android shell provides it through the native bridge
 * (see native/androidPlatform.ts); tests provide a Node implementation.
 *
 * SQL is synchronous on purpose: both SQLite backends are synchronous, and
 * keeping it that way lets the ported routers read like the Python originals.
 */

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;   // lower-cased names
  body: string;
}

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface SqlStatement { sql: string; params?: SqlValue[] }

export interface Sql {
  query(sql: string, params?: SqlValue[]): Row[];
  /** Returns rows changed and the last inserted rowid. */
  run(sql: string, params?: SqlValue[]): { changes: number; lastId: number };
  /** All statements in ONE transaction (atomic). */
  batch(statements: SqlStatement[]): void;
}

export interface Platform {
  name: "android" | "node" | "browser";
  http(req: HttpRequest): Promise<HttpResponse>;
  sql: Sql;
  /** FinBERT logits for pre-tokenized batches, or null when no model is available. */
  finbert(inputIds: number[][], attentionMask: number[][]): Promise<number[][] | null>;
  /** vocab.txt contents + label order (id2label) shipped with the model. */
  finbertAssets(): Promise<{ vocab: string; labels: string[] } | null>;
  notify?(title: string, body: string): void;
  log?(level: "info" | "warn" | "error", msg: string): void;
}

let current: Platform | null = null;

export function setPlatform(p: Platform): void {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error("Platform not initialised");
  return current;
}

export const db = {
  query: (sql: string, params: SqlValue[] = []) => platform().sql.query(sql, params),
  one: (sql: string, params: SqlValue[] = []): Row | null => platform().sql.query(sql, params)[0] ?? null,
  scalar: <T = SqlValue>(sql: string, params: SqlValue[] = []): T | null => {
    const r = platform().sql.query(sql, params)[0];
    return r ? (Object.values(r)[0] as T) : null;
  },
  run: (sql: string, params: SqlValue[] = []) => platform().sql.run(sql, params),
  batch: (statements: SqlStatement[]) => { if (statements.length) platform().sql.batch(statements); },
};

export function log(level: "info" | "warn" | "error", msg: string): void {
  const p = current;
  if (p?.log) p.log(level, msg);
  else (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${level}] ${msg}`);
}
