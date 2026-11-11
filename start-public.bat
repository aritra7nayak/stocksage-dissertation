@echo off
REM ============================================================
REM  StockSage India - run locally, reachable from anywhere
REM
REM  Backend stays on THIS machine, so FinBERT keeps your GPU.
REM  Tailscale Funnel gives it a public HTTPS URL - no port
REM  forwarding, which matters because most Indian ISPs are
REM  behind CGNAT and cannot forward ports at all.
REM
REM  The React bundle is built into backend\static so FastAPI
REM  serves it too: one origin, so no CORS and no second tunnel.
REM
REM  Usage:  start-public.bat            (rebuilds the frontend)
REM          start-public.bat skipbuild  (reuses the last build)
REM ============================================================
cd /d "%~dp0"

echo.
echo  ====================================================
echo   StockSage India - starting in PUBLIC mode...
echo  ====================================================
echo.

REM --- Locate the Tailscale CLI --------------------------------------
set "TS=tailscale"
where tailscale >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\Tailscale\tailscale.exe" (
        set "TS=C:\Program Files\Tailscale\tailscale.exe"
    ) else (
        echo  ERROR: Tailscale is not installed.
        echo  Install it from https://tailscale.com/download/windows
        echo  then sign in and run me again.
        pause
        exit /b 1
    )
)

REM --- 0. Free port 8000 if a stale backend is holding it -------------
echo  [0/6] Clearing any stale backend on port 8000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)

REM --- 1. Make sure the Docker ENGINE is running ----------------------
echo  [1/6] Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo  Docker isn't running. Launching Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
)
set /a DOCKTRIES=0
:waitdocker
docker info >nul 2>&1
if errorlevel 1 (
    set /a DOCKTRIES+=1
    if %DOCKTRIES% GEQ 24 (
        echo.
        echo  ERROR: Docker engine did not come up after ~2 minutes.
        echo  Open Docker Desktop, wait for "Engine running", then run me again.
        pause
        exit /b 1
    )
    timeout /t 5 >nul
    goto waitdocker
)
echo  Docker engine is ready.

REM --- 2. Start the database and wait for connections -----------------
echo  [2/6] Starting database...
docker compose up -d
echo  Waiting for Postgres to accept connections...
set /a DBTRIES=0
:waitdb
docker exec stocksage_db pg_isready -U stocksage >nul 2>&1
if errorlevel 1 (
    set /a DBTRIES+=1
    if %DBTRIES% GEQ 20 (
        echo  WARNING: Postgres not ready after 60s - starting anyway.
        goto dbdone
    )
    timeout /t 3 >nul
    goto waitdb
)
:dbdone
echo  Database is ready.

REM --- 3. Build the frontend into backend\static ----------------------
if /i "%~1"=="skipbuild" (
    echo  [3/6] Skipping frontend build ^(skipbuild^).
    if not exist "backend\static\index.html" (
        echo  ERROR: no previous build found. Run without 'skipbuild' first.
        pause
        exit /b 1
    )
    goto afterbuild
)
echo  [3/6] Building frontend ^(~90 seconds^)...
pushd frontend
call npm run build
if errorlevel 1 (
    echo.
    echo  ERROR: frontend build failed - see the messages above.
    popd
    pause
    exit /b 1
)
popd
if exist "backend\static" rmdir /s /q "backend\static"
robocopy "frontend\dist" "backend\static" /E /NFL /NDL /NJH /NJS /NP >nul
REM robocopy uses exit codes 0-7 for success; 8+ is a real failure.
if %ERRORLEVEL% GEQ 8 (
    echo  ERROR: could not copy the build into backend\static.
    pause
    exit /b 1
)
echo  Frontend bundled into backend\static.
:afterbuild

REM --- 4. Start the backend, serving the SPA too ----------------------
echo  [4/6] Starting backend API ^(GPU FinBERT, scheduler on^)...
REM NOTE: the quoted form  set "VAR=value"  is required. Writing
REM   set VAR=value && next
REM makes cmd capture the space before && into the value, so the app would
REM receive "true " and fail to parse it as a boolean.
start "StockSage Backend" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\activate && set "SERVE_FRONTEND=true" && uvicorn app.main:app --host 127.0.0.1 --port 8000"

echo  Waiting for the API to come up...
set /a APITRIES=0
:waitapi
curl -fsS http://127.0.0.1:8000/api/health >nul 2>&1
if errorlevel 1 (
    set /a APITRIES+=1
    if %APITRIES% GEQ 30 (
        echo  WARNING: API not responding after ~60s. Check the backend window.
        goto apidone
    )
    timeout /t 2 >nul
    goto waitapi
)
:apidone
echo  API is up.

REM --- 5. Publish it to the internet ----------------------------------
echo  [5/6] Opening the public tunnel...
"%TS%" funnel --bg 8000
if errorlevel 1 (
    echo.
    echo  ERROR: could not start the funnel. Common causes:
    echo    - not signed in yet:            tailscale up
    echo    - Funnel not permitted in your tailnet ACL
    echo    - HTTPS certificates disabled in the admin console
    echo  See REMOTE_ACCESS.md for the one-time setup.
    pause
    exit /b 1
)

REM --- 6. Show the public URL ----------------------------------------
echo.
echo  [6/6] Your public URL:
"%TS%" funnel status
echo.
echo  ====================================================
echo   StockSage is live.
echo   - Local:  http://localhost:8000
echo   - Public: the https://...ts.net URL above
echo.
echo   This PC must stay awake for the site to stay up.
echo   To take it offline again: stop-public.bat
echo  ====================================================
echo.
pause
