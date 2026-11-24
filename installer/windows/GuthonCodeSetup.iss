; Inno Setup 6.4+; all payload inputs are supplied by build_windows_installer.py.
#ifndef PayloadRoot
  #error PayloadRoot is required
#endif

[Setup]
AppId={{61B4CA19-08B1-4D57-92C3-02400B35D658}
AppName=Guthon 开发套件
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Guthon
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
OutputDir={#OutputRoot}
OutputBaseFilename=GuthonCodeSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
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
WelcomeLabel2=选择本机已安装的 IDE，安装器会将 GuthonNexus 安装到勾选的 IDE，并准备开发工具和 Bridge。缺少 Git 时会下载并校验。已有工作数据会保留。
FinishedHeadingLabel=Guthon 环境已准备
FinishedLabel=请在选定的 IDE 中打开工作数据目录下的 Guthon.code-workspace，再从活动栏进入 Guthon Nexus。安装结果中提供工作区路径。

[Files]
Source: "{#PayloadRoot}\runtime\*"; DestDir: "{tmp}\ide-scan\runtime"; Flags: dontcopy recursesubdirs
Source: "{#PayloadRoot}\installer\ide.py"; DestDir: "{tmp}\ide-scan"; Flags: dontcopy
Source: "{#PayloadRoot}\*"; DestDir: "{app}\payloads\{#BundleId}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{code:ResultPage}"; Description: "查看安装结果"; Flags: shellexec postinstall skipifsilent unchecked

[Code]
const
  CodeBuddyDownload = 'https://www.codebuddy.cn/ide/';
var
  IdePage: TInputOptionWizardPage;
  IdeIds: TArrayOfString;
  IdeRoot: String;
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
  if IdeRoot <> '' then
    Result := Result + ' --ide-root ' + Quote(IdeRoot);
end;

function ResultPage(Param: String): String;
begin
  Result := DataPage.Values[0] + '\var\nexus\setup-result.html';
end;

procedure OpenCodeBuddyDownload(Sender: TObject);
var
  ErrorCode: Integer;
begin
  if not ShellExec('open', CodeBuddyDownload, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode) then
    MsgBox('请在浏览器中打开 ' + CodeBuddyDownload, mbInformation, MB_OK);
end;

procedure InitializeWizard;
var
  ScanDir, OutputFile, Params: String;
  Detected: TArrayOfString;
  DownloadButton: TNewButton;
  I, Delimiter, ExitCode: Integer;
begin
  IdeRoot := ExpandConstant('{param:IDEROOT|}');
  ExtractTemporaryFiles('{tmp}\ide-scan\runtime\*');
  ExtractTemporaryFiles('{tmp}\ide-scan\ide.py');
  ScanDir := ExpandConstant('{tmp}\ide-scan');
  OutputFile := ScanDir + '\editors.txt';
  Params := '-B ' + Quote(ScanDir + '\ide.py') + ' ' + Quote(OutputFile);
  if IdeRoot <> '' then
    Params := Params + ' ' + Quote(IdeRoot);
  if not Exec(ScanDir + '\runtime\python.exe', Params, ScanDir, SW_HIDE, ewWaitUntilTerminated, ExitCode) or
     (ExitCode <> 0) or not LoadStringsFromFile(OutputFile, Detected) then
    RaiseException('无法检测本机 IDE，请重新运行安装器。');

  if GetArrayLength(Detected) = 0 then begin
    IdePage := CreateInputOptionPage(wpWelcome, '准备 IDE', '未检测到可安装 Nexus 的 IDE',
      '请访问 ' + CodeBuddyDownload + ' 下载并安装 CodeBuddy 国内版，然后重新运行本安装器。', False, True);
    IdePage.CheckListBox.Visible := False;
    DownloadButton := TNewButton.Create(IdePage);
    DownloadButton.Parent := IdePage.Surface;
    DownloadButton.Top := ScaleY(56);
    DownloadButton.Width := ScaleX(225);
    DownloadButton.Height := ScaleY(28);
    DownloadButton.Caption := '打开 CodeBuddy 国内版官网';
    DownloadButton.OnClick := @OpenCodeBuddyDownload;
  end else begin
    IdePage := CreateInputOptionPage(wpWelcome, '选择 IDE', '选择安装 GuthonNexus 的 IDE',
      '可勾选一个或多个。安装后在所选 IDE 的活动栏进入 Guthon Nexus。', False, True);
    SetArrayLength(IdeIds, GetArrayLength(Detected));
    for I := 0 to GetArrayLength(Detected) - 1 do begin
      Delimiter := Pos('|', Detected[I]);
      IdeIds[I] := Copy(Detected[I], 1, Delimiter - 1);
      IdePage.Add(Copy(Detected[I], Delimiter + 1, Length(Detected[I])));
    end;
    IdePage.Values[0] := True;
  end;

  DataPage := CreateInputDirPage(IdePage.ID, '选择工作数据目录',
    '程序和工作数据分开保存', '源码、配置和索引保存在此目录，更新或卸载程序会保留它们。', False, '');
  DataPage.Add('工作数据目录：');
  DataPage.Values[0] := ExpandConstant('{param:TOOLHOME|}');
  if DataPage.Values[0] = '' then DataPage.Values[0] := GetPreviousData('ToolHome', ExpandConstant('{userdocs}\GuthonWork'));
  MarketPage := CreateInputQueryPage(DataPage.ID, '团队插件市场（可选）',
    '有团队 Git 克隆地址时可填写', '公开包可留空，点击“下一步”继续安装。安装后可手动放入部门规则。团队也可预置地址，已有安装会复用上次填写的值。');
  MarketPage.Add('guthon-team Git 地址（可留空）：', False);
  MarketPage.Values[0] := ExpandConstant('{param:MARKETPLACEURL|}');
  if MarketPage.Values[0] = '' then MarketPage.Values[0] := GetPreviousData('MarketplaceUrl', '');
  if MarketPage.Values[0] = '' then MarketPage.Values[0] := GetEnv('GUTHON_TEAM_MARKETPLACE_URL');
end;

function SelectedIdeIds: String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to GetArrayLength(IdeIds) - 1 do begin
    if IdePage.Values[I] then begin
      if Result <> '' then Result := Result + ',';
      Result := Result + IdeIds[I];
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Message: String;
begin
  Result := True;
  if CurPageID <> IdePage.ID then Exit;
  if GetArrayLength(IdeIds) = 0 then
    Message := '请安装 CodeBuddy 国内版后重新运行安装器。' + #13#10 + CodeBuddyDownload
  else if SelectedIdeIds = '' then
    Message := '请至少勾选一个 IDE。'
  else
    Exit;
  Log(Message);
  SuppressibleMsgBox(Message, mbInformation, MB_OK, IDOK);
  Result := False;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'ToolHome', DataPage.Values[0]);
  SetPreviousData(PreviousDataKey, 'MarketplaceUrl', MarketPage.Values[0]);
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
    Params := BaseParameters + ' --ides ' + Quote(SelectedIdeIds) +
      ' --marketplace-url ' + Quote(Trim(MarketPage.Values[0]));
    InstallFailed := not ExecAndLogOutput(Payload + '\runtime\python.exe', Params,
      Payload, SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode, @SetupOutput);
    if ExitCode <> 0 then InstallFailed := True;
    if InstallFailed then begin
      MsgBox('安装未完成，已保留工作数据。请查看安装结果并修复后重新运行安装包。', mbError, MB_OK);
      if FileExists(ResultPage('')) then
        ShellExec('open', ResultPage(''), '', '', SW_SHOWNORMAL, ewNoWait, ExitCode);
      RaiseException('Guthon 初始化未完成：' + ResultPage(''));
    end;
    DeleteFile(ExpandConstant('{userdesktop}\开始 Guthon 开发.lnk'));
    DeleteFile(ExpandConstant('{userprograms}\Guthon\开始 Guthon 开发.lnk'));
  end;
end;
