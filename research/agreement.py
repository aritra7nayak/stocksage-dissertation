"""Inter-annotator agreement on the double-annotated subset.

    python -m research.agreement data/annotation/annotator_a.jsonl data/annotation/annotator_b.jsonl

Reports Cohen's kappa for sentiment, severity and scope, a per-event-type
kappa (each event treated as present/absent), and Jaccard agreement on the
linked companies. Items are matched by id; only ids labelled by both count.
"""
import argparse
import json

from research import metrics, schema


def agreement(a_path: str, b_path: str) -> dict:
    a = {r["id"]: r for r in schema.load_valid(a_path)}
    b = {r["id"]: r for r in schema.load_valid(b_path)}
    ids = sorted(set(a) & set(b))
    if not ids:
        raise SystemExit("the two files share no ids")
    out = {"items": len(ids), "annotators": [a[ids[0]]["annotator"], b[ids[0]]["annotator"]]}
    for field in ("sentiment", "severity", "scope"):
        out[field] = metrics.cohen_kappa([a[i][field] for i in ids], [b[i][field] for i in ids])
    # 95% bootstrap CI on the headline number (sentiment kappa), for the report
    out["sentiment_ci"] = metrics.bootstrap_ci(metrics.cohen_kappa, [a[i]["sentiment"] for i in ids],
                                               [b[i]["sentiment"] for i in ids], n_boot=2000)
    out["raw_agreement"] = {f: round(sum(a[i][f] == b[i][f] for i in ids) / len(ids), 4)
                            for f in ("sentiment", "severity", "scope")}
    out["events"] = {ev: metrics.cohen_kappa([ev in a[i]["events"] for i in ids],
                                             [ev in b[i]["events"] for i in ids])
                     for ev in schema.EVENT_TYPES}
    jacc = []
    for i in ids:
        sa, sb = set(a[i]["companies"]), set(b[i]["companies"])
        jacc.append(1.0 if not sa and not sb else len(sa & sb) / len(sa | sb))
    out["companies_mean_jaccard"] = round(sum(jacc) / len(jacc), 4)
    out["disagreements"] = [{"id": i, "headline": a[i]["headline"],
                             "a": a[i]["sentiment"], "b": b[i]["sentiment"]}
                            for i in ids if a[i]["sentiment"] != b[i]["sentiment"]]
    return out


def _mlflow(rep: dict, args) -> None:
    """One run in experiment stocksage-annotation when MLFLOW_TRACKING_URI is set."""
    import os
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return
    try:
        import mlflow
        mlflow.set_experiment("stocksage-annotation")
        with mlflow.start_run(run_name=f"agreement-n{rep['items']}"):
            mlflow.log_params({"items": rep["items"], "a": args.a, "b": args.b})
            mlflow.log_metrics({f"kappa.{f}": rep[f] for f in ("sentiment", "severity", "scope")}
                               | {f"kappa.event.{e}": k for e, k in rep["events"].items() if k == k}
                               | {"kappa.sentiment_low": rep["sentiment_ci"]["low"],
                                  "kappa.sentiment_high": rep["sentiment_ci"]["high"],
                                  "companies_mean_jaccard": rep["companies_mean_jaccard"]})
            mlflow.log_artifact(args.out)
    except Exception as exc:
        print(f"MLflow logging skipped: {exc}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--out", default=None, help="also write the report here (e.g. reports/agreement.json)")
    args = ap.parse_args(argv)
    rep = agreement(args.a, args.b)
    print(json.dumps(rep, indent=2))
    if args.out:
        from pathlib import Path
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(rep, indent=2), encoding="utf-8")
        _mlflow(rep, args)



if __name__ == "__main__":
    main()
