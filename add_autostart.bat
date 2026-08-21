@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Автозапуск при включении компьютера

if not exist "%~dp0WarehouseApp.exe" (
    echo ОШИБКА: WarehouseApp.exe не найден рядом с этим скриптом.
    pause
    exit /b 1
)

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut([IO.Path]::Combine($ws.SpecialFolders['Startup'], 'WarehouseApp.lnk')); $sc.TargetPath = '%~dp0WarehouseApp.exe'; $sc.WorkingDirectory = '%~dp0'; $sc.Description = 'Склад IT-техники'; $sc.Save()"

if errorlevel 1 (
    echo ОШИБКА: не удалось создать ярлык автозапуска.
) else (
    echo ГОТОВО. WarehouseApp.exe будет запускаться автоматически
    echo при входе текущего пользователя в систему.
    echo.
    echo Чтобы убрать автозапуск: Win+R -^> shell:startup -^> удалите ярлык WarehouseApp
)
echo.
pause
