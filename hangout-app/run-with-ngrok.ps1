# Hangout 4 - Auto Run + Ngrok Share (one click)
Set-Location $PSScriptRoot
Write-Host "==========================================" -ForegroundColor Yellow
Write-Host " Hangout 4 + ngrok (Live Share) " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Yellow

# find ngrok
$ngrok = $null
if (Test-Path "G:\coding\ngrok.exe") { $ngrok = "G:\coding\ngrok.exe" }
elseif (Test-Path "$PSScriptRoot\ngrok.exe") { $ngrok = "$PSScriptRoot\ngrok.exe" }
elseif (Get-Command ngrok -ErrorAction SilentlyContinue) { $ngrok = "ngrok" }
else { Write-Host "ngrok.exe not found! Put ngrok.exe in G:\coding\ or hangout-app\" -ForegroundColor Red; Write-Host "Download: https://ngrok.com/download" -ForegroundColor Yellow; $ngrok = $null }

# start server in background job
Write-Host "Starting server on :8000..." -ForegroundColor Green
$serverJob = Start-Job -ScriptBlock {
    Set-Location $using:PSScriptRoot
    python -m uvicorn backend.server:app --host 0.0.0.0 --port 8000
}
Start-Sleep -Seconds 4
# check health
try {
    $h = Invoke-WebRequest -Uri "http://localhost:8000/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "Server OK: $($h.Content)" -ForegroundColor Green
    Start-Process "http://localhost:8000"
} catch {
    Write-Host "Server failed to start: $_" -ForegroundColor Red
    Stop-Job $serverJob; Remove-Job $serverJob; exit 1
}

if ($ngrok) {
    Write-Host ""
    Write-Host "Starting ngrok tunnel..." -ForegroundColor Cyan
    Write-Host "Share the https://xxxx.ngrok-free.app URL with friends!" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop both." -ForegroundColor DarkGray
    # run ngrok in foreground (blocks)
    & $ngrok http 8000
    # cleanup
    Stop-Job $serverJob -ErrorAction SilentlyContinue; Remove-Job $serverJob -ErrorAction SilentlyContinue
} else {
    Write-Host "Run manually: ngrok http 8000" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop server." -ForegroundColor DarkGray
    Wait-Job $serverJob
}
