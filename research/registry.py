"""Model registry and evaluation-gated promotion (MLOps lifecycle).

    python -m research.registry register models/finbert-in --task sentiment
    python -m research.registry gate 1 --gold data/corpus/labelled.jsonl
    python -m research.registry shadow 1          # serve beside the champion, log only
    python -m research.registry promote 1 --gold data/corpus/labelled.jsonl
    python -m research.registry rollback          # previous champion, no gate
    python -m research.registry list

Stages: candidate -> (shadow) -> champion -> archived (or rolled_back). models/registry.json is
the source of truth; it is mirrored to the MLflow Model Registry (aliases
"champion" and "shadow") when MLFLOW_TRACKING_URI is set and mlflow is
installed. For the sentiment task the registry also writes
models/serving.json, which the API reads to choose its champion and shadow
models (it reloads on change, no restart needed).

The gate compares the candidate with the current champion (or, before the
first promotion, the pinned generic FinBERT) on the frozen test split:
  1. macro-F1 improves (point estimate, by more than --min-delta),
  2. the paired-bootstrap 95% CI of that improvement excludes 0,
  3. McNemar's test on per-headline correctness gives p < --alpha,
  4. no class loses more than --max-class-drop F1.
All four must hold. Every gate run is a look at the test set; the count is
kept in the registry (`test_set_looks`) so the report can state it.
"""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from research import ROOT, metrics, schema

MODELS = ROOT / "models"
REGISTRY = MODELS / "registry.json"
SERVING = MODELS / "serving.json"
MANIFEST = ROOT / "data" / "corpus" / "test_manifest.json"
BASELINE = "baseline"                 # pseudo-version: the pinned generic FinBERT
TASKS = ("sentiment", "events")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _rel(p: Path) -> str:
    p = Path(p).resolve()
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return str(p)


def _abs(p: str) -> Path:
    q = Path(p)
    return q if q.is_absolute() else ROOT / q


