; Inno Setup 6.4+; all payload inputs are supplied by build_windows_installer.py.
#ifndef PayloadRoot
  #error PayloadRoot is required
#endif

[Setup]
AppId={{61B4CA19-08B1-4D57-92C3-02400B35D658}
AppName=Guthon 开发套件
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Guthon
DefaultGroupName=Guthon
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
OutputDir={#OutputRoot}
OutputBaseFilename=GuthonCodeSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
DisableDirPage=yes
CloseApplications=no
SetupLogging=yes
UninstallDisplayName=Guthon 开发套件（保留工作数据）

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Messages]
ButtonNext=下一步(&N) >
ButtonBack=< 上一步(&B)
ButtonInstall=安装(&I)
ButtonCancel=取消
ButtonFinish=完成
WelcomeLabel1=欢迎安装 Guthon 开发套件
WelcomeLabel2=安装器将准备开发工具、Nexus、Bridge 和团队插件环境。已有工作数据会保留。首次使用仍需登录个人账号并确认工作区与插件信任。
FinishedHeadingLabel=Guthon 环境已准备
FinishedLabel=请查看安装结果，打开 CodeBuddy 完成一次性插件确认，后续使用 GuthonNexus。

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}\payloads\{#BundleId}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\开始 Guthon 开发"; Filename: "{app}\payloads\{#BundleId}\runtime\pythonw.exe"; Parameters: "{code:LaunchParameters}"; WorkingDir: "{app}"
Name: "{userdesktop}\开始 Guthon 开发"; Filename: "{app}\payloads\{#BundleId}\runtime\pythonw.exe"; Parameters: "{code:LaunchParameters}"; WorkingDir: "{app}"

[Run]
Filename: "{code:ResultPage}"; Flags: shellexec postinstall skipifsilent
Filename: "{app}\payloads\{#BundleId}\runtime\pythonw.exe"; Parameters: "{code:LaunchParameters}"; Description: "打开 CodeBuddy 完成安装确认"; Flags: postinstall skipifsilent nowait

[Code]
var
  DataPage: TInputDirWizardPage;
  MarketPage: TInputQueryWizardPage;
  InstallFailed: Boolean;

function Payload: String;
begin
  Result := ExpandConstant('{app}\payloads\{#BundleId}');
end;

function Quote(const Value: String): String;
var
  I: Integer;
begin
  Result := Value;
  I := Length(Value);
  while (I > 0) and (Value[I] = '\') do begin
    Result := Result + '\';
    I := I - 1;
  end;
  Result := '"' + Result + '"';
end;

function BaseParameters: String;
begin
  Result := '-X utf8 -B ' + Quote(Payload + '\installer\engine.py') + ' --payload ' + Quote(Payload) +
    ' --home ' + Quote(DataPage.Values[0]);
end;

function LaunchParameters(Param: String): String;
begin
  Result := BaseParameters + ' --launch-only';
end;

function ResultPage(Param: String): String;
begin
  Result := DataPage.Values[0] + '\var\nexus\setup-result.html';
end;

procedure InitializeWizard;
begin
  DataPage := CreateInputDirPage(wpWelcome, '选择工作数据目录',
    '程序和工作数据分开保存', '源码、配置和索引保存在此目录，更新或卸载程序会保留它们。', False, '');
  DataPage.Add('工作数据目录：');
  DataPage.Values[0] := ExpandConstant('{param:TOOLHOME|}');
  if DataPage.Values[0] = '' then DataPage.Values[0] := GetPreviousData('ToolHome', ExpandConstant('{userdocs}\GuthonWork'));
  MarketPage := CreateInputQueryPage(DataPage.ID, '团队插件市场',
    '填写团队提供的内网 Git 克隆地址', '公开安装包不内置内网地址。可使用团队预置环境变量 GUTHON_TEAM_MARKETPLACE_URL；已有安装会复用上次填写的地址。');
  MarketPage.Add('guthon-team Git 地址：', False);
  MarketPage.Values[0] := ExpandConstant('{param:MARKETPLACEURL|}');
  if MarketPage.Values[0] = '' then MarketPage.Values[0] := GetPreviousData('MarketplaceUrl', '');
  if MarketPage.Values[0] = '' then MarketPage.Values[0] := GetEnv('GUTHON_TEAM_MARKETPLACE_URL');

end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'ToolHome', DataPage.Values[0]);
  SetPreviousData(PreviousDataKey, 'MarketplaceUrl', MarketPage.Values[0]);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = MarketPage.ID) and (Trim(MarketPage.Values[0]) = '') then begin
    MsgBox('请填写团队提供的 guthon-team Git 克隆地址。', mbError, MB_OK);
    Result := False;
  end;
end;

procedure SetupOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if Pos('GUTHON_STEP ', S) = 1 then
    WizardForm.StatusLabel.Caption := Copy(S, 13, Length(S));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params: String;
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    Params := BaseParameters + ' --marketplace-url ' + Quote(Trim(MarketPage.Values[0]));
    InstallFailed := not ExecAndLogOutput(Payload + '\runtime\python.exe', Params,
      Payload, SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode, @SetupOutput);
    if ExitCode <> 0 then InstallFailed := True;
    if InstallFailed then begin
      MsgBox('安装未完成，已保留工作数据。请查看安装结果并修复后重新运行安装包。', mbError, MB_OK);
      if FileExists(ResultPage('')) then
        ShellExec('open', ResultPage(''), '', '', SW_SHOWNORMAL, ewNoWait, ExitCode);
      RaiseException('Guthon 初始化未完成：' + ResultPage(''));
    end;
  end;
end;
