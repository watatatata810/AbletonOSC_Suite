@echo off
title OscTester Server
cd /d "%~dp0"

echo ==============================================
echo  Starting OscTester Server...
echo ==============================================

:: Find and kill the process safely using port 3010
for /f "tokens=5" %%a in ('netstat -aon ^| find "LISTENING" ^| find ":3010 "') do (
    echo [Info] Port 3010 is in use by PID %%a. Killing the old process...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 >nul
)

echo Checking packages...
call npm install
node server.js
pause
