@echo off
chcp 866 >nul
title Возврат к локальному режиму

net session >nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: запустите этот файл от имени администратора
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

echo Возвращаю локальный режим...

rem Правим %ProgramData%\Warehouse\config.json, сохраняя остальные ключи
rem (например checkUpdates), а не удаляя файл целиком.
echo   Обновляю %ProgramData%\Warehouse\config.json...
python -c "import json,os,pathlib; p=pathlib.Path(os.environ['ProgramData'])/'Warehouse'/'config.json'; p.parent.mkdir(parents=True, exist_ok=True); d=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}; d['host']='127.0.0.1'; d.setdefault('port',8765); p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8'); print(p)"
if errorlevel 1 (
    echo ОШИБКА: не удалось изменить config.json
    pause
    exit /b 1
)
echo   [1/2] config.json обновлён - сервер снова доступен только с этого компьютера

netsh advfirewall firewall delete rule name="Склад IT-техники" >nul 2>nul
echo   [2/2] Правило брандмауэра удалено

echo.
echo ГОТОВО. Перезапустите приложение (или сервер), чтобы настройки применились.
echo.
pause
