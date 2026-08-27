@echo off
chcp 866 >nul
cd /d "%~dp0"
title Настройка сетевого режима

rem Нужны права администратора (правило брандмауэра)
net session >nul 2>&1
if errorlevel 1 (
    echo Ошибка: запустите этот файл от имени администратора
    echo ^(правый клик -^> "Запуск от имени администратора"^)
    pause
    exit /b 1
)

echo Настройка сетевого режима...

rem 1. Конфигурация: сервер слушает все сетевые интерфейсы
(
echo {
echo   "host": "0.0.0.0",
echo   "port": 8765
echo }
) > config.json
echo   [1/3] config.json создан

rem 2. Правило брандмауэра для порта 8765
netsh advfirewall firewall delete rule name="Склад IT-учёта" >nul 2>nul
netsh advfirewall firewall add rule name="Склад IT-учёта" dir=in action=allow protocol=TCP localport=8765 >nul
echo   [2/3] Правило брандмауэра установлено (TCP 8765)

echo   [3/3] Доступ теперь контролируется учётными записями пользователей - при первом запуске приложения появится мастер создания администратора

echo.
echo Готово. Перезапустите приложение (если открыто), чтобы настройки применились.
echo.
echo Адрес для других компьютеров в сети:
for /f %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | Select-Object -First 1).IPAddress"') do (
    echo   http://%%i:8765/
)
echo.
echo Чтобы вернуть локальный режим, запустите setup_local.bat
echo.
pause
