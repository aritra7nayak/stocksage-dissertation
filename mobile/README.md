# StockSage for Android

The whole of StockSage running on the phone: no laptop, no server, no account.
The database, the 15-rule engine, FinBERT, backtests, the options desk and the
08:30 / 12:30 / 16:00 IST schedule all live inside the app. The only network
traffic is market data (Yahoo Finance, NSE) and the five news RSS feeds.

## Install

1. Build it (below), or take `mobile/dist/StockSage.apk`.
2. Copy the APK to the phone and open it. Android asks once to allow installs from that source.
3. On first launch, allow notifications. Then open **More → Phone & schedule** and
   tap **Fix** on anything that isn't green. On Xiaomi, Oppo, Vivo or OnePlus phones,
   "Unrestricted battery" decides whether the 08:30 run fires.

The first open builds today's brief right away (about 20–60 s on a phone). After
that, the scheduled runs keep it fresh and notify you.

## How it works

```
┌─ Android app (mobile/android, Kotlin) ─────────────────────────────────┐
│  MainActivity ── WebView ── bundled UI (mobile/web)                     │
│                     │  window.StockSageNative                          │
│  NativeBridge ──────┼── SQLite (Db.kt)        ← schema in TypeScript   │
│                     ├── HTTP + cookie jar (Http.kt, no CORS)           │
│                     └── FinBERT, onnxruntime (FinBert.kt)              │
│  Scheduler → exact alarm → AlarmReceiver → JobService                  │
│                     └── headless WebView loads ?job=MORNING …          │
└─────────────────────────────────────────────────────────────────────────┘
```

- **The backend is a TypeScript port of `backend/app`** (`mobile/web/src/backend`).
  The React pages are the same files as the web app (`frontend/src`). An axios
  adapter answers their `/api/*` calls in-process, so nothing runs on a server.
- **Parity is tested, not assumed.** `tests/parity` feeds identical market data to
  the original Python and to the port:
  - every indicator, score and reason string matches (6,402 values);
  - the backtester matches trade for trade (214 trades, two presets);
  - the tokenizer and FinBERT pipeline match Hugging Face/PyTorch on 94 headlines.
- **FinBERT** is `ProsusAI/finbert` exported by `scripts/export_finbert.py` with
  8-bit block weights and fp16 embeddings: 146 MB, every label identical to
  PyTorch, scores within 0.03. Plain int8 quantization was tried and rejected
  because it changed 18 of 87 labels.
- **Background runs** use one exact alarm at a time (Mon–Fri IST). The alarm
  starts a foreground service that runs the same engine in an off-screen
  WebView and posts the result as a notification.

## Build

Needs Node 20+, Android Studio (its JDK and SDK are used), and the backend venv
(only for the one-time FinBERT export):

```powershell
powershell -ExecutionPolicy Bypass -File mobile\build.ps1
```

This exports the model if it's missing, builds the web bundle into
`android/app/src/main/assets/web`, builds a signed release, and copies the arm64
APK to `mobile/dist/StockSage.apk`.

**Signing:** `android/stocksage-release.jks` + `android/keystore.properties` are
gitignored. Back both up. Android only installs updates signed with the same key;
lose it and you'd have to uninstall, which wipes the app's data.

## Develop

```powershell
cd mobile\web
npm install
npx tsc -b                                   # typecheck backend + shared pages
npx tsx tests\smoke.ts                       # live engine run under Node (node:sqlite)
$env:SMOKE_DB="$env:TEMP\ss.db"; npx tsx tests\smoke.ts "POST /api/engine/run"; npx tsx tests\e2e.ts
npx tsx tests\parity\dump.ts; ..\..\backend\.venv\Scripts\python.exe tests\parity\parity.py
```

Open `mobile/android` in Android Studio to run on a phone or emulator. For
WebView debugging, use `chrome://inspect`; debug builds allow it.

## Differences from the laptop app

- One user and no login: the phone is the user.
- Rule edits on the Settings page reach the engine. On the laptop,
  `get_live_settings` swallows a `NameError` (`AsyncSessionLocal` isn't imported in
  `settings_router.py`), so it always uses the `.env` defaults.
- Yahoo's `dividendYield` is read as the raw fraction, which is what the scorer
  expects. yfinance reports it as a percent.
- Excel export keeps your layout, but without bold header styling (SheetJS
  community edition doesn't write styles).
- The options Monte Carlo uses a different seeded random generator than numpy,
  so expected-value figures differ by sampling noise only.