class Registry:
    def __init__(self, path: Path = REGISTRY, serving: Path = SERVING):
        self.path, self.serving = Path(path), Path(serving)
        self.data = (json.loads(self.path.read_text(encoding="utf-8-sig")) if self.path.exists()
                     else {"schema": 1, "tasks": {}})

    def task(self, task: str) -> dict:
        return self.data["tasks"].setdefault(task, {"versions": [], "champion": None, "shadow": None,
                                                    "history": [], "test_set_looks": 0})

    def get(self, task: str, version: int) -> dict:
        for v in self.task(task)["versions"]:
            if v["version"] == version:
                return v
        raise SystemExit(f"{task}: no version {version} (see: python -m research.registry list)")

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2) + "\n", encoding="utf-8")
        self._write_serving()

    def _log(self, task: str, action: str, version, **extra) -> None:
        self.task(task)["history"].append({"at": _now(), "action": action, "version": version, **extra})

    # ── lifecycle ──────────────────────────────────────────────────────────
    def register(self, model_dir: Path, task: str) -> dict:
        model_dir = Path(model_dir)
        log_path = model_dir / "train_log.json"
        if not log_path.exists():
            raise SystemExit(f"{log_path} not found: register a directory written by train_classifier")
        log = json.loads(log_path.read_text(encoding="utf-8"))
        if log.get("task") != task:
            raise SystemExit(f"{model_dir} was trained for task {log.get('task')!r}, not {task!r}")
        from research.train_classifier import weights_sha256
        sha = weights_sha256(model_dir)
        t = self.task(task)
        for v in t["versions"]:
            if v["weights_sha256"] == sha:
                raise SystemExit(f"these weights are already registered as version {v['version']}")
        entry = {"version": 1 + max((v["version"] for v in t["versions"]), default=0),
                 "task": task, "path": _rel(model_dir), "base_model": log.get("model"),
                 "weights_sha256": sha, "gold_sha256": log.get("gold_sha256"),
                 "test_fingerprint": log.get("test_fingerprint"),
                 "best_dev_macro_f1": log.get("best_dev_macro_f1"),
                 "mlflow_run_id": log.get("mlflow_run_id"), "mlflow_version": None,
                 "registered_at": _now(), "stage": "candidate", "gates": []}
        t["versions"].append(entry)
        self._log(task, "register", entry["version"])
        entry["mlflow_version"] = _mlflow_register(entry)
        self.save()
        return entry

    def set_shadow(self, task: str, version: int | None) -> None:
        t = self.task(task)
        if version is not None:
            v = self.get(task, version)
            if v["stage"] == "champion":
                raise SystemExit(f"version {version} is the champion; shadow a candidate")
            v["stage"] = "shadow"
        if t["shadow"] is not None and t["shadow"] != version:
            old = self.get(task, t["shadow"])
            if old["stage"] == "shadow":
                old["stage"] = "candidate"
        t["shadow"] = version
        self._log(task, "shadow" if version is not None else "shadow_clear", version)
        _mlflow_alias(task, "shadow", self.get(task, version) if version is not None else None)
        self.save()

    def promote(self, task: str, version: int, gate: dict) -> None:
        if not gate["passed"]:
            raise SystemExit(f"gate failed for version {version}: {', '.join(gate['failed'])}")
        t = self.task(task)
        if t["champion"] is not None:
            self.get(task, t["champion"])["stage"] = "archived"
        v = self.get(task, version)
        v["stage"] = "champion"
        if t["shadow"] == version:
            t["shadow"] = None
        t["champion"] = version
        t.setdefault("lineage", []).append(version)
        self._log(task, "promote", version, gate=gate["report"])
        _mlflow_alias(task, "champion", v)
        self.save()

    def rollback(self, task: str) -> int | str:
        """Back to the most recently archived champion (or the baseline). No gate:
        this is the emergency path, and it is recorded in the history."""
        t = self.task(task)
        if t["champion"] is None:
            raise SystemExit("no champion to roll back from (already on the baseline)")
        current = self.get(task, t["champion"])
        lineage = t.setdefault("lineage", [])     # champions in promotion order
        if lineage and lineage[-1] == current["version"]:
            lineage.pop()
        current["stage"] = "rolled_back"
        previous = lineage[-1] if lineage else BASELINE
        if previous == BASELINE:
            t["champion"] = None
        else:
            self.get(task, previous)["stage"] = "champion"
            t["champion"] = previous
        self._log(task, "rollback", previous, from_version=current["version"])
        _mlflow_alias(task, "champion", None if previous == BASELINE else self.get(task, previous))
        self.save()
        return previous

    # ── serving file for the API ───────────────────────────────────────────
    def _write_serving(self) -> None:
        t = self.data["tasks"].get("sentiment")
        if not t:
            return

        def ref(version):
            if version is None:
                return None
            v = self.get("sentiment", version)
            return {"path": v["path"], "registry_version": v["version"],
                    "version": f"{Path(v['path']).name}@v{v['version']}:{v['weights_sha256'][:12]}"}

        doc = {"champion": ref(t["champion"]), "shadow": ref(t["shadow"]), "updated_at": _now(),
               "note": "Written by research.registry. champion=null serves the pinned "
                       "FINBERT_MODEL/FINBERT_REVISION from settings."}
        self.serving.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.serving.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.serving)            # the API never reads a half-written file


# ── the gate ───────────────────────────────────────────────────────────────

def _test_records(gold: Path, manifest: Path) -> tuple[list[dict], str]:
    recs = schema.load_valid(gold)
    fp = schema.check_test_frozen(recs, manifest)["fingerprint"]   # strict: complete test set
    test = [r for r in recs if r.get("split") == "test"]
    if not test:
        raise SystemExit(f"no test records in {gold}")
    return test, fp


