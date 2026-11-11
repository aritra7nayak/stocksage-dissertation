@echo off
REM ===========================================================================
REM  StockSage India - standalone installer for a single Windows PC.
REM
REM  Copy this file and stocksage-bundle.tar.gz into the same folder, then
REM  double-click this file. It installs the app and its own private database
REM  and puts a StockSage icon on the Desktop. Nothing is shared with any
REM  other machine.
REM
REM  This file is a batch script with a PowerShell installer stored after the
REM  #PSPAYLOAD marker below: cmd stops reading at "exit /b", so those lines
REM  are just data to it. The two lines below carve the payload out to a temp
REM  file and run it.
REM ===========================================================================
setlocal
title StockSage India - Installer

set "PSFILE=%TEMP%\stocksage-install-%RANDOM%%RANDOM%.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=Get-Content -LiteralPath '%~f0'; $i=[Array]::IndexOf($s,'#PSPAYLOAD'); Set-Content -LiteralPath '%PSFILE%' -Value $s[($i+1)..($s.Count-1)] -Encoding UTF8"
if not exist "%PSFILE%" (
    echo.
    echo   Could not prepare the installer - PowerShell is unavailable or blocked.
    echo.
    pause
    exit /b 1
)

REM The folder is handed over as an environment variable, NOT an argument:
REM %~dp0 ends with a backslash, and "...\" on a command line makes PowerShell
REM read \" as an escaped quote, which mangles the path.
set "SS_BUNDLE_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PSFILE%"
set "RC=%ERRORLEVEL%"
del "%PSFILE%" >nul 2>&1
exit /b %RC%

#PSPAYLOAD
# ---------------------------------------------------------------------------
#  StockSage India - standalone installer (PowerShell payload)
#
#  Extracted and run by Install-StockSage.bat. Everything it installs lives on
#  this one computer: its own Postgres, its own data, no server to depend on.
# ---------------------------------------------------------------------------
param([string]$BundleDir = '.')

$ErrorActionPreference = 'Continue'      # docker writes to stderr as a matter of course
$ProgressPreference    = 'SilentlyContinue'

