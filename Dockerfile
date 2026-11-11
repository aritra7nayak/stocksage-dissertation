# ─────────────────────────────────────────────────────────────────────────────
# StockSage India — single-container deployment
#
# Builds the React frontend, then serves it as static files from the FastAPI
# app so the whole product lives behind one HTTPS URL with no CORS setup.
# Runs on both amd64 and arm64 (Oracle Ampere); see deploy/ and DEPLOY.md.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the SPA ───────────────────────────────────────────────────
FROM node:20-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Empty base URL = same-origin requests, since FastAPI serves this bundle.
ENV VITE_API_URL=""
RUN npm run build


# ── Stage 2: the API (and static host) ───────────────────────────────────────
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# libgomp1 is required by torch; curl is for the container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged uid 1000. Create it up front so every
# path we write to at runtime (model cache, .auth_secret, job_history) is
# already owned by it.
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    HF_HOME=/home/user/.cache/huggingface \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app

# Torch, CPU-only, installed before the rest so it stays a cached layer.
# The source differs by architecture: on x86 the default PyPI wheel drags in
# ~2.5 GB of CUDA libraries we can never use, so we pull from PyTorch's CPU
# index; on arm64 (Oracle Ampere) that index has no wheels, and PyPI's
# aarch64 wheel is already CPU-only.
RUN ARCH="$(dpkg --print-architecture)"; \
    echo "Installing torch for $ARCH"; \
    if [ "$ARCH" = "amd64" ]; then \
        pip install --no-cache-dir torch==2.5.1 \
            --index-url https://download.pytorch.org/whl/cpu; \
    else \
        pip install --no-cache-dir torch==2.5.1; \
    fi

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Bake FinBERT into the image (~440 MB) so the first sentiment request doesn't
# stall on a download and a cold start stays fast. Deliberately above the
# source COPY: editing app code then doesn't re-download the model.
ARG FINBERT_MODEL=ProsusAI/finbert
ARG FINBERT_REVISION=4556d13015211d73dccd3fdd39d39232506f3e43
ENV FINBERT_MODEL=${FINBERT_MODEL} FINBERT_REVISION=${FINBERT_REVISION}
RUN python -c "import os; from transformers import AutoModelForSequenceClassification as M, AutoTokenizer as T; m=os.environ['FINBERT_MODEL']; r=os.environ['FINBERT_REVISION'] or None; T.from_pretrained(m, revision=r); M.from_pretrained(m, revision=r)"

COPY backend/app ./app
COPY scripts ./scripts
COPY --from=frontend /build/dist ./static

RUN chown -R user:user /app /home/user
USER user

# No GPU here, and free hosts sleep — so no in-process cron.
ENV USE_GPU=false \
    ENABLE_SCHEDULER=false \
    SERVE_FRONTEND=true \
    PORT=7860

EXPOSE 7860
HEALTHCHECK --interval=60s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:7860/api/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
