"""Drift detection on the live feed (MLOps monitoring, offline half).

    python -m research.drift                       # last 7 days vs the 28 before
    python -m research.drift --current-days 7 --reference-days 28 --end 2026-12-01

Compares a current window of stored headlines (news_items) with a reference
window and reports, per check, the Population Stability Index (PSI):

  prediction drift  champion label mix, sentiment score, confidence
                    (only rows scored by the current champion version, so a
                    model change is never reported as drift)
  data drift        headline length, publisher mix, share of words unseen in
                    the reference window, share linked to a company
  shadow            champion/shadow disagreement rate, when a shadow runs

PSI < 0.10 stable, 0.10-0.25 moderate, >= 0.25 drift (the usual credit-risk
thresholds). The out-of-vocabulary check is relative: the current rate is
compared with the reference window's own second half against its first half.
Exit code 2 when any check drifts, so a scheduled run can trigger an
active-learning round (research/active_learning.py).

Implemented with numpy only, like research/metrics.py, so the numbers do not
depend on a monitoring library's version.
"""
import argparse
import json
import math
import os
import re
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import numpy as np

from research import ROOT

STABLE, MODERATE = 0.10, 0.25
_WORD = re.compile(r"[a-z][a-z'&-]+")


def psi(ref_counts, cur_counts, eps: float = 1e-4) -> float:
    """PSI over aligned bins: sum((c - r) * ln(c / r)) of the bin shares."""
    r = np.asarray(ref_counts, float)
    c = np.asarray(cur_counts, float)
    if r.sum() == 0 or c.sum() == 0:
        return float("nan")
    r = np.clip(r / r.sum(), eps, None)
    c = np.clip(c / c.sum(), eps, None)
    return float(np.sum((c - r) * np.log(c / r)))


def categorical_psi(ref: list, cur: list) -> float:
    cats = sorted(set(ref) | set(cur), key=str)
    rc, cc = Counter(ref), Counter(cur)
    return psi([rc[k] for k in cats], [cc[k] for k in cats])


def numeric_psi(ref: list[float], cur: list[float], bins: int = 10,
                edges: list[float] | None = None) -> float:
    """PSI with fixed edges, or reference-quantile edges when none are given."""
    if not ref or not cur:
        return float("nan")
    if edges is None:
        edges = sorted(set(np.quantile(ref, np.linspace(0, 1, bins + 1)[1:-1]).tolist()))
    e = [-math.inf, *edges, math.inf]
    return psi(np.histogram(ref, e)[0], np.histogram(cur, e)[0])


def status(value: float) -> str:
    if value != value:                 # NaN: not enough data
        return "n/a"
    return "stable" if value < STABLE else "moderate" if value < MODERATE else "drift"


def _words(h: str) -> list[str]:
    return _WORD.findall(h.lower())


def oov_rate(vocab: set, headlines: list[str]) -> float:
    toks = [w for h in headlines for w in _words(h)]
    return sum(w not in vocab for w in toks) / len(toks) if toks else float("nan")


def compare(ref: list[dict], cur: list[dict], champion: str | None = None) -> dict:
    """All checks for two windows of news rows (dicts with headline, source,
    sentiment, sentiment_score, sentiment_confidence, sentiment_model,
    related_symbols and, optionally, shadow_sentiment)."""
    checks: dict[str, dict] = {}

    def add(name, value, kind, **extra):
        checks[name] = {"psi" if kind == "psi" else "value": round(value, 4) if value == value else None,
                        "status": status(value) if kind == "psi" else extra.pop("status"), **extra}

    if champion is None:              # the version that scored most of the current window
        top = Counter(r["sentiment_model"] for r in cur if r.get("sentiment_model")).most_common(1)
        champion = top[0][0] if top else None
    ref_m = [r for r in ref if r.get("sentiment_model") == champion]
    cur_m = [r for r in cur if r.get("sentiment_model") == champion]
    if ref_m and cur_m:
        add("prediction.label_mix", categorical_psi([r["sentiment"] for r in ref_m],
                                                    [r["sentiment"] for r in cur_m]), "psi",
            ref_share=_shares(r["sentiment"] for r in ref_m), cur_share=_shares(r["sentiment"] for r in cur_m))
        add("prediction.score", numeric_psi([float(r["sentiment_score"]) for r in ref_m],
                                            [float(r["sentiment_score"]) for r in cur_m],
                                            edges=[-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]), "psi")
        rc = [float(r["sentiment_confidence"]) for r in ref_m if r.get("sentiment_confidence") is not None]
        cc = [float(r["sentiment_confidence"]) for r in cur_m if r.get("sentiment_confidence") is not None]
        if len(rc) >= 50 and len(cc) >= 50:
            add("prediction.confidence", numeric_psi(rc, cc, edges=[0.5, 0.6, 0.7, 0.8, 0.9, 0.95]), "psi",
                ref_mean=round(float(np.mean(rc)), 4), cur_mean=round(float(np.mean(cc)), 4))
    else:
        checks["prediction"] = {"status": "n/a", "note": f"no rows scored by {champion} in both windows "
                                "(model changed or nothing scored); prediction drift not measured"}

    add("data.headline_length", numeric_psi([len(_words(r["headline"])) for r in ref],
                                            [len(_words(r["headline"])) for r in cur]), "psi")
    add("data.source_mix", categorical_psi([r["source"] for r in ref], [r["source"] for r in cur]), "psi")
    def linked(rows):
        return sum(bool(r.get("related_symbols")) for r in rows) / len(rows) if rows else float("nan")

    add("data.linked_share", categorical_psi([bool(r.get("related_symbols")) for r in ref],
                                             [bool(r.get("related_symbols")) for r in cur]), "psi",
        ref_share=round(linked(ref), 4), cur_share=round(linked(cur), 4))

    half = len(ref) // 2
    first = {w for r in ref[:half] for w in _words(r["headline"])}
    base = oov_rate(first, [r["headline"] for r in ref[half:]])
    vocab = {w for r in ref for w in _words(r["headline"])}
    now = oov_rate(vocab, [r["headline"] for r in cur])
    ratio = now / base if base and base == base and now == now else float("nan")
    checks["data.unseen_words"] = {
        "value": round(now, 4) if now == now else None, "reference_rate": round(base, 4) if base == base else None,
        "ratio": round(ratio, 3) if ratio == ratio else None,
        "status": "n/a" if ratio != ratio else "stable" if ratio < 1.5 else "moderate" if ratio < 2.5 else "drift"}

    pairs = [(r["sentiment"], r["shadow_sentiment"]) for r in cur
             if r.get("shadow_sentiment") and r.get("sentiment_model") == champion]
    if pairs:
        dis = sum(a != b for a, b in pairs) / len(pairs)
        checks["shadow.disagreement"] = {"value": round(dis, 4), "n": len(pairs), "status": "info"}

    worst = max((c["status"] for c in checks.values()),
                key=lambda s: {"drift": 3, "moderate": 2, "stable": 1}.get(s, 0), default="n/a")
    return {"champion": champion, "n_reference": len(ref), "n_current": len(cur),
            "n_reference_champion": len(ref_m), "n_current_champion": len(cur_m),
            "overall": worst, "checks": checks}


