@echo off
chcp 65001 >nul
title Остановка Склад IT-техники

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    set FOUND=1
    echo Останавливаю процесс %%p...
    taskkill /PID %%p /F >nul 2>nul
)

if "%FOUND%"=="0" (
    echo Сервер не запущен.
) else (
    echo Сервер остановлен.
)
timeout /t 2 /nobreak >nul
exit /b 0
