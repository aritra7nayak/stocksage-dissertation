"""Historical headline backfill from the GDELT Global Knowledge Graph (GKG 2.0).

    pip install google-cloud-bigquery
    gcloud auth application-default login
    python -m research.gdelt_backfill --project <id> --start 2023-01-01 --end 2026-10-31 --dry-run
    python -m research.gdelt_backfill --project <id> --start 2023-01-01 --end 2026-10-31 \
        --out data/raw/gdelt.jsonl

GKG records each article's page title in the Extras field (<PAGE_TITLE>) and
the time GDELT saw it in DATE (UTC, YYYYMMDDHHMMSS). That crawl time is later
than publication, so using it for alignment can only delay a headline, never
leak it early. Each record is stored with time_source="crawl".

Cost control: the query reads three columns of the partitioned table for the
requested dates only. Always run --dry-run first; it prints the bytes the
query would scan (BigQuery's free tier is 1 TB of scanned data per month).
"""
import argparse
import hashlib
import html
import json
import os
import re
from datetime import date, datetime, timezone
from urllib.parse import urlparse

from research import ROOT, schema

# GDELT's SourceCommonName. Economic Times is filed under indiatimes.com, which
# it shares with the Times of India, so the query keeps only ET's host for it.
PUBLISHERS = (
    "indiatimes.com",
    "moneycontrol.com",
    "livemint.com",
    "business-standard.com",
    "financialexpress.com",
    "thehindubusinessline.com",
)
QUERY = """
SELECT DATE AS crawl_ts, SourceCommonName AS source, DocumentIdentifier AS url,
       REGEXP_EXTRACT(Extras, r'<PAGE_TITLE>(.*?)</PAGE_TITLE>') AS title
FROM `gdelt-bq.gdeltv2.gkg_partitioned`
WHERE _PARTITIONTIME BETWEEN TIMESTAMP(@start) AND TIMESTAMP(@end)
  AND SourceCommonName IN UNNEST(@publishers)
  AND (SourceCommonName != 'indiatimes.com'
       OR STRPOS(DocumentIdentifier, '//economictimes.indiatimes.com/') > 0)
  AND REGEXP_CONTAINS(DocumentIdentifier, r'(?i)/(markets?|stocks?|business|economy|companies|industry|news/economy)/')
"""

# Rows that are not English news articles (found in the Nov 2026 backfill):
# Hindi editions (10.6% of rows), Moneycontrol's user message board, and
# Mint's live stock-quote pages.
_DEVANAGARI = re.compile("[ऀ-ॿ]")
_MOJIBAKE = ("â€", "Ã")                      # UTF-8 read as cp1252: "Jaypeeâ€™s"
# Quote and tool pages, and ET's machine-written price blurbs ("Vedanta Share
# Price: Vedanta shares gain 1.82% as Sensex rises"): they restate a price move,
# so there is nothing to label and the backtest has the prices already.
_NOT_NEWS = re.compile(
    r"(?i)share price today \(|share price live|currency converter|forex rates live"
    r"|stock price today, live"
    r"|^[^:]{2,60} share price: .{2,60} shares? +(rise|fall|gain|jump|drop|decline|climb|surge|slip|up|down)\b"
    r"|^indices: stock market update: ")
# ET prepends a lowercase search keyword: "toyota: Toyota clocks best sales".
_ET_KEYWORD_PREFIX = re.compile(r"^[a-z][^:]{0,40}:\s+(?=[A-Z0-9₹$])")


def keep(url: str, title: str) -> bool:
    host = urlparse(url).netloc.lower()
    if host.startswith("hindi.") or host == "mmb.moneycontrol.com":
        return False
    if "/market/market-stats/" in url or _DEVANAGARI.search(title) or _NOT_NEWS.search(title):
        return False
    return True


def _fix_mojibake(t: str) -> str:
    if any(m in t for m in _MOJIBAKE):
        try:
            return t.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            # Lossy variant: the dash's last byte already became a plain quote.
            return t.replace('â€"', "—")
    return t


