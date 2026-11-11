"""FinBERT sentiment scoring on GPU, with a registry champion and a shadow.

- Lazy: a model loads on first use (not at server boot), ~440 MB download the
  very first time, then cached by HuggingFace locally.
- Runs fp16 on CUDA (~250 MB VRAM per model on an RTX 2050), fp32 on CPU.
- Label order is read from model config, never hardcoded.
- If loading or inference fails, callers get sentiment=NEUTRAL/score=0 and a
  flag; the pipeline then leans on keyword severity alone (conservative).

Which model serves: models/serving.json (written by research.registry) names
the champion and an optional shadow. Without that file, or with
champion=null, the pinned FINBERT_MODEL/FINBERT_REVISION from settings
serves. The file is re-read when it changes, so a promotion or rollback takes
effect at the next news poll without a restart. The shadow scores the same
headlines for comparison only: its output is logged, never used in a decision.
"""
import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger("stocksage.finbert")
settings = get_settings()

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass
class SentimentResult:
    headline: str
    sentiment: str          # POSITIVE | NEGATIVE | NEUTRAL
    score: float            # P(pos) - P(neg), in [-1, 1]
    confidence: float       # max class probability
    model_used: bool = True


class Scorer:
    """One sequence-classification model, loaded once on first use."""

    def __init__(self, model_id: str, revision: str | None = None, version: str | None = None,
                 role: str = "champion"):
        self.model_id, self.revision, self.role = model_id, revision or None, role
        self._version = version
        self._model = None
        self._tokenizer = None
        self.device = "cpu"
        self.load_failed = False
        # Scoring runs in worker threads, so two refreshes can reach load() at
        # once. Concurrent from_pretrained calls left the model on the meta device.
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> bool:
        if self._model is not None:
            return True
        with self._lock:
            if self._model is not None:
                return True
            if self.load_failed:
                return False
            try:
                import torch
                from transformers import AutoModelForSequenceClassification, AutoTokenizer

                device = "cuda" if (settings.use_gpu and torch.cuda.is_available()) else "cpu"
                logger.info("Loading %s model %s on %s...", self.role, self.model_id, device)
                tokenizer = AutoTokenizer.from_pretrained(self.model_id, revision=self.revision)
                model = AutoModelForSequenceClassification.from_pretrained(
                    self.model_id, revision=self.revision)
                model.eval().to(device)
                if device == "cuda":
                    model.half()
                # Publish only a fully loaded model; _model is the readiness flag.
                self._tokenizer, self.device = tokenizer, device
                self._model = model
                logger.info("%s model ready on %s (%s).", self.role.capitalize(), device, self.version())
                return True
            except Exception:
                logger.exception("%s model %s failed to load", self.role, self.model_id)
                self.load_failed = True
                return False

    def unload(self) -> None:
        self._model = self._tokenizer = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def score(self, headlines: list[str], batch_size: int = 16) -> list[SentimentResult]:
        """Never raises; degrades to neutral (model_used=False) on failure."""
        if not headlines:
            return []
        if not self.load():
            return [SentimentResult(h, "NEUTRAL", 0.0, 0.0, model_used=False) for h in headlines]

        import torch

        model, tokenizer = self._model, self._tokenizer
        id2label = {i: lbl.upper() for i, lbl in model.config.id2label.items()}
        pos_idx = next(i for i, l in id2label.items() if l.startswith("POS"))
        neg_idx = next(i for i, l in id2label.items() if l.startswith("NEG"))

        results: list[SentimentResult] = []
        try:
            with torch.inference_mode():
                for i in range(0, len(headlines), batch_size):
                    batch = headlines[i:i + batch_size]
                    enc = tokenizer(batch, padding=True, truncation=True, max_length=96,
                                    return_tensors="pt").to(self.device)
                    probs = torch.softmax(model(**enc).logits.float(), dim=-1).cpu()
                    for h, p in zip(batch, probs):
                        top = int(p.argmax())
                        results.append(SentimentResult(
                            headline=h, sentiment=id2label[top],
                            score=round(float(p[pos_idx] - p[neg_idx]), 3),
                            confidence=round(float(p[top]), 3)))
        except Exception:
            logger.exception("%s inference error: neutral fallback for this batch", self.role)
            done = len(results)
            results += [SentimentResult(h, "NEUTRAL", 0.0, 0.0, model_used=False)
                        for h in headlines[done:]]
        return results

    def version(self) -> str | None:
        """Stored with every prediction so scores from different models are
        never silently mixed. None until loaded."""
        if self._model is None:
            return None
        if self._version:
            return self._version
        commit = getattr(self._model.config, "_commit_hash", None) or self.revision
        return f"{self.model_id}@{commit[:12]}" if commit else self.model_id

    def status(self) -> dict:
        return {"role": self.role, "loaded": self.loaded, "device": self.device if self.loaded else None,
                "load_failed": self.load_failed, "model": self.model_id,
                "revision": self.revision, "version": self.version()}


