@echo off
chcp 866 >nul
title Настройка сетевого режима

rem Нужны права администратора (правило брандмауэра)
net session >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: запустите этот файл от имени администратора
    echo ^(правый клик -^> "Запуск от имени администратора"^)
    pause
    exit /b 1
)

rem Правка config.json в %ProgramData%\Warehouse требует Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: Python не найден. Установите Python 3 и добавьте его в PATH,
    echo затем запустите этот файл ещё раз.
    pause
    exit /b 1
)

echo Включаю сетевой режим...

rem 1. Конфигурация: сервер слушает все сетевые интерфейсы.
rem    Правим %ProgramData%\Warehouse\config.json, сохраняя остальные
rem    ключи (например checkUpdates), а не создавая файл заново.
echo   Обновляю %ProgramData%\Warehouse\config.json...
python -c "import json,os,pathlib; p=pathlib.Path(os.environ['ProgramData'])/'Warehouse'/'config.json'; p.parent.mkdir(parents=True, exist_ok=True); d=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}; d['host']='0.0.0.0'; d.setdefault('port',8765); p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8'); print(p)"
if errorlevel 1 (
    echo ОШИБКА: не удалось изменить config.json
    pause
    exit /b 1
)
echo   [1/3] config.json обновлён

rem 2. Правило брандмауэра для порта 8765
netsh advfirewall firewall delete rule name="Склад IT-техники" >nul 2>nul
netsh advfirewall firewall add rule name="Склад IT-техники" dir=in action=allow protocol=TCP localport=8765 >nul
echo   [2/3] Правило брандмауэра добавлено (TCP 8765)

echo   [3/3] Доступ теперь контролируется учётными записями пользователей - при первом запуске появится мастер создания администратора

echo.
echo ГОТОВО. Перезапустите приложение (или сервер), чтобы настройки применились.
echo.
echo Адрес сервера для мобильного приложения:
for /f %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | Select-Object -First 1).IPAddress"') do (
    echo   http://%%i:8765/
)
echo.
echo Этот адрес нужен мобильному приложению. Отсканируйте им QR-код
echo в разделе "Пользователи" настольного приложения - адрес пропишется сам.
echo.
echo Открывать этот адрес в браузере на другом компьютере больше нельзя:
echo работа с приложением идёт на этом компьютере, а по сети - только мобильное приложение.
echo.
echo Чтобы вернуть локальный режим, запустите setup_local.bat
echo.
pause
