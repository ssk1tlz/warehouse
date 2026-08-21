@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Возврат к локальному режиму

net session >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: запустите этот файл от имени администратора
    pause
    exit /b 1
)

echo Возвращаю локальный режим...

if exist config.json (
    del config.json
    echo   [1/2] config.json удален — сервер снова доступен только с этого компьютера
) else (
    echo   [1/2] config.json не найден — уже локальный режим
)

netsh advfirewall firewall delete rule name="Склад IT-техники" >nul 2>nul
echo   [2/2] Правило брандмауэра удалено

echo.
echo ГОТОВО. Перезапустите приложение (или сервер), чтобы настройки применились.
echo.
pause
