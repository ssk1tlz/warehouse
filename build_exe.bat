@echo off
echo ========================================
echo Building Warehouse App EXE
echo ========================================
echo.

REM Check if PyInstaller is installed
python -c "import PyInstaller" 2>nul
if %errorlevel% neq 0 (
    echo PyInstaller not found. Installing...
    python -m pip install pyinstaller
    if %errorlevel% neq 0 (
        echo Failed to install PyInstaller
        pause
        exit /b 1
    )
)

REM Check if PyQt5 is installed
python -c "import PyQt5" 2>nul
if %errorlevel% neq 0 (
    echo PyQt5 not found. Installing...
    python -m pip install PyQt5
    if %errorlevel% neq 0 (
        echo Failed to install PyQt5
        pause
        exit /b 1
    )
)

echo.
echo Cleaning old build files...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist WarehouseApp.spec del /q WarehouseApp.spec

echo.
echo Building executable...
echo.

REM Build the executable
pyinstaller --onefile ^
    --windowed ^
    --name "WarehouseApp_New" ^
    --icon=NONE ^
    --add-data "server.py;." ^
    --add-data "app.js;." ^
    --add-data "index.html;." ^
    --add-data "styles.css;." ^
    --add-data "schema.sql;." ^
    --add-data "act_generator.py;." ^
    --add-data "mobile_actions.py;." ^
    --add-data "qrcode-lib.js;." ^
    --add-data "chart.umd.min.js;." ^
    --hidden-import=PyQt5 ^
    --hidden-import=sqlite3 ^
    --clean ^
    warehouse_tray.py

if %errorlevel% neq 0 (
    echo.
    echo Build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo Build completed successfully!
echo ========================================
echo.
echo Executable location: dist\WarehouseApp_New.exe
echo.
echo Next steps:
echo 1. Close any running WarehouseApp.exe
echo 2. Backup old WarehouseApp.exe (if exists)
echo 3. Copy dist\WarehouseApp_New.exe to d:\warehouse\
echo 4. Rename to WarehouseApp.exe
echo 5. Run WarehouseApp.exe
echo.
pause

