@echo off
REM ===========================================================================
REM  Build the standalone StockSage bundle - run this on THIS machine.
REM
REM  Produces two files in dist\ that are the entire delivery:
REM      Install-StockSage.bat      the installer
REM      stocksage-bundle.tar(.gz)  the app + database images
REM
REM  Copy both onto a USB drive. On the other PC they go in one folder and the
REM  .bat is double-clicked - no repo, no Python, no Node, no internet needed
REM  for the install itself.
REM
REM  Takes 20-40 minutes the first time (torch, FinBERT and the React build),
REM  then a few minutes for the save + compress on later runs.
REM ===========================================================================
setlocal
cd /d "%~dp0.."
title StockSage - build standalone bundle

echo.
echo   ================================================================
echo    StockSage India - building the standalone bundle
echo   ================================================================
echo.

REM --- Docker engine -------------------------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
    echo   Docker is not running. Starting Docker Desktop...
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
set /a DTRIES=0
:waitdocker
docker info >nul 2>&1
if errorlevel 1 (
    set /a DTRIES+=1
    if %DTRIES% GEQ 60 (
        echo   ERROR: Docker Desktop did not start. Open it, wait for "Engine
        echo          running", then run this again.
        pause
        exit /b 1
    )
    timeout /t 5 >nul
    goto waitdocker
)
echo   [1/5] Docker engine is ready.

REM --- The app image (FastAPI + React bundle + FinBERT) --------------------
echo.
echo   [2/5] Building the app image - this is the long one...
docker build --platform linux/amd64 -t stocksage-app:1.0 -f Dockerfile .
if errorlevel 1 (
    echo   ERROR: the app image failed to build. Scroll up for the reason.
    pause
    exit /b 1
)

REM --- The database image (Postgres with the schema baked in) --------------
echo.
echo   [3/5] Building the database image...
docker build --platform linux/amd64 -t stocksage-db:1.0 -f packaging\Dockerfile.db .
if errorlevel 1 (
    echo   ERROR: the database image failed to build.
    pause
    exit /b 1
)

REM --- Save both images into one archive ------------------------------------
echo.
echo   [4/5] Saving both images to dist\stocksage-bundle.tar ...
if not exist dist mkdir dist
if exist dist\stocksage-bundle.tar     del dist\stocksage-bundle.tar
if exist dist\stocksage-bundle.tar.gz  del dist\stocksage-bundle.tar.gz
docker save -o dist\stocksage-bundle.tar stocksage-app:1.0 stocksage-db:1.0
if errorlevel 1 (
    echo   ERROR: docker save failed - is there enough free disk space?
    pause
    exit /b 1
)

REM Compress only if it actually helps: newer Docker already stores layers
REM compressed, in which case gzip just wastes ten minutes for nothing.
echo.
echo   [5/5] Compressing ^(kept only if it saves real space^)...
powershell -NoProfile -Command "$t='dist\stocksage-bundle.tar'; $g=$t+'.gz'; $i=[IO.File]::OpenRead($t); $o=[IO.File]::Create($g); $z=New-Object IO.Compression.GzipStream($o,[IO.Compression.CompressionMode]::Compress); $i.CopyTo($z); $z.Dispose(); $o.Dispose(); $i.Dispose(); if ((Get-Item $g).Length -lt (Get-Item $t).Length * 0.92) { Remove-Item $t; Write-Host ('        compressed to ' + [math]::Round((Get-Item $g).Length/1GB,2) + ' GB') } else { Remove-Item $g; Write-Host '        compression did not help - keeping the plain .tar' }"

copy /y packaging\Install-StockSage.bat dist\ >nul

echo.
echo   ================================================================
echo    Bundle ready in:  %CD%\dist
echo.
dir /b dist
echo.
echo    Copy BOTH files to a USB drive. On the other PC, put them in one
echo    folder and double-click Install-StockSage.bat.
echo   ================================================================
echo.
pause
