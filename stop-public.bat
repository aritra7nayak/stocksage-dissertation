@echo off
REM ============================================================
REM  StockSage India - take it off the internet and shut down
REM ============================================================
cd /d "%~dp0"

set "TS=tailscale"
where tailscale >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\Tailscale\tailscale.exe" set "TS=C:\Program Files\Tailscale\tailscale.exe"
)

echo  Closing the public tunnel...
"%TS%" serve reset >nul 2>&1

echo  Stopping StockSage...
taskkill /FI "WINDOWTITLE eq StockSage Backend*" /T /F >nul 2>&1

REM Stop the database container (data is preserved in the Docker volume)
docker compose stop

echo.
echo  Stopped, and the public URL no longer resolves to anything.
echo  Your data is safe in the database volume.
echo  Run start-public.bat to bring it back.
echo.
pause
