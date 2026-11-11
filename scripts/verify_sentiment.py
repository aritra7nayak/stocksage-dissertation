"""Step 4 verification — FinBERT on your GPU + live Indian news flow.

Run from backend (venv active):  python ..\\scripts\\verify_sentiment.py
FIRST RUN downloads FinBERT (~440 MB) — 2–5 minutes. After that, seconds.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.sentiment import finbert                      # noqa: E402
from app.sentiment.bad_news import classify_headline, combine_with_sentiment  # noqa: E402
from app.sentiment.scrapers import fetch_all_feeds     # noqa: E402

LINE = "─" * 70

SAMPLES = [
    "Infosys beats Q4 estimates, raises FY27 revenue guidance",
    "Sensex crashes over 1,400 points as FII selloff deepens",
    "SEBI bars promoter group from securities market in fraud probe",
    "RBI keeps repo rate unchanged, maintains neutral stance",
    "Tata Steel announces record capex for green steel plants",
    "Major NBFC defaults on bond repayment; rating downgraded to junk",
]


def main() -> None:
    print(LINE)
    print("1) FinBERT — first run downloads the model, please wait…")
    results = finbert.score_headlines(SAMPLES)
    status = finbert.model_status()
    print(f"   Model loaded: {status['loaded']}  |  Device: {status['device']}")
    print(LINE)
    print(f"   {'SENTIMENT':<9} {'SCORE':>6} {'SEV':>4}  HEADLINE")
    for s in results:
        c = combine_with_sentiment(classify_headline(s.headline), s.sentiment, s.score)
        flag = "⛔" if c.is_severe else "⚠️ " if c.is_bad else "  "
        print(f"   {s.sentiment:<9} {s.score:>+6.2f} {c.severity:>4.0f} {flag} {s.headline[:58]}")

    print(LINE)
    print("2) LIVE RSS FEEDS (Indian financial news)")
    items = fetch_all_feeds()
    print(f"   Fetched {len(items)} headlines across sources.")
    for it in items[:6]:
        print(f"   [{it.source[:22]:<22}] {it.headline[:60]}")

    print(LINE)
    if status["device"] == "cuda":
        print("✅ Step 4 verified — FinBERT is scoring on your GPU, news is flowing.")
    elif status["loaded"]:
        print("✅ FinBERT works but on CPU — check /api/health/gpu if you expected CUDA.")
    else:
        print("⚠️ FinBERT failed to load — keyword fallback active. Check internet/VRAM.")


if __name__ == "__main__":
    main()
