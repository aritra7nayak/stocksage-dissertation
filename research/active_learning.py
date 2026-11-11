"""Active learning: choose the next headlines to label, then fold them into training.

    # 1. pick 300 headlines the champion is least sure about
    python -m research.active_learning batch data/raw/live_feed.jsonl data/raw/gdelt.jsonl
    # 2. label data/corpus/sheet_al_round_<k>.csv (same guidelines), then import it
    python -m research.build_sample import data/corpus/sheet_al_round_1.csv --annotator A \
        --sample data/annotation/al_round_1.jsonl --to data/annotation/al_round_1_labels.jsonl
    # 3. add the labelled rows to the training split of the gold file
    python -m research.active_learning merge data/annotation/al_round_1_labels.jsonl
    # 4. retrain, register, gate, shadow, promote (research/README.md, "Retraining loop")

Acquisition: margin uncertainty, 1 - (p_top - p_second), from the serving
champion (models/serving.json, or the pinned FinBERT), plus a bonus when the
shadow model disagrees with the champion. Diversity: at most one headline per
near-duplicate key and at most --max-source-share of the batch per publisher.

Leakage rules: new rows only ever join the train split. Any pool headline
that matches a sample headline, or shares a near-duplicate key with a test
headline, is excluded, and `merge` re-checks the frozen test fingerprint.
"""
import argparse
import json
import math
import random
import re
from collections import Counter
from pathlib import Path

import numpy as np

from research import ROOT, schema
from research.build_sample import story_keys

ANNOTATION = ROOT / "data" / "annotation"
CORPUS = ROOT / "data" / "corpus"


def _norm(h: str) -> str:
    return " ".join("".join(ch for ch in h.lower() if ch.isalnum() or ch == " ").split())


def near_key(h: str, k: int = 8) -> str:
    """First k normalised words: catches re-titled syndicated copies
    ("Sensex falls 500 points as ... | Mint" vs "... - Moneycontrol")."""
    return " ".join(_norm(h).split()[:k])


def _test_story_keys(recs: list[dict]) -> set[str]:
    return {k for r in recs if r.get("split") == "test" for k in story_keys(r["headline"])}


def _same_story(headline: str, keys: set[str]) -> bool:
    return any(k in keys for k in story_keys(headline))


def margin_uncertainty(probs: np.ndarray) -> np.ndarray:
    if len(probs) == 0:
        return np.zeros(0)
    top2 = np.sort(probs, axis=1)[:, -2:]
    return 1.0 - (top2[:, 1] - top2[:, 0])


def build_pool(raw_paths: list[str], sample: list[dict]) -> list[dict]:
    seen_ids = {r["id"] for r in sample}
    seen_norm = {_norm(r["headline"]) for r in sample}
    test_keys = _test_story_keys(sample)
    pool, keys = [], set()
    for p in raw_paths:
        for rec in schema.read_jsonl(p):
            if schema.validate(rec, labelled=False) or rec["id"] in seen_ids:
                continue
            n = _norm(rec["headline"])
            if n in seen_norm or _same_story(rec["headline"], test_keys) or n in keys:
                continue
            keys.add(n)
            pool.append(rec)
    return pool


def select(pool: list[dict], uncertainty: np.ndarray, n: int, disagree: np.ndarray | None = None,
           max_source_share: float = 0.4, disagreement_bonus: float = 0.5) -> list[dict]:
    score = uncertainty + (disagreement_bonus * disagree if disagree is not None else 0)
    cap = max(1, math.ceil(n * max_source_share))
    per_source, used_keys, out = Counter(), set(), []
    for i in np.argsort(-score, kind="stable"):
        r = pool[int(i)]
        key = near_key(r["headline"])
        if key in used_keys or per_source[r["source"]] >= cap:
            continue
        used_keys.add(key)
        per_source[r["source"]] += 1
        out.append({**r, "al_score": round(float(score[i]), 4),
                    "al_disagree": bool(disagree[i]) if disagree is not None else None})
        if len(out) == n:
            break
    return out


def _serving_models() -> tuple[tuple[str, str | None], tuple[str, str | None] | None]:
    """(champion, shadow) as (model path or hub id, revision)."""
    from app.config import get_settings
    s = get_settings()
    doc = {}
    p = ROOT / "models" / "serving.json"
    if p.exists():
        doc = json.loads(p.read_text(encoding="utf-8"))

    def ref(entry):
        return (str(ROOT / entry["path"]) if not Path(entry["path"]).is_absolute() else entry["path"], None)
    champ = ref(doc["champion"]) if doc.get("champion") else (s.finbert_model, s.finbert_revision or None)
    return champ, (ref(doc["shadow"]) if doc.get("shadow") else None)


