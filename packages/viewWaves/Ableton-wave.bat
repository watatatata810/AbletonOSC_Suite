@echo off
:: Change to the directory where the batch file is located
cd /d "%~dp0"

echo Starting Ableton Live Waveform Viewer...

:: Check if already running (Poka-Yoke)
tasklist /FI "WINDOWTITLE eq Ableton Waves" 2>NUL | find /I "neutralino-win_x64.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo The application is already running.
    timeout /t 2 >NUL
    exit /b
)

:: Start Neutralinojs (this automatically runs node server.js in background)
start "" "bin\neutralino-win_x64.exe" --load-dir-res --path=.
