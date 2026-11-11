/** Dump real bars + TS indicator outputs so parity.py can recompute them with the Python originals. */
import { writeFileSync } from "node:fs";
import { initBackend } from "../../src/backend";
import { getHistory } from "../../src/backend/market/fetcher";
import { computeAll } from "../../src/backend/market/indicators";
import { indicatorFrame, techScoreAt } from "../../src/backend/backtest/simulator";
import { nodePlatform } from "../nodePlatform";

initBackend(nodePlatform());
const symbols = ["INFY.NS", "RELIANCE.NS", "HDFCBANK.NS", "TATASTEEL.NS", "GOLDBEES.NS", "^NSEI", "SUZLON.NS", "PAGEIND.NS"];
const out: any[] = [];
for (const s of symbols) {
  for (const period of ["1y", "2y"]) {
    const bars = await getHistory(s, period);
    const f = indicatorFrame(bars);
    const scores = bars.close.map((_, i) => techScoreAt(f, i));
    out.push({ symbol: s, period, bars, live: computeAll(bars, false), livePartial: computeAll(bars, true), scores });
  }
}
writeFileSync("tests/parity/dump.json", JSON.stringify(out));
console.log(`dumped ${out.length} series`);
