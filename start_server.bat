@echo off
chcp 866 >nul
cd /d "%~dp0"
title Запуск Склад IT-техники

rem Если сервер уже работает - просто открываем браузер
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo Сервер уже запущен. Открываю браузер...
    start http://127.0.0.1:8765/
    exit /b 0
)

rem Проверяем наличие Python
where python >nul 2>nul
if errorlevel 1 (
    echo ОШИБКА: Python не найден. Установите Python или запустите WarehouseApp.exe
    pause
    exit /b 1
)

echo Запуск сервера...
start "Warehouse Server" /min python server.py

rem Даем серверу время подняться, затем открываем браузер
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8765/
exit /b 0
