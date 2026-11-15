"""Draw the annotation sample, fix the splits and write labelling sheets.

    python -m research.build_sample sample data/raw/live_feed.jsonl data/raw/gdelt.jsonl \
        --n 3000 --double 300
    python -m research.build_sample import data/corpus/sheet_annotator_a.csv \
        --annotator A --to data/annotation/annotator_a.jsonl
    python -m research.build_sample prefill    # optional: LLM pre-labels into sheet A
    python -m research.build_sample import-db --annotator A \
        --to data/annotation/annotator_a.jsonl  # labels saved in the app's Research tab

Steps:
1. Merge raw files, validate, and group copies of one story (same first or
   last 8 normalised words, see story_keys), keeping the earliest copy, so
   a story can never be in two splits.
2. Draw --n headlines with a fixed seed, balancing publishers.
3. Assign train/dev/test (70/15/15). The test split is frozen from here on:
   every experiment reads it and no model is ever tuned on it.
4. Mark a --double subset, drawn evenly from all splits, that the second
   annotator labels independently for Cohen's kappa.
5. Write data/corpus/sample.jsonl plus CSV sheets for annotators.

The CSV sheets are deliberately blank. In particular the `companies` column is
never pre-filled by the entity linker: the gold links must not be produced by
the system that E3 evaluates.

`prefill` copies LLM pre-labels (research/prelabel.py) into sheet A for the
eligible rows only (train/dev, not double-annotated) and never touches
companies or sectors. A pre-filled row counts only once the annotator has
reviewed it and typed `y` in the `checked` column; import then marks it
`human_verified` and reports how often each field was changed.
"""
import argparse
import csv
import json
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from research import ROOT, schema
from research.prelabel import FIELDS as PRELABEL_FIELDS, eligible

SHEET_COLUMNS = ["id", "headline", "source", "published_at", "sentiment", "events",
                 "severity", "scope", "companies", "sectors", "notes", "checked"]


def _norm(h: str) -> str:
    return " ".join("".join(ch for ch in h.lower() if ch.isalnum() or ch == " ").split())


STORY_WORDS = 8


def story_keys(h: str, k: int = STORY_WORDS) -> tuple[str, ...]:
    """Keys shared by re-worded copies of one story: the first and the last k
    normalised words. Syndicated and re-titled copies usually keep one end
    ("Sensex falls 500 points as banks drag | Mint" vs "... - Moneycontrol",
    "Stock market today: Sensex falls 500 points as banks drag")."""
    words = _norm(h).split()
    if len(words) <= k:
        return (" ".join(words),)
    return ("^" + " ".join(words[:k]), " ".join(words[-k:]) + "$")


