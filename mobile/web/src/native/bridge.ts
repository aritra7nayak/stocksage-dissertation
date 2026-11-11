/**
 * JS side of the Android bridge (StockSageNative, see NativeBridge.kt).
 *
 * Fast calls (SQL, asset reads) are synchronous @JavascriptInterface methods.
 * Slow ones (HTTP, FinBERT, file saves) are fire-and-forget with an id: native
 * does the work off the UI thread, then calls window.__ssNative.resolve(id),
 * and JS pulls the result with take(id). Every result is a JSON envelope
 * {ok: true, ...} or {ok: false, error}.
 */
export interface NativeBridge {
  sqlQuery(sql: string, params: string): string;
  sqlRun(sql: string, params: string): string;
  sqlBatch(statements: string): string;
  httpRequest(id: string, request: string): void;
  finbertAssets(): string;
  finbertRun(id: string, payload: string): void;
  saveFile(id: string, name: string, mime: string, base64: string): void;
  take(id: string): string;
  notify(title: string, body: string): void;
  haptic(kind: string): void;
  openExternal(url: string): void;
  setSystemBars(dark: boolean): void;
  scheduleInfo(): string;
  setSchedule(config: string): string;
  runJobNow(type: string): void;
  openSettings(which: string): void;
  jobFinished(outcome: string): void;
  appInfo(): string;
  log(level: string, message: string): void;
}

declare global {
  interface Window {
    StockSageNative?: NativeBridge;
    __ssNative?: { resolve(id: string): void; insets?(t: number, r: number, b: number, l: number): void };
  }
}

export const native: NativeBridge | null = typeof window !== "undefined" ? window.StockSageNative ?? null : null;
export const isAndroid = native !== null;

const pending = new Map<string, (raw: string) => void>();
let seq = 0;

if (typeof window !== "undefined") {
  window.__ssNative = {
    ...(window.__ssNative ?? {}),
    resolve(id: string) {
      const cb = pending.get(id);
      pending.delete(id);
      cb?.(native!.take(id));
    },
  };
}

export function envelope<T = any>(raw: string): T {
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error || "Native call failed");
  return r as T;
}

/** Start an async native call and resolve with its JSON envelope. */
export function callAsync<T = any>(start: (id: string) => void): Promise<T> {
  const id = `c${++seq}_${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, (raw) => {
      try { resolve(envelope<T>(raw)); } catch (e) { reject(e); }
    });
    try {
      start(id);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

export const haptic = (kind: "tap" | "success" | "warning" = "tap") => { try { native?.haptic(kind); } catch { /* optional */ } };
