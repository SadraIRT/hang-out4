# Hangout 4 - One-Click Auto Runner
# Double-click via run.bat (bypasses ExecutionPolicy) or right-click Run with PowerShell
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host " Hangout 4 Live Sync (Toman) " -ForegroundColor Cyan
Write-Host " Host: sadra89.r@gmail.com " -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Yellow

# 1. Check Python
try { $pyVer = python --version 2>&1 } catch { Write-Host "Python not found! Install Python 3.10+ and add to PATH" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
Write-Host "Python: $pyVer" -ForegroundColor Green

# 2. Install deps if missing
if (-not (python -c "import fastapi" 2>$null; echo $? | findstr True) -or $LASTEXITCODE -ne 0) {
}
# robust check
python -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing backend deps..." -ForegroundColor Yellow
    pip install -r backend/requirements.txt
    if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed" -ForegroundColor Red; Read-Host "Press Enter"; exit 1 }
}

# 3. Ensure DB & port free
$port = 8000
$existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) { Write-Host "Port $port busy (maybe server already running). Trying to use it..." -ForegroundColor Yellow }

# 4. Open browser after 2 sec
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    try { Start-Process "http://localhost:8000" } catch {}
    Write-Host "Browser opened: http://localhost:8000" -ForegroundColor Cyan
} | Out-Null

# 5. Start server (blocking) - use python -m uvicorn so PATH not needed
Write-Host ""
Write-Host "Starting server on http://localhost:8000 ..." -ForegroundColor Green
Write-Host "Share via ngrok: run run-with-ngrok.bat or 'ngrok http 8000' in another terminal" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

try {
    python -m uvicorn backend.server:app --host 0.0.0.0 --port $port --reload
} catch {
    Write-Host "Failed to start: $_" -ForegroundColor Red
    Write-Host "Try: python -m pip install -r backend/requirements.txt" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}
