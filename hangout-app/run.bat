@echo off
REM Hangout 4 - Double-click to run (no admin needed)
REM This bypasses PowerShell ExecutionPolicy automatically
echo Starting Hangout 4...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run.ps1"
if errorlevel 1 (
  echo.
  echo Server stopped with error. Press any key to close.
  pause >nul
)
