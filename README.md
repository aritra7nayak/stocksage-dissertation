# StockSage India

Rule-governed daily intelligence for Indian markets — BUY / SELL / HOLD suggestions
driven by 15 transparent rules, technicals, fundamentals, and FinBERT news sentiment.

> **Personal research tool. Not investment advice.** Paper-trading mode is ON by default.

---

## Architecture (v2, reviewed)

```
┌────────────────────────────────────────────────────┐
│  React + Vite + Tailwind + Framer Motion (native)  │  http://localhost:5173
└────────────────────────┬───────────────────────────┘
                         │ REST
┌────────────────────────┴───────────────────────────┐
│  FastAPI modular monolith (native venv, GPU)       │  http://localhost:8000
│  market_data │ sentiment │ rules │ engine │        │
│  backtest    │ portfolio │ APScheduler (IST jobs)  │
└────────────────────────┬───────────────────────────┘
                         │ asyncpg
┌────────────────────────┴───────────────────────────┐
│  PostgreSQL 16 (the only Docker container)          │  localhost:5433
└────────────────────────────────────────────────────┘
```

- Backend runs **natively** so FinBERT gets direct CUDA access on your GPU.
- Daily jobs (IST, Mon–Fri): **08:30** morning brief · **12:30** midday guard refresh · **16:00** EOD snapshot.

## Setup — Step 1 (Foundation)

Prerequisites: Docker Desktop, Python 3.11+, Node 20+ (Node needed from Step 7).

```powershell
# 1. Database (one container, port 5433)
docker compose up -d
docker compose ps          # wait for "healthy"

# 2. Backend environment
cd backend
python -m venv .venv
.venv\Scripts\activate     # (Linux/Mac: source .venv/bin/activate)
pip install -r requirements.txt

# 3. PyTorch with CUDA for your GPU (~2.5 GB download, one time)
pip install torch --index-url https://download.pytorch.org/whl/cu121

# 4. Config
copy ..\.env.example ..\.env    # defaults work as-is; edit capital/rules if you want
copy ..\.env .env               # backend reads .env from its own folder too

# 5. Run
uvicorn app.main:app --reload --port 8000
```

### Verify Step 1

| Check | Command | Expect |
|---|---|---|
| API alive + scheduler | `curl http://localhost:8000/api/health` | 3 cron jobs listed, IST time |
| Schema + seed data | `curl http://localhost:8000/api/health/db` | `status: ok` and a non-zero `table_count` |
| GPU ready | `curl http://localhost:8000/api/health/gpu` | `cuda_available: true`, your GPU name |

Interactive docs: http://localhost:8000/docs

### Resetting the database
```powershell
docker compose down -v && docker compose up -d   # wipes and re-runs init.sql
```

## The 15 Rules

| # | Rule |
|---|---|
| R1–R5 | Capital buckets: 20% cash · 20% gold+silver ETF · 30% Nifty 50 · 20% Next 100 · 10% smallcap |
| R6 | Stock purchase band ₹7,000–₹9,000 |
| R7 | ETF purchase band ₹5,000–₹6,000 |
| R8 | Max 20% of capital deployed in a single day |
| R9 | Diversify across 9 sectors |
| R10 | No buying into weak sectors |
| R11 | Nifty fell → no buying (morning run uses previous close; midday run re-checks live) |
| R12 | Severe bad news → pause affected segment/market |
| R13 | **Stop-loss**: sell at −8% from avg buy |
| R14 | **Deterioration exit**: composite score < 0.35 for 3 straight days → sell |
| R15 | **Profit protect**: after +15%, sell if it gives back 5% from peak |

R13–R15 are configurable in `.env` / Settings page and are stored in `app_settings`.

## Hosting

Three ways to run it beyond `start.bat` on this PC, all free:

- **[REMOTE_ACCESS.md](REMOTE_ACCESS.md)** — keep the backend on this PC and
  publish it with Tailscale Funnel. FinBERT keeps the GPU, nothing to pay, but
  the site is only up while the machine is awake.
- **[DEPLOY.md](DEPLOY.md)** — always-on Oracle Cloud Always Free ARM VM.
- **[packaging/README.md](packaging/README.md)** — not hosting at all: hand
  the whole app to someone as two files on a USB drive. They double-click an
  installer and get a Desktop icon, their own database and their own login,
  running only on their PC.

### The container stack

The `Dockerfile` builds the frontend and serves it from FastAPI, so the whole
app runs behind one HTTPS URL; `deploy/docker-compose.prod.yml` adds Postgres
and a Caddy reverse proxy that handles TLS certificates automatically. Because
the VM never sleeps, FinBERT and the IST scheduler both work exactly as they do
locally.

## Build roadmap

- [x] **Step 1** — Docker, schema, config, runnable skeleton
- [x] **Step 2** — Market data: yfinance fetcher, hand-rolled indicators (RSI/MACD/EMA/BB/ADX/Stoch), fundamentals, universe seeder (206 symbols)
- [ ] **Step 3** — Rules engine R1–R15 as pure, unit-tested functions
- [ ] **Step 4** — Sentiment: RSS scrapers, FinBERT on GPU, India-specific bad-news guard
- [ ] **Step 5** — Composite scorer, suggestion engine, `/api/daily-brief`
- [ ] **Step 6** — Backtester + paper trading
- [ ] **Step 7** — Frontend (dark navy / cyan glow design system, Framer Motion everywhere)
