"""Batch inference with class probabilities for a saved sentiment model.

Used by the registry (re-predicting the frozen test split for a registered
version) and by active learning (uncertainty over the unlabelled pool). The
API keeps its own scorer (backend/app/sentiment/finbert.py); this module is
offline only.
"""
from collections.abc import Sequence
from pathlib import Path

import numpy as np


def predict_proba(model: str | Path, headlines: Sequence[str], revision: str | None = None,
                  batch: int = 64, max_len: int = 64, cpu: bool = False) -> tuple[list[str], np.ndarray]:
    """(labels, probs): labels are schema names (negative/neutral/positive) in
    the model's head order; probs has one row per headline."""
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() and not cpu else "cpu"
    tok = AutoTokenizer.from_pretrained(str(model), revision=revision)
    net = AutoModelForSequenceClassification.from_pretrained(str(model), revision=revision)
    net.eval().to(device)
    if device == "cuda":
        net.half()
    labels = [str(net.config.id2label[i]).lower() for i in range(net.config.num_labels)]
    out = []
    with torch.inference_mode():
        for i in range(0, len(headlines), batch):
            enc = tok(list(headlines[i:i + batch]), padding=True, truncation=True,
                      max_length=max_len, return_tensors="pt").to(device)
            out.append(torch.softmax(net(**enc).logits.float(), -1).cpu().numpy())
    del net
    if device == "cuda":
        torch.cuda.empty_cache()
    return labels, (np.concatenate(out) if out else np.zeros((0, len(labels))))


def labels_from_proba(labels: list[str], probs: np.ndarray) -> list[str]:
    return [labels[i] for i in probs.argmax(-1)] if len(probs) else []
