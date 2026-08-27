@echo off
chcp 65001 >nul
title AgentForge
cd /d "%~dp0"

echo [1/3] Dang giai phong port 3001 - chi tien trinh dang LISTEN local...
REM Chi target tien trinh dang LISTEN tren local port 3001; bo qua PID he thong 0/4.
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001" ^| findstr "LISTENING"') do (
    if not "%%a"=="0" (
        if not "%%a"=="4" (
            echo   - Phat hien PID %%a dang LISTEN tren port 3001, dang ket thuc...
            taskkill /F /PID %%a >nul 2>&1
            if errorlevel 1 echo     ! Khong the ket thuc PID %%a - bo qua.
        ) else (
            echo   - Phat hien PID 4 - System - dang giu port 3001. KHONG the kill System.
            echo     Kiem tra HTTP.sys: netsh http show urlacl ^| findstr 3001
        )
    )
)
timeout /t 2 /nobreak >nul

echo [2/3] Kiem tra lai port 3001...
set "PORT_BUSY=0"
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001" ^| findstr "LISTENING"') do set "PORT_BUSY=1"
if "%PORT_BUSY%"=="1" (
    echo   ! Canh bao: port 3001 van bi chiem.
    echo     - Neu la PID 4 - System hoac HTTP.sys: chay "netsh http show urlacl ^| findstr 3001" de tim reservation va xoa, hoac doi PORT.
    echo     - Neu la PID khac: dung Task Manager ket thuc tien trinh do, roi chay lai.
    pause
    exit /b 1
)
echo   + Port 3001 da sach.

echo [3/3] Khoi chay AgentForge - Non-Watch (server khong restart khi sua code)...
call npm run start
pause
