@echo off
chcp 65001 >nul
title AgentForge - Stop
cd /d "%~dp0"

echo [*] Dang tim va dung AgentForge server tren port 3001...
set "FOUND=0"
REM Chi target tien trinh dang LISTEN tren local port 3001; bo qua PID he thong 0/4.
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001" ^| findstr "LISTENING"') do (
    if not "%%a"=="0" (
        if not "%%a"=="4" (
            echo   - Phat hien PID %%a dang LISTEN tren port 3001, dang ket thuc...
            taskkill /F /PID %%a >nul 2>&1
            if errorlevel 1 echo     ! Khong the ket thuc PID %%a - bo qua.
            set "FOUND=1"
        ) else (
            echo   - Phat hien PID 4 - System - dang giu port 3001. KHONG the kill System.
            echo     Kiem tra HTTP.sys: netsh http show urlacl ^| findstr 3001
        )
    )
)
if "%FOUND%"=="0" (
    echo   + Khong tim thay tien trinh nao dang LISTEN tren port 3001 - server co the da dung hoac chua khoi chay.
) else (
    timeout /t 2 /nobreak >nul
    netstat -aon 2>nul | findstr ":3001" | findstr "LISTENING" >nul
    if errorlevel 1 (echo   + Da dung thanh cong, port 3001 da sach.) else (echo   ! Port 3001 van con listener - co the la PID 4 - System.)
)
echo Xong.
pause