def _shares(values) -> dict:
    c = Counter(values)
    n = sum(c.values())
    return {k: round(v / n, 4) for k, v in sorted(c.items())}


def load_window(db: str, start: datetime, end: datetime) -> list[dict]:
    import psycopg2
    import psycopg2.extras

    try:
        conn = psycopg2.connect(db)
    except psycopg2.OperationalError:
        raise SystemExit("Cannot reach the database. Start it first (start.bat).") from None
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT to_regclass('shadow_predictions') IS NOT NULL AS ok")
        has_shadow = cur.fetchone()["ok"]
        cur.execute("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'news_items'"
                    " AND column_name = 'sentiment_confidence'")
        conf = "n.sentiment_confidence" if cur.fetchone()["n"] else "NULL AS sentiment_confidence"
        cur.execute(f"""
            SELECT n.headline, n.source, n.sentiment, n.sentiment_score, {conf},
                   n.sentiment_model, n.related_symbols, n.fetched_at
                   {", s.sentiment AS shadow_sentiment" if has_shadow else ""}
            FROM news_items n
            {"LEFT JOIN LATERAL (SELECT sentiment FROM shadow_predictions sp WHERE sp.url_hash = n.url_hash"
             " ORDER BY created_at DESC LIMIT 1) s ON true" if has_shadow else ""}
            WHERE n.fetched_at >= %s AND n.fetched_at < %s
              AND (n.published_at IS NULL OR n.published_at >= n.fetched_at - interval '7 days')
            ORDER BY n.fetched_at""", (start, end))
        rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def last_day(iso: str) -> str:
    """Windows are end-exclusive; the inclusive last day of one."""
    return (datetime.fromisoformat(iso) - timedelta(days=1)).date().isoformat()


def _markdown(rep: dict) -> str:
    lines = [f"# Drift report: {rep['current']['start'][:10]} to {last_day(rep['current']['end'])}", "",
             f"Reference {rep['reference']['start'][:10]} to {last_day(rep['reference']['end'])} "
             f"({rep['n_reference']} headlines) vs current ({rep['n_current']}). "
             f"Champion `{rep['champion']}`. **Overall: {rep['overall']}**", "",
             "| Check | PSI / value | Status |", "|---|---|---|"]
    for name, c in rep["checks"].items():
        v = c.get("psi", c.get("value"))
        lines.append(f"| {name} | {'' if v is None else v} | {c['status']} |")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    from dotenv import load_dotenv

    from research.export_news import DEFAULT_DB

    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--end", type=date.fromisoformat, help="last day of the current window (default today)")
    ap.add_argument("--current-days", type=int, default=7)
    ap.add_argument("--reference-days", type=int, default=28)
    ap.add_argument("--db", default=os.environ.get("DATABASE_URL_SYNC", DEFAULT_DB))
    ap.add_argument("--out", default=str(ROOT / "reports"))
    a = ap.parse_args(argv)

    import pytz
    ist = pytz.timezone("Asia/Kolkata")                     # windows are IST days, like corpus_status
    end = ist.localize(datetime.combine((a.end or datetime.now(ist).date()) + timedelta(days=1), time.min))
    cur_start = end - timedelta(days=a.current_days)
    ref_start = cur_start - timedelta(days=a.reference_days)
    ref = load_window(a.db, ref_start, cur_start)
    cur = load_window(a.db, cur_start, end)
    if not ref or not cur:
        raise SystemExit(f"not enough data: {len(ref)} reference and {len(cur)} current headlines")
    rep = compare(ref, cur)
    rep.update({"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "reference": {"start": ref_start.isoformat(), "end": cur_start.isoformat()},
                "current": {"start": cur_start.isoformat(), "end": end.isoformat()},
                "thresholds": {"stable": STABLE, "moderate": MODERATE}})
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = f"drift_{last_day(end.isoformat())}"
    (out / f"{stem}.json").write_text(json.dumps(rep, indent=2, default=str), encoding="utf-8")
    (out / f"{stem}.md").write_text(_markdown(rep), encoding="utf-8")
    print(_markdown(rep))
    return 2 if rep["overall"] == "drift" else 0


if __name__ == "__main__":
    raise SystemExit(main())
