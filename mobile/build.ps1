# Build the StockSage Android app (release, signed) → mobile\dist\StockSage.apk
#   powershell -ExecutionPolicy Bypass -File mobile\build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $root

$model = Join-Path $root "android\app\src\main\assets\finbert\model.onnx"
if (-not (Test-Path $model)) {
    Write-Host "FinBERT model missing - exporting it (needs backend\.venv with torch + transformers)..."
    & "$repo\backend\.venv\Scripts\python.exe" -m pip install --quiet onnx onnxscript onnxruntime
    & "$repo\backend\.venv\Scripts\python.exe" (Join-Path $root "scripts\export_finbert.py")
    if ($LASTEXITCODE -ne 0) { throw "FinBERT export failed" }
}

Push-Location (Join-Path $root "web")
if (-not (Test-Path node_modules)) { npm install }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Web build failed" }
Pop-Location

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
Push-Location (Join-Path $root "android")
.\gradlew.bat assembleRelease --console=plain
if ($LASTEXITCODE -ne 0) { throw "Android build failed" }
Pop-Location

$out = Join-Path $root "dist"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $root "android\app\build\outputs\apk\release\app-arm64-v8a-release.apk") (Join-Path $out "StockSage.apk") -Force
Write-Host "`nDone: $out\StockSage.apk"
