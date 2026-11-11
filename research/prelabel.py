"""LLM pre-labels for annotator A's sheet (Gemini, free tier).

    pip install google-genai
    $env:GEMINI_API_KEY = "<key from aistudio.google.com>"   # or put it in .env
    python -m research.prelabel --dry-run              # show the prompt and the row count
    python -m research.prelabel                        # writes data/annotation/prelabels.jsonl
    python -m research.build_sample prefill            # copies them into sheet_annotator_a.csv

Which rows are pre-labelled (see `eligible`): since guidelines v1.2, every
row, for both annotators. The v1.2 pre-labels in prelabels.jsonl were written
by Claude (model claude-opus-5-5) for all six fields including companies and
sectors; this script's earlier Gemini output is kept in prelabels_gemini.jsonl.
Because this script skips ids already in the output file, it has nothing left
to do on the current sample.

The prompt is the annotation guidelines themselves (sections 1-4), so the LLM
and the annotators work from the same definitions. Each output line records
the model version Google reports and a hash of the prompt.

Free-tier limits change and are shown per project in AI Studio. The script
sends --batch headlines per request, waits 60/--rpm seconds between requests,
appends every finished batch, and skips ids already in the output file, so a
run that stops on the daily quota resumes where it left off.
"""
import argparse
import hashlib
import json
import os
import time
from collections.abc import Callable
from pathlib import Path

from dotenv import load_dotenv

from research import ROOT, schema

load_dotenv(ROOT / ".env")
GUIDELINES = ROOT / "research" / "annotation" / "GUIDELINES.md"
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
FIELDS = ("sentiment", "events", "severity", "scope")

INSTRUCTIONS = """You are pre-labelling Indian financial news headlines for a human annotator,
who will review every label. Follow these annotation guidelines exactly:

{guidelines}

For each input headline return one object with these keys:
  "id": the input id, unchanged
  "sentiment": one of {sentiments}
  "events": a list of one or more of {events}; "other" only on its own
  "severity": one of {severities}
  "scope": one of {scopes}
Return a JSON array with exactly one object per input headline, in input order.
Judge only the headline text. When the headline does not settle a question,
choose the cautious value (neutral, none, other)."""


def eligible(rec: dict) -> bool:
    """Rows that may be pre-labelled: every row (guidelines v1.2; see the decisions log)."""
    return rec.get("split") in schema.SPLITS


def build_prompt() -> str:
    text = GUIDELINES.read_text(encoding="utf-8")
    start, end = text.index("## 1. Sentiment"), text.index("## 5. Companies")
    return INSTRUCTIONS.format(guidelines=text[start:end].strip(),
                               sentiments=list(schema.SENTIMENTS),
                               events=list(schema.EVENT_TYPES),
                               severities=list(schema.SEVERITIES), scopes=list(schema.SCOPES))


def prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode()).hexdigest()[:12]


def clean(item: dict) -> dict | None:
    """Validate one LLM label; None if any field is outside the schema."""
    events = item.get("events")
    if isinstance(events, str):
        events = [events]
    if not isinstance(events, list):
        return None
    events = sorted({str(e).strip().lower() for e in events}) or ["other"]
    if "other" in events and len(events) > 1:
        events.remove("other")
    lab = {"sentiment": str(item.get("sentiment", "")).strip().lower(), "events": events,
           "severity": str(item.get("severity", "")).strip().lower(),
           "scope": str(item.get("scope", "")).strip().lower()}
    ok = (lab["sentiment"] in schema.SENTIMENTS and lab["severity"] in schema.SEVERITIES
          and lab["scope"] in schema.SCOPES and all(e in schema.EVENT_TYPES for e in events))
    return lab if ok else None


class QuotaExhausted(RuntimeError):
    pass


