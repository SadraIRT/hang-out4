@echo off
echo Starting Hangout 4 + ngrok...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run-with-ngrok.ps1"
pause