def _preds(path: Path, test: list[dict], key: str, who: str) -> list:
    if not path.exists():
        raise SystemExit(f"{who}: {path} not found (python -m research.registry predict ...)")
    p = {r["id"]: r for r in schema.read_jsonl(path)}
    missing = [r["id"] for r in test if r["id"] not in p or key not in p[r["id"]]]
    if missing:
        raise SystemExit(f"{who}: no {key} prediction for {len(missing)} test ids, e.g. {missing[:3]} "
                         "(re-predict: python -m research.registry predict ...)")
    return [p[r["id"]][key] for r in test]


def baseline_predictions(test: list[dict], fingerprint: str) -> list[str]:
    """Generic pinned FinBERT on the test split, cached per test fingerprint."""
    cache = MODELS / "baseline" / f"predictions_test_{fingerprint[:12]}.jsonl"
    if not cache.exists():
        from research import baselines
        preds = baselines.finbert_sentiment([r["headline"] for r in test])
        schema.write_jsonl(cache, [{"id": r["id"], "sentiment": p} for r, p in zip(test, preds)])
    return _preds(cache, test, "sentiment", "baseline")


def gate_decision(task: str, gold_labels: list, champion: list, candidate: list,
                  min_delta: float = 0.0, alpha: float = 0.05, max_class_drop: float = 0.05) -> dict:
    """Pure decision function (unit-tested): the four promotion criteria."""
    if task == "sentiment":
        labels = list(schema.SENTIMENTS)

        def score(g, p):
            return metrics.macro_f1(g, p, labels)

        def per_class(p):
            return {k: v["f1"] for k, v in metrics.per_class(gold_labels, p, labels).items()}
        g_cmp, a_cmp, b_cmp = gold_labels, champion, candidate
    else:
        labels = list(schema.EVENT_TYPES)
        gold_labels = [set(x) for x in gold_labels]
        champion, candidate = [set(x) for x in champion], [set(x) for x in candidate]

        def score(g, p):
            return metrics.multilabel_f1(g, p, labels)["macro_f1"]

        def per_class(p):
            return {k: v["f1"] for k, v in metrics.multilabel_f1(gold_labels, p, labels)["per_label"].items()}
        # McNemar on exact-set correctness; sets made hashable for comparison.
        g_cmp = [frozenset(x) for x in gold_labels]
        a_cmp, b_cmp = [frozenset(x) for x in champion], [frozenset(x) for x in candidate]

    boot = metrics.paired_bootstrap(score, gold_labels, champion, candidate)
    mcn = metrics.mcnemar(g_cmp, a_cmp, b_cmp)
    pa, pb = per_class(champion), per_class(candidate)
    drops = {k: round(pa[k] - pb[k], 4) for k in labels if pa[k] - pb[k] > max_class_drop}
    checks = {
        "macro_f1_improves": boot["delta"] > min_delta,
        "bootstrap_ci_excludes_zero": boot["low"] > 0,
        "mcnemar_significant": mcn["c"] > mcn["b"] and mcn["p_value"] < alpha,
        "no_class_regression": not drops,
    }
    return {"passed": all(checks.values()), "checks": checks,
            "failed": [k for k, ok in checks.items() if not ok],
            "champion_macro_f1": round(score(gold_labels, champion), 4),
            "candidate_macro_f1": round(score(gold_labels, candidate), 4),
            "paired_bootstrap": boot, "mcnemar": mcn, "per_class_champion": pa,
            "per_class_candidate": pb, "class_drops": drops,
            "thresholds": {"min_delta": min_delta, "alpha": alpha, "max_class_drop": max_class_drop}}


