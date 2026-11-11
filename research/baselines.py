"""Predictors compared in E1–E3, all behind one interface: headline -> label.

- keyword_*: the production regex classifier (app.sentiment.bad_news) read as
  a sentiment / event / severity predictor. This is the "keyword baseline".
- finbert_sentiment: the generic, off-the-shelf model exactly as deployed.
- linkers: the substring baseline and the alias-table entity linker.
- load_predictions: any other model's outputs, keyed by record id, so a
  fine-tuned model is evaluated on precisely the same items.
"""
import importlib.util
from pathlib import Path

from research import ROOT, schema
from app.sentiment import bad_news

# Every production keyword mapped to the event taxonomy. Price-movement words
# ("plunges", "falls") describe a reaction, not an event, so they map to
# "other". test_research_metrics asserts this table covers every keyword.
KEYWORD_EVENTS: dict[str, str] = {
    # regulatory action
    **dict.fromkeys(["sebi bars", "sebi bans", "sebi crackdown", "sebi probe", "sebi order",
                     "rbi restricts", "rbi penalty", "license cancelled", "ed raids",
                     "cbi probe", "nclt", "trading halted"], "regulatory_action"),
    # fraud, default, governance
    **dict.fromkeys(["fraud", "scam", "money laundering", "default", "defaults",
                     "bankruptcy", "insolvency", "downgraded to junk", "auditor resigns"],
                    "fraud_default"),
    # monetary policy
    **dict.fromkeys(["rbi hikes", "repo rate raised", "rate hike", "inflation surges"],
                    "monetary_policy"),
    # earnings and guidance
    **dict.fromkeys(["misses estimates", "profit falls", "profit drops", "weak guidance",
                     "loss widens", "margin pressure", "cuts target", "rating downgrade",
                     "downgrade"], "earnings_guidance"),
    # corporate action
    **dict.fromkeys(["shuts down", "mass layoffs", "layoffs", "strike"], "corporate_action"),
    # macro / geopolitical
    **dict.fromkeys(["war", "invasion", "missile", "air strike", "airstrike", "nuclear",
                     "pandemic", "lockdown", "curfew", "terror attack", "emergency declared",
                     "sanctions", "trade war", "tariff", "gdp contracts", "recession",
                     "recession fears", "sovereign downgrade", "rupee collapses",
                     "rupee crashes", "crude surges", "oil spikes", "gst hike",
                     "windfall tax", "slowdown deepens"], "macro_geopolitical"),
    # flows
    **dict.fromkeys(["fii sell-off", "fii selloff", "fiis pull out", "foreign outflows",
                     "promoter pledge"], "flows"),
    # market reaction words
    **dict.fromkeys(["market crash", "market meltdown", "bloodbath on dalal street",
                     "black monday", "circuit breaker", "crashes", "plunges", "plummets",
                     "tanks", "sinks", "nosedives", "bloodbath", "sell-off", "selloff",
                     "slips", "declines", "falls", "drops"], "other"),
}


def keyword_sentiment(headline: str) -> str:
    """The keyword classifier only knows bad news: it cannot say 'positive'."""
    return "negative" if bad_news.classify_headline(headline).is_bad else "neutral"


def keyword_events(headline: str) -> set[str]:
    c = bad_news.classify_headline(headline)
    events = {KEYWORD_EVENTS.get(k, "other") for k in c.matched_keywords}
    events.discard("other")
    return events or {"other"}


def keyword_severity(headline: str) -> str:
    sev = bad_news.classify_headline(headline).severity
    return "high" if sev >= 6 else "medium" if sev >= 4 else "low" if sev > 0 else "none"


def keyword_halt(headline: str) -> bool:
    """Would this headline count toward the market-wide R12 halt?"""
    c = bad_news.classify_headline(headline)
    return c.is_systemic and c.is_severe


def gold_halt(rec: dict) -> bool:
    return rec["scope"] == "market" and rec["severity"] == "high"


def finbert_sentiment(headlines: list[str]) -> list[str]:
    from app.sentiment import finbert
    results = finbert.score_headlines(headlines)
    if not all(r.model_used for r in results):
        raise RuntimeError("FinBERT did not load; refusing to report neutral fallbacks as results")
    return [r.sentiment.lower() for r in results]


def universe() -> list[tuple[str, str]]:
    """(symbol, company) pairs from the embedded universe, without a database."""
    spec = importlib.util.spec_from_file_location("seed_universe",
                                                  ROOT / "scripts" / "seed_universe.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)        # module only defines lists; seed() is not called
    return [(s, n) for s, n, *_ in mod.NIFTY50 + mod.NEXT100 + mod.SMALLCAP + mod.ETFS]


def linkers(companies: list[tuple[str, str]] | None = None) -> dict:
    from app.nlp.entity_linker import EntityLinker
    from app.nlp.substring_linker import SubstringLinker
    companies = companies or universe()
    return {"substring": SubstringLinker(companies).symbols,
            "entity_linker": EntityLinker(companies).symbols}


def load_predictions(path: str | Path) -> dict[str, dict]:
    """{id: {"sentiment": ..., "events": [...], ...}} from a model's output JSONL."""
    return {r["id"]: r for r in schema.read_jsonl(path)}