def next_round() -> int:
    nums = [int(m.group(1)) for f in ANNOTATION.glob("al_round_*.jsonl")
            if (m := re.fullmatch(r"al_round_(\d+)\.jsonl", f.name))]
    return 1 + max(nums, default=0)


def batch(raw: list[str], sample_path: Path, n: int, pool_size: int, seed: int,
          max_source_share: float) -> Path:
    from research import infer
    from research.build_sample import write_sheet

    sample = list(schema.read_jsonl(sample_path))
    pool = build_pool(raw, sample)
    random.Random(seed).shuffle(pool)
    pool = pool[:pool_size]
    heads = [r["headline"] for r in pool]
    (champ, rev), shadow = _serving_models()
    print(f"scoring {len(pool)} pool headlines with {champ}" + (f" and shadow {shadow[0]}" if shadow else ""))
    labels, probs = infer.predict_proba(champ, heads, revision=rev)
    disagree = None
    if shadow:
        s_labels, s_probs = infer.predict_proba(shadow[0], heads, revision=shadow[1])
        disagree = (np.array(infer.labels_from_proba(labels, probs))
                    != np.array(infer.labels_from_proba(s_labels, s_probs))).astype(float)
    chosen = select(pool, margin_uncertainty(probs), n, disagree, max_source_share)
    k = next_round()
    for r in chosen:
        r.update(split="train", double_annotate=False, al_round=k)
    out = ANNOTATION / f"al_round_{k}.jsonl"
    schema.write_jsonl(out, chosen)
    write_sheet(CORPUS / f"sheet_al_round_{k}.csv", chosen)
    print(json.dumps({"round": k, "selected": len(chosen), "pool": len(pool),
                      "mean_uncertainty_selected": round(float(np.mean([r["al_score"] for r in chosen])), 4)
                      if chosen else None,
                      "sources": dict(Counter(r["source"] for r in chosen))}))
    print(f"wrote {out} and {CORPUS / f'sheet_al_round_{k}.csv'}")
    return out


def merge(labels_path: Path, gold_path: Path, manifest: Path) -> dict:
    """Append labelled active-learning rows to the gold file's train split."""
    gold = schema.load_valid(gold_path)
    before = schema.check_test_frozen(gold, manifest, allow_partial=True)["fingerprint"]
    have = {r["id"] for r in gold}
    test_keys = _test_story_keys(gold)
    new, skipped = [], Counter()
    for r in schema.load_valid(labels_path):
        if r.get("split") != "train":
            raise schema.SchemaError(f"{r['id']}: active-learning rows must be split=train")
        if r["id"] in have:
            skipped["already in gold"] += 1
        elif _same_story(r["headline"], test_keys):
            skipped["near-duplicate of a test headline"] += 1
        else:
            new.append(r)
    merged = gold + new
    if schema.test_fingerprint(merged) != before:
        raise schema.SchemaError("merge would change the test split; nothing written")
    schema.write_jsonl(gold_path, merged)
    stats = {"added": len(new), "skipped": dict(skipped), "gold_rows": len(merged)}
    print(json.dumps(stats))
    return stats


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("batch", help="select the next headlines to label")
    b.add_argument("raw", nargs="+")
    b.add_argument("--sample", default=str(CORPUS / "sample.jsonl"))
    b.add_argument("--n", type=int, default=300)
    b.add_argument("--pool-size", type=int, default=20000, help="random subset of the pool to score")
    b.add_argument("--max-source-share", type=float, default=0.4)
    b.add_argument("--seed", type=int, default=7)
    m = sub.add_parser("merge", help="add labelled rows to the gold train split")
    m.add_argument("labels")
    m.add_argument("--gold", default=str(CORPUS / "labelled.jsonl"))
    m.add_argument("--manifest", default=str(CORPUS / "test_manifest.json"))
    a = ap.parse_args(argv)
    if a.cmd == "batch":
        batch(a.raw, Path(a.sample), a.n, a.pool_size, a.seed, a.max_source_share)
    else:
        merge(Path(a.labels), Path(a.gold), Path(a.manifest))


if __name__ == "__main__":
    main()
