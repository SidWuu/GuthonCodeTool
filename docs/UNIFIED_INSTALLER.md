# GuthonCodeSetup Windows 统一安装器

本地实现入口：`installer/windows/GuthonCodeSetup.iss` 提供原生安装向导，
`scripts/installer/ide.py` 探测 IDE，`scripts/installer/engine.py` 编排组件安装，Nexus `src/onboarding.js` 提供一次性安装确认。

API 源码功能直接使用 Nexus；浏览器增强为可选组件，安装助手完成不以 Chrome 配对为前提。需要网页增强时仍可从助手或 Nexus 手动启动并配对 Bridge。

## 员工安装与配置

员工操作、GitHub Release 下载清单以及无法自动完成步骤的教程，统一维护在
[Windows 安装步骤第一章：一键安装配置](GuthonCodeTool_Windows安装步骤.html#one-click)。
本文件只说明维护者构建流程、组件职责和验证边界。
安装包会携带同一份 Windows 手册及其截图，一次性安装助手定位到该章。
GuthonCodeSetup 负责安装工具、插件和基础环境。完成后可在已选 IDE 中使用 GuthonNexus。
产品／项目、API 登录、数据库诊断连接、源码拉取和索引属于后续业务使用，不是安装步骤或完成条件。

## 组件与职责

- GuthonCodeTool 与 GuthonNexus：从当前源码构建后组合安装，生成后端路径、数据目录与一次性安装确认设置。
- GuthonBridge：安装到 `var/nexus/updates/chrome/extension` 固定托管目录，Nexus 启动本地服务；
  沿用员工现有 Chrome，首次由员工确认加载扩展并配对，不创建专用浏览器或修改浏览器策略。
- guthon-team 按需配置。已有团队地址时，首次配置助手确认仓库访问后通过 GuthonCodeTool 的 `setup --team-source` 同步规范和门禁。公开包留空时，安装器准备开发根，保留已放入的部门规则。
- 私有 Python：套件提供解释器，供安装器、团队规范同步和市场插件 Hook 使用。解释器路径由安装或运行入口持有。
- IDE：向导用临时解出的私有 Python 探测本机编辑器。用户可多选，静默安装选择列表首项。安装阶段重新发现所选 IDE，通过各自的 VSIX CLI 安装并回读版本。没有可用入口时向导提供 CodeBuddy 国内版官网。
- Git：已有时复用，缺失时使用校验过的 Git for Windows 安装程序。离线构建可内置 Git 安装程序。

基础工具检查通过后可以完成首次配置。已配置团队地址时，助手另检查同步回执。
可选的 Hook 检查识别 guthon-guard 0.5.0 或更新版本的实际 SessionStart 回执。
其他生命周期、远端 CI 和平台行为需要各自的运行验证。

## 官方下载与构建

无需私有下载服务器。`installer/windows/downloads.json` 固定官方 URL、核定 SHA-256 和安装参数。
Python 从 python.org 获取，哈希来自官方 SPDX。Git 从 Git for Windows 的 GitHub Release 获取，安装器的哈希与参数参考 Microsoft WinGet 仓库的对应版本清单。
下载失败、HTTP 降级或摘要不匹配会停止，不跳过校验。静默安装与 UAC／重启仍需 Windows 实测。
下载前先校验本地缓存，摘要匹配就复用文件；不以构建电脑已安装的系统 Python 或 IDE 代替发行载荷。
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
`--stage-only` 只组装。已有 Git 的环境可使用 `--existing-tools` 构建无预置 Git 安装文件的试用包。完整包要求唯一的 Git 依赖及非空静默参数。
Windows 构建还会对实际隔离 Python、中文输出和后端临时数据目录执行冒烟检查。

正式 Release 工作流复用同次构建的后端与插件附件，在 GitHub 托管 Windows runner 编译并检查 GuthonCodeSetup。
独立工作流 `Build GuthonCodeSetup` 可生成候选包，市场 URL 可留空，或为内部定制填写。
它下载上述官方依赖、构建当前源码组件、编译安装器并生成摘要。
公开发行包不预置内网地址。安装时可留空、填写团队地址，或通过环境变量预置。
带预置地址的内部定制包只在私有构建仓库上传 artifact。
不创建新发行仓库；正式 Release 工作流将安装器及其摘要纳入独立签名。Git 访问凭据不进入安装包。
完整 EXE 正式分发前仍需 Authenticode 或独立可信渠道签名，并完成干净 Windows 验收。

## 保留、恢复与验证

程序安装在 `%LOCALAPPDATA%\Programs\Guthon\payloads\<bundleId>`。
工作数据独立；卸载保留数据和供插件使用的 `%LOCALAPPDATA%\Guthon\runtimes\<bundleId>`。
ASCII `python-version.txt` 指针避免中文用户名路径通过 CMD 文本解码；显式 `GUTHON_PYTHON` 优先。
在 IDE 中打开套件生成的 `Guthon.code-workspace` 后，Nexus 按安装结果配置后端所需的 Git 和私有 Python 路径。

设置只更新仍与上次受管值一致的叶子。填写地址时，同名市场来源冲突会停止。地址留空且安装包没有预置地址时，保留已有市场、插件和手工规则。
团队独立安装器在同步时检查人工修改和 Git Hook 冲突。已有托管 Bridge 目录保留并使用 Nexus 更新入口。
结果保存到 `var/nexus/setup-result.json` 与 HTML；一次性安装确认状态保存到 `var/nexus/onboarding.json`，不保存密码或配对令牌。
每次重试复查当前状态；安装阶段不收集平台业务密码，不调用业务同步或索引命令。

发行 CI 编译后使用临时便携版 VS Code 验证 VSIX 安装及版本回读。该检查通过 `/IDEROOT` 指定便携版所在目录。
Windows 实机验收范围包括多选各 IDE、无 IDE 引导、Git 静默安装、无系统 Python、中文路径、
CodeBuddy 内网授权后的直接规范同步、可选的实际 SessionStart、API 登录／拉取／索引、MCP、Chrome 加载／配对、
重复安装、断点恢复、升级和卸载保留数据。本地测试不能替代这些验收。

依赖版本、下载地址与摘要以 `installer/windows/downloads.json` 为准；Python 摘要可参考 [官方 SPDX](https://www.python.org/ftp/python/3.14.3/python-3.14.3-embed-amd64.zip.spdx.json)。

安装确认记录与安装包身份关联，完成后日常启动不再打开助手。Bridge 可在首次安装配置助手中按需启用。

## 精简联网构建

发行 CI 使用 `fetch_installer_inputs.py --online`，构建阶段只下载内置 Python。Git 的固定 URL、SHA-256 和安装参数写入载荷清单。安装时缺少 Git 才会下载到用户本地缓存，校验成功后启动安装程序。

输入获取命令省略 `--online` 会下载离线 Git 安装文件，再传入同一 `--prerequisites` 构建完整包。

体积变化应比较实际编译 EXE；载荷总大小只能说明组成变化。macOS 可验证载荷、下载和安装编排逻辑，Windows EXE 编译、首次联网安装与 UAC 仍需 Windows runner 验证。

## Windows 后端候选验证

手动运行 `Build GuthonCodeSetup` 工作流，默认 `components_only=true`：只构建当前源码的 Windows 后端与插件候选，不创建 Release、不编译或安装整套依赖。下载 `GuthonCodeTool-windows-components-candidate` artifact，内含后端 EXE、Nexus VSIX、组件清单与 SHA256SUMS。已有同事环境验证索引优化时替换后端；同时安装配套 Nexus 才能验证日志摘要显示。核对候选 buildId，版本号可能与当前正式版相同。

需要验证精简联网安装器时显式将 `components_only` 设为 `false`。构建始终来自所选远程分支的提交，本机未提交改动不会进入候选包。