$ImgApp     = 'stocksage-app:1.0'
$ImgDb      = 'stocksage-db:1.0'
$CtrApp     = 'stocksage_desktop_app'
$CtrDb      = 'stocksage_desktop_db'
$Net        = 'stocksage_desktop_net'
$VolPg      = 'stocksage_desktop_data'
$VolJobs    = 'stocksage_desktop_jobs'
$InstallDir = Join-Path $env:LOCALAPPDATA 'StockSage'
$CfgPath    = Join-Path $InstallDir 'config.json'
$IconPath   = Join-Path $InstallDir 'stocksage.ico'
$DockerUrl  = 'https://www.docker.com/products/docker-desktop/'
$IconB64    = 'AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv87KR7/Oyke/zspHv8AAAAAAAAAAAAAAAAAAAAAOigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf86KB3/Oigd/zooHf8AAAAAAAAAADknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jx3/OScd/zknHf85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zknHP85Jxz/OScc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYc/zgmHP84Jhz/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/84Jhv/OCYb/zgmG/83JRv/NyUb/zclG/83JRv/NyUb/6zvhv83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zclG/83JRv/NyUb/zckGv83JBr/NyQa/zckGv+s74b/rO+G/6zvhv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NyQa/zckGv83JBr/NiQa/zYkGv82JBr/rO+G/6zvhv+s74b/rO+G/6zvhv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82JBr/NiQa/zYkGv82Ixn/NiMZ/zYjGf9bwCD/rO+G/6zvhv+s74b/XsUi/1m7H/82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zYjGf82Ixn/NiMZ/zUjGf81Ixn/NSMZ/zUjGf9dxCH/rO+G/17FIv9exSL/XsUi/1zDIP81Ixn/NSMZ/zUjGf81Ixn/NSMZ/zUjGf9LhRn/XcQh/13EIf81Ixn/NSMZ/zUjGf81Ixn/NSMZ/zUjGf81Ixn/NSMZ/zUjGf81Ixn/NSMZ/zUjGf81Ixn/NCIY/zQiGP80Ihj/NCIY/zQiGP9dxCH/XsUi/17FIv9exSL/XsUi/13EIf80Ihj/NCIY/zQiGP9LhBn/XcQh/17FIv9exSL/XsUi/13EIf80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP9dxCH/XsUi/17FIv9exSL/XsUi/13EIf9JhRn/XcQh/17FIv9exSL/XsUi/17FIv9exSL/XsUi/1zCIP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zQiGP80Ihj/NCIY/zMhF/8zIRf/MyEX/zMhF/8zIRf/MyEX/zMhF/9cwyD/XsUi/17FIv9exSL/XsUi/17FIv9exSL/XsUi/17FIv9exSL/XsUi/17FIv9exSL/XsUi/zQtF/8zIRf/MyEX/zMhF/8zIRf/MyEX/zMhF/8zIRf/MyEX/zMhF/8zIRf/MyAX/zMgF/8zIBf/MyAX/zMgF/8zIBf/MyAX/zMgF/9Zux//XsUi/17FIv9exSL/XsUi/17FIv9exSL/XsUi/13EIf9cwyD/XsUi/17FIv9exSL/XcQh/zMgF/8zIBf/MyAX/zMgF/8zIBf/MyAX/zMgF/8zIBf/MyAX/zMgF/8yIBb/MiAW/zIgFv8yIBb/MiAW/zIgFv8yIBb/MiAW/zIgFv9IgBr/XcQh/17FIv9exSL/XsUi/13EIf9KhBn/MiAW/zIgFv9dxCH/XsUi/17FIv9exSL/XMIg/zIgFv8yIBb/MiAW/zIgFv8yIBb/MiAW/zIgFv8yIBb/MiAW/zIfFv8yHxb/Mh8W/zIfFv8yHxb/Mh8W/zIfFv8yHxb/Mh8W/zIfFv8yHxb/XcQh/13EIf9KhBn/Mh8W/zIfFv8yHxb/Mh8W/zQrFv9exSL/XsUi/17FIv9exSL/NCsW/zIfFv8yHxb/Mh8W/zIfFv8yHxb/Mh8W/zIfFv8yHxb/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/1zCIP9exSL/XsUi/17FIv9dxCH/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHxX/MR8V/zEfFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/13EIf9exSL/XsUi/17FIv9cwiD/MR4V/zEeFf8xHhX/MR4V/zEeFf8xHhX/MR4V/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MioU/17FIv9exSL/XsUi/17FIv8yKBT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8wHRT/XMIg/17FIv9exSL/XsUi/13EIf8wHRT/MB0U/zAdFP8wHRT/MB0U/zAdFP8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/LxwT/y8cE/8vHBP/XcQh/17FIv9exSL/XsUi/6zvhv8vHBP/LxwT/y8cE/8vHBP/LxwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8uHBP/LhwT/y4cE/8wKRP/XsUi/17FIv+s74b/rO+G/6zvhv8uHBP/LhwT/y4cE/8uHBP/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv8uGxL/LhsS/y4bEv9cwiD/rO+G/6zvhv+s74b/rO+G/6zvhv8uGxL/LhsS/y4bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv8tGxL/LRsS/y0bEv9dxCH/rO+G/6zvhv+s74b/LRsS/y0bEv8tGxL/LRsS/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf8tGhH/LRoR/y0aEf9cwCH/rO+G/y0aEf8tGhH/LRoR/y0aEf8tGhH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRH/LBkR/ywZEf8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/ywZEP8sGRD/LBkQ/wAAAAArGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/KxgQ/ysYEP8rGBD/AAAAACsYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/ysYD/8rGA//KxgP/wAAAAAAAAAAAAAAACoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//KhcP/yoXD/8qFw//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function Rule  { Write-Host ('  ' + ('-' * 64)) -ForegroundColor DarkGray }
function Step  { param($n, $m) Write-Host ''; Write-Host "  [$n/9] $m" -ForegroundColor Cyan }
function Info  { param($m) Write-Host "        $m" -ForegroundColor Gray }
function Good  { param($m) Write-Host "        $m" -ForegroundColor Green }
function Warn  { param($m) Write-Host "        $m" -ForegroundColor Yellow }
function Die {
    param($m)
    Write-Host ''
    Write-Host '  INSTALL FAILED' -ForegroundColor Red
    Write-Host "  $m" -ForegroundColor Red
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}

