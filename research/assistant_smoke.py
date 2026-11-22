"""Smoke-test the assistant end to end on a handful of real questions.

    deploy\\slm\\start-slm.bat                       # model server on :8081
    python -m research.assistant_smoke --out reports/assistant_smoke_2b.json

Runs the full loop in-process (tools hit the live database and market data),
prints each answer with the tools it used, and saves everything as JSON. This
is a quick check, not the E5 evaluation (which has its own fixed question set
and scoring).
"""
import argparse
import asyncio
import json
import time
from pathlib import Path

from research import ROOT

QUESTIONS = [
    ("stock", "Give me a quick analysis of Infosys. Is it in an uptrend?"),
    ("stock", "What are the support and resistance levels for HDFC Bank?"),
    ("fundamental", "Is TCS expensive on valuation? What are its P/E and ROE?"),
    ("options", "Should I buy Nifty calls this week?"),
    ("options", "What is the expected move and max pain for Bank Nifty?"),
    ("market", "How is the market today? What are FIIs doing?"),
    ("sector", "How is the IT sector doing?"),
    ("news", "Any bad news on Reliance in the last two weeks?"),
    ("concept", "What is IV crush and why does it hurt option buyers?"),
    ("concept", "What does a WAIT verdict mean on the StockSage options page?"),
    ("portfolio", "How is my portfolio doing?"),
    ("refusal", "What will be the price of Tata Steel next Friday?"),
]


async def run(out: Path, only: str | None) -> list[dict]:
    from app.assistant import agent, tools
    from app.db.database import AsyncSessionLocal
    results = []
    async with AsyncSessionLocal() as db:
        for cat, q in QUESTIONS:
            if only and cat != only:
                continue
            t = time.perf_counter()
            try:
                r = await agent.answer(q, [], tools.Ctx(db=db, user_id=1))
            except Exception as e:
                r = {"answer": f"ERROR {type(e).__name__}: {e}", "tool_calls": [], "sources": []}
            r |= {"category": cat, "question": q, "seconds": round(time.perf_counter() - t, 1)}
            results.append(r)
            print(f"\n### [{cat}] {q}  ({r['seconds']}s)")
            print("tools:", [(c["tool"], c["arguments"], "ok" if c["ok"] else "ERR") for c in r["tool_calls"]])
            print(r["answer"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    return results


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "reports" / "assistant_smoke.json"))
    ap.add_argument("--only", help="run one category only")
    a = ap.parse_args(argv)
    asyncio.run(run(Path(a.out), a.only))


if __name__ == "__main__":
    main()
