@echo off
chcp 866 >nul
echo ═══════════════════════════════════════════════════════════════════════════
echo   АВТОМАТИЧЕСКАЯ ПЕРЕСБОРКА И ЗАМЕНА WarehouseApp.exe
echo ═══════════════════════════════════════════════════════════════════════════
echo.

REM Проверка, запущен ли процесс
echo [1/6] Проверка запущенных процессов...
tasklist /FI "IMAGENAME eq WarehouseApp.exe" 2>NUL | find /I /N "WarehouseApp.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo.
    echo [!] ВНИМАНИЕ: WarehouseApp.exe запущен!
    echo.
    echo Пожалуйста, закройте приложение перед продолжением.
    echo Проверьте системный трей (область уведомлений).
    echo.
    pause
    exit /b 1
)
echo [OK] Процесс не запущен

REM Проверка зависимостей
echo.
echo [2/6] Проверка зависимостей (версии зафиксированы в requirements.txt)...
python -c "import PyQt5" 2>nul
if %errorlevel% neq 0 (
    echo [!] Зависимости не установлены. Устанавливаю...
    python -m pip install -r requirements.txt
) else (
    python -c "import PyInstaller" 2>nul
    if %errorlevel% neq 0 (
        python -m pip install -r requirements.txt
    )
)
echo [OK] Все зависимости установлены

REM Очистка старых файлов сборки
echo.
echo [3/6] Очистка старых файлов сборки...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
echo [OK] Очистка завершена

REM Сборка нового exe
echo.
echo [4/6] Сборка нового exe файла...
echo Это может занять несколько минут...
echo.
pyinstaller WarehouseApp_New.spec --clean
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] ОШИБКА: Сборка не удалась!
    echo.
    pause
    exit /b 1
)
echo [OK] Сборка завершена успешно

REM Проверка наличия нового файла
echo.
echo [5/6] Проверка результата...
if not exist "dist\WarehouseApp_New.exe" (
    echo [ERROR] ОШИБКА: Файл dist\WarehouseApp_New.exe не найден!
    pause
    exit /b 1
)
echo [OK] Новый exe файл создан

REM Резервное копирование старого файла
echo.
echo [6/6] Замена старого файла...
if exist "WarehouseApp.exe" (
    echo Создание резервной копии старого файла...
    set timestamp=%date:~-4%%date:~3,2%%date:~0,2%_%time:~0,2%%time:~3,2%%time:~6,2%
    set timestamp=%timestamp: =0%
    copy /Y "WarehouseApp.exe" "WarehouseApp_OLD_%timestamp%.exe" >nul
    echo [OK] Резервная копия создана: WarehouseApp_OLD_%timestamp%.exe
)

REM Копирование нового файла
echo Копирование нового файла...
copy /Y "dist\WarehouseApp_New.exe" "WarehouseApp.exe" >nul
if %errorlevel% neq 0 (
    echo [ERROR] ОШИБКА: Не удалось скопировать файл!
    pause
    exit /b 1
)
echo [OK] Новый файл скопирован

echo.
echo ═══════════════════════════════════════════════════════════════════════════
echo   [OK] ГОТОВО!
echo ═══════════════════════════════════════════════════════════════════════════
echo.
echo Новый WarehouseApp.exe готов к использованию!
echo.
echo Что изменилось:
echo   [OK] Исправлена проблема с бесконечным открытием окон
echo   [OK] Добавлена возможность указывать объект/город/отдел на этикетках
echo   [OK] Исправлена проблема с выбором оборудования
echo.
echo Теперь вы можете запустить WarehouseApp.exe
echo.
pause