# Every docker call goes through here: native stderr is captured rather than
# thrown, and the exit code is what we branch on.
#
# Deliberately a SIMPLE function with no param block: docker's own short flags
# have to reach $args untouched, and a declared parameter would make -e
# ambiguous with PowerShell's -ErrorAction / -ErrorVariable and blow up every
# `docker run` here.
function D {
    $out = & docker @args 2>&1
    @{ Code = $LASTEXITCODE; Out = (($out | Out-String).Trim()) }
}
function DockerUp { (D info --format '{{.ServerVersion}}').Code -eq 0 }
function PortFree {
    param([int]$p)
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop(); $true
    } catch { $false }
}

Clear-Host
Write-Host ''
Write-Host '   StockSage India' -ForegroundColor White
Write-Host '   Standalone installer - app and database both run on THIS computer.' -ForegroundColor DarkGray
Rule

# -- 1. The bundle ----------------------------------------------------------
Step 1 'Looking for the app bundle'
# The wrapper hands the folder over in an environment variable on purpose:
# %~dp0 ends in a backslash, and passing "...\" on a command line makes
# PowerShell's own parser treat \" as an escaped quote, which used to leave a
# stray " glued to the end of the path.
if ($env:SS_BUNDLE_DIR) { $BundleDir = $env:SS_BUNDLE_DIR }
$BundleDir = $BundleDir.Trim().Trim('"')

$looked = @($BundleDir, (Get-Location).Path) | Where-Object { $_ } | Select-Object -Unique
$bundle = $null
foreach ($dir in $looked) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $bundle = Get-ChildItem -LiteralPath $dir -Filter 'stocksage-bundle.tar*' -File -ErrorAction SilentlyContinue |
              Sort-Object Length -Descending | Select-Object -First 1
    if ($bundle) { break }
}
if (-not $bundle) {
    # Say what was actually searched and seen - "it is not there" is useless
    # advice when the file is sitting right there in the folder.
    $saw = ''
    if (Test-Path -LiteralPath $looked[0]) {
        $names = (Get-ChildItem -LiteralPath $looked[0] -File -ErrorAction SilentlyContinue |
                  Select-Object -First 10).Name
        if ($names) { $saw = "`n  That folder holds: " + ($names -join ', ') }
    }
    Die ("No stocksage-bundle.tar or .tar.gz here.`n  Looked in: " + ($looked -join "`n             ") + $saw +
         "`n  Put Install-StockSage.bat and the bundle file in ONE folder, then run it again.")
}
Info ('{0}  ({1:N0} MB)' -f $bundle.Name, ($bundle.Length / 1MB))
Info ('in {0}' -f $bundle.DirectoryName)

# -- 2. Docker --------------------------------------------------------------
Step 2 'Checking Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn 'Docker Desktop is not installed. StockSage needs it (it is free).'
    Info 'Opening the download page now. Install it with the default options,'
    Info 'restart if Windows asks, then run this installer again.'
    Start-Process $DockerUrl
    Write-Host ''
    Read-Host '  Press Enter to close'
    exit 1
}
if (-not (DockerUp)) {
    Info 'Docker is not running yet - starting it (can take a couple of minutes)...'
    $exe = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
             "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe") |
           Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($exe) { Start-Process $exe }
    $waited = 0
    while (-not (DockerUp)) {
        Start-Sleep -Seconds 5
        $waited += 5
        if ($waited -ge 300) {
            Die 'Docker Desktop did not start within 5 minutes. Open it yourself, wait until it says "Engine running", then run this installer again.'
        }
    }
}
Good 'Docker engine is running.'

