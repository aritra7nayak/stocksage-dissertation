"""Replay the same bundle through the ORIGINAL Python BacktestSimulator and diff every trade."""
import json, sys
from datetime import date
from pathlib import Path
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
import pandas as pd
from app.config import get_settings
from app.backtest.simulator import BacktestSimulator

d = json.loads(Path(__file__).with_name("sim.json").read_text(encoding="utf-8"))
def frame(b):
    return pd.DataFrame({"Open": b["open"], "High": b["high"], "Low": b["low"], "Close": b["close"], "Volume": b["volume"]},
                        index=pd.to_datetime(b["dates"]))
prices = {s: frame(b) for s, b in d["prices"].items()}
nifty = frame(d["nifty"])
meta = {s: tuple(v) for s, v in d["meta"].items()}
base = get_settings()
bad = 0
for run in d["runs"]:
    s = base.model_copy(update={"stop_loss_pct": run["settings"]["stop_loss_pct"], "cash_reserve_pct": run["settings"]["cash_reserve_pct"]})
    r = BacktestSimulator(prices, meta, nifty, s).run(date.fromisoformat(run["start"]), date.fromisoformat(run["end"]), 100000)
    ts = run["result"]
    for k in ("final_value", "total_return_pct", "nifty_return_pct", "max_drawdown_pct", "win_rate", "total_trades", "open_positions"):
        if abs(float(getattr(r, k)) - float(ts[k])) > 1e-6:
            bad += 1; print(f"MISMATCH {run['label']} {run['start']} {k}: py={getattr(r, k)} ts={ts[k]}")
    pt = [(t.symbol, t.action, str(t.trade_date), t.quantity, t.price, t.pnl, t.triggered_rule, t.reason) for t in r.trades]
    tt = [(t["symbol"], t["action"], t["trade_date"], t["quantity"], t["price"], t["pnl"], t["triggered_rule"], t["reason"]) for t in ts["trades"]]
    if pt != tt:
        bad += 1
        for i, (a, b) in enumerate(zip(pt, tt)):
            if a != b:
                print(f"FIRST TRADE DIFF {run['label']} {run['start']} #{i}:\n  py={a}\n  ts={b}"); break
        if len(pt) != len(tt): print(f"  trade counts py={len(pt)} ts={len(tt)}")
    print(f"{run['label']:>12} {run['start']}: py {r.total_return_pct:+.3f}% / ts {ts['total_return_pct']:+.3f}%  trades py={len(pt)} ts={len(tt)}")
print("ALL MATCH" if not bad else f"{bad} mismatches")
