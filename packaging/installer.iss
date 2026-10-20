; Master の Inno Setup の設計図 (MS-20)。scripts/build-release.ps1 が /DAppVersion=x.y.z /DSourceDir=... /DOutputDir=... を渡す。
; 利用者領域 ({localappdata}\Programs\Master) に入れる (管理者不要)。AppId 固定で上書き更新。
; 入れる前に動いている Master を止める (node.exe が使用中だと差し替えられない)。
; データ (%APPDATA%\Master: data・backups・config.json) と document の正本には触らない。アンインストールでも残す。

#ifndef AppVersion
  #error "AppVersion を /DAppVersion=x.y.z で渡してください (build-release.ps1 が渡します)"
#endif
#ifndef SourceDir
  #error "SourceDir を /DSourceDir=<release\Master-x.y.z> で渡してください"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
#endif

[Setup]
AppId={{B6D1F3A2-7C4E-4F0B-9A61-3E8D2C5F7A90}
AppName=Master
AppVersion={#AppVersion}
AppVerName=Master {#AppVersion}
DefaultDirName={localappdata}\Programs\Master
DefaultGroupName=Master
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Master-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
DisableProgramGroupPage=yes
UninstallDisplayName=Master
UninstallDisplayIcon={app}\master.ico
SetupIconFile={#SourceDir}\master.ico
CloseApplications=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Master"; Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch.ps1"""; IconFilename: "{app}\master.ico"; WorkingDir: "{app}"
Name: "{group}\Master をアンインストール"; Filename: "{uninstallexe}"

[Run]
; ショートカット (デスクトップ・スタートメニュー)・スタートアップ登録・サーバー起動は今までどおり install-desktop.ps1 が行う
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-desktop.ps1"""; WorkingDir: "{app}"; StatusMsg: "ショートカットとスタートアップを登録しています..."; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch.ps1"""; WorkingDir: "{app}"; Description: "Master を開く"; Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-server.ps1"""; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "stopserver"

[UninstallDelete]
; install-desktop.ps1 が作るショートカット (データは消さない)
Type: files; Name: "{userdesktop}\Master.lnk"
Type: files; Name: "{userprograms}\Master.lnk"
Type: files; Name: "{userstartup}\Master Tray.lnk"
Type: files; Name: "{userstartup}\Master Server.lnk"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\vendor"

[Code]
// 入れる前に、前の版の Master を止める (前の版が入っていれば {app}\scripts\stop-server.ps1 がある)
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script: String;
  ResultCode: Integer;
begin
  Result := '';
  Script := ExpandConstant('{app}\scripts\stop-server.ps1');
  if FileExists(Script) then
  begin
    if not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Result := '動いている Master を止められませんでした (PowerShell を起動できません)'
    else if ResultCode <> 0 then
      Result := '動いている Master を止められませんでした (ポート 3945 を別のプログラムが使っているかもしれません)。止めてからやり直してください';
  end;
end;
