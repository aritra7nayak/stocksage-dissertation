"""Recompute indicators with the ORIGINAL Python code on the exact bars the TS port used, and diff."""
import json, math, sys
from dataclasses import asdict
from pathlib import Path
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "backend"))
import pandas as pd
from app.market_data.indicators import compute_all
from app.backtest.series import indicator_frame, tech_score_at

data = json.loads(Path(__file__).with_name("dump.json").read_text(encoding="utf-8"))
bad = 0
checked = 0
for item in data:
    b = item["bars"]
    df = pd.DataFrame({"Open": b["open"], "High": b["high"], "Low": b["low"], "Close": b["close"], "Volume": b["volume"]},
                      index=pd.to_datetime(b["dates"]))
    for key, partial in (("live", False), ("livePartial", True)):
        py = asdict(compute_all(df, last_bar_partial=partial))
        ts = item[key]
        for k, v in py.items():
            checked += 1
            tv = ts[k]
            same = (v == tv) if not isinstance(v, float) else (math.isclose(v, tv, rel_tol=0, abs_tol=1e-9) or (math.isnan(v) and tv is None))
            if not same:
                bad += 1
                print(f"MISMATCH {item['symbol']} {item['period']} {key}.{k}: py={v!r} ts={tv!r}")
    f = indicator_frame(df)
    for i in range(len(df)):
        checked += 1
        p = tech_score_at(f, i)
        t = item["scores"][i]
        if abs(p - t) > 1e-9:
            bad += 1
            if bad < 40:
                print(f"MISMATCH {item['symbol']} {item['period']} tech_score_at[{i}] py={p} ts={t}")
print(f"checked {checked} values across {len(data)} series — {bad} mismatches")