# -- 3. Previous install ----------------------------------------------------
Step 3 'Checking for an existing install'
$cfg = $null
if (Test-Path $CfgPath) {
    try { $cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
$volExists = (D volume ls -q -f "name=^$VolPg$").Out -ne ''
$ctrExists = ((D ps -a -q -f "name=^$CtrApp$").Out -ne '') -or ((D ps -a -q -f "name=^$CtrDb$").Out -ne '')

if ($ctrExists -or $volExists) {
    if ($cfg) {
        Info 'StockSage is already installed here.'
        Info 'Reinstalling replaces the app but KEEPS your database - portfolio,'
        Info 'trades, history and login all survive.'
        $a = Read-Host '        Continue? [Y/n]'
        if ($a -and $a -notmatch '^[Yy]') { Info 'Nothing was changed.'; Read-Host '  Press Enter to close'; exit 0 }
    } else {
        # Without config.json the old database password is unrecoverable, so that
        # volume can never be opened again - say so plainly before wiping it.
        Warn 'A StockSage database from an earlier install is here, but its password'
        Warn 'was not saved, so it cannot be reopened. Continuing starts a fresh,'
        Warn 'EMPTY database - any old portfolio data in it is lost.'
        $a = Read-Host '        Erase it and continue? [y/N]'
        if ($a -notmatch '^[Yy]') { Info 'Nothing was changed.'; Read-Host '  Press Enter to close'; exit 0 }
        $null = D rm -f $CtrApp $CtrDb
        $null = D volume rm $VolPg $VolJobs
        $volExists = $false
    }
    $null = D rm -f $CtrApp $CtrDb
} else {
    Info 'Fresh install.'
}

# -- 4. Settings ------------------------------------------------------------
Step 4 'Choosing settings'
$port = 0
if ($cfg -and $cfg.port -and (PortFree ([int]$cfg.port))) { $port = [int]$cfg.port }
if (-not $port) { $port = @(8000, 8010, 8080, 8800, 9000, 9090) | Where-Object { PortFree $_ } | Select-Object -First 1 }
if (-not $port) { Die 'Could not find a free port for the app (tried 8000, 8010, 8080, 8800, 9000, 9090).' }

if ($cfg -and $cfg.pgPassword) { $pgPass = [string]$cfg.pgPassword }
else { $pgPass = [guid]::NewGuid().ToString('N') }
if ($cfg -and $cfg.authSecret) { $authSecret = [string]$cfg.authSecret }
else { $authSecret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N') }

Info "Address:  http://localhost:$port"
Info 'Data:     a private database on this PC - nothing is shared or uploaded.'

# -- 5. Load the images -----------------------------------------------------
Step 5 'Unpacking the app (a few minutes - it is a few GB)'
$r = D load -i $bundle.FullName
if ($r.Code -ne 0) { Die "Could not unpack the app bundle.`n  $($r.Out)" }
foreach ($img in @($ImgApp, $ImgDb)) {
    if ((D image inspect $img --format '{{.Id}}').Code -ne 0) {
        Die "$img was not in the bundle - the file may have copied incompletely. Copy it off the drive again."
    }
}
Good 'App unpacked.'

# -- 6. Database ------------------------------------------------------------
Step 6 'Setting up the private database'
$null = D network create $Net
$null = D volume create $VolPg
$null = D volume create $VolJobs
# --restart no: the app runs only when its shortcut is used.
$r = D run -d --name $CtrDb --network $Net --restart no `
        -e "POSTGRES_DB=stocksage" -e "POSTGRES_USER=stocksage" -e "POSTGRES_PASSWORD=$pgPass" `
        -e 'TZ=Asia/Kolkata' `
        -v "${VolPg}:/var/lib/postgresql/data" $ImgDb
if ($r.Code -ne 0) { Die "Could not start the database.`n  $($r.Out)" }
$waited = 0
while ((D exec $CtrDb pg_isready -U stocksage -d stocksage).Code -ne 0) {
    Start-Sleep -Seconds 3
    $waited += 3
    if ($waited -ge 150) { Die "The database did not come up. See why with:  docker logs $CtrDb" }
}
Good 'Database ready.'

# -- 7. The app -------------------------------------------------------------
Step 7 'Starting StockSage'
$r = D run -d --name $CtrApp --network $Net --restart no `
        -p "127.0.0.1:${port}:7860" `
        -e "DATABASE_URL=postgresql+asyncpg://stocksage:$pgPass@${CtrDb}:5432/stocksage" `
        -e "DATABASE_URL_SYNC=postgresql://stocksage:$pgPass@${CtrDb}:5432/stocksage" `
        -e "AUTH_SECRET=$authSecret" `
        -e 'SERVE_FRONTEND=true' -e 'ENABLE_SCHEDULER=true' -e 'USE_GPU=false' `
        -e 'PORT=7860' -e 'TZ=Asia/Kolkata' `
        -e "CORS_ORIGINS=http://localhost:$port,http://127.0.0.1:$port" `
        -v "${VolJobs}:/app/job_history" $ImgApp
if ($r.Code -ne 0) { Die "Could not start the app.`n  $($r.Out)" }
# The image has no /app/job_history, so Docker creates the mount point owned by
# root while the app runs as uid 1000 - hand it over, or saved backtests fail.
$null = D exec -u 0 $CtrApp chown -R 1000:1000 /app/job_history

Info 'Waiting for it to finish booting...'
$waited = 0
$up = $false
while (-not $up) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) { $up = $true }
    } catch { }
    if (-not $up) {
        Start-Sleep -Seconds 3
        $waited += 3
        if ($waited -ge 240) { Die "The app did not answer on http://localhost:$port. See why with:  docker logs $CtrApp" }
    }
}
Good 'StockSage is up.'

