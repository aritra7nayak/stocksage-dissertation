import type { Factor } from "../../api/options";
import { DivergingBar, FitBar, Panel } from "./parts";

const GROUPS = ["Technical", "Options flow", "Sentiment", "Market context"];

function groupScore(fs: Factor[]) {
  const live = fs.filter((f) => f.available);
  const w = live.reduce((s, f) => s + f.weight, 0);
  return w ? live.reduce((s, f) => s + f.value * f.weight, 0) / w : 0;
}

export function DirectionBreakdown({ factors }: { factors: Factor[] }) {
  const totalLive = factors.filter((f) => f.available).reduce((s, f) => s + f.weight, 0);
  return (
    <Panel title="Direction — why bullish or bearish"
      hint="Every factor scores −1 (bearish) to +1 (bullish). Weight is its share of the direction score; factors with missing data are greyed out and the rest are re-weighted.">
      <div className="flex flex-col gap-5">
        {GROUPS.map((g) => {
          const fs = factors.filter((f) => f.group === g);
          if (!fs.length) return null;
          const gs = groupScore(fs);
          const gw = fs.reduce((s, f) => s + f.weight, 0);
          return (
            <div key={g}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-bold">{g} <span className="num text-[11px] font-normal text-muted">· {(gw * 100).toFixed(0)}% weight</span></span>
                <span className="num text-sm font-bold" style={{ color: gs > 0.05 ? "#16C784" : gs < -0.05 ? "#F0526B" : "rgb(var(--muted))" }}>
                  {gs > 0 ? "+" : ""}{(gs * 100).toFixed(0)}
                </span>
              </div>
              <div className="flex flex-col gap-2.5">
                {fs.map((f) => (
                  <div key={f.key} className={f.available ? "" : "opacity-50"}>
                    <div className="grid grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-3">
                      <span className="truncate text-[13px]">{f.label}</span>
                      <DivergingBar value={f.value} muted={!f.available} />
                      <span className="num text-right text-[12px] font-bold">
                        {f.available ? `${f.value > 0 ? "+" : ""}${f.value.toFixed(2)}` : "n/a"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex justify-between gap-3 text-[11px] text-muted">
                      <span>{f.detail}</span>
                      <span className="num shrink-0">{f.available && totalLive ? `${((f.weight / totalLive) * 100).toFixed(0)}%` : "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function SuitabilityBreakdown({ factors }: { factors: Factor[] }) {
  return (
    <Panel title="Buyer fit — is it worth paying premium now?"
      hint="Option buyers fight time decay and overpriced volatility. These factors score 0 (hostile) to 1 (ideal) for a buyer, regardless of direction.">
      <div className="flex flex-col gap-3">
        {factors.map((f) => (
          <div key={f.key}>
            <div className="grid grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-3">
              <span className="truncate text-[13px]">{f.label}</span>
              <FitBar value={f.value} />
              <span className="num text-right text-[12px] font-bold">{(f.value * 100).toFixed(0)}</span>
            </div>
            <div className="mt-0.5 flex justify-between gap-3 text-[11px] text-muted">
              <span>{f.detail}</span><span className="num shrink-0">{(f.weight * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
