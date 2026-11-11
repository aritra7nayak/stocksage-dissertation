"""Run experiments E1–E3 on a labelled split and write a report.

    python -m research.evaluate --gold data/corpus/labelled.jsonl --split test \
        --pred finbert_ft=reports/preds_finbert_ft.jsonl --finbert

E1 sentiment:      keyword baseline, generic FinBERT (--finbert), each --pred model
E2 event/severity: keyword classifier, each --pred model that has "events"
E3 entity linking: substring baseline vs. entity linker

Every comparison against the strongest baseline gets a McNemar test (E1) and
a paired-bootstrap CI on the metric difference (E1, E2). Output: a JSON file
with every number and a Markdown summary for the report.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from research import ROOT, baselines, metrics, schema


def _e1(recs, preds_by_model):
    gold = [r["sentiment"] for r in recs]
    labels = list(schema.SENTIMENTS)

    def mf1(g, p):
        return metrics.macro_f1(g, p, labels)

    out = {}
    for name, pred in preds_by_model.items():
        out[name] = {"macro_f1": metrics.bootstrap_ci(mf1, gold, pred),
                     "accuracy": round(metrics.accuracy(gold, pred), 4),
                     "per_class": metrics.per_class(gold, pred, labels),
                     "confusion": {"labels": labels,
                                   "matrix": metrics.confusion(gold, pred, labels).tolist()}}
    ref = "finbert_generic" if "finbert_generic" in preds_by_model else "keyword"
    for name, pred in preds_by_model.items():
        if name not in (ref, "keyword"):
            out[name]["vs_" + ref] = {
                "mcnemar": metrics.mcnemar(gold, preds_by_model[ref], pred),
                "paired_bootstrap_macro_f1": metrics.paired_bootstrap(
                    mf1, gold, preds_by_model[ref], pred)}
    return out


def _e2(recs, event_preds, severity_preds):
    gold_ev = [set(r["events"]) for r in recs]
    labels = list(schema.EVENT_TYPES)
    out = {}
    for name, pred in event_preds.items():
        out[name] = metrics.multilabel_f1(gold_ev, pred, labels)

    gold_halt = [baselines.gold_halt(r) for r in recs]
    kw_halt = [baselines.keyword_halt(r["headline"]) for r in recs]
    non_halt = sum(1 for g in gold_halt if not g)
    out["keyword"]["false_market_halt_rate"] = round(
        sum(1 for g, p in zip(gold_halt, kw_halt) if p and not g) / non_halt, 4) if non_halt else None
    for name, sev in severity_preds.items():
        gold_high = [r["severity"] == "high" for r in recs]
        n_high = sum(gold_high)
        missed = sum(1 for g, p in zip(gold_high, sev) if g and p != "high")
        out.setdefault(name, {})["missed_severe_rate"] = round(missed / n_high, 4) if n_high else None
        out[name]["severity_macro_f1"] = round(metrics.macro_f1(
            [r["severity"] for r in recs], sev, list(schema.SEVERITIES)), 4)
    return out


def _e3(recs):
    gold = [set(r["companies"]) for r in recs]
    return {name: metrics.linking_scores(gold, [link(r["headline"]) for r in recs])
            for name, link in baselines.linkers().items()}


def _markdown(rep) -> str:
    lines = [f"# Evaluation — split `{rep['split']}` ({rep['n']} headlines)", ""]
    lines += ["## E1 Sentiment", "", "| Model | Macro-F1 (95% CI) | Accuracy |", "|---|---|---|"]
    for name, r in rep["E1"].items():
        ci = r["macro_f1"]
        lines.append(f"| {name} | {ci['point']:.3f} ({ci['low']:.3f}–{ci['high']:.3f}) "
                     f"| {r['accuracy']:.3f} |")
    lines += ["", "## E2 Events", "", "| Model | Micro-F1 | Macro-F1 |", "|---|---|---|"]
    for name, r in rep["E2"].items():
        if "micro_f1" in r:
            lines.append(f"| {name} | {r['micro_f1']:.3f} | {r['macro_f1']:.3f} |")
    lines += ["", "## E3 Entity linking", "",
              "| Linker | Precision | Recall | F1 | Misattribution rate |", "|---|---|---|---|---|"]
    for name, r in rep["E3"].items():
        lines.append(f"| {name} | {r['precision']:.3f} | {r['recall']:.3f} | {r['f1']:.3f} "
                     f"| {r['misattribution_rate']:.3f} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--split", default="test", choices=schema.SPLITS)
    ap.add_argument("--finbert", action="store_true", help="also score the generic FinBERT (slow)")
    ap.add_argument("--pred", action="append", default=[], metavar="NAME=PATH",
                    help="predictions JSONL from a trained model (repeatable)")
    ap.add_argument("--out", default=str(ROOT / "reports"))
    ap.add_argument("--manifest", default=str(ROOT / "data" / "corpus" / "test_manifest.json"))
    ap.add_argument("--allow-partial-test", action="store_true",
                    help="interim result while some frozen test rows are still unlabelled")
    a = ap.parse_args(argv)

    all_recs = schema.load_valid(a.gold)
    frozen = schema.check_test_frozen(all_recs, a.manifest, a.allow_partial_test)
    recs = [r for r in all_recs if r.get("split") == a.split]
    if not recs:
        raise SystemExit(f"no records with split={a.split!r} in {a.gold}")
    heads = [r["headline"] for r in recs]

    sent = {"keyword": [baselines.keyword_sentiment(h) for h in heads]}
    events = {"keyword": [baselines.keyword_events(h) for h in heads]}
    sev = {"keyword": [baselines.keyword_severity(h) for h in heads]}
    if a.finbert:
        sent["finbert_generic"] = baselines.finbert_sentiment(heads)
    for spec in a.pred:
        name, path = spec.split("=", 1)
        preds = baselines.load_predictions(path)
        missing = [r["id"] for r in recs if r["id"] not in preds]
        if missing:
            raise SystemExit(f"{name}: no prediction for {len(missing)} ids, e.g. {missing[:3]}")
        if "sentiment" in preds[recs[0]["id"]]:
            sent[name] = [preds[r["id"]]["sentiment"] for r in recs]
        if "events" in preds[recs[0]["id"]]:
            events[name] = [set(preds[r["id"]]["events"]) for r in recs]
        if "severity" in preds[recs[0]["id"]]:
            sev[name] = [preds[r["id"]]["severity"] for r in recs]

    rep = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "gold": str(a.gold), "gold_sha256": schema.file_sha256(a.gold),
           "test_fingerprint": frozen["fingerprint"], "test_complete": frozen["complete"],
           "split": a.split, "n": len(recs),
           "E1": _e1(recs, sent), "E2": _e2(recs, events, sev), "E3": _e3(recs)}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"eval_{a.split}.json").write_text(json.dumps(rep, indent=2), encoding="utf-8")
    (out / f"eval_{a.split}.md").write_text(_markdown(rep), encoding="utf-8")
    print(_markdown(rep))
    return rep


if __name__ == "__main__":
    main()
