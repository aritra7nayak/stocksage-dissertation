/**
 * End-to-end smoke run of the on-device backend under Node, against the real
 * internet (Yahoo, RSS, NSE). Usage:  npx tsx tests/smoke.ts [endpoint...]
 */
import { dispatch, initBackend } from "../src/backend";
import { nodePlatform } from "./nodePlatform";

const p = nodePlatform(process.env.SMOKE_DB ?? ":memory:");
initBackend(p);

const targets = process.argv.slice(2);
const calls: [string, string, unknown?][] = targets.length
  ? targets.map((t) => (t.includes(" ") ? (t.split(" ") as [string, string]) : ["GET", t]))
  : [
    ["GET", "/api/health"],
    ["GET", "/api/market/indices"],
    ["GET", "/api/market/technicals/INFY.NS"],
    ["GET", "/api/market/fundamentals/INFY.NS"],
    ["POST", "/api/news/refresh"],
    ["GET", "/api/news/guard-status"],
    ["POST", "/api/engine/run"],
  ];

for (const [method, url, body] of calls) {
  const t0 = Date.now();
  const { status, data } = await dispatch(method, url, body ?? {});
  const text = JSON.stringify(data);
  console.log(`\n=== ${method} ${url} → ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${text.length} bytes)`);
  console.log(text.length > 1800 ? `${text.slice(0, 1800)}…` : text);
}
p.close();
