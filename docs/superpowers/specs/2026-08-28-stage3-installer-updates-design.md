# Этап 3 дорожной карты: установщик, подпись сборок и обновления — дизайн

## Контекст

Этапы 1-2 (`docs/superpowers/specs/2026-08-27-stage1-foundation-design.md`,
`2026-08-27-stage2-conflicts-integrity-design.md`) уже в `master`: миграции
схемы, роли/токены, HMAC-канал, обнаружение конфликтов, WAL + integrity
check, восстановление из бэкапа, тосты на мобильном. Этот этап не трогает
складскую логику — готовит продукт к установке у людей, которые не будут
собирать его из исходников.

Сейчас: установка = скопировать `WarehouseApp.exe` куда угодно и запустить
`setup_local.bat`/`setup_lan.bat`/`add_autostart.bat`. `warehouse.db`,
`backups/`, `config.json` лежат рядом с EXE — обновление приложения (замена
EXE) требует ручного переноса файлов. Мобильное собирается только debug-APK
(`gradlew.bat assembleDebug`), устанавliвается вручную через ADB/файл.
Версии нигде не зафиксированы: ни в EXE, ни в `build.gradle` (`versionCode
1`/`versionName "1.0"` — не менялись с создания проекта). Логи — `print()` в
`server.py`/`warehouse_tray.py`, ничего не пишется в файл.

**Инфраструктурное решение, принятое в ходе брейнsторминга:** у проекта не
было ни одного git remote. Создан публичный репозиторий
`https://github.com/ssk1tlz/warehouse` (`gh repo create`, история коммитов
проверена — `config.json`/`warehouse.db`/секретов в ней никогда не было),
`master` запушен, `origin` настроен. Публичность — не косметика, а
требование Задачи D: анонимная проверка обновлений без встроенного токена
работает только у публичного репозитория GitHub.

## Не-цели этого этапа

- **Платная подпись кода Windows-сертификатом** — прямо исключена в промте.
  Вместо неё: `docs/RELEASING.md` документирует предупреждение SmartScreen
  "Windows защитила ваш компьютер" и как через него пройти
  (`Дополнительно -> Выполнить в любом случае`), с пометкой, что покупка
  сертификата снимает это позже.
- **Автозагрузка/автоустановка обновлений.** Задача D — только уведомление
  со ссылкой на страницу релиза; никакого фонового скачивания файлов,
  никакой телеметрии (сам факт проверки не сообщает на сервер проекта
  ничего, кроме анонимного GET к публичному GitHub API).
- **Windows Service вместо автозапуска по входу.** Текущий механизм
  (ярлык в папке `Startup`, `add_autostart.bat`) переносится в установщик
  как есть — не заменяется службой. Не запрошено, лишняя сложность
  (регистрация/права службы) ради того же результата.
- **Персистентное "не показывать это обновление снова"** для плашки на
  десктопе. Плашка дублируется при каждом перезапуске приложения, пока
  версия не обновится, — простейшее поведение, соответствует духу
  "ненавязчиво, но не давать забыть"; сессионного скрытия (крестик)
  достаточно.
- **iOS/другие мобильные платформы.** Мобильное приложение — Android-only
  (как и на предыдущих этапах); Задача C про release-подпись касается
  только `mobile/android`.

## Выбранные варианты (зафиксировано с пользователем)

- **`%ProgramData%\Warehouse`, не `%APPDATA%`.** Приложение ставится в
  Program Files (машинно), сервер обслуживает LAN независимо от того, какой
  пользователь Windows сейчас залогинен; `%ProgramData%` не привязан к
  профилю пользователя (важно при роуминг-профилях) и по умолчанию
  доступен на запись без повышения прав.
- **GitHub-репозиторий публичный.** Альтернатива (приватный репозиторий +
  вшитый в бинарник read-only токен) отклонена: токен, извлекаемый из
  скачанного EXE/APK 100% пользователей, не является секретом — это
  security-театр, который создаёт ложное чувство приватности и требует
  процесса ротации при утечке. Публичный репозиторий раскрывает только
  исходный код (не данные, не бизнес-информацию заказчика).
