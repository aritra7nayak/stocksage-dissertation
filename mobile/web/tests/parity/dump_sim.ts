/** Run the TS backtester on a real 60-symbol bundle and dump inputs + results for sim_parity.py. */
import { writeFileSync } from "node:fs";
import { initBackend } from "../../src/backend";
import { BASE } from "../../src/backend/config";
import { BacktestSimulator } from "../../src/backend/backtest/simulator";
import { batchHistory, getHistory } from "../../src/backend/market/fetcher";
import { UNIVERSE } from "../../src/backend/market/universe";
import { nodePlatform } from "../nodePlatform";
import { addDays, todayIst } from "../../src/backend/util/time";

initBackend(nodePlatform());
const pick = UNIVERSE.filter((u) => u[4]).filter((_, i) => i % 3 === 0).concat(UNIVERSE.filter((u) => u[3].endsWith("ETF")));
const meta: Record<string, [string, string]> = {};
for (const [s, , sec, seg] of pick) meta[s] = [seg, sec];
const prices = await batchHistory(Object.keys(meta), "2y");
const nifty = await getHistory(BASE.nifty50_index, "2y");
const end = todayIst();
const runs = [];
for (const [label, settings] of [["conservative", BASE], ["aggressive", { ...BASE, stop_loss_pct: 0.12, cash_reserve_pct: 0.1 }]] as const) {
  const sim = new BacktestSimulator(prices, meta, nifty, settings);
  for (const days of [365, 182]) runs.push({ label, settings, start: addDays(end, -days), end, result: sim.run(addDays(end, -days), end, 100000) });
}
writeFileSync("tests/parity/sim.json", JSON.stringify({ prices, meta, nifty, runs }));
console.log(runs.map((r) => `${r.label} ${r.start}: ${r.result.total_return_pct}% vs nifty ${r.result.nifty_return_pct}%, ${r.result.total_trades} trades`).join("\n"));
