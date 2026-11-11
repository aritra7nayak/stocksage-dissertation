"""Daily collection check for the live feed (news_items).

    python -m research.corpus_status            # last 7 days
    python -m research.corpus_status --day 2026-11-03

Per IST day: headlines stored, how many FinBERT scored (sentiment_model set),
how many are linked to a company, and which hours had new rows. A day with the
30-minute poll running shows new rows in most hours; long empty stretches mean
the app or the laptop was off.
"""
import argparse
import os
from datetime import date

from dotenv import load_dotenv

from research import ROOT
from research.export_news import DEFAULT_DB

load_dotenv(ROOT / ".env")
IST = "AT TIME ZONE 'Asia/Kolkata'"


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--day", type=date.fromisoformat)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--db", default=os.environ.get("DATABASE_URL_SYNC", DEFAULT_DB))
    a = ap.parse_args(argv)
    import psycopg2

    try:
        conn = psycopg2.connect(a.db)
    except psycopg2.OperationalError:
        raise SystemExit("Cannot reach the database. Start it first (start.bat).") from None
    with conn, conn.cursor() as cur:
        cur.execute(f"""SELECT date(fetched_at {IST}) d, count(*), count(sentiment_model),
                               count(*) FILTER (WHERE cardinality(related_symbols) > 0),
                               array_agg(DISTINCT extract(hour FROM fetched_at {IST})::int)
                        FROM news_items GROUP BY 1 ORDER BY 1 DESC LIMIT %s""",
                    (a.days if not a.day else 400,))
        rows = [r for r in cur.fetchall() if not a.day or r[0] == a.day]
        print(f"{'day (IST)':<12}{'stored':>8}{'scored':>8}{'linked':>8}  hours with new rows")
        for d, n, scored, linked, hours in rows:
            hrs = sorted(h for h in hours if h is not None)
            print(f"{d!s:<12}{n:>8}{scored:>8}{linked:>8}  {len(hrs):>2}/24 {hrs}")
        cur.execute("SELECT count(*), count(sentiment_model), min(fetched_at) FROM news_items")
        total, scored, first = cur.fetchone()
        print(f"\nall time: {total} headlines since {first:%Y-%m-%d}, {total - scored} without a "
              f"model version" + (" (run: python -m app.sentiment.rescore --all)"
                                  if total - scored else ""))


if __name__ == "__main__":
    main()
