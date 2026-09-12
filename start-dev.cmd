@echo off
REM Union-API-Proxy 开发实例启动脚本（与线上 CodeBuddy-API-Proxy 完全隔离）
REM
REM 隔离要点：
REM   PORT=3801                              与线上 3800 并存
REM   CODEBUDDY_DATA_DIR=%USERPROFILE%\.union-api-proxy  独立 SQLite，绝不触碰线上库
REM   CODEBUDDY_NO_OPEN=1                    不自动弹浏览器
REM
REM 用法：双击本文件，或命令行执行 start-dev.cmd

cd /d "%~dp0"

set PORT=3801
set CODEBUDDY_DATA_DIR=%USERPROFILE%\.union-api-proxy
set CODEBUDDY_NO_OPEN=1

echo Union-API-Proxy dev instance
echo   API/管理页: http://127.0.0.1:%PORT%
echo   数据目录:   %CODEBUDDY_DATA_DIR%
echo.

node server.js
