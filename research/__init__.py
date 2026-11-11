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

# .env supplies MLFLOW_TRACKING_URI (and DATABASE_URL_SYNC) to every script.
# Values already set in the shell win, so tests and CI can switch it off.
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env", override=False)
except ImportError:                      # python-dotenv is a backend dependency
    pass
