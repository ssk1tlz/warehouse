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

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "..\dist\WarehouseApp_New.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Удалить {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"
Name: "autostart"; Description: "Запускать при входе в Windows"; Flags: unchecked
Name: "firewall"; Description: "Открыть порт 8765 в брандмауэре (нужно для подключения телефона по сети)"; Flags: unchecked

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Склад IT-техники"" dir=in action=allow protocol=TCP localport=8765"; Tasks: firewall; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Склад IT-техники"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"

; Данные пользователя (%ProgramData%\Warehouse) лежат ВНЕ {app}, поэтому
; деинсталлятор их не трогает — это следствие DefaultDirName, а не
; отдельная защита, которую можно случайно потерять.