# -- 8. Seed the stock universe ---------------------------------------------
Step 8 'Loading the NSE stock universe'
$r = D exec $CtrApp python scripts/seed_universe.py
if ($r.Code -ne 0) {
    Warn 'The stock list could not be loaded automatically.'
    Warn 'The app still works - retry it later with:'
    Warn "  docker exec $CtrApp python scripts/seed_universe.py"
} else {
    foreach ($l in ($r.Out -split "`r?`n")) { if ($l.Trim()) { Info $l.Trim() } }
}

# -- 9. Shortcuts -----------------------------------------------------------
Step 9 'Creating shortcuts'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
[IO.File]::WriteAllBytes($IconPath, [Convert]::FromBase64String($IconB64))

$launcher = @"
@echo off
title StockSage India
echo.
echo   Starting StockSage India...
echo.

docker info >nul 2>&1
if errorlevel 1 (
    echo   Starting Docker Desktop first - this takes a minute...
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
set /a DTRIES=0
:waitdocker
docker info >nul 2>&1
if errorlevel 1 (
    set /a DTRIES+=1
    if %DTRIES% GEQ 60 goto dockerfail
    timeout /t 5 >nul
    goto waitdocker
)

docker start $CtrDb >nul 2>&1
docker start $CtrApp >nul 2>&1

echo   Almost there...
where curl >nul 2>&1
if errorlevel 1 (
    rem No curl.exe - older Windows build. Just give it a fixed moment.
    timeout /t 25 >nul
    goto ready
)
set /a ATRIES=0
:waitapp
curl -fsS -m 3 http://127.0.0.1:$port/api/health >nul 2>&1
if errorlevel 1 (
    set /a ATRIES+=1
    if %ATRIES% GEQ 60 goto appfail
    timeout /t 3 >nul
    goto waitapp
)

:ready
start "" http://localhost:$port
exit /b 0

:dockerfail
echo.
echo   Docker Desktop would not start. Open it from the Start menu, wait until
echo   it says "Engine running", then use this shortcut again.
pause
exit /b 1

:appfail
echo.
echo   StockSage did not answer on http://localhost:$port
echo   To see why, run:   docker logs $CtrApp
pause
exit /b 1
"@

$stopper = @"
@echo off
title Stop StockSage
echo.
echo   Stopping StockSage...
docker stop $CtrApp >nul 2>&1
docker stop $CtrDb >nul 2>&1
echo   Stopped. Your data is untouched - start it again any time.
timeout /t 3 >nul
"@

$uninstaller = @"
@echo off
title Uninstall StockSage
echo.
echo   This removes the StockSage app from this computer.
echo.
set /p KEEP=  Also delete your portfolio database (y/N)?
docker rm -f $CtrApp $CtrDb >nul 2>&1
if /i "%KEEP%"=="y" docker volume rm $VolPg $VolJobs >nul 2>&1
docker network rm $Net >nul 2>&1
docker rmi $ImgApp $ImgDb >nul 2>&1
del "%USERPROFILE%\Desktop\StockSage.lnk" >nul 2>&1
rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\StockSage" >nul 2>&1
echo.
echo   Done. This folder can be deleted: %~dp0
pause
"@

$readme = @"
StockSage India - installed on this computer
============================================

Open it        Double-click the StockSage icon on the Desktop,
               or go to http://localhost:$port while it is running.
Close it       Start menu > StockSage > Stop StockSage.
               (Closing the browser tab does not stop it.)

First time     Register a username and password on the login screen. The first
               account created is the owner and gets its own paper portfolio.
               Nothing is sent anywhere - the account exists only on this PC.

Where things live
  App + database   Docker containers: $CtrApp, $CtrDb
  Your data        Docker volume "$VolPg" (portfolio, trades, history)
  Saved backtests  Docker volume "$VolJobs"
  This folder      $InstallDir
                   config.json holds this install's database password and
                   login secret. Keep it - a reinstall reuses it so your data
                   survives. It is readable by your Windows account only.

Day to day
  docker ps                           what is running
  docker logs $CtrApp            the app log, if something looks wrong
  docker exec $CtrApp python scripts/seed_universe.py
                                      refresh the stock list

Backup (whole database into one file)
  docker exec $CtrDb pg_dump -U stocksage stocksage > backup.sql

Notes
  - Market data comes from Yahoo Finance while you use the app, so the PC
    needs internet for fresh prices. Everything else is local.
  - The scheduler runs the 08:30 / 12:30 / 16:00 IST jobs, but only while the
    app is running. If the PC was off, trigger a run from the app instead.
  - Uninstall: Start menu > StockSage > Uninstall StockSage.
"@

Set-Content -LiteralPath (Join-Path $InstallDir 'StockSage.cmd')           -Value $launcher    -Encoding ASCII
Set-Content -LiteralPath (Join-Path $InstallDir 'Stop StockSage.cmd')      -Value $stopper     -Encoding ASCII
Set-Content -LiteralPath (Join-Path $InstallDir 'Uninstall StockSage.cmd') -Value $uninstaller -Encoding ASCII
Set-Content -LiteralPath (Join-Path $InstallDir 'README.txt')              -Value $readme      -Encoding ASCII

@{ port = $port; pgPassword = $pgPass; authSecret = $authSecret;
   version = '1.0'; installedAt = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content -LiteralPath $CfgPath -Encoding ASCII

function New-Shortcut {
    param($Path, $Target, $Desc, [int]$Style = 7)
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
    $sc.TargetPath       = $Target
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation     = $IconPath
    $sc.Description      = $Desc
    $sc.WindowStyle      = $Style      # 7 = start minimised; the browser is the UI
    $sc.Save()
}

$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\StockSage'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null

New-Shortcut (Join-Path $desktop   'StockSage.lnk')           (Join-Path $InstallDir 'StockSage.cmd')           'Open StockSage India'
New-Shortcut (Join-Path $startMenu 'StockSage.lnk')           (Join-Path $InstallDir 'StockSage.cmd')           'Open StockSage India'
New-Shortcut (Join-Path $startMenu 'Stop StockSage.lnk')      (Join-Path $InstallDir 'Stop StockSage.cmd')      'Shut StockSage down' 1
New-Shortcut (Join-Path $startMenu 'Uninstall StockSage.lnk') (Join-Path $InstallDir 'Uninstall StockSage.cmd') 'Remove StockSage'    1
Good 'Desktop shortcut created: StockSage'

Write-Host ''
Rule
Write-Host '   Installed.' -ForegroundColor Green
Write-Host ''
Write-Host "   Open it     Desktop icon 'StockSage'   (or http://localhost:$port)"
Write-Host '   Stop it     Start menu > StockSage > Stop StockSage'
Write-Host "   Notes       $InstallDir\README.txt"
Write-Host ''
Write-Host '   On the first screen, register a username and password - that'
Write-Host '   account is yours alone and never leaves this computer.'
Rule
Write-Host ''

Start-Process "http://localhost:$port"
Read-Host '  Press Enter to close'
exit 0
