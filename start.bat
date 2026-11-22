@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title capy-relay

echo ============================================
echo   capy-relay  -  local OpenAI endpoint
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)

rem optional: start.bat login  -> force a fresh login
set "EXTRA="
if /i "%~1"=="login" set "EXTRA=--relogin"
if /i "%~1"=="relogin" set "EXTRA=--relogin"

rem ---------- [1/3] account: check session, show login menu if needed ----------
rem this part lives in start.js so the Chinese prompts render correctly
node start.js prepare %EXTRA%
if errorlevel 1 (
  echo.
  echo [!] Not started. Fix the message above, then run start.bat again.
  pause
  exit /b 1
)

rem ---------- [2/3] device worker ----------
echo [2/3] Starting device worker (window "capy-device", minimized)
start "capy-device" /min cmd /c "node device-worker.js"
rem use the full path: a GNU timeout earlier in PATH would choke on /t
"%SystemRoot%\System32\timeout.exe" /t 2 >nul

rem ---------- [3/3] relay ----------
echo [3/3] Relay on http://127.0.0.1:8787/v1
echo Keep this window open. Closing it stops the relay.
echo.
node server.js
echo.
echo Relay exited.
pause
