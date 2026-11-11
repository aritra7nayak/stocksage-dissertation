/** The backend Platform implemented on the Android bridge. */
import type { HttpRequest, HttpResponse, Platform, Row, SqlValue } from "../backend/platform";
import { callAsync, envelope, NativeBridge } from "./bridge";

export function androidPlatform(n: NativeBridge): Platform {
  let assets: { vocab: string; labels: string[] } | null | undefined;
  return {
    name: "android",
    async http(req: HttpRequest): Promise<HttpResponse> {
      const r = await callAsync<{ status: number; headers: Record<string, string>; body: string }>(
        (id) => n.httpRequest(id, JSON.stringify(req)));
      return { status: r.status, headers: r.headers ?? {}, body: r.body ?? "" };
    },
    sql: {
      query: (sql: string, params: SqlValue[] = []) => envelope<{ rows: Row[] }>(n.sqlQuery(sql, JSON.stringify(params))).rows,
      run: (sql: string, params: SqlValue[] = []) => {
        const r = envelope<{ changes: number; lastId: number }>(n.sqlRun(sql, JSON.stringify(params)));
        return { changes: r.changes, lastId: r.lastId };
      },
      batch: (statements) => { envelope(n.sqlBatch(JSON.stringify(statements))); },
    },
    async finbertAssets() {
      if (assets === undefined) {
        try {
          const r = envelope<{ vocab: string; labels: string[] }>(n.finbertAssets());
          assets = { vocab: r.vocab, labels: r.labels };
        } catch {
          assets = null;
        }
      }
      return assets;
    },
    async finbert(inputIds, attentionMask) {
      const r = await callAsync<{ logits: number[][] }>((id) =>
        n.finbertRun(id, JSON.stringify({ input_ids: inputIds, attention_mask: attentionMask })));
      return r.logits;
    },
    notify: (title, body) => n.notify(title, body),
    log: (level, msg) => {
      n.log(level, msg);
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(msg);
    },
  };
}
