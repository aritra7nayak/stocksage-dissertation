"""Research tooling: evaluation statistics against hand-computed values, the
label schema, the keyword→event baseline map, and the corpus pipeline
(sample → sheet → import → evaluate → agreement) end to end on synthetic data.
"""
import csv
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app.sentiment import bad_news
from research import agreement, baselines, build_sample, evaluate, metrics, schema


# ── statistics ───────────────────────────────────────────────────────────

def test_macro_f1_by_hand():
    gold, pred = ["a", "a", "b", "b"], ["a", "b", "b", "b"]
    # a: P=1, R=.5, F=.667 ; b: P=.667, R=1, F=.8
    assert math.isclose(metrics.macro_f1(gold, pred, ["a", "b"]), (2 / 3 + 0.8) / 2, abs_tol=1e-3)
    assert metrics.confusion(gold, pred, ["a", "b"]).tolist() == [[1, 1], [0, 2]]


def test_cohen_kappa_by_hand():
    assert metrics.cohen_kappa([1, 1, 0, 0], [1, 0, 0, 0]) == 0.5
    assert metrics.cohen_kappa(["x", "y"], ["x", "y"]) == 1.0


def test_mcnemar_matches_chi2_table():
    gold = [1] * 12
    a = [1] * 10 + [0] * 2          # A right on the first 10
    b = [0] * 10 + [1] * 2          # B right only on the last 2  → b=10, c=2
    r = metrics.mcnemar(gold, a, b)
    assert (r["b"], r["c"]) == (10, 2)
    assert math.isclose(r["chi2"], 49 / 12, abs_tol=1e-4)
    assert math.isclose(r["p_value"], 0.04331, abs_tol=1e-4)     # scipy.stats.chi2.sf


def test_multilabel_and_linking():
    m = metrics.multilabel_f1([{"x"}, {"x", "y"}], [{"x"}, {"y"}], ["x", "y"])
    assert m["micro_f1"] == 0.8 and m["per_label"]["y"]["f1"] == 1.0
    s = metrics.linking_scores([{"A"}, set(), {"B"}], [{"A", "C"}, {"D"}, set()])
    assert s["precision"] == round(1 / 3, 4) and s["recall"] == 0.5
    assert s["misattribution_rate"] == round(2 / 3, 4)


def test_bootstrap_brackets_point():
    gold = ["a", "b"] * 50
    pred = ["a", "b"] * 40 + ["b", "a"] * 10
    ci = metrics.bootstrap_ci(metrics.accuracy, gold, pred, n_boot=300)
    assert ci["low"] <= ci["point"] == 0.8 <= ci["high"]
    pb = metrics.paired_bootstrap(metrics.accuracy, gold, pred, gold, n_boot=300)
    assert pb["delta"] == 0.2 and pb["p_not_better"] == 0.0


# ── schema ───────────────────────────────────────────────────────────────

GOOD = {"id": "x1", "headline": "Infosys wins a large deal in Europe", "source": "ET",
        "published_at": "2026-01-05T08:00:00+05:30", "sentiment": "positive",
        "events": ["corporate_action"], "severity": "none", "scope": "company",
        "companies": ["INFY.NS"], "sectors": ["IT"], "annotator": "A"}


def test_schema_accepts_good_record():
    assert schema.validate(GOOD) == []


def test_schema_catches_mistakes():
    bad = dict(GOOD, sentiment="bullish", events=["other", "flows"], companies=["INFY"],
               published_at="2026-01-05T08:00:00")
    errs = " | ".join(schema.validate(bad))
    for frag in ("sentiment", "'other' cannot", "NSE symbols", "timezone"):
        assert frag in errs
    assert "needs at least one company" in " ".join(
        schema.validate(dict(GOOD, companies=[])))


# ── keyword baseline ─────────────────────────────────────────────────────

def test_every_production_keyword_has_an_event():
    keywords = set(bad_news.SYSTEMIC_KEYWORDS) | set(bad_news.COMPANY_KEYWORDS)
    assert keywords <= set(baselines.KEYWORD_EVENTS), \
        f"unmapped: {sorted(keywords - set(baselines.KEYWORD_EVENTS))}"
    assert set(baselines.KEYWORD_EVENTS.values()) <= set(schema.EVENT_TYPES)


def test_keyword_predictors():
    assert baselines.keyword_sentiment("SEBI bars promoter over fraud") == "negative"
    assert baselines.keyword_sentiment("Infosys wins deal") == "neutral"
    assert baselines.keyword_events("SEBI bars promoter over fraud") == \
        {"regulatory_action", "fraud_default"}
    assert baselines.keyword_events("Stocks drift sideways") == {"other"}
    assert baselines.keyword_halt("War fears grip markets as missile strikes reported")


def test_universe_loads_without_db():
    u = baselines.universe()
    assert len(u) > 200 and ("TCS.NS", "Tata Consultancy Services") in u


# ── pipeline end to end ──────────────────────────────────────────────────

HEADLINES = [
    ("Infosys wins large deal from European bank", "positive", "corporate_action", "INFY.NS"),
    ("SEBI bars promoter of small lender over fraud", "negative", "regulatory_action", ""),
    ("Tata Steel shares fall after weak quarterly results", "negative", "earnings_guidance",
     "TATASTEEL.NS"),
    ("Markets end flat ahead of the RBI policy meeting", "neutral", "monetary_policy", ""),
    ("HDFC Bank raises deposit rates for senior citizens", "neutral", "corporate_action",
     "HDFCBANK.NS"),
    ("War fears grip markets as missile strikes reported", "negative", "macro_geopolitical", ""),
]


