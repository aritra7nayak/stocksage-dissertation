/**
 * The in-app "server": a path router plus an axios adapter. The React pages
 * keep calling api.get("/api/...") exactly as they do against FastAPI; the
 * adapter dispatches those calls to the TypeScript handlers in-process.
 * Errors come back as {status, data: {detail}} — the shape the pages read.
 */
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { AxiosError } from "axios";
import { log } from "./platform";
import { HttpError } from "./util/py";

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface RouteDef { method: string; re: RegExp; keys: string[]; handler: Handler }

const routes: RouteDef[] = [];

/** Register a route; ":name" segments become params. Order matters (first match wins). */
export function route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: Handler): void {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
}

/** A binary response (e.g. the Excel export). */
export class FileResult {
  constructor(public blob: Blob, public filename: string) {}
}

export async function dispatch(method: string, url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const u = new URL(url, "http://app.local");
  const path = u.pathname;
  for (const r of routes) {
    if (r.method !== method.toUpperCase()) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const data = await r.handler({ params, query: u.searchParams, body });
      return { status: 200, data };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, data: { detail: e.detail } };
      log("error", `${method} ${path} failed: ${(e as Error)?.stack || e}`);
      return { status: 500, data: { detail: (e as Error)?.message || "Internal error" } };
    }
  }
  return { status: 404, data: { detail: "Not Found" } };
}

async function parseBody(data: unknown): Promise<unknown> {
  if (data == null) return {};
  if (typeof FormData !== "undefined" && data instanceof FormData) return data;
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

export const localAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const method = (config.method || "get").toUpperCase();
  let url = config.url || "";
  if (config.params) {
    const qs = new URLSearchParams(config.params as Record<string, string>).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const body = await parseBody(config.data);
  const { status, data } = await dispatch(method, url, body);
  const out = data instanceof FileResult ? data.blob : data;
  const response: AxiosResponse = {
    data: out, status, statusText: status < 400 ? "OK" : "Error",
    headers: {}, config, request: {},
  };
  if (status >= 400) {
    throw new AxiosError(`Request failed with status code ${status}`,
      status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, {}, response);
  }
  return response;
};
