"""Evaluation statistics for experiments E1–E3 and annotation agreement.

Implemented with the standard library and numpy only, so the evaluation has
no dependency that could change its numbers between machines. Each function
is checked against hand-computed values in backend/tests/test_research_metrics.py.
"""
import math
from collections.abc import Callable, Hashable, Sequence

import numpy as np


# ── single-label classification ─────────────────────────────────────────

def confusion(gold: Sequence, pred: Sequence, labels: Sequence) -> np.ndarray:
    """Rows = gold, columns = predicted, in `labels` order."""
    idx = {lab: i for i, lab in enumerate(labels)}
    m = np.zeros((len(labels), len(labels)), dtype=int)
    for g, p in zip(gold, pred, strict=True):
        m[idx[g], idx[p]] += 1
    return m


def per_class(gold: Sequence, pred: Sequence, labels: Sequence) -> dict:
    m = confusion(gold, pred, labels)
    out = {}
    for i, lab in enumerate(labels):
        tp = m[i, i]
        fp = m[:, i].sum() - tp
        fn = m[i, :].sum() - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        out[lab] = {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4),
                    "support": int(m[i, :].sum())}
    return out


def macro_f1(gold: Sequence, pred: Sequence, labels: Sequence) -> float:
    pc = per_class(gold, pred, labels)
    return float(np.mean([pc[lab]["f1"] for lab in labels]))


def accuracy(gold: Sequence, pred: Sequence) -> float:
    return float(np.mean([g == p for g, p in zip(gold, pred, strict=True)])) if gold else 0.0


# ── multi-label (event types) ────────────────────────────────────────────

def multilabel_f1(gold: Sequence[set], pred: Sequence[set], labels: Sequence) -> dict:
    """Micro and macro F1 over label sets, plus per-label P/R/F1."""
    tp = {lab: 0 for lab in labels}
    fp = dict(tp)
    fn = dict(tp)
    for g, p in zip(gold, pred, strict=True):
        for lab in labels:
            if lab in p and lab in g:
                tp[lab] += 1
            elif lab in p:
                fp[lab] += 1
            elif lab in g:
                fn[lab] += 1

    def prf(t, f_p, f_n):
        p = t / (t + f_p) if t + f_p else 0.0
        r = t / (t + f_n) if t + f_n else 0.0
        return p, r, (2 * p * r / (p + r) if p + r else 0.0)

    per = {}
    for lab in labels:
        p, r, f = prf(tp[lab], fp[lab], fn[lab])
        per[lab] = {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4),
                    "support": tp[lab] + fn[lab]}
    _, _, micro = prf(sum(tp.values()), sum(fp.values()), sum(fn.values()))
    return {"micro_f1": round(micro, 4),
            "macro_f1": round(float(np.mean([per[lab]["f1"] for lab in labels])), 4),
            "per_label": per}


# ── entity linking (sets of symbols per headline) ────────────────────────

def linking_scores(gold: Sequence[set], pred: Sequence[set]) -> dict:
    """Micro P/R/F1 over (headline, symbol) pairs, plus the misattribution
    rate: share of headlines with at least one wrongly linked company."""
    tp = sum(len(g & p) for g, p in zip(gold, pred, strict=True))
    fp = sum(len(p - g) for g, p in zip(gold, pred, strict=True))
    fn = sum(len(g - p) for g, p in zip(gold, pred, strict=True))
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    mis = sum(1 for g, pr in zip(gold, pred, strict=True) if pr - g)
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4),
            "misattribution_rate": round(mis / len(gold), 4) if gold else 0.0,
            "headlines": len(gold), "gold_links": tp + fn, "predicted_links": tp + fp}


# ── agreement ────────────────────────────────────────────────────────────

def cohen_kappa(a: Sequence[Hashable], b: Sequence[Hashable]) -> float:
    """Cohen's kappa for two annotators over the same items."""
    if len(a) != len(b) or not a:
        raise ValueError("need two equal-length, non-empty label sequences")
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    cats = set(a) | set(b)
    pe = sum((list(a).count(c) / n) * (list(b).count(c) / n) for c in cats)
    return 1.0 if pe == 1 else round((po - pe) / (1 - pe), 4)


# ── significance ─────────────────────────────────────────────────────────

def mcnemar(gold: Sequence, pred_a: Sequence, pred_b: Sequence) -> dict:
    """McNemar's test with continuity correction (Dietterich, 1998).
    b = A right & B wrong, c = A wrong & B right."""
    b = sum(1 for g, x, y in zip(gold, pred_a, pred_b, strict=True) if x == g and y != g)
    c = sum(1 for g, x, y in zip(gold, pred_a, pred_b, strict=True) if x != g and y == g)
    if b + c == 0:
        return {"b": 0, "c": 0, "chi2": 0.0, "p_value": 1.0}
    chi2 = (abs(b - c) - 1) ** 2 / (b + c)
    p = math.erfc(math.sqrt(chi2 / 2))     # chi-square survival function, 1 d.f.
    return {"b": b, "c": c, "chi2": round(chi2, 4), "p_value": round(p, 6)}


def bootstrap_ci(metric: Callable[[list, list], float], gold: Sequence, pred: Sequence,
                 n_boot: int = 2000, alpha: float = 0.05, seed: int = 13) -> dict:
    """Percentile bootstrap CI of metric(gold, pred), resampling items."""
    rng = np.random.default_rng(seed)
    gold, pred = list(gold), list(pred)
    n = len(gold)
    stats = []
    for _ in range(n_boot):
        ix = rng.integers(0, n, n)
        stats.append(metric([gold[i] for i in ix], [pred[i] for i in ix]))
    lo, hi = np.quantile(stats, [alpha / 2, 1 - alpha / 2])
    return {"point": round(metric(gold, pred), 4), "low": round(float(lo), 4),
            "high": round(float(hi), 4), "n_boot": n_boot}


def paired_bootstrap(metric: Callable[[list, list], float], gold: Sequence,
                     pred_a: Sequence, pred_b: Sequence, n_boot: int = 2000,
                     seed: int = 13) -> dict:
    """Difference metric(B) − metric(A) with a 95% CI and the share of
    resamples in which B does not beat A (a one-sided p-value)."""
    rng = np.random.default_rng(seed)
    gold, pa, pb = list(gold), list(pred_a), list(pred_b)
    n = len(gold)
    diffs = []
    for _ in range(n_boot):
        ix = rng.integers(0, n, n)
        g = [gold[i] for i in ix]
        diffs.append(metric(g, [pb[i] for i in ix]) - metric(g, [pa[i] for i in ix]))
    lo, hi = np.quantile(diffs, [0.025, 0.975])
    return {"delta": round(metric(gold, pb) - metric(gold, pa), 4),
            "low": round(float(lo), 4), "high": round(float(hi), 4),
            "p_not_better": round(float(np.mean([d <= 0 for d in diffs])), 4)}