- **Одна версия на весь продукт**, не отдельные версии десктопа и
  мобильного. Один Git-тег `vX.Y.Z` = один релиз = один установщик +
  один release-APK, оба из одного и того же коммита. Соответствует
  прямому требованию Задачи C ("версия десктопа и мобильного — из одного
  источника").

## Архитектура: границы модулей

Новые модули и файлы:

- **`paths.py`** (новый) — единственное место вычисления `DATA_DIR`,
  `DB_PATH`, `BACKUP_DIR`, `CONFIG_FILE`, `LOG_DIR`; функция
  `migrate_legacy_data()`. `server.py`, `warehouse_tray.py`, `migrations.py`
  импортируют пути отсюда вместо локального вычисления `ROOT`.
- **`VERSION`** (новый, корень репозитория) — обычный текстовый файл,
  единственная строка `X.Y.Z`. Источник версии для PyInstaller-сборки,
  `build.gradle`, `/api/state`, баннера обновлений.
- **`bump_version.py`** (новый) — `python bump_version.py {major|minor|patch}`
  обновляет `VERSION` и синхронизированный `mobile/www/js/version.js`
  одной командой.
- **`installer/warehouse.iss`** + **`installer/build_installer.bat`**
  (новые) — Inno Setup скрипт и обёртка сборки.
- **`mobile/android/keystore.properties`** (не коммитится,
  `.gitignore`) — путь и пароли release-keystore, читается
  `mobile/android/app/build.gradle`.
- **`docs/RELEASING.md`** (новый) — пошаговая инструкция выпуска релиза
  от и до (см. "Тестирование"/критерии приёмки).

Существующие точки изменения:

- **`server.py`** — `init_db()` вызывает `paths.migrate_legacy_data()` до
  открытия БД; `logging` вместо части `print()`; новые
  `GET/POST /api/settings`, поле `latestVersion`/`currentVersion` в
  `GET /api/state`; фоновая (не блокирующая старт) проверка GitHub раз в
  сутки.
- **`warehouse_tray.py`** — использует пути из `paths.py` вместо
  собственного `ROOT`.
- **`mobile/android/app/build.gradle`** — `versionName`/`versionCode` из
  `VERSION`; `signingConfig release`.
- **`app.js`/`index.html`** — модалка "Настройки" (admin) с чекбоксом
  "Проверять обновления"; баннер новой версии.
- **`mobile/www/js/screens.js`/`mobile/www/index.html`** — блок версии +
  баннер на экране настроек; `mobile/www/js/version.js` (новый, коммитится,
  обновляется `bump_version.py`).

## Задача A — разделение программы и данных

### `paths.py`

```python
import os
from pathlib import Path

def _data_dir() -> Path:
    base = os.environ.get("ProgramData", r"C:\ProgramData")
    return Path(base) / "Warehouse"

DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "warehouse.db"
BACKUP_DIR = DATA_DIR / "backups"
CONFIG_FILE = DATA_DIR / "config.json"
LOG_DIR = DATA_DIR / "logs"
```

`server.py`/`warehouse_tray.py`/`migrations.py` больше не вычисляют `ROOT`
для данных (PyInstaller `ROOT` остаётся — он всё ещё нужен для read-only
ресурсов внутри `_MEIPASS`, если такие есть, но не для `DB_PATH` и т.п.).

### Миграция legacy-расположения

```python
def legacy_root() -> Path:
    """Папка рядом с исполняемым файлом — где раньше жили данные."""
    import sys
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

def migrate_legacy_data() -> None:
    if DB_PATH.exists():
        return  # уже мигрировано или чистая установка
    old_db = legacy_root() / "warehouse.db"
    if not old_db.exists():
        return  # действительно чистая установка, мигрировать нечего
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # DB через ту же WAL-safe online-backup копию, что и server._copy_database()
    # (переиспользуется, не дублируется — см. "Границы модулей")
    ...
    # config.json и backups/ — обычным shutil.copy2/copytree
    ...
    # исходные файлы НЕ удаляются: переименовываются в *.migrated,
    # чтобы падение на середине миграции было восстановимо и ничего не терялось
```

Ключевое: копирование, не перемещение, с переименованием источника
(`warehouse.db` → `warehouse.db.migrated`) только после успешного
копирования — тот же принцип "не удалять, пока не подтверждена копия",
что и в `pre_restore_backup()` из Этапа 2. `_copy_database()` (уже
существует в `server.py` с Этапа 2, WAL-aware через `Connection.backup()`)
переиспользуется через импорт, а не копипастится — единственное безопасное
место, которое умеет копировать живую БД.

Идемпотентность: проверка `if DB_PATH.exists(): return` в начале —
повторный запуск (после уже случившейся миграции) не трогает файлы вообще.

### Логирование

`logging.handlers.RotatingFileHandler(LOG_DIR / "warehouse.log", maxBytes=5_000_000, backupCount=3)`,
уровень INFO. Заменяет `print()` на границе запуска/остановки сервера и
любые `except Exception as e: print(...)` в `warehouse_tray.py` — не
построчный лог HTTP-запросов (лишний шум и рост файла без пользы для
единственного разработчика, поддерживающего этот проект).

## Задача B — установщик Windows (Inno Setup)

`installer/warehouse.iss`, ключевые директивы:

```
#define MyAppVersion GetEnv("WAREHOUSE_VERSION")
[Setup]
AppId={{FD91C08C-6D2F-45E6-A98B-F77C8CDDE02F}}
AppName=Склад IT-техники
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\Warehouse
DefaultGroupName=Склад IT-техники
OutputBaseFilename=WarehouseSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes

[Files]
Source: "..\dist\WarehouseApp_New.exe"; DestDir: "{app}"; DestName: "WarehouseApp.exe"

[Icons]
Name: "{group}\Склад IT-техники"; Filename: "{app}\WarehouseApp.exe"
Name: "{autodesktop}\Склад IT-техники"; Filename: "{app}\WarehouseApp.exe"

[Tasks]
Name: "autostart"; Description: "Запускать при входе в Windows"; Flags: unchecked
Name: "firewall"; Description: "Открыть порт в файрволе для сети склада (нужно для подключения телефона)"; Flags: unchecked

[Icons]
Name: "{userstartup}\WarehouseApp"; Filename: "{app}\WarehouseApp.exe"; Tasks: autostart

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Склад IT-техники"" dir=in action=allow protocol=TCP localport=8765"; Tasks: firewall; Flags: runhidden

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Склад IT-техники"""; Flags: runhidden
```

`installer\build_installer.bat`: читает `VERSION`, экспортирует
`WAREHOUSE_VERSION`, запускает `pyinstaller` (если `dist\` не свежее
исходников) и `iscc.exe installer\warehouse.iss`.

`AppId` выше сгенерирован один раз для этого проекта и должен оставаться
неизменным во всех будущих версиях (Inno Setup использует его, чтобы
находить и заменять предыдущую установку при обновлении) — не
перегенерировать в плане реализации или в последующих релизах.

`{app}` — только `Program Files\Warehouse`; `%ProgramData%\Warehouse`
вне этой директории, поэтому деинсталлятор Inno Setup **по умолчанию** её
не трогает — никакого специального кода "не удалять данные" не нужно, это
следствие правильного выбора `DefaultDirName`, а не отдельная защита,
которую можно случайно сломать.

Bat-файлы в корне (`add_autostart.bat`, `setup_lan.bat`, `setup_local.bat`,
`start_server.bat`, `stop_server.bat`) остаются — это путь для разработки
(запуск без установки), не для конечного пользователя. `ИНСТРУКЦИЯ.txt`/
`БЫСТРЫЙ_СТАРТ.txt` переписываются: основной путь — скачать установщик со
страницы релиза, bat-файлы упоминаются как "для разработчиков".

## Задача C — release-подпись Android + единая версия

### `VERSION` и `bump_version.py`

```python
# bump_version.py
import re, sys
from pathlib import Path

VERSION_FILE = Path(__file__).parent / "VERSION"
MOBILE_VERSION_JS = Path(__file__).parent / "mobile/www/js/version.js"

def bump(part: str) -> str:
    major, minor, patch = map(int, VERSION_FILE.read_text().strip().split("."))
    if part == "major": major, minor, patch = major + 1, 0, 0
    elif part == "minor": minor, patch = minor + 1, 0
    elif part == "patch": patch += 1
    else: raise SystemExit("Использование: bump_version.py {major|minor|patch}")
    new_version = f"{major}.{minor}.{patch}"
    VERSION_FILE.write_text(new_version + "\n")
    MOBILE_VERSION_JS.write_text(f"window.APP_VERSION = '{new_version}';\n")
    return new_version

if __name__ == "__main__":
    print(bump(sys.argv[1]))
```

`mobile/www/js/version.js` **коммитится** (не генерируется только на
сборке) — так и десктоп, и мобильное всегда видят одну и ту же версию из
одного файла в git, без отдельного шага генерации перед каждым запуском в
разработке.

### `build.gradle`

```groovy
def versionProps = new Properties()
def versionFile = rootProject.file('../VERSION')
def versionParts = versionFile.text.trim().split('\\.')
def (vMajor, vMinor, vPatch) = versionParts.collect { it as int }

android {
    defaultConfig {
        versionCode vMajor * 10000 + vMinor * 100 + vPatch
        versionName "${vMajor}.${vMinor}.${vPatch}"
    }
    signingConfigs {
        release {
            def propsFile = rootProject.file('keystore.properties')
            if (propsFile.exists()) {
                def props = new Properties()
                props.load(new FileInputStream(propsFile))
                storeFile file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}

tasks.whenTaskAdded { task ->
    if (task.name == "validateSigningRelease" && !rootProject.file('keystore.properties').exists()) {
        task.doFirst {
            throw new GradleException(
                "keystore.properties не найден — assembleRelease требует release-подпись. " +
                "См. docs/RELEASING.md."
            )
        }
    }
}
```

Известное упрощение: формула `versionCode` предполагает `minor`/`patch` <
100 — при текущем темпе релизов этого проекта достаточный запас,
документируется в `docs/RELEASING.md` как ограничение, не решается заранее
(YAGNI).

### Keystore

`docs/RELEASING.md` документирует: `keytool -genkeypair -v -keystore
warehouse.jks -keyalg RSA -keysize 2048 -validity 10000 -alias warehouse`,
выполняется один раз, файл хранится вне репозитория (например,
`%USERPROFILE%\.warehouse-release\warehouse.jks`), путь и пароли — в
`mobile/android/keystore.properties` (в `.gitignore`).

## Задача D — проверка обновлений через GitHub Releases

### Контракт GitHub API

`GET https://api.github.com/repos/ssk1tlz/warehouse/releases/latest` (без
токена — публичный репозиторий), таймаут 3 сек, `User-Agent` заголовок
обязателен для GitHub API. Тег релиза — строго `vX.Y.Z`, релиз создаётся
процессом из `docs/RELEASING.md` (см. Тестирование) и несёт два ассета:
установщик `.exe` и release `.apk`.

### Кэш проверки

`DATA_DIR/update_check.json`:

```json
{"lastCheckedAt": "2026-08-28T10:00:00+00:00", "latestVersion": "1.2.0", "releaseUrl": "https://github.com/ssk1tlz/warehouse/releases/tag/v1.2.0"}
```

Проверка выполняется: (1) один раз в фоновом потоке при старте сервера, не
блокируя открытие порта; (2) лениво при любом `GET /api/state`, если с
`lastCheckedAt` прошло ≥24 часов. Любая ошибка (нет сети, rate-limit,
timeout, невалидный JSON) — тихо игнорируется, `update_check.json` не
трогается, следующая попытка — по тому же 24-часовому правилу от
последнего УСПЕШНОГО `lastCheckedAt` (не от неудачной попытки — иначе
временная проблема с сетью надолго подавит проверку).

`checkUpdates` читается из `config.json` заново при каждой попытке
проверки (не кэшируется в памяти при старте процесса) — выключение в
настройках действует немедленно, без перезапуска сервера.

### `GET/POST /api/settings` (admin)

```
GET /api/settings -> {"checkUpdates": true}
POST /api/settings {"checkUpdates": false} -> {"ok": true}
```

Сливается в существующий `config.json` (сохраняет `host`/`port`/
`password`), не создаёт отдельный файл настроек — одна точка правды для
конфигурации сервера, как и сейчас.

### `GET /api/state`

Добавляются два top-level поля (не внутри `assets`):

```json
{"currentVersion": "1.1.0", "latestVersion": "1.2.0", ...}
```

`latestVersion` — `null`, если проверка не выполнялась, `checkUpdates`
выключен, или последняя проверка не нашла версию новее текущей (не
показываем "нет обновлений" отдельным состоянием — фронтенду достаточно
`latestVersion == null || latestVersion <= currentVersion` → баннер скрыт).

### UI (десктоп)

Баннер над основным содержимым (не модалка — не должен требовать закрытия
для продолжения работы), появляется когда
`semver(latestVersion) > semver(currentVersion)`, текст "Доступна версия
{latestVersion}" + ссылка на `releaseUrl` + крестик закрытия (скрывает до
конца текущей сессии вкладки — не персистентно, см. "Не-цели").

Модалка "Настройки" — новый пункт в сайдбаре рядом с "Резервные копии"
(тот же паттерн из Этапа 2: `data-requires-role="admin"`), единственное
содержимое пока — чекбокс "Проверять обновления", читает/пишет через
`GET`/`POST /api/settings`.

### UI (мобильное)

`mobile/www/js/version.js` даёт `window.APP_VERSION`. На экране настроек
(`screen-settings`) — текст текущей версии всегда, и баннер с текстом
"Доступна версия {latestVersion}. Страница релиза:" + сам URL как
выделяемый текст (не кликабельная ссылка — Capacitor WebView не гарантирует
открытие системного браузера без дополнительного плагина, а тянуть
`@capacitor/browser` ради одной ссылки — лишняя зависимость), когда
`latestVersion` из последнего `GET /api/state` новее `APP_VERSION`.
Никакого отдельного обращения к GitHub с телефона — источник истины один,
сервер.

## Обработка ошибок

- Миграция данных: копирование до переименования источника — сбой на
  середине не теряет ничего, следующий запуск видит `old_db.exists()` всё
  ещё `True` (переименование не произошло) и повторяет попытку.
- `assembleRelease` без `keystore.properties` — понятная ошибка Gradle со
  ссылкой на документацию, не тихий debug-signed APK.
- Проверка обновлений: любая сетевая/API ошибка — тихо, ничего не ломает,
  никогда не блокирует старт сервера или ответ `/api/state`.
- Установщик: файрвол/автозапуск — оба явно опциональны (unchecked),
  отказ пользователя от любого — не мешает установке.

## Тестирование

- `pytest`: `paths.migrate_legacy_data()` — переносит `warehouse.db`
  (включая WAL-режим случай — открытая БД с несбрасанным `-wal`),
  `config.json`, `backups/`; идемпотентна при повторном вызове; не трогает
  ничего, если legacy-файла нет; переименовывает источник, не удаляет.
  `versionCode`-формула (через прямой вызов эквивалентной Python-функции
  или парсинг сгенерированного `build.gradle`, если Gradle-часть не
  тестируется напрямую — см. решение в плане реализации). Сравнение версий
  и решение "показывать ли `latestVersion`" при разных ответах GitHub API
  (найдена новее / та же / старее / невалидный JSON / таймаут).
- `node --test`: рендер баннера обновления на экране настроек мобильного
  при `latestVersion` новее/не новее/отсутствует.
- Не автоматизировано (ручная проверка, как установщик/сборки в Этапах
  1-2): реальная установка `.exe` на этой машине (или в чистую папку),
  деинсталляция, `assembleRelease` даёт устанавливаемый подписанный APK,
  баннер в реальном UI.

## Критерии приёмки (без изменений от промта)

1. Чистая машина (или чистая папка): установщик ставит приложение, оно
   запускается, база создаётся в `ProgramData`; деинсталляция не удаляет
   данные.
2. Старый пользователь: после обновления база из папки с EXE переехала в
   `ProgramData` без потерь (проверить на копии реальной базы).
3. `assembleRelease` даёт подписанный APK, который ставится на телефон.
4. Плашка обновления появляется при более свежем релизе и не мешает
   офлайн-работе.
5. `docs/RELEASING.md` описывает выпуск от и до.
