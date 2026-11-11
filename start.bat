@echo off
REM ============================================================
REM  StockSage India - one-click launcher (v3)
REM   - kills any stale backend holding port 8000
REM   - waits for the Docker engine (max ~2 min)
REM   - waits for Postgres via pg_isready (max ~60s, never hangs)
REM   - then starts backend + frontend and opens the browser
REM ============================================================
cd /d "%~dp0"

echo.
echo  ====================================================
echo   StockSage India - starting up...
echo  ====================================================
echo.

REM --- 0. Free port 8000 if a stale backend is holding it ------------
echo  [0/5] Clearing any stale backend on port 8000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 2 >nul
netstat -ano | findstr :8000 | findstr LISTENING >nul
if not errorlevel 1 (
    echo.
    echo  ERROR: Port 8000 is still in use and could not be freed:
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do tasklist /FI "PID eq %%p"
    echo  Close that program ^(or an old "StockSage Backend" window^),
    echo  or re-run this file as Administrator, then try again.
    pause
    exit /b 1
)

REM --- 1. Make sure the Docker ENGINE is running ----------------------
echo  [1/5] Checking Docker...
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

REM --- 2. Start the database and wait until it ACCEPTS CONNECTIONS ----
echo  [2/5] Starting database...
docker compose up -d
echo  Waiting for Postgres to accept connections...
set /a DBTRIES=0
:waitdb
docker exec stocksage_db pg_isready -U stocksage >nul 2>&1
if errorlevel 1 (
    set /a DBTRIES+=1
    if %DBTRIES% GEQ 20 (
        echo  WARNING: Postgres not ready after 60s - starting anyway.
        echo  If the app errors, run:  docker compose logs db
        goto dbdone
    )
    timeout /t 3 >nul
    goto waitdb
)
:dbdone
echo  Database is ready.

REM --- 3. Start the backend in its own window ------------------------
echo  [3/5] Starting backend API...
start "StockSage Backend" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\activate && uvicorn app.main:app --port 8000"

REM --- 4. Start the frontend in its own window -----------------------
echo  [4/5] Starting frontend...
start "StockSage Frontend" cmd /k "cd /d "%~dp0frontend" && npm run dev"

REM --- 5. Open the browser -------------------------------------------
echo  [5/5] Waiting for servers to warm up...
timeout /t 8 >nul
start "" http://localhost:3000

echo.
echo  ====================================================
echo   StockSage is running.
echo   - App:      http://localhost:3000
echo   - API docs: http://localhost:8000/docs
echo   Keep the two new windows open. To stop: stop.bat
echo  ====================================================
echo.
pause
