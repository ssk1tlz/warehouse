@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

rem Найти ISCC.exe: сначала переменная окружения ISCC (если задана),
rem затем поставленный для текущего пользователя Inno Setup 6,
rem затем стандартная установка для всех пользователей.
if defined ISCC (
    if not exist "%ISCC%" (
        echo ОШИБКА: Inno Setup не найден: "%ISCC%" ^(задан через переменную ISCC^)
        exit /b 1
    )
    goto :iscc_found
)

set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" goto :iscc_found

set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" goto :iscc_found

echo ОШИБКА: Inno Setup не найден.
echo Установите его командой: winget install -e --id JRSoftware.InnoSetup
exit /b 1

:iscc_found

if not exist "VERSION" (
    echo ОШИБКА: файл VERSION не найден.
    exit /b 1
)
set /p WAREHOUSE_VERSION=<VERSION

python bump_version.py --check
if errorlevel 1 (
    echo ОШИБКА: файлы версии рассинхронизированы с VERSION.
    exit /b 1
)

echo Сборка EXE (PyInstaller)...
pyinstaller WarehouseApp_New.spec --noconfirm
if errorlevel 1 (
    echo ОШИБКА: не удалось собрать EXE.
    exit /b 1
)

echo Сборка установщика версии %WAREHOUSE_VERSION%...
"%ISCC%" installer\warehouse.iss
if errorlevel 1 (
    echo ОШИБКА: не удалось собрать установщик.
    exit /b 1
)

echo.
echo Готово: installer\output\WarehouseSetup-%WAREHOUSE_VERSION%.exe
