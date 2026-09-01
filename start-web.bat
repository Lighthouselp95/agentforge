@echo off
setlocal
cd /d "%~dp0"
title AgentForge Web Launcher

set PORT=3001
set OPEN_BROWSER=1

if exist "release\agentforge-web.exe" (
    echo [Launcher] Starting AgentForge standalone exe ...
    start "AgentForge Server" /min release\agentforge-web.exe
) else if exist "dist\server.js" (
    echo [Launcher] Starting AgentForge server from dist ...
    start "AgentForge Server" /min node dist\server.js --open
) else (
    echo [Launcher] dist not found - starting via npm run dev ...
    start "AgentForge Server" /min cmd /c "npm run dev -- --open"
)

echo [Launcher] Server is starting minimized.
echo [Launcher] Browser will open http://localhost:%PORT%/v2 automatically.
echo [Launcher] This window can be closed safely - server keeps running.
timeout /t 3 >nul
exit /b 0
