@echo off
REM Union-API-Proxy dev instance (isolated from the production CodeBuddy-API-Proxy).
REM
REM Isolation:
REM   PORT=3801                     coexist with the production instance on 3800
REM   CODEBUDDY_DATA_DIR=...        separate SQLite, never touches the production DB
REM   CODEBUDDY_NO_OPEN=1           do not auto-open the browser
REM
REM Usage: double-click this file, or run "start-dev.cmd" in a terminal.

cd /d "%~dp0"

set PORT=3801
set CODEBUDDY_DATA_DIR=%USERPROFILE%\.union-api-proxy
set CODEBUDDY_NO_OPEN=1

echo Union-API-Proxy dev instance
echo   Web UI / API : http://127.0.0.1:%PORT%
echo   Data dir     : %CODEBUDDY_DATA_DIR%
echo.

node server.js
