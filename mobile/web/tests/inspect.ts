/** Print a readable summary of the stored brief + data health (after tests/smoke.ts with SMOKE_DB). */
import { dispatch, initBackend } from "../src/backend";
import { nodePlatform } from "./nodePlatform";
initBackend(nodePlatform(process.env.SMOKE_DB));
const b = (await dispatch("GET", "/api/daily-brief", {})).data as any;
console.log("brief:", b.date, b.run_type, `${b.duration_seconds}s`, "go:", b.market_guard.go_status, "-", b.market_guard.go_message);
console.log("buys:", b.buy_suggestions.map((x: any) => `${x.symbol} ${x.quantity}×${x.price.toFixed(1)} score ${x.composite_score} [${x.rules_passed.join(",")}]`).join(" | ") || "none");
console.log("skipped:", b.skipped.map((x: any) => `${x.symbol}:${x.killed_by}`).join(" ") || "none");
console.log("news:", JSON.stringify(b.news));
const h = (await dispatch("GET", "/api/insights/health", {})).data as any;
console.log("health:", `${h.analyzed_today}/${h.universe_active} analysed (${h.coverage_pct}%), news today ${h.news_today}, missing ${h.missing_today.join(" ")}`);
const s = (await dispatch("GET", "/api/suggestions/today", {})).data as any;
console.log("suggestions logged:", s.count);
