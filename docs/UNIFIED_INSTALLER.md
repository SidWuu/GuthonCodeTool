# GuthonCodeSetup Windows 统一安装器

本地实现入口：`installer/windows/GuthonCodeSetup.iss` 提供原生安装向导，
`scripts/installer/engine.py` 编排组件安装，Nexus `src/onboarding.js` 提供工具与插件的一次性安装确认。
v0.3.2 发行流程构建统一安装器；构建／安装冒烟与真实客户端、业务验收分别记录。

## 员工安装与配置

员工操作、GitHub Release 下载清单以及无法自动完成步骤的教程，统一维护在
[Windows 安装步骤第一章：一键安装配置](GuthonCodeTool_Windows安装步骤.html#one-click)。
本文件只说明维护者构建流程、组件职责和验证边界。
安装包会携带同一份 Windows 手册及其截图，一次性安装助手定位到该章。
GuthonCodeSetup 只负责从零安装工具、插件和基础环境；完成后提示在 CodeBuddy 使用 GuthonNexus。
产品／项目、SVN 业务认证、数据库连接、源码检出和索引属于后续业务使用，不是安装步骤或完成条件。

## 组件与职责

- GuthonCodeTool 与 GuthonNexus：从当前源码构建后组合安装，生成后端路径、数据目录与一次性安装确认设置。
- GuthonBridge：安装到 `var/nexus/updates/chrome/extension` 固定托管目录，Nexus 启动本地服务；
  沿用员工现有 Chrome，首次由员工确认加载扩展并配对，不创建专用浏览器或修改浏览器策略。
- guthon-team：唯一安装来源是团队内网 Git 插件市场。安装器只声明市场地址和启用 guthon-guard，
  不复制 Guard、规范、Linter，不克隆维护仓库。客户端从市场获取／更新插件，实际 SessionStart
  使用已安装插件携带的版本化规范幂等初始化或更新工作区；不是每个聊天重新 clone 内网仓库。
- 私有 Python：应用自带解释器，供安装器和市场插件 Hook 使用；不修改系统 Python 或全局 PATH。
- CodeBuddy IDE、Git、SVN：官方下载的离线安装程序，用于没有对应组件的电脑；已有组件复查后复用。

Guard 0.2.10 候选支持私有 Python、UTF-8 与 SessionStart 最小运行回执。
向导要求该回执来自本次安装之后，安装／启用状态不能代替实际 Hook 运行。
此版本须先按 guthon-team 发布流程更新内网市场；本轮源码修改未自动提交或发布。
回执只证明 SessionStart 被执行并检查就绪，不证明所有生命周期、远端 CI 或平台业务运行。

## 官方下载与构建

无需私有下载服务器。`installer/windows/downloads.json` 固定官方 URL、核定 SHA-256 和安装参数。
Python 从 python.org 获取，哈希来自官方 SPDX；CodeBuddy 从腾讯 COS CDN 获取；Git 从官方 GitHub
Release 获取；SVN 从 TortoiseSVN 官方 SourceForge 分发源获取。三项安装器的哈希与参数参考
Microsoft WinGet 仓库的对应版本清单；版本不会在构建时静默追最新。
下载失败、HTTP 降级或摘要不匹配会停止，不跳过校验。静默安装与 UAC／重启仍需 Windows 实测。
下载前先校验本地缓存，摘要匹配就复用文件；不以构建电脑已安装的系统 Python 或 IDE 代替发行载荷。
员工运行离线包时先检测 CodeBuddy/Git/SVN 并自检，存在且可用时跳过对应安装。
Python 固定使用套件内独立运行时，不探测或复用系统 Python，也无需在员工电脑再次下载它。

构建机需 Windows x64、Python 3.12+、Node.js、Inno Setup 6.4+。
本地构建示例（市场地址使用团队实际值，不带密码）：

```powershell
python scripts/fetch_installer_inputs.py --output C:\GuthonBuild\inputs
python scripts/build_installer_components.py --output C:\GuthonBuild\components
python scripts/build_windows_installer.py `
  --components-dir C:\GuthonBuild\components `
  --marketplace-url "ssh://git@forgejo.example.invalid:2222/team/guthon-team.git" `
  --python-zip C:\GuthonBuild\inputs\python.zip `
  --python-sha256 <downloads.json中的Python摘要> `
  --prerequisites C:\GuthonBuild\inputs\prerequisites.json `
  --output C:\GuthonBuild\output
```

`--components-dir` 只接受本机或同一 CI 作业刚从可信源码构建的组件。
复用下载的 Release 时改用 `--release-dir`，仍强制核验固定公钥签名；旧 VSIX 没有一次性安装配置助手会拒绝组包。
`--stage-only` 只组装；`--existing-tools` 生成依赖已安装的试用包。完整包要求三项依赖及非空静默参数。
Windows 构建还会对实际隔离 Python、中文输出和后端临时数据目录执行冒烟检查。

正式 Release 工作流复用同次构建的后端与插件附件，在 GitHub 托管 Windows runner 编译并检查 GuthonCodeSetup。
独立工作流 `Build GuthonCodeSetup` 可生成候选包，市场 URL 可留空，或为内部定制填写。
它下载上述官方依赖、构建当前源码组件、编译安装器并生成摘要。
公开发行包不预置内网地址，安装时填写团队地址或通过环境变量预置。
带预置地址的内部定制包只在私有构建仓库上传 artifact。
不创建新发行仓库；正式 Release 工作流将安装器及其摘要纳入独立签名。Git 访问凭据不进入安装包。
完整 EXE 正式分发前仍需 Authenticode 或独立可信渠道签名，并完成干净 Windows 验收。

## 保留、恢复与验证

程序安装在 `%LOCALAPPDATA%\Programs\Guthon\payloads\<bundleId>`。
工作数据独立；卸载保留数据和供插件使用的 `%LOCALAPPDATA%\Guthon\runtimes\<bundleId>`。
ASCII `python-version.txt` 指针避免中文用户名路径通过 CMD 文本解码；显式 `GUTHON_PYTHON` 优先。
桌面入口同时携带 Git/SVN/私有 Python 环境。安装器不初始化业务 Git，不提交 SVN，也不保存平台源码。

设置只更新仍与上次受管值一致的叶子，其他设置保留。同名市场来源冲突会停止。
规范的人工修改由 guthon-team SessionStart 检查，安装器不覆盖。已有托管 Bridge 目录保留并使用 Nexus 更新入口。
结果保存到 `var/nexus/setup-result.json` 与 HTML；一次性安装确认状态保存到 `var/nexus/onboarding.json`，不保存密码或配对令牌。
每次重试复查当前状态；安装阶段不收集 SVN 业务密码，不调用业务同步或索引命令。

待 Windows 实机验证：实际 Inno 编译、三项依赖静默安装、无系统 Python、中文路径、
CodeBuddy 内网市场提示和真实 SessionStart、SVN 登录／检出／完整索引、MCP、Chrome 加载／配对、
重复安装、断点恢复、升级和卸载保留数据。本地测试不能替代这些验收。

参考：[Python SPDX](https://www.python.org/ftp/python/3.14.3/python-3.14.3-embed-amd64.zip.spdx.json)、
[CodeBuddy 清单](https://github.com/microsoft/winget-pkgs/blob/master/manifests/t/Tencent/CodeBuddy/1.106.1/Tencent.CodeBuddy.installer.yaml)、
[Git 清单](https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Git/Git/2.55.0/Git.Git.installer.yaml)、
[SVN 清单](https://github.com/microsoft/winget-pkgs/blob/master/manifests/t/TortoiseSVN/TortoiseSVN/1.14.9.29743/TortoiseSVN.TortoiseSVN.installer.yaml)。

安装确认记录与安装包身份关联，完成后日常启动不再打开助手。套件工作区启用 Bridge 自动启动；普通工作区保持原默认行为。