def run_gate(reg: Registry, task: str, version: int, gold: Path, manifest: Path = MANIFEST,
             out_dir: Path = ROOT / "reports", **thresholds) -> dict:
    key = "sentiment" if task == "sentiment" else "events"
    test, fp = _test_records(gold, manifest)
    cand = reg.get(task, version)
    if cand["test_fingerprint"] not in (None, fp):
        print(f"note: version {version} was trained while the test set was incomplete; "
              "using its current predictions file")
    t = reg.task(task)
    candidate = _preds(_abs(cand["path"]) / "predictions_test.jsonl", test, key, f"v{version}")
    if t["champion"] is not None:
        ch = reg.get(task, t["champion"])
        champion = _preds(_abs(ch["path"]) / "predictions_test.jsonl", test, key, f"v{ch['version']}")
        against = ch["version"]
    elif task == "sentiment":
        champion, against = baseline_predictions(test, fp), BASELINE
    else:
        from research import baselines
        champion, against = [baselines.keyword_events(r["headline"]) for r in test], "keyword"
    gold_labels = [r[key] for r in test]
    res = gate_decision(task, gold_labels, champion, candidate, **thresholds)
    t["test_set_looks"] += 1
    res.update({"task": task, "candidate": version, "against": against, "n_test": len(test),
                "test_fingerprint": fp, "gold_sha256": schema.file_sha256(gold), "at": _now(),
                "test_set_look": t["test_set_looks"]})
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"gate_{task}_v{version}_{t['test_set_looks']}"
    (out_dir / f"{stem}.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    (out_dir / f"{stem}.md").write_text(_gate_md(res), encoding="utf-8")
    res["report"] = _rel(out_dir / f"{stem}.json")
    cand["gates"].append({"at": res["at"], "passed": res["passed"], "against": against,
                          "report": res["report"]})
    reg._log(task, "gate", version, passed=res["passed"], against=against)
    _mlflow_gate(cand, res)
    reg.save()
    return res


def reusable_gate(reg: Registry, task: str, version: int, gold: Path) -> dict | None:
    """The candidate's last gate result if it passed against the current
    champion on the same gold file: promoting after a shadow period then
    costs no further look at the test set."""
    v = reg.get(task, version)
    if not v["gates"] or not v["gates"][-1]["passed"]:
        return None
    path = _abs(v["gates"][-1]["report"])
    if not path.exists():
        return None
    res = json.loads(path.read_text(encoding="utf-8"))
    champion = reg.task(task)["champion"]
    expected = champion if champion is not None else (BASELINE if task == "sentiment" else "keyword")
    if res["against"] != expected or res["gold_sha256"] != schema.file_sha256(gold):
        return None
    res["report"] = v["gates"][-1]["report"]
    return res


def _gate_md(r: dict) -> str:
    b, m = r["paired_bootstrap"], r["mcnemar"]
    lines = [f"# Promotion gate: {r['task']} v{r['candidate']} vs {r['against']}", "",
             f"**{'PASSED' if r['passed'] else 'FAILED'}** on {r['n_test']} frozen test headlines "
             f"(fingerprint `{r['test_fingerprint'][:12]}`, test-set look #{r['test_set_look']})", "",
             "| Check | Result |", "|---|---|"]
    lines += [f"| {k.replace('_', ' ')} | {'pass' if ok else 'FAIL'} |" for k, ok in r["checks"].items()]
    lines += ["", f"Macro-F1: {r['champion_macro_f1']:.4f} -> {r['candidate_macro_f1']:.4f} "
              f"(delta {b['delta']:+.4f}, 95% CI {b['low']:+.4f} to {b['high']:+.4f})",
              f"McNemar: b={m['b']} c={m['c']} chi2={m['chi2']} p={m['p_value']}"]
    if r["class_drops"]:
        lines.append(f"Class F1 drops above threshold: {r['class_drops']}")
    return "\n".join(lines) + "\n"


def predict_test(reg: Registry, task: str, version: int, gold: Path, manifest: Path = MANIFEST) -> Path:
    """(Re)write predictions_test.jsonl for a registered sentiment model."""
    if task != "sentiment":
        raise SystemExit("predict supports the sentiment task; events models write theirs in training")
    from research import infer
    test, _ = _test_records(gold, manifest)
    v = reg.get(task, version)
    labels, probs = infer.predict_proba(_abs(v["path"]), [r["headline"] for r in test])
    out = _abs(v["path"]) / "predictions_test.jsonl"
    schema.write_jsonl(out, [{"id": r["id"], "sentiment": s}
                             for r, s in zip(test, infer.labels_from_proba(labels, probs))])
    return out


# ── MLflow mirror (optional; the JSON registry works without it) ──────────

def _mlflow_client():
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return None
    try:
        from mlflow.tracking import MlflowClient
    except ImportError:
        print("MLFLOW_TRACKING_URI is set but mlflow is not installed; registry kept locally only")
        return None
    return MlflowClient()


def _mlflow_safe(fn):
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:                 # the local registry stays authoritative
            print(f"MLflow mirror skipped: {exc}")
            return None
    return wrapper


@_mlflow_safe
def _mlflow_register(entry: dict) -> str | None:
    client = _mlflow_client()
    if client is None or not entry.get("mlflow_run_id"):
        return None
    name = f"stocksage-{entry['task']}"
    try:
        client.create_registered_model(name)
    except Exception:
        pass                                     # already exists
    mv = client.create_model_version(name, source=f"runs:/{entry['mlflow_run_id']}",
                                     run_id=entry["mlflow_run_id"],
                                     tags={"weights_sha256": entry["weights_sha256"],
                                           "path": entry["path"], "local_version": str(entry["version"])})
    return mv.version


@_mlflow_safe
def _mlflow_alias(task: str, alias: str, entry: dict | None) -> None:
    client = _mlflow_client()
    if client is None:
        return
    name = f"stocksage-{task}"
    if entry is None or not entry.get("mlflow_version"):
        try:
            client.delete_registered_model_alias(name, alias)
        except Exception:
            pass
        return
    client.set_registered_model_alias(name, alias, entry["mlflow_version"])


@_mlflow_safe
def _mlflow_gate(entry: dict, res: dict) -> None:
    client = _mlflow_client()
    if client is None or not entry.get("mlflow_run_id"):
        return
    run = entry["mlflow_run_id"]
    client.log_metric(run, "gate_candidate_test_macro_f1", res["candidate_macro_f1"])
    client.log_metric(run, "gate_delta_macro_f1", res["paired_bootstrap"]["delta"])
    client.set_tag(run, f"gate_{res['test_set_look']}", "passed" if res["passed"] else "failed")
    client.log_artifact(run, str(_abs(res["report"])))


def sync_mlflow(reg: Registry) -> dict:
    """Mirror the whole JSON registry into MLflow: a training run for every
    version that has none (rebuilt from its train_log.json and tagged
    backfilled=true, e.g. models trained before the tracking server was up),
    a model version for each, and the champion/shadow aliases. Idempotent."""
    if _mlflow_client() is None:
        raise SystemExit("Set MLFLOW_TRACKING_URI (see .env.example) and start the server: "
                         "docker compose --profile mlops up -d mlflow")
    from research.train_classifier import _mlflow as log_training_run
    stats = {"runs_backfilled": 0, "versions_registered": 0}
    for task, t in reg.data["tasks"].items():
        for v in t["versions"]:
            if not v.get("mlflow_run_id"):
                path = _abs(v["path"])
                log = json.loads((path / "train_log.json").read_text(encoding="utf-8"))
                log.setdefault("weights_sha256", v["weights_sha256"])
                v["mlflow_run_id"] = log_training_run(log, path, tags={
                    "backfilled": "true", "local_version": str(v["version"])})
                stats["runs_backfilled"] += bool(v["mlflow_run_id"])
            if v.get("mlflow_run_id") and not v.get("mlflow_version"):
                v["mlflow_version"] = _mlflow_register(v)
                stats["versions_registered"] += bool(v["mlflow_version"])
        for alias in ("champion", "shadow"):
            ver = t.get(alias)
            _mlflow_alias(task, alias, reg.get(task, ver) if isinstance(ver, int) else None)
    reg.save()
    return stats


# ── CLI ────────────────────────────────────────────────────────────────────

def _print_list(reg: Registry) -> None:
    for task, t in reg.data["tasks"].items():
        print(f"{task}: champion={t['champion'] or BASELINE} shadow={t['shadow']} "
              f"test_set_looks={t['test_set_looks']}")
        for v in t["versions"]:
            last = v["gates"][-1] if v["gates"] else None
            gate = f"gate {'pass' if last['passed'] else 'fail'} vs {last['against']}" if last else "no gate"
            print(f"  v{v['version']:<3} {v['stage']:<10} {v['path']:<32} dev {v['best_dev_macro_f1']}  {gate}")
    if not reg.data["tasks"]:
        print("registry is empty")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--registry", default=str(REGISTRY))
    ap.add_argument("--serving", default=str(SERVING))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("sync-mlflow", help="mirror every version, run and alias into MLflow")
    r = sub.add_parser("register")
    r.add_argument("model_dir")
    r.add_argument("--task", choices=TASKS, default="sentiment")
    for name in ("gate", "promote", "predict"):
        p = sub.add_parser(name)
        p.add_argument("version", type=int)
        p.add_argument("--task", choices=TASKS, default="sentiment")
        p.add_argument("--gold", default=str(ROOT / "data" / "corpus" / "labelled.jsonl"))
        p.add_argument("--manifest", default=str(MANIFEST))
        if name != "predict":
            p.add_argument("--min-delta", type=float, default=0.0)
            p.add_argument("--alpha", type=float, default=0.05)
            p.add_argument("--max-class-drop", type=float, default=0.05)
    s = sub.add_parser("shadow")
    s.add_argument("version", type=int, nargs="?")
    s.add_argument("--clear", action="store_true")
    s.add_argument("--task", choices=TASKS, default="sentiment")
    rb = sub.add_parser("rollback")
    rb.add_argument("--task", choices=TASKS, default="sentiment")
    a = ap.parse_args(argv)

    reg = Registry(Path(a.registry), Path(a.serving))
    if a.cmd == "list":
        _print_list(reg)
    elif a.cmd == "sync-mlflow":
        print(json.dumps(sync_mlflow(reg)))
    elif a.cmd == "register":
        e = reg.register(Path(a.model_dir), a.task)
        print(f"registered {a.task} v{e['version']} ({e['path']}, weights {e['weights_sha256'][:12]})")
    elif a.cmd == "predict":
        print(f"wrote {predict_test(reg, a.task, a.version, Path(a.gold), Path(a.manifest))}")
    elif a.cmd in ("gate", "promote"):
        res = reusable_gate(reg, a.task, a.version, Path(a.gold)) if a.cmd == "promote" else None
        if res:
            print(f"reusing the passing gate {res['report']} (same champion and gold file)")
        else:
            res = run_gate(reg, a.task, a.version, Path(a.gold), Path(a.manifest),
                           min_delta=a.min_delta, alpha=a.alpha, max_class_drop=a.max_class_drop)
        print(_gate_md(res))
        if a.cmd == "promote":
            reg.promote(a.task, a.version, res)
            print(f"v{a.version} is now the {a.task} champion")
        elif not res["passed"]:
            raise SystemExit(1)
    elif a.cmd == "shadow":
        if a.clear == (a.version is not None):
            ap.error("give a version, or --clear")
        reg.set_shadow(a.task, None if a.clear else a.version)
        print("shadow cleared" if a.clear else f"v{a.version} is now the {a.task} shadow")
    elif a.cmd == "rollback":
        print(f"{a.task} champion is now {reg.rollback(a.task)}")


if __name__ == "__main__":
    main()