def group_stories(recs: list[dict]) -> list[list[dict]]:
    """Union-find over story_keys: each group is one story in all its copies."""
    parent = list(range(len(recs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner: dict[str, int] = {}
    for i, r in enumerate(recs):
        for key in story_keys(r["headline"]):
            if key in owner:
                parent[find(i)] = find(owner[key])
            else:
                owner[key] = i
    groups: dict[int, list[dict]] = defaultdict(list)
    for i, r in enumerate(recs):
        groups[find(i)].append(r)
    return list(groups.values())


# The live feed names feeds ("Economic Times Markets") and GDELT names hosts
# ("economictimes.indiatimes.com"). Balancing on the raw name counted one
# publisher several times and drew the small live feed ~50x too often.
_PUBLISHERS = (("economic times", "economictimes"), ("economictimes", "economictimes"), ("livemint", "livemint"), ("mint", "livemint"),
               ("business standard", "business-standard"), ("business-standard", "business-standard"),
               ("businessline", "businessline"), ("financial express", "financialexpress"),
               ("financialexpress", "financialexpress"), ("moneycontrol", "moneycontrol"))


def publisher(source: str) -> str:
    s = source.lower()
    return next((p for needle, p in _PUBLISHERS if needle in s), s)


def _ts(rec: dict) -> datetime:
    return datetime.fromisoformat(rec["published_at"])


def build(paths: list[str], n: int, n_double: int, seed: int, out_dir: Path) -> dict:
    records = []
    for p in paths:
        records += [rec for rec in schema.read_jsonl(p) if not schema.validate(rec, labelled=False)]
    # One headline per story (its earliest copy), so no story can sit in both
    # train and test: a model tested on a re-worded copy of a training
    # headline would look better than it is.
    stories = group_stories(records)
    pool = sorted((min(g, key=_ts) for g in stories), key=lambda r: r["id"])
    rng = random.Random(seed)

    by_source: dict[str, list] = defaultdict(list)
    for r in pool:
        r["publisher"] = publisher(r["source"])
        by_source[r["publisher"]].append(r)
    for recs in by_source.values():
        rng.shuffle(recs)
    sample: list[dict] = []
    while len(sample) < min(n, len(pool)):            # round-robin across publishers
        for src in sorted(by_source):
            if by_source[src] and len(sample) < n:
                sample.append(by_source[src].pop())
    rng.shuffle(sample)

    n_test = n_dev = round(len(sample) * 0.15)
    for i, r in enumerate(sample):
        r["split"] = "test" if i < n_test else "dev" if i < n_test + n_dev else "train"
    double_ids = {r["id"] for r in rng.sample(sample, min(n_double, len(sample)))}
    for r in sample:
        r["double_annotate"] = r["id"] in double_ids

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / "test_manifest.json"
    if manifest.exists():
        raise SystemExit(f"{manifest} exists: the test split is already frozen. Delete it only "
                         "if you really mean to re-draw the test set (and say so in the report).")
    schema.write_jsonl(out_dir / "sample.jsonl", sample)
    schema.write_test_manifest(manifest, sample, seed)
    write_sheet(out_dir / "sheet_annotator_a.csv", sample)
    write_sheet(out_dir / "sheet_annotator_b.csv", [r for r in sample if r["double_annotate"]])
    stats = {"records": len(records), "pool": len(pool), "sample": len(sample),
             "splits": {s: sum(r["split"] == s for r in sample) for s in schema.SPLITS},
             "double_annotated": len(double_ids)}
    print(stats)
    return stats


def write_sheet(path: Path, recs: list[dict]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:   # BOM: opens cleanly in Excel
        w = csv.DictWriter(fh, SHEET_COLUMNS)
        w.writeheader()
        for r in recs:
            w.writerow({c: r.get(c, "") for c in SHEET_COLUMNS[:4]})


def _cell(lab: dict, field: str) -> str:
    return ";".join(lab[field]) if field == "events" else lab[field]


def prefill_record(sheet: str | Path) -> Path:
    """Sidecar listing the rows prefill actually wrote, so import knows which
    rows the annotator saw pre-filled (a pre-label that arrived after a row
    was labelled by hand was never shown and must not count)."""
    return Path(sheet).with_suffix(".prefilled.json")


def _read_record(sheet: str | Path) -> set[str] | None:
    p = prefill_record(sheet)
    return set(json.loads(p.read_text(encoding="utf-8"))) if p.exists() else None


def prefill(sheet: Path, sample_path: Path, prelabels_path: Path) -> dict:
    """Write LLM pre-labels into sheet A, into rows not yet labelled only.
    Safe to re-run as more pre-labels arrive: labelled rows, rows already
    pre-filled once and every other column (companies, notes) are kept."""
    with open(sheet, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    base = {r["id"]: r for r in schema.read_jsonl(sample_path)}
    labels = {r["id"]: r for r in schema.read_jsonl(prelabels_path)}
    record = _read_record(sheet) or set()
    n = 0
    for row in rows:
        lab = labels.get(row["id"])
        untouched = not any((row.get(f) or "").strip() for f in (*PRELABEL_FIELDS, "checked"))
        if lab and eligible(base[row["id"]]) and untouched and row["id"] not in record:
            row.update({f: _cell(lab, f) for f in PRELABEL_FIELDS})
            record.add(row["id"])
            n += 1
    try:
        with open(sheet, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, SHEET_COLUMNS)
            w.writeheader()
            for row in rows:
                w.writerow({c: row.get(c, "") for c in SHEET_COLUMNS})
    except PermissionError:
        raise SystemExit(f"{sheet} is open in another program (Excel?). Save and close it, "
                         "then run prefill again.") from None
    prefill_record(sheet).write_text(json.dumps(sorted(record)), encoding="utf-8")
    print(f"pre-filled {n} more rows ({len(record)} in total) of {len(rows)} in {sheet}")
    return {"prefilled": n, "total_prefilled": len(record), "rows": len(rows)}


def read_sheet(path: str | Path, annotator: str, sample_path: str | Path,
               prelabels_path: str | Path | None = None) -> list[dict]:
    """Turn a filled CSV sheet back into validated labelled JSONL records.
    Multi-value cells (events, companies, sectors) are ';'-separated.

    With prelabels_path, rows that were pre-filled are kept only when
    `checked` is y (origin human_verified), and the share of pre-labels the
    annotator changed is printed per field."""
    base = {r["id"]: r for r in schema.read_jsonl(sample_path)}
    pre = ({r["id"]: r for r in schema.read_jsonl(prelabels_path)}
           if prelabels_path and Path(prelabels_path).exists() else {})
    shown = _read_record(path)                # None: sheet from before the record existed
    out, problems, unchecked = [], [], 0
    changed = {f: 0 for f in PRELABEL_FIELDS}
    n_verified = 0
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if not row.get("sentiment"):
                continue                                  # not labelled yet
            was_shown = row["id"] in shown if shown is not None else eligible(base[row["id"]])
            lab = pre.get(row["id"]) if was_shown else None
            if lab and (row.get("checked") or "").strip().lower() not in ("y", "yes"):
                unchecked += 1                            # pre-filled but not reviewed
                continue
            rec = dict(base[row["id"]])

            def split_cell(v):
                return [x.strip() for x in (v or "").split(";") if x.strip()]

            rec.update(sentiment=row["sentiment"].strip().lower(),
                       events=[e.lower() for e in split_cell(row["events"])] or ["other"],
                       severity=(row["severity"] or "none").strip().lower(),
                       scope=(row["scope"] or "none").strip().lower(),
                       companies=[c.upper() if c.upper().endswith(".NS") else c.upper() + ".NS"
                                  for c in split_cell(row["companies"])],
                       sectors=split_cell(row["sectors"]),
                       annotator=annotator, origin="human_verified" if lab else "human",
                       notes=row.get("notes") or None)
            if lab:
                n_verified += 1
                for f in PRELABEL_FIELDS:
                    changed[f] += (sorted(rec[f]) if f == "events" else rec[f]) != lab[f]
            errs = schema.validate(rec)
            if errs:
                problems.append(f"{row['id']}: {'; '.join(errs)}")
            out.append(rec)
    if problems:
        raise schema.SchemaError("Sheet has invalid rows:\n  " + "\n  ".join(problems))
    if unchecked:
        print(f"skipped {unchecked} pre-filled rows not yet marked checked=y")
    if n_verified:
        print("pre-labels changed by the annotator: " + json.dumps(
            {f: f"{c / n_verified:.1%}" for f, c in changed.items()}) + f" (n={n_verified})")
    return out


B_SUBSET_NAME = "b_subset.json"


def read_b_subset(path: str | Path) -> set[str] | None:
    p = Path(path)
    return set(json.loads(p.read_text(encoding="utf-8"))["ids"]) if p.exists() else None


def draw_b_subset(sample_path: str | Path, out: str | Path, n: int, seed: int, split: str = "test") -> dict:
    """Annotator B's rows (guidelines v1.4): n rows of one split, drawn with a
    fixed seed so the draw is reproducible. Refuses to redraw over an existing
    file, because B may already have labelled the old draw."""
    out = Path(out)
    if out.exists():
        raise SystemExit(f"{out} exists; delete it deliberately to redraw")
    pool = sorted(r["id"] for r in schema.read_jsonl(sample_path) if r.get("split") == split)
    if n > len(pool):
        raise SystemExit(f"only {len(pool)} {split} rows")
    ids = sorted(random.Random(seed).sample(pool, n))
    doc = {"n": n, "seed": seed, "split": split, "drawn_at": datetime.now().astimezone().isoformat(timespec="seconds"),
           "ids": ids}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return doc


def labels_to_records(rows: list[dict], annotator: str, sample_path: str | Path) -> list[dict]:
    """Rows of the `annotations` table (Research tab) -> validated labelled
    records. A row saved with a stored pre-label was reviewed from it in the
    browser (saving is the review), so it is human_verified."""
    base = {r["id"]: r for r in schema.read_jsonl(sample_path)}
    b_ids = read_b_subset(Path(sample_path).parent.parent / "annotation" / B_SUBSET_NAME)
    out, problems, n_verified = [], [], 0
    fields = PRELABEL_FIELDS + ("companies", "sectors")
    changed = {f: 0 for f in fields}
    for row in rows:
        rid, lab = row["item_id"], row.get("prelabel")
        if rid not in base:
            problems.append(f"{rid}: not in the sample")
            continue
        in_b = rid in b_ids if b_ids is not None else base[rid].get("double_annotate")
        if annotator == "B" and not in_b:
            problems.append(f"{rid}: annotator B labelled a row outside the double subset")
        if lab and not eligible(base[rid]):
            problems.append(f"{rid}: a pre-label was shown on a row that must start blank")
        rec = dict(base[rid])
        rec.update(sentiment=row["sentiment"], events=sorted(row["events"]),
                   severity=row["severity"], scope=row["scope"], companies=list(row["companies"]),
                   sectors=list(row["sectors"]), annotator=annotator,
                   origin="human_verified" if lab else "human", notes=row.get("notes") or None)
        if lab:
            n_verified += 1
            for f in fields:
                if f not in lab:                         # older pre-labels had four fields
                    continue
                mine, shown = rec[f], lab[f]
                changed[f] += (sorted(mine) if isinstance(mine, list) else mine) != (
                    sorted(shown) if isinstance(shown, list) else shown)
        errs = schema.validate(rec)
        if errs:
            problems.append(f"{rid}: {'; '.join(errs)}")
        out.append(rec)
    if problems:
        raise schema.SchemaError("Invalid labels:\n  " + "\n  ".join(problems))
    if n_verified:
        print("pre-labels changed by the annotator: " + json.dumps(
            {f: f"{c / n_verified:.1%}" for f, c in changed.items()}) + f" (n={n_verified})")
    return out


def assemble_gold(human: list[dict], sample_path: str | Path, prelabels_path: str | Path | None,
                  silver: bool = True) -> list[dict]:
    """The training/evaluation file (data/corpus/labelled.jsonl).

    Human labels (annotator A's export) win wherever they exist. With `silver`,
    train and dev rows nobody has reviewed take the LLM pre-label, marked
    origin=llm_prelabel so every report can count or exclude them. Test rows
    are only ever human-labelled: an unreviewed test row is left out, and
    evaluation reports the test split as partial until all are done."""
    base = [r for r in schema.read_jsonl(sample_path)]
    by_human = {r["id"]: r for r in human}
    pre = ({r["id"]: r for r in schema.read_jsonl(prelabels_path)}
           if silver and prelabels_path and Path(prelabels_path).exists() else {})
    out, problems = [], []
    for rec in base:
        if rec["id"] in by_human:
            out.append(by_human[rec["id"]])
            continue
        lab = pre.get(rec["id"])
        if rec.get("split") == "test" or not lab:
            continue
        r = dict(rec) | {f: lab.get(f, []) for f in ("sentiment", "events", "severity", "scope",
                                                     "companies", "sectors")}
        r.update(annotator="LLM", origin="llm_prelabel", model=lab.get("model"))
        errs = schema.validate(r)
        if errs:
            problems.append(f"{r['id']}: {'; '.join(errs)}")
        out.append(r)
    if problems:
        raise schema.SchemaError("invalid pre-labels:\n  " + "\n  ".join(problems[:20]))
    counts = defaultdict(lambda: defaultdict(int))
    for r in out:
        counts[r["split"]][r.get("origin") or "human"] += 1
    print(json.dumps({s: dict(c) for s, c in counts.items()}))
    return out


def read_db(db_url: str, annotator: str, sample_path: str | Path) -> list[dict]:
    import psycopg2
    import psycopg2.extras

    try:
        conn = psycopg2.connect(db_url)
    except psycopg2.OperationalError:
        raise SystemExit("Cannot reach the database. Start it first (start.bat).") from None
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT to_regclass('annotations') IS NOT NULL AS ok")
        if not cur.fetchone()["ok"]:
            raise SystemExit("No annotations table yet: start the API once, then label in the Research tab.")
        cur.execute("SELECT item_id, sentiment, events, severity, scope, companies, sectors, notes, prelabel"
                    " FROM annotations WHERE annotator = %s ORDER BY item_id", (annotator,))
        rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return labels_to_records(rows, annotator, sample_path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    smp = sub.add_parser("sample", help="draw the sample and write blank sheets")
    smp.add_argument("raw", nargs="+")
    smp.add_argument("--n", type=int, default=3000)
    smp.add_argument("--double", type=int, default=300)
    smp.add_argument("--seed", type=int, default=20261108)
    smp.add_argument("--out", default=str(ROOT / "data" / "corpus"))
    imp = sub.add_parser("import", help="convert a filled sheet to labelled JSONL")
    imp.add_argument("sheet")
    imp.add_argument("--annotator", required=True)
    imp.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    imp.add_argument("--to", required=True)
    imp.add_argument("--prelabels", default=str(ROOT / "data" / "annotation" / "prelabels.jsonl"))
    idb = sub.add_parser("import-db", help="export labels saved in the Research tab to labelled JSONL")
    idb.add_argument("--annotator", required=True, choices=["A", "B"])
    idb.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    idb.add_argument("--to", required=True)
    idb.add_argument("--db", default=None, help="default: DATABASE_URL_SYNC or the local database")
    gd = sub.add_parser("gold", help="annotator A's labels + LLM silver for unreviewed train/dev rows")
    gd.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    gd.add_argument("--prelabels", default=str(ROOT / "data" / "annotation" / "prelabels.jsonl"))
    gd.add_argument("--to", default=str(ROOT / "data" / "corpus" / "labelled.jsonl"))
    gd.add_argument("--no-silver", dest="silver", action="store_false",
                    help="human labels only (the silver-vs-human ablation)")
    gd.add_argument("--db", default=None)
    bs = sub.add_parser("b-subset", help="draw annotator B's rows (seeded) into data/annotation/b_subset.json")
    bs.add_argument("--n", type=int, default=120)
    bs.add_argument("--seed", type=int, default=20261115)
    bs.add_argument("--split", default="test", choices=schema.SPLITS)
    bs.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    bs.add_argument("--to", default=str(ROOT / "data" / "annotation" / B_SUBSET_NAME))
    pf = sub.add_parser("prefill", help="copy LLM pre-labels into the blank sheet A")
    pf.add_argument("--sheet", default=str(ROOT / "data" / "corpus" / "sheet_annotator_a.csv"))
    pf.add_argument("--sample", default=str(ROOT / "data" / "corpus" / "sample.jsonl"))
    pf.add_argument("--prelabels", default=str(ROOT / "data" / "annotation" / "prelabels.jsonl"))
    a = ap.parse_args()
    if a.cmd in ("import-db", "gold"):
        import os

        from dotenv import load_dotenv

        from research.export_news import DEFAULT_DB
        load_dotenv(ROOT / ".env")
        db = a.db or os.environ.get("DATABASE_URL_SYNC", DEFAULT_DB)
        if a.cmd == "import-db":
            recs = read_db(db, a.annotator, a.sample)
        else:
            recs = assemble_gold(read_db(db, "A", a.sample), a.sample, a.prelabels, a.silver)
        print(f"{schema.write_jsonl(a.to, recs)} labelled records -> {a.to}")
    elif a.cmd == "b-subset":
        doc = draw_b_subset(a.sample, a.to, a.n, a.seed, a.split)
        print(f"{doc['n']} {doc['split']} rows (seed {doc['seed']}) -> {a.to}")
    elif a.cmd == "prefill":
        prefill(Path(a.sheet), Path(a.sample), Path(a.prelabels))
    elif a.cmd == "import":
        recs = read_sheet(a.sheet, a.annotator, a.sample, a.prelabels)
        print(f"{schema.write_jsonl(a.to, recs)} labelled records -> {a.to}")
    else:
        build(a.raw, a.n, a.double, a.seed, Path(a.out))