# ── serving configuration (models/serving.json) ────────────────────────────

_state_lock = threading.Lock()
_champion: Scorer | None = None
_shadow: Scorer | None = None
_serving_mtime: float | None = -1.0       # -1: never read


def _serving_path() -> Path:
    p = Path(settings.serving_config) if settings.serving_config else REPO_ROOT / "models" / "serving.json"
    return p if p.is_absolute() else REPO_ROOT / p


def _read_serving() -> dict:
    p = _serving_path()
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))   # tolerate a BOM (Notepad, PowerShell)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.exception("Unreadable %s: keeping the current models", p)
        raise


def _scorer_for(ref: dict | None, role: str) -> Scorer | None:
    if not ref:
        return None
    path = Path(ref["path"])
    path = path if path.is_absolute() else REPO_ROOT / path
    return Scorer(str(path), None, ref.get("version"), role)


def _same(a: Scorer | None, b: Scorer | None) -> bool:
    if a is None or b is None:
        return a is b
    return (a.model_id, a.revision, a._version) == (b.model_id, b.revision, b._version)


def _refresh() -> None:
    """(Re)build the champion and shadow scorers when serving.json changes."""
    global _champion, _shadow, _serving_mtime
    p = _serving_path()
    try:
        mtime = p.stat().st_mtime
    except OSError:
        mtime = None
    if mtime == _serving_mtime and _champion is not None:
        return
    with _state_lock:
        if mtime == _serving_mtime and _champion is not None:
            return
        try:
            doc = _read_serving()
        except (OSError, ValueError):
            _serving_mtime = mtime
            if _champion is None:
                _champion = Scorer(settings.finbert_model, settings.finbert_revision)
            return
        champion = _scorer_for(doc.get("champion"), "champion") or Scorer(
            settings.finbert_model, settings.finbert_revision)
        shadow = _scorer_for(doc.get("shadow"), "shadow") if settings.shadow_enabled else None
        if not _same(champion, _champion):
            if _champion is not None:
                logger.info("Champion changed: %s -> %s", _champion.model_id, champion.model_id)
                _champion.unload()
            _champion = champion
        if not _same(shadow, _shadow):
            if _shadow is not None:
                _shadow.unload()
            _shadow = shadow
            if shadow is not None:
                logger.info("Shadow model configured: %s", shadow.model_id)
        _serving_mtime = mtime


def champion() -> Scorer:
    _refresh()
    return _champion


def shadow() -> Scorer | None:
    _refresh()
    return _shadow


# ── module API used by the pipeline, rescore and research code ─────────────

def score_headlines(headlines: list[str], batch_size: int = 16) -> list[SentimentResult]:
    """Score with the champion. Never raises; degrades to neutral on failure."""
    return champion().score(headlines, batch_size)


def model_version() -> str | None:
    return champion().version()


def model_status() -> dict:
    """Diagnostics for /api/news/model-status."""
    s = champion().status()
    sh = shadow()
    s["shadow"] = sh.status() if sh else None
    s["serving_config"] = str(_serving_path()) if _serving_path().exists() else None
    return s
