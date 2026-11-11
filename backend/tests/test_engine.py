"""Engine tests — composite math, planner provisional state, sector health.

The killer test here: three high-scoring candidates, but the R8 daily cap only
fits two ₹9,000 buys — the planner MUST approve exactly 2 and skip the third
with R8 as the recorded reason. Without provisional state updates this fails.

Run:  python tests/test_engine.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings
from app.engine import scoring
from app.engine.planner import plan_buys, plan_sells
from app.engine.sector_health import compute_sector_health
from app.rules.base import BuyCandidate, MarketState, PortfolioState

S = Settings()


def pstate(**kw) -> PortfolioState:
    d = dict(total_capital=100_000, cash_balance=100_000)
    d.update(kw)
    return PortfolioState(**d)


def market(**kw) -> MarketState:
    return MarketState(nifty_fell=False, nifty_change_pct=0.4, **kw)


def cand(sym, score=0.75, price=1500.0, segment="NIFTY50", sector="IT", etf=False):
    return BuyCandidate(sym, segment, sector, price, score, etf)


# ── Scoring math ─────────────────────────────────────────────────────────────

def test_composite_weights():
    assert scoring.composite(1.0, 1.0, 1.0) == 1.0
    assert scoring.composite(0.0, 0.0, 0.0) == 0.0
    assert scoring.composite(1.0, 0.0, 0.0) == 0.40
    assert scoring.composite(0.0, 1.0, 0.0) == 0.35
    assert scoring.composite(0.0, 0.0, 1.0) == 0.25


def test_sentiment_mapping():
    assert scoring.sentiment_to_unit(-1.0) == 0.0
    assert scoring.sentiment_to_unit(0.0) == 0.5
    assert scoring.sentiment_to_unit(1.0) == 1.0


def test_recommendation_and_confidence():
    assert scoring.recommendation(0.72) == "BUY"
    assert scoring.recommendation(0.30) == "SELL"
    assert scoring.recommendation(0.50) == "HOLD"
    assert scoring.confidence(0.75) == "HIGH"
    assert scoring.confidence(0.62) == "MEDIUM"
    assert scoring.confidence(0.55) == "LOW"


# ── Planner: provisional state is the whole game ─────────────────────────────

def test_daily_cap_respected_across_multiple_buys():
    cands = [cand("A.NS", 0.9, sector="IT"),
             cand("B.NS", 0.85, sector="Banking & Finance"),
             cand("C.NS", 0.80, sector="FMCG")]
    buys, skips, final = plan_buys(cands, pstate(), market(), S)
    assert len(buys) == 2, "Only two ₹9,000 buys fit the ₹20,000 daily cap"
    assert skips and skips[0].results[-1].rule_id == "R8"
    assert final.invested_today == 18_000.0
    assert final.cash_balance == 82_000.0


def test_bucket_capacity_respected_across_buys():
    # NIFTY50 bucket = 30k. Pre-deployed 15k. Two 9k buys → second must fail bucket.
    p = pstate(bucket_deployed={"NIFTY50": 15_000}, cash_balance=85_000)
    cands = [cand("A.NS", 0.9, sector="IT"), cand("B.NS", 0.85, sector="FMCG")]
    buys, skips, _ = plan_buys(cands, p, market(), S)
    assert len(buys) == 1 and skips[0].results[-1].rule_id == "R3"


def test_sector_concentration_across_buys():
    # Big enough equity base to arm R9, then two IT buys back-to-back
    p = pstate(bucket_deployed={"NIFTY50": 18_000, "NEXT100": 9_000},
               sector_deployed={"FMCG": 18_000, "Banking & Finance": 9_000},
               cash_balance=73_000)
    cands = [cand("TCS.NS", 0.9, sector="IT"),
             cand("INFY.NS", 0.88, segment="NEXT100", sector="IT")]
    buys, skips, _ = plan_buys(cands, p, market(), S)
    # 1st IT buy: 9k/36k = 25% OK. 2nd: 18k/45k = 40% > 35% cap → R9
    assert len(buys) == 1 and skips[0].results[-1].rule_id == "R9"


def test_blocker_stops_everything_immediately():
    cands = [cand("A.NS", 0.9), cand("B.NS", 0.9), cand("C.NS", 0.9)]
    buys, skips, _ = plan_buys(cands, pstate(), MarketState(nifty_fell=True,
                                                            nifty_change_pct=-1.1), S)
    assert buys == [] and len(skips) == 1, "BLOCKER must short-circuit the whole plan"
    assert skips[0].results[-1].rule_id == "R11"


def test_low_score_candidates_never_considered():
    buys, skips, _ = plan_buys([cand("MEH.NS", 0.55)], pstate(), market(), S)
    assert buys == [] and skips == [], "Sub-0.60 scores aren't buy material, not even skips"


def test_segment_limits_and_order():
    cands = [cand(f"N{i}.NS", 0.9 - i * 0.01, sector=s) for i, s in
             enumerate(["IT", "FMCG", "Metal", "Services"])]  # 4 NIFTY50 names
    buys, _, _ = plan_buys(cands, pstate(total_capital=1_000_000, cash_balance=1_000_000),
                           market(), S)
    n50 = [b for b in buys if b.candidate.segment == "NIFTY50"]
    assert len(n50) <= 3, "Max 3 NIFTY50 suggestions per day"


def test_etf_planning():
    gold = cand("GOLDBEES.NS", 0.7, price=121.3, segment="GOLD_ETF", sector="Metal", etf=True)
    buys, _, _ = plan_buys([gold], pstate(), market(weak_sectors={"Metal"}), S)
    assert len(buys) == 1 and 5000 <= buys[0].total_cost <= 6000


# ── Sells via planner ────────────────────────────────────────────────────────

def test_plan_sells_separates_alerts_from_holds():
    holdings = [
        {"symbol": "LOSER.NS", "avg_buy_price": 1000, "current_price": 900,
         "peak_price": 1010, "low_score_streak": 0},                      # −10% → R13
        {"symbol": "FINE.NS", "avg_buy_price": 1000, "current_price": 1050,
         "peak_price": 1060, "low_score_streak": 1},                      # healthy
    ]
    sells, holds = plan_sells(holdings, S)
    assert [s.symbol for s in sells] == ["LOSER.NS"] and sells[0].triggered_rule == "R13"
    assert [h.symbol for h in holds] == ["FINE.NS"]


# ── Sector health ────────────────────────────────────────────────────────────

def test_sector_health_weak_and_strong():
    sectors = {"A.NS": "IT", "B.NS": "IT", "C.NS": "Metal", "D.NS": "Metal"}
    change = {"A.NS": 1.5, "B.NS": 1.0, "C.NS": -2.2, "D.NS": -1.8}
    rsi = {"A.NS": 62, "B.NS": 58, "C.NS": 24, "D.NS": 28}
    news = {"IT": 0.5, "Metal": -0.7}
    rows = compute_sector_health(sectors, change, rsi, news, ("IT", "Metal", "FMCG"))
    by = {r.sector: r for r in rows}
    assert by["IT"].status == "STRONG"
    assert by["Metal"].status == "WEAK"
    assert by["FMCG"].status == "NEUTRAL" and by["FMCG"].score == 50.0  # no data → neutral
    assert by["IT"].top_gainer == "A.NS"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n✅ All {len(fns)} engine tests passed — the planner respects every cap across multiple buys.")
