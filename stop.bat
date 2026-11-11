@echo off
REM ============================================================
REM  StockSage India - stop everything
REM ============================================================
cd /d "%~dp0"

echo  Stopping StockSage...

REM Close the backend + frontend windows by their titles
taskkill /FI "WINDOWTITLE eq StockSage Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq StockSage Frontend*" /T /F >nul 2>&1

REM Stop the database container (data is preserved in the Docker volume)
docker compose stop

echo.
echo  Stopped. Your data is safe in the database volume.
echo  Run start.bat tomorrow to bring it all back.
echo.
pause
