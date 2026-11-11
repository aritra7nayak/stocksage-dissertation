import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Play } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine } from "recharts";
import { api, getBacktestRuns } from "../api/client";
import { LoadingOrb } from "../components/shared/ui";

export default function BacktestPage() {
  const [runs, setRuns] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadRuns = async () => {
    const r = await getBacktestRuns();
    setRuns(r);
    if (r.length) loadDetail(r[0].id);
    setLoading(false);
  };
  const loadDetail = async (id: number) => {
    const d = await api.get(`/api/backtest/runs/${id}`).then((x) => x.data);
    setDetail(d);
  };
  const run = async () => {
    setRunning(true);
    try {
      await api.post("/api/backtest/run", { name: `Run ${new Date().toLocaleString()}` });
      await loadRuns();
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    loadRuns();
  }, []);

  if (loading) return <LoadingOrb label="Loading backtests…" />;

  const curve = detail?.rule_config?.equity_curve || [];
  const m = detail?.metrics;
  const alpha = m ? m.return_pct - m.nifty_pct : 0;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="eyebrow mb-2">Strategy Validation</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Backtest</h1>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="glass glow-cyan flex items-center gap-2 rounded-xl px-5 py-3 font-medium disabled:opacity-50"
        >
          <Play size={16} className={running ? "animate-pulse" : ""} />
          {running ? "Simulating ~2 min…" : "Run new backtest"}
        </button>
      </div>

      {!detail ? (
        <div className="glass rounded-2xl p-10 text-center text-muted">
          No backtests yet. Run one to replay all 15 rules over the last year of real NSE data.
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { l: "Strategy", v: `${m.return_pct >= 0 ? "+" : ""}${(m.return_pct ?? 0).toFixed(1)}%`, c: m.return_pct >= 0 ? "#34F5A0" : "#FF4D7E" },
              { l: "Nifty Buy-Hold", v: `${m.nifty_pct >= 0 ? "+" : ""}${(m.nifty_pct ?? 0).toFixed(1)}%`, c: "#6B7DB3" },
              { l: "Alpha", v: `${alpha >= 0 ? "+" : ""}${(alpha ?? 0).toFixed(1)}%`, c: alpha >= 0 ? "#34F5A0" : "#FF4D7E" },
              { l: "Max Drawdown", v: `−${(m.max_dd_pct ?? 0).toFixed(1)}%`, c: "#FFC04D" },
            ].map((s) => (
              <motion.div key={s.l} className="glass rounded-2xl p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                <div className="eyebrow mb-2">{s.l}</div>
                <div className="num text-2xl font-bold" style={{ color: s.c }}>{s.v}</div>
              </motion.div>
            ))}
          </div>

          {curve.length > 0 && (
            <div className="glass mb-6 rounded-2xl p-5">
              <div className="eyebrow mb-4">Equity Curve</div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={curve}>
                  <XAxis dataKey="date" tick={{ fill: "#6B7DB3", fontSize: 11 }} minTickGap={60} />
                  <YAxis tick={{ fill: "#6B7DB3", fontSize: 11 }} domain={["auto", "auto"]} width={70} />
                  <Tooltip
                    contentStyle={{ background: "#0D1426", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12 }}
                    labelStyle={{ color: "#6B7DB3" }}
                  />
                  <ReferenceLine y={detail.rule_config?.equity_curve?.[0]?.equity} stroke="#6B7DB3" strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="equity" stroke="#22D3EE" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
              {detail.rule_config?.notes?.map((n: string, i: number) => (
                <p key={i} className="mt-3 text-[11px] leading-relaxed text-muted">{n}</p>
              ))}
            </div>
          )}

          <div className="glass overflow-hidden rounded-2xl">
            <div className="border-b border-line px-5 py-3 eyebrow">Trades ({detail.trades?.length || 0})</div>
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {detail.trades?.map((t: any, i: number) => (
                    <tr key={i} className="border-b border-line/40">
                      <td className="num px-5 py-2 text-muted">{t.date}</td>
                      <td className="px-3 py-2 font-bold">{t.symbol.replace(".NS", "")}</td>
                      <td className="px-3 py-2">
                        <span className="num text-[11px] font-bold" style={{ color: t.action === "BUY" ? "#34F5A0" : "#FF4D7E" }}>
                          {t.action}
                        </span>
                      </td>
                      <td className="num px-3 py-2">₹{t.price?.toLocaleString("en-IN")}</td>
                      <td className="num px-3 py-2" style={{ color: t.pnl > 0 ? "#34F5A0" : t.pnl < 0 ? "#FF4D7E" : "#6B7DB3" }}>
                        {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}₹${t.pnl.toLocaleString("en-IN")}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted">{t.rule || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