def test_pipeline_end_to_end(tmp_path):
    raw = [{"id": f"r{i}", "headline": h, "source": f"src{i % 2}",
            "published_at": f"2026-01-0{i + 1}T07:00:00+05:30"}
           for i, (h, *_) in enumerate(HEADLINES)]
    raw.append(dict(raw[0], id="dup", published_at="2026-01-09T07:00:00+05:30"))
    schema.write_jsonl(tmp_path / "raw.jsonl", raw)

    stats = build_sample.build([str(tmp_path / "raw.jsonl")], n=6, n_double=3, seed=1,
                               out_dir=tmp_path)
    assert stats["pool"] == 6, "near-duplicate dropped"
    assert sum(stats["splits"].values()) == 6 and stats["double_annotated"] == 3

    # Fill sheet A with the gold labels; B disagrees on one sentiment.
    sample = {r["id"]: r for r in schema.read_jsonl(tmp_path / "sample.jsonl")}
    gold = {f"r{i}": row for i, row in enumerate(HEADLINES)}
    for name, flip in (("a", False), ("b", True)):
        path = tmp_path / f"sheet_annotator_{name}.csv"
        rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
        for k, row in enumerate(rows):
            _, sent, ev, comp = gold[row["id"]]
            if flip and k == 0:
                sent = "neutral" if sent != "neutral" else "positive"
            row.update(sentiment=sent, events=ev, severity="none" if sent == "positive" else "low",
                       companies=comp,
                       scope="company" if comp else "market")
        with open(path, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, build_sample.SHEET_COLUMNS)
            w.writeheader()
            w.writerows(rows)

    a = build_sample.read_sheet(tmp_path / "sheet_annotator_a.csv", "A", tmp_path / "sample.jsonl")
    b = build_sample.read_sheet(tmp_path / "sheet_annotator_b.csv", "B", tmp_path / "sample.jsonl")
    assert len(a) == 6 and len(b) == 3 and all(r["split"] == sample[r["id"]]["split"] for r in a)
    schema.write_jsonl(tmp_path / "a.jsonl", a)
    schema.write_jsonl(tmp_path / "b.jsonl", b)

    ag = agreement.agreement(str(tmp_path / "a.jsonl"), str(tmp_path / "b.jsonl"))
    assert ag["items"] == 3 and len(ag["disagreements"]) == 1

    for r in a:
        r["split"] = "test"                     # evaluate everything
    schema.write_jsonl(tmp_path / "gold.jsonl", a)
    rep = evaluate.main(["--gold", str(tmp_path / "gold.jsonl"), "--split", "test",
                         "--out", str(tmp_path / "reports"),
                         "--manifest", str(tmp_path / "no_manifest.json")])   # not the real frozen one
    assert rep["E3"]["entity_linker"]["misattribution_rate"] == 0.0
    assert rep["E3"]["substring"]["misattribution_rate"] > 0
    assert (tmp_path / "reports" / "eval_test.md").exists()


# ── GDELT backfill row filters ───────────────────────────────────────────

def test_gdelt_keep_and_title_fixes():
    from research import gdelt_backfill as g
    assert g.keep("https://www.moneycontrol.com/news/business/stocks/buy-cipla-1.html",
                  "Buy Cipla; target of Rs 1550: ICICI Securities")
    assert not g.keep("https://mmb.moneycontrol.com/forum-topics/stocks/x", "buy zomato 52 sl 50")
    assert not g.keep("https://hindi.moneycontrol.com/news/markets/x", "Stock to Buy today")
    assert not g.keep("https://www.livemint.com/market/market-stats/x", "City Union Bank Share Price")
    assert not g.keep("https://www.livemint.com/x", "Stock to Buy: इस बैंक")
    assert g._clean_title("Jaypeeâ€™s realty assets | Mint", "livemint.com") == \
        "Jaypee’s realty assets"
    assert g._fix_mojibake('Green â€" is it real?') == "Green — is it real?"
    assert g._source("indiatimes.com", "https://economictimes.indiatimes.com/x") == \
        "economictimes.indiatimes.com"


def test_gdelt_et_quirks():
    from research import gdelt_backfill as g
    et = "economictimes.indiatimes.com"
    assert g._clean_title("toyota: Toyota clocks best yearly sales", et) == "Toyota clocks best yearly sales"
    assert g._clean_title("Budget 2025: Sitharaman announces mission", et) == \
        "Budget 2025: Sitharaman announces mission"
    assert g._clean_title("toyota: Toyota clocks best sales", "livemint.com").startswith("toyota:")
    u = "https://economictimes.indiatimes.com/markets/x"
    assert not g.keep(u, "Vedanta Share Price: Vedanta  shares  gain  1.82% as Sensex  rises")
    assert not g.keep(u, "Indices: Stock market update: Nifty IT index  advances  0.4%")
    assert not g.keep(u, "HDFC Life Share Price Today (03 Jan, 2023)")
    assert g.keep(u, "Paytm share price today tanks on buzz of block deal")
