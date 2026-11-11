"""Label schema for the Indian financial news corpus, with validation.

One JSON object per line. Raw (unlabelled) records need only id, headline,
source and published_at. Labelled records add the fields under LABEL_FIELDS.
The annotation guidelines (research/annotation/GUIDELINES.md) define every
value; this module is the machine-checkable version of them.
"""
import json
import re
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path

SENTIMENTS = ("negative", "neutral", "positive")
EVENT_TYPES = (
    "regulatory_action",      # SEBI/RBI/ED/CBI/NCLT orders, bans, probes, penalties
    "fraud_default",          # fraud, default, insolvency, auditor exit, governance failure
    "monetary_policy",        # RBI rate/liquidity decisions, inflation prints
    "earnings_guidance",      # results, guidance, broker target changes
    "corporate_action",       # M&A, demerger, buyback, dividend, capex, layoffs, plant shutdown
    "macro_geopolitical",     # war, pandemic, sanctions, tariffs, GDP, rupee, crude, tax policy
    "flows",                  # FII/DII flows, block deals, promoter pledges, index inclusion
    "other",                  # market commentary and anything not above
)
SEVERITIES = ("none", "low", "medium", "high")
SCOPES = ("market", "sector", "company", "none")
SECTORS = ("IT", "Banking & Finance", "Pharma & Healthcare", "Oil & Gas", "Metal",
           "Energy & Power", "Manufacturing", "FMCG", "Services")      # GUIDELINES.md section 6
SPLITS = ("train", "dev", "test")
ORIGINS = ("human", "llm_prelabel", "human_verified")

RAW_FIELDS = ("id", "headline", "source", "published_at")
LABEL_FIELDS = ("sentiment", "events", "severity", "scope", "companies", "sectors", "annotator")
_SYMBOL = re.compile(r"^[A-Z0-9&\-]+\.NS$")


class SchemaError(ValueError):
    pass


def validate(rec: dict, labelled: bool = True) -> list[str]:
    """All problems with one record (empty list = valid)."""
    errs = []
    for f in RAW_FIELDS:
        if not rec.get(f):
            errs.append(f"missing {f}")
    if rec.get("headline") and len(rec["headline"].strip()) < 15:
        errs.append("headline shorter than 15 characters")
    ts = rec.get("published_at")
    if ts:
        try:
            if datetime.fromisoformat(ts).tzinfo is None:
                errs.append("published_at must include a timezone offset")
        except (TypeError, ValueError):
            errs.append(f"published_at not ISO-8601: {ts!r}")
    if rec.get("split") is not None and rec["split"] not in SPLITS:
        errs.append(f"split {rec['split']!r} not in {SPLITS}")
    if not labelled:
        return errs

    for f in LABEL_FIELDS:
        if f not in rec:
            errs.append(f"missing {f}")
    if rec.get("sentiment") not in SENTIMENTS:
        errs.append(f"sentiment {rec.get('sentiment')!r} not in {SENTIMENTS}")
    events = rec.get("events")
    if not isinstance(events, list) or not events:
        errs.append("events must be a non-empty list (use ['other'])")
    else:
        bad = [e for e in events if e not in EVENT_TYPES]
        if bad:
            errs.append(f"unknown event types {bad}")
        if "other" in events and len(events) > 1:
            errs.append("'other' cannot be combined with another event type")
    if rec.get("severity") not in SEVERITIES:
        errs.append(f"severity {rec.get('severity')!r} not in {SEVERITIES}")
    if rec.get("sentiment") == "positive" and rec.get("severity") not in ("none", None):
        errs.append("positive sentiment needs severity 'none' (severity measures downside only)")
    if rec.get("scope") not in SCOPES:
        errs.append(f"scope {rec.get('scope')!r} not in {SCOPES}")
    companies = rec.get("companies")
    if not isinstance(companies, list):
        errs.append("companies must be a list (may be empty)")
    else:
        bad = [c for c in companies if not _SYMBOL.match(str(c))
               or str(c).split(".")[0] in ("NONE", "NA", "NIL", "NULL", "NO")]
        if bad:
            errs.append(f"companies must be NSE symbols like 'TCS.NS': {bad}")
        if rec.get("scope") == "company" and not companies:
            errs.append("scope 'company' needs at least one company")
    if not isinstance(rec.get("sectors"), list):
        errs.append("sectors must be a list (may be empty)")
    else:
        bad = [s for s in rec["sectors"] if s not in SECTORS]
        if bad:
            errs.append(f"unknown sectors {bad} (use {list(SECTORS)})")
    if rec.get("origin") is not None and rec["origin"] not in ORIGINS:
        errs.append(f"origin {rec['origin']!r} not in {ORIGINS}")
    return errs


