"""Offline research code for the dissertation (corpus, labels, evaluation).

Nothing here is imported by the API. Scripts add backend/ to sys.path so they
can evaluate the production components (bad_news, finbert, entity linker)
exactly as deployed.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DATA = ROOT / "data"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
