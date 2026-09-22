; Установщик «Склад IT-техники».
; AppId зафиксирован навсегда: по нему Inno Setup находит и заменяет
; предыдущую установку при обновлении. Никогда не менять.
#define MyAppName "Склад IT-техники"
#define MyAppExeName "WarehouseApp.exe"
#define MyAppVersion GetEnv("WAREHOUSE_VERSION")

[Setup]
AppId={{FD91C08C-6D2F-45E6-A98B-F77C8CDDE02F}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Склад IT-техники
DefaultDirName={autopf}\Warehouse
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=WarehouseSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
; Значок NexaHub: у установщика и в «Программы и компоненты» (иконка самого .exe вшита при сборке).
SetupIconFile=..\assets\nexahub.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "..\dist\WarehouseApp_New.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Удалить {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{commonstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"
Name: "autostart"; Description: "Запускать при входе в Windows"; Flags: unchecked
Name: "firewall"; Description: "Открыть порт 8765 в брандмауэре (нужно для подключения телефона по сети)"; Flags: unchecked

[Run]
; Удаляем прежнее правило перед добавлением: без этого повторный запуск
; установщика с отмеченной галочкой "firewall" (переустановка/обновление)
; накапливает дублирующиеся одинаковые правила. Если правила ещё нет —
; netsh вернёт ненулевой код, но [Run] в Inno Setup его не проверяет, так
; что это безопасно (тот же приём, что и в setup_lan.bat).
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Склад IT-техники"""; Tasks: firewall; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Склад IT-техники"" dir=in action=allow protocol=TCP localport=8765"; Tasks: firewall; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Склад IT-техники"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"

; Данные пользователя (%ProgramData%\Warehouse) лежат ВНЕ {app}, поэтому
; деинсталлятор их не трогает — это следствие DefaultDirName, а не
; отдельная защита, которую можно случайно потерять.

; Галочка "firewall" (см. [Tasks] выше) обещает подключение телефона по
; сети, но открытый порт сам по себе не включает сетевой режим: сервер
; по умолчанию слушает только 127.0.0.1 (server.py читает host из
; config.json, а установщик его не создавал). Здесь, и только когда
; задача firewall выбрана, дописываем рабочий config.json — но лишь если
; его ещё нет: у существующего пользователя там могут быть свои
; значения (а позже задача D2 добавит ключ checkUpdates), и молча
; затирать их при обновлении программы было бы хуже исходного дефекта.
;
; Второе условие ниже (LegacyConfigFile) — для пользователя, обновляющегося
; с версии до Этапа 3: его настоящий config.json лежит рядом со старым .exe
; ({app}\config.json), а paths.migrate_legacy_data() переносит его в
; %ProgramData%\Warehouse ПРИ ПЕРВОМ ЗАПУСКЕ программы после установки — то
; есть позже, чем этот скрипт. Guard миграции — "если ProgramData\config.json
; уже существует, не копировать" — так что если бы мы здесь безусловно
; писали дефолт (когда только ProgramData\config.json ещё не существует), то
; миграция увидела бы "конфиг уже есть" и молча пропустила бы перенос
; реальных host/port пользователя. Полноценный перенос (мердж) значений
; здесь, в Pascal, не делаем — это отдельная, более рискованная задача;
; просто уступаем дорогу миграции, если её ещё не было.
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir: String;
  ConfigFile: String;
  LegacyConfigFile: String;
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('firewall') then
    begin
      ConfigDir := ExpandConstant('{commonappdata}\Warehouse');
      ConfigFile := ConfigDir + '\config.json';
      LegacyConfigFile := ExpandConstant('{app}\config.json');
      // Ничего не пишем, если конфиг уже есть в новом месте, ИЛИ если есть
      // старый config.json, который migrate_legacy_data() перенесёт сам при
      // первом запуске — иначе наш дефолт "появится первым" и заставит
      // миграцию решить, что переносить уже нечего, тихо потеряв реальные
      // host/port пользователя.
      if not FileExists(ConfigFile) and not FileExists(LegacyConfigFile) then
      begin
        ForceDirectories(ConfigDir);
        SaveStringToFile(ConfigFile, '{"host": "0.0.0.0", "port": 8765}', False);
      end;
    end;
  end;
end;