def read_jsonl(path: str | Path) -> Iterator[dict]:
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise SchemaError(f"{path}:{n}: invalid JSON ({exc})") from exc


def write_jsonl(path: str | Path, records: Iterable[dict]) -> int:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


def file_sha256(path: str | Path) -> str:
    """Content hash of a file (dataset lineage in reports and the registry)."""
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── frozen test split ──────────────────────────────────────────────────────
# build_sample writes test_manifest.json once. Training, evaluation and the
# promotion gate refuse to run when the test ids they see differ from it, so
# the test set cannot drift (rows added, relabelled into train, re-drawn)
# without that being an explicit, visible act.

def test_fingerprint(recs: Iterable[dict]) -> str:
    ids = sorted(r["id"] for r in recs if r.get("split") == "test")
    import hashlib
    return hashlib.sha256("\n".join(ids).encode()).hexdigest()


def write_test_manifest(path: str | Path, recs: list[dict], seed: int) -> dict:
    from datetime import datetime, timezone
    ids = sorted(r["id"] for r in recs if r.get("split") == "test")
    manifest = {"test_fingerprint": test_fingerprint(recs), "n_test": len(ids), "seed": seed,
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "test_ids": ids}
    Path(path).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check_test_frozen(recs: Iterable[dict], manifest_path: str | Path,
                      allow_partial: bool = False) -> dict:
    """Compare the test ids in `recs` with the frozen manifest.

    Returns {"fingerprint", "complete"}. Raises when a test id is not in the
    manifest, or (unless allow_partial, for interim results while annotation
    is still running) when manifest ids are missing. No manifest file (a toy
    corpus in tests) skips the comparison."""
    recs = list(recs)
    fp = test_fingerprint(recs)
    p = Path(manifest_path)
    if not p.exists():
        return {"fingerprint": fp, "complete": None}
    man = json.loads(p.read_text(encoding="utf-8"))
    if fp == man["test_fingerprint"]:
        return {"fingerprint": fp, "complete": True}
    have = {r["id"] for r in recs if r.get("split") == "test"}
    want = set(man["test_ids"])
    extra, missing = sorted(have - want), sorted(want - have)
    if extra:
        raise SchemaError(f"{len(extra)} test ids are not in the frozen manifest {p}, "
                          f"e.g. {extra[:3]}; the test set must not change")
    if not allow_partial:
        raise SchemaError(f"{len(missing)} of {len(want)} frozen test rows are not labelled yet "
                          f"(e.g. {missing[:3]}); pass --allow-partial-test for an interim result")
    return {"fingerprint": fp, "complete": False}


def load_valid(path: str | Path, labelled: bool = True) -> list[dict]:
    """Read a file and raise on the first invalid record or duplicate id."""
    out, seen = [], set()
    for i, rec in enumerate(read_jsonl(path), 1):
        errs = validate(rec, labelled)
        if rec.get("id") in seen:
            errs.append(f"duplicate id {rec.get('id')!r}")
        if errs:
            raise SchemaError(f"{path} record {i} ({rec.get('id')}): " + "; ".join(errs))
        seen.add(rec["id"])
        out.append(rec)
    return out


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Validate a corpus JSONL file.")
    ap.add_argument("path")
    ap.add_argument("--raw", action="store_true", help="unlabelled records")
    a = ap.parse_args()
    recs = load_valid(a.path, labelled=not a.raw)
    print(f"OK: {len(recs)} valid records in {a.path}")
