"""Export the live feed archive (news_items) to raw corpus JSONL.

    python -m research.export_news --out data/raw/live_feed.jsonl

Reads DATABASE_URL_SYNC from the environment or .env (same as the app).
Uses published_at when the feed gave one, else fetched_at, and records which
in `time_source`, because only published_at is safe for backtest alignment.
Rows published more than 7 days before they were fetched are skipped: they
come from dead feeds that kept serving old items (Moneycontrol, 2016/2024).
"""
import argparse
import os

from dotenv import load_dotenv

from research import ROOT, schema

load_dotenv(ROOT / ".env")
DEFAULT_DB = "postgresql://stocksage:stocksage_secret_2026@localhost:5433/stocksage"


def export(out: str, db_url: str) -> int:
    import psycopg2

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('news_items')")
            if not cur.fetchone()[0]:
                raise SystemExit("news_items does not exist in this database")
            cur.execute("""SELECT column_name FROM information_schema.columns
                           WHERE table_name = 'news_items' AND column_name = 'summary'""")
            has_summary = cur.fetchone() is not None
            cur.execute(f"""SELECT id, headline, source, url, published_at, fetched_at,
                                   {'summary' if has_summary else 'NULL'}
                            FROM news_items ORDER BY COALESCE(published_at, fetched_at)""")
            all_rows = cur.fetchall()
    finally:
        conn.close()
    rows = [r for r in all_rows if not (r[4] and r[5] and (r[5] - r[4]).days > 7)]
    stale = len(all_rows) - len(rows)

    def recs():
        for nid, headline, source, url, pub, fetched, summary in rows:
            ts = pub or fetched
            yield {"id": f"live-{nid}", "headline": headline, "source": source or "unknown",
                   "url": url, "summary": summary,
                   "published_at": ts.isoformat() if ts else None,
                   "time_source": "published" if pub else "fetched", "origin_corpus": "live_feed"}

    good = [r for r in recs() if not schema.validate(r, labelled=False)]
    n = schema.write_jsonl(out, good)
    print(f"Wrote {n} headlines to {out} ({len(rows) - n} skipped as invalid, "
          f"{stale} as stale feed items)")
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "data" / "raw" / "live_feed.jsonl"))
    ap.add_argument("--db", default=os.environ.get("DATABASE_URL_SYNC", DEFAULT_DB))
    a = ap.parse_args()
    export(a.out, a.db)
