"""Step 2 verification — pulls REAL NSE data through every market_data component.

Run from the backend folder (venv active):  python ..\\scripts\\verify_market_data.py
Requires internet. Takes ~30–60 seconds (Yahoo fundamentals are slow per symbol).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.market_data import fetcher                      # noqa: E402
from app.market_data.fundamentals import score_fundamentals  # noqa: E402
from app.market_data.indicators import compute_all       # noqa: E402

LINE = "─" * 64


def main() -> None:
    print(LINE)
    print("1) INDICES")
    idx = fetcher.get_indices()
    for name, q in idx.items():
        print(f"   {name:<8} {q['price']:>12,.2f}  ({q['change_pct']:+.2f}%)  as of {q['as_of'][:10]}")

    print(LINE)
    print("2) NIFTY GUARD (R11)")
    status = fetcher.get_nifty_status()
    print(f"   {status['verdict']}")

    print(LINE)
    print("3) GOLD / SILVER ETFs")
    gs = fetcher.get_gold_silver()
    print(f"   GOLDBEES   ₹{gs['gold']['price']:>8,.2f}  ({gs['gold']['change_pct']:+.2f}%)")
    print(f"   SILVERBEES ₹{gs['silver']['price']:>8,.2f}  ({gs['silver']['change_pct']:+.2f}%)")

    for symbol in ("INFY.NS", "RELIANCE.NS"):
        print(LINE)
        print(f"4) FULL ANALYSIS — {symbol}")
        df = fetcher.get_history(symbol, "1y")
        tech = compute_all(df)
        print(f"   Price ₹{df['Close'].iloc[-1]:,.2f} | RSI {tech.rsi_14} | MACD {tech.macd_signal} "
              f"| EMA20/50 {tech.ema_20}/{tech.ema_50} | ADX {tech.adx}")
        print(f"   TECHNICAL SCORE: {tech.technical_score}")
        for r in tech.reasons[:4]:
            print(f"     • {r}")
        fund = score_fundamentals(symbol)
        print(f"   FUNDAMENTAL SCORE: {fund.fundamental_score} "
              f"(PE {fund.pe_ratio}, ROE {fund.roe})")
        for r in fund.reasons[:3]:
            print(f"     • {r}")

    print(LINE)
    print("✅ Step 2 verified — real NSE data is flowing through indicators and scoring.")


if __name__ == "__main__":
    main()
