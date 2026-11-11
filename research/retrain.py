"""One retraining round: train -> register -> gate -> shadow.

    python -m research.retrain --model ProsusAI/finbert --revision 4556d13015211d73dccd3fdd39d39232506f3e43 \
        --out models/finbert-in-r2

Trains on the current gold file (after `active_learning merge`), registers the
result, runs the promotion gate against the champion on the frozen test set
and, if it passes, puts it in shadow so it scores live headlines beside the
champion. Promotion stays a separate, deliberate step after the shadow period:

    python -m research.drift                      # disagreement, live behaviour
    python -m research.registry promote <version>

A candidate that fails the gate stays registered (stage candidate) with its
gate report, so a failed round is recorded, not lost.
"""
import argparse
from pathlib import Path

from research import ROOT, registry, train_classifier


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--task", choices=registry.TASKS, default="sentiment")
    ap.add_argument("--model", required=True, help="start point (hub id or local dir)")
    ap.add_argument("--revision", default=None)
    ap.add_argument("--gold", default=str(ROOT / "data" / "corpus" / "labelled.jsonl"))
    ap.add_argument("--manifest", default=str(registry.MANIFEST))
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", dest="max_len", type=int, default=64)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--no-shadow", action="store_true", help="gate only; do not deploy as shadow")
    a = ap.parse_args(argv)

    log = train_classifier.train(a)
    print(f"trained: best dev macro-F1 {log['best_dev_macro_f1']}")
    reg = registry.Registry()
    entry = reg.register(Path(a.out), a.task)
    print(f"registered v{entry['version']}")
    res = registry.run_gate(reg, a.task, entry["version"], Path(a.gold), Path(a.manifest))
    print(registry._gate_md(res))
    if not res["passed"]:
        print(f"v{entry['version']} stays a candidate: {', '.join(res['failed'])}")
        return 1
    if not a.no_shadow and a.task == "sentiment":
        reg.set_shadow(a.task, entry["version"])
        print(f"v{entry['version']} is now the shadow; promote it after the shadow period")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