def _clean_title(title: str, source: str) -> str:
    t = _fix_mojibake(html.unescape(title or "").strip())
    for sep in (" | ", " - ", " – "):          # drop "… | Mint", "… - Moneycontrol"
        head, _, tail = t.rpartition(sep)
        if head and len(tail) < 40:
            t = head.strip()
    if "indiatimes" in source:
        t = _ET_KEYWORD_PREFIX.sub("", t)
    return t


def _source(source: str, url: str) -> str:
    return "economictimes.indiatimes.com" if source == "indiatimes.com" else source


def clean_file(path: str) -> dict:
    """Apply keep() and the title fixes to an existing backfill file in place,
    so an earlier run does not have to be queried (and paid for in quota) again."""
    kept, dropped = [], 0
    for rec in schema.read_jsonl(path):
        title = _clean_title(rec["headline"], rec["source"])
        if not keep(rec.get("url", ""), title) or len(title) < 15:
            dropped += 1
            continue
        kept.append({**rec, "headline": title, "source": _source(rec["source"], rec.get("url", ""))})
    schema.write_jsonl(path, kept)
    stats = {"kept": len(kept), "dropped": dropped}
    print(json.dumps(stats))
    return stats


# Hard cap per query. The sandbox fails over-quota queries anyway; this also
# makes a query fail, not bill, if billing is ever attached to the project.
MAX_BYTES = 1_000_000_000_000


def run(start: date, end: date, out: str | None, dry_run: bool, project: str | None = None,
        publishers: tuple[str, ...] = PUBLISHERS) -> None:
    from google.cloud import bigquery

    client = bigquery.Client(project=project)
    params = [bigquery.ScalarQueryParameter("start", "STRING", start.isoformat()),
              bigquery.ScalarQueryParameter("end", "STRING", end.isoformat()),
              bigquery.ArrayQueryParameter("publishers", "STRING", list(publishers))]
    cfg = bigquery.QueryJobConfig(query_parameters=params, dry_run=dry_run,
                                  use_query_cache=not dry_run, maximum_bytes_billed=MAX_BYTES)
    job = client.query(QUERY, job_config=cfg)
    if dry_run:
        gb = job.total_bytes_processed / 1e9
        print(f"Dry run ({client.project}): would scan {gb:,.1f} GB of the 1,000 GB free each month"
              + (" -- too large for one run, split the date range" if gb > 1000 else ""))
        return
    print("Query running; downloading rows (this can take several minutes)...", flush=True)

    seen, records, dropped = set(), [], 0
    for row in job.result():
        title = _clean_title(row.title, row.source)
        if len(title) < 15:
            continue
        if not keep(row.url, title):
            dropped += 1
            continue
        key = " ".join(title.lower().split())
        if key in seen:                         # syndicated / re-crawled copies
            continue
        seen.add(key)
        ts = datetime.strptime(str(row.crawl_ts), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        records.append({
            "id": "gdelt-" + hashlib.sha1(row.url.encode()).hexdigest()[:16],
            "headline": title, "source": _source(row.source, row.url), "url": row.url,
            "published_at": ts.isoformat(), "time_source": "crawl",
            "origin_corpus": "gdelt_gkg"})
    records.sort(key=lambda r: r["published_at"])
    n = schema.write_jsonl(out, records)
    print(f"Wrote {n} unique headlines to {out} ({dropped} non-English/forum/quote rows dropped)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--start", type=date.fromisoformat)
    ap.add_argument("--end", type=date.fromisoformat)
    ap.add_argument("--out", default=str(ROOT / "data" / "raw" / "gdelt.jsonl"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--project", default=os.environ.get("GOOGLE_CLOUD_PROJECT"),
                    help="Google Cloud project id (default: $GOOGLE_CLOUD_PROJECT or gcloud's)")
    ap.add_argument("--publishers", help="comma-separated SourceCommonName list (default: all)")
    ap.add_argument("--clean", metavar="FILE",
                    help="re-apply the row filters and title fixes to an existing file; no query")
    a = ap.parse_args()
    if a.clean:
        clean_file(a.clean)
    elif not (a.start and a.end):
        ap.error("--start and --end are required (or use --clean FILE)")
    else:
        pubs = tuple(p.strip() for p in a.publishers.split(",")) if a.publishers else PUBLISHERS
        run(a.start, a.end, a.out, a.dry_run, a.project, pubs)
