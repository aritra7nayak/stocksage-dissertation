/**
 * Node implementation of the platform seam, for tests and smoke runs:
 * node:sqlite for the database, fetch + a small cookie jar for HTTP (no CORS
 * in Node, same as the native Android stack), onnxruntime-node for FinBERT.
 */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpRequest, HttpResponse, Platform, SqlValue } from "../src/backend/platform";

const here = dirname(fileURLToPath(import.meta.url));
export const MODEL_DIR = resolve(here, "../../android/app/src/main/assets/finbert");

class CookieJar {
  private jar = new Map<string, Map<string, string>>();   // domain → name → value

  store(host: string, setCookies: string[]) {
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const domAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("domain="));
      const domain = (domAttr ? domAttr.slice(7) : host).replace(/^\./, "").toLowerCase();
      if (!this.jar.has(domain)) this.jar.set(domain, new Map());
      this.jar.get(domain)!.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(host: string): string {
    const out: string[] = [];
    for (const [domain, kv] of this.jar) {
      if (host === domain || host.endsWith(`.${domain}`)) for (const [k, v] of kv) out.push(`${k}=${v}`);
    }
    return out.join("; ");
  }
}

export function nodePlatform(dbPath = ":memory:"): Platform & { close(): void } {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const jar = new CookieJar();
  let ort: any = null;
  let session: any = null;

  const p: Platform & { close(): void } = {
    name: "node",
    async http(req: HttpRequest): Promise<HttpResponse> {
      let url = req.url;
      for (let hop = 0; hop < 6; hop++) {
        const host = new URL(url).hostname;
        const headers: Record<string, string> = { ...(req.headers ?? {}) };
        const cookie = jar.header(host);
        if (cookie) headers.Cookie = cookie;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? 20000);
        try {
          const r = await fetch(url, { method: req.method ?? "GET", headers, body: req.body, redirect: "manual", signal: ctl.signal });
          jar.store(host, r.headers.getSetCookie());
          if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
            url = new URL(r.headers.get("location")!, url).toString();
            continue;
          }
          const hdrs: Record<string, string> = {};
          r.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
          return { status: r.status, headers: hdrs, body: await r.text() };
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error("Too many redirects");
    },
    sql: {
      query: (sql, params = []) => sqlite.prepare(sql).all(...(params as SqlValue[])) as Record<string, SqlValue>[],
      run: (sql, params = []) => {
        const r = sqlite.prepare(sql).run(...(params as SqlValue[]));
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      batch: (stmts) => {
        sqlite.exec("BEGIN");
        try {
          for (const s of stmts) sqlite.prepare(s.sql).run(...((s.params ?? []) as SqlValue[]));
          sqlite.exec("COMMIT");
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      },
    },
    async finbertAssets() {
      const vocab = resolve(MODEL_DIR, "vocab.txt"), cfg = resolve(MODEL_DIR, "labels.json");
      if (!existsSync(vocab) || !existsSync(cfg)) return null;
      return { vocab: readFileSync(vocab, "utf8"), labels: JSON.parse(readFileSync(cfg, "utf8")) };
    },
    async finbert(ids, mask) {
      const model = resolve(MODEL_DIR, "model.onnx");
      if (!existsSync(model)) return null;
      ort ??= await import("onnxruntime-node");
      session ??= await ort.InferenceSession.create(model);
      const b = ids.length, n = ids[0].length;
      const t = (rows: number[][]) => new ort.Tensor("int64", BigInt64Array.from(rows.flat().map(BigInt)), [b, n]);
      const feeds: Record<string, unknown> = { input_ids: t(ids), attention_mask: t(mask) };
      if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = t(ids.map((r) => r.map(() => 0)));
      const out = await session.run(feeds);
      const logits = out[session.outputNames[0]].data as Float32Array;
      const k = logits.length / b;
      return Array.from({ length: b }, (_, i) => Array.from(logits.slice(i * k, (i + 1) * k)));
    },
    close: () => sqlite.close(),
  };
  return p;
}
