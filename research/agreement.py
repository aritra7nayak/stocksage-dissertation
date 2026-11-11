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


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("a")
    ap.add_argument("b")
    args = ap.parse_args()
    print(json.dumps(agreement(args.a, args.b), indent=2))