def gemini_caller(model: str, api_key: str) -> Callable[[str, str], tuple[str, str]]:
    """(system prompt, user text) -> (response text, model version)."""
    import httpx
    from google import genai
    from google.genai import errors, types

    client = genai.Client(api_key=api_key)
    cfg_kw = dict(temperature=0.0, response_mime_type="application/json")

    def call(system: str, user: str) -> tuple[str, str]:
        overloaded = 0
        for attempt in range(12):
            try:
                r = client.models.generate_content(
                    model=model, contents=user,
                    config=types.GenerateContentConfig(system_instruction=system, **cfg_kw))
                return r.text or "", getattr(r, "model_version", None) or model
            except (errors.APIError, httpx.TransportError) as e:
                code = getattr(e, "code", None)
                # 5xx "high demand" and dropped connections are temporary: wait them out.
                if isinstance(e, httpx.TransportError) or code in (500, 502, 503, 504):
                    overloaded += 1
                    wait = min(30 * 2 ** (overloaded - 1), 600)
                    print(f"  server busy ({code or type(e).__name__}); retrying in {wait}s", flush=True)
                    time.sleep(wait)
                    continue
                if e.code != 429:
                    raise
                if "per day" in str(e).lower() or "PerDay" in str(e) or attempt >= 4:
                    raise QuotaExhausted(str(e)) from e
                time.sleep(30 * (attempt + 1))          # per-minute limit: back off
        raise QuotaExhausted("server stayed unavailable; run again later to resume")

    return call


def run(sample: Path, out: Path, call, batch: int, rpm: float, limit: int | None) -> dict:
    prompt = build_prompt()
    phash = prompt_hash(prompt)
    done = {r["id"] for r in schema.read_jsonl(out)} if out.exists() else set()
    todo = [r for r in schema.read_jsonl(sample) if eligible(r) and r["id"] not in done]
    if limit:
        todo = todo[:limit]
    stats = {"todo": len(todo), "labelled": 0, "rejected": 0, "requests": 0}
    out.parent.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        user = json.dumps([{"id": r["id"], "headline": r["headline"]} for r in chunk],
                          ensure_ascii=False)
        if stats["requests"]:
            time.sleep(60.0 / rpm)
        try:
            text, version = call(prompt, user)
        except QuotaExhausted as e:
            stats["stopped"] = f"quota: {e}"[:300]
            break
        stats["requests"] += 1
        try:
            items = json.loads(text)
        except json.JSONDecodeError:
            stats["rejected"] += len(chunk)
            continue
        by_id = {str(it.get("id")): it for it in items if isinstance(it, dict)}
        rows = []
        for r in chunk:
            lab = clean(by_id.get(r["id"], {}))
            if lab is None:
                stats["rejected"] += 1                   # left blank for the annotator
                continue
            rows.append({"id": r["id"], **lab, "origin": "llm_prelabel", "model": version,
                         "prompt_sha": phash})
        with open(out, "a", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        stats["labelled"] += len(rows)
        print(f"  {i + len(chunk)}/{len(todo)} headlines, {stats['rejected']} rejected", flush=True)
    return stats


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    ap.add_argument("--out", default=str(ROOT / "data" / "annotation" / "prelabels.jsonl"))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--batch", type=int, default=25, help="headlines per request")
    ap.add_argument("--rpm", type=float, default=5, help="requests per minute to stay under")
    ap.add_argument("--limit", type=int, help="pre-label at most this many headlines (trial run)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    if a.dry_run:
        rows = [r for r in schema.read_jsonl(a.sample) if eligible(r)]
        prompt = build_prompt()
        print(prompt, f"\n\n[prompt {prompt_hash(prompt)}, {len(prompt)} chars] "
              f"{len(rows)} eligible rows -> {-(-len(rows) // a.batch)} requests")
        return
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise SystemExit("Set GEMINI_API_KEY (aistudio.google.com -> Get API key) in .env")
    stats = run(Path(a.sample), Path(a.out), gemini_caller(a.model, key), a.batch, a.rpm, a.limit)
    print(stats)
    if "stopped" in stats:
        print("Daily quota reached. Run the same command tomorrow; finished rows are kept.")


if __name__ == "__main__":
    main()
