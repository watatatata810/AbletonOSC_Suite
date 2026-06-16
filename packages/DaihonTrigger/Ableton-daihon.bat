@echo off
:: Change to the directory where the batch file is located
cd /d "%~dp0"

echo ==============================================
echo  Starting DaihonTrigger Server...
echo ==============================================

:: Find and kill the process safely using port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| find "LISTENING" ^| find ":3001 "') do (
    echo [Info] Port 3001 is in use by PID %%a. Killing the old process...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 >nul
)

:: Set environment variables for the router
set OSC_PORT=11003
set PORT=3001

:: Start the Node.js server
node server.js

:: Keep the window open in case of errors
pause
