# Guthon SVN Navigator

面向谷神 SVN 源码快照的 VS Code 扩展（当前版本 0.7.10）。插件不会改名、移动或复制 SVN 中的业务文件，而是解析页面索引及 `procedures/`、`system-script/`、`tables/`、`views/`，在 VS Code 左侧展示中文源码目录。

插件把一个谷神项目视为一个逻辑项目。`SYS-*` 是系统维度，`0000`、`0008` 等是数据源维度，目录下的页面、过程函数、系统脚本、表和视图共同组成项目源码；它们不是多个项目边界。

## 功能

- 自动识别旧式完整 SVN 工作副本、分片 checkout，以及一个外层目录下的多个项目。
- 多项目工作区只激活一个当前项目；切换项目后目录、搜索、更新、提交和源代码管理均只针对当前项目。
- 按“系统 → 中文目录 → 菜单 → 页面对象”展示页面树，并按数据源/系统展示过程函数、系统脚本、表和视图。
- JSON 页面可按查询区、表单、主表、页签、明细表继续展开，并查看其中的字段、按钮、事件和数据源 SQL；这些节点都是同一个物理文件的虚拟视图。
- 点击虚拟控件只打开当前片段的虚拟文档，不再展示整份 JSON；服务组件 `.gss` 仍可直接打开。
- 组件、控件的右键菜单保留“在原始 JSON 中定位”，需要修改时可回到同一个物理文件。
- 页面、组件、字段和按钮中的所有 `*Script` 都会拆成独立脚本节点；字段脚本会显示字段编码和字段名称，便于区分多个 `onChangeScript`。
- 脚本虚拟文档保存时保留原脚本格式，并把特殊字符按原 JSON 规则重新转义，减少 SVN 无意义差异。
- 脚本、数据源 SQL 和“字段（数量）”集合虚拟文档支持直接编辑，按 `Ctrl+S` 会回写原始 JSON；组件和按钮整体片段仍需回到原始 JSON 修改。
- 使用“搜索源码对象”在当前项目内查找页面、过程函数、系统脚本、表和视图；选中结果后自动展开左侧目录并定位目标文件。
- `index.md` 发生变化时自动刷新目录。
- 在 VS Code“源代码管理”视图中显示 SVN 新增、修改、删除和冲突文件，并支持查看差异、`svn update` 和提交。
- 页面 JSON 的差异查看显示格式化后的事件 Script 和数据源 SQL；原始 SVN 文件仍保持原布局。
- 在脚本/SQL可读差异中可把光标所在的单个事件或 SQL 块恢复到 SVN BASE，不影响同一文件的其他修改；“取消本地更改”仍是整文件操作。
- 支持手动检查远程变更，并比较本地 `BASE` 与服务器 `HEAD`；不会后台频繁轮询全部分片工作副本。
- 更新前检查本地修改和冲突；存在本地修改时先把真实 SVN Patch 备份到插件缓存目录，再执行更新。
- 支持 Cleanup、保留当前内容并标记冲突已解决、真实 Patch 导出和 SVN changelist 变更集分组。
- `.gss`、`.vm`、`.java`、`.js`、`.sql`、页面 `.json` 支持编辑器行号栏 Quick Diff；JSON 在 SCM 中仍可选择事件脚本/SQL 可读差异。
- SVN Quick Diff 浮窗提供与 Git 一致的“取消当前变更”按钮，只撤销当前 hunk；右侧 minimap/overview ruler 同时显示变更位置。
- 文件历史可搜索版本号、作者和提交说明；JSON 页面历史支持“事件脚本与 SQL 可读差异”和“原始源码差异”。
- 在插件面板中执行 `svn update` 或查看 `svn status`。
- 为 `.gss` 文件提供与 Guthon VM 对齐的语法高亮、悬浮 API 文档、参数片段和语法快捷补全。
- 可在项目内生成 AI 索引，帮助 AI 按中文名称、编码、路径和调用关系快速定位源码。
- GSS、页面事件脚本和 SQL 中识别到过程函数/服务组件调用后，macOS 使用 Cmd+点击、Windows 使用 Ctrl+点击跳转真实源码。

## 安装

使用 VS Code 的“扩展：从 VSIX 安装...”命令，选择生成的：

```text
  guthon-svn-navigator-0.7.10.vsix
```

安装后打开 SVN 工作区目录，左侧活动栏会出现 `Guthon SVN` 图标。

### 多项目配置

外层工作区使用英文文件名 `guthon-projects.yaml`。旧的中文文件名仍兼容，但新项目请使用英文文件名和英文配置字段：

```yaml
version: 2
projects:
  gmeSvn:
    name: gmeSvn
    path: gmeSvn
    repository_url: https://source.example/gss/product/xxx/SYS-xxx
    username: your-svn-user
    checkout_paths:
      - skill
      - public
      - pages/SYS-xxx
      - procedures/0000
      - system-script/SYS-xxx
      - tables/0000
      - views/0000
  scsjSvn:
    name: scsjSvn
    path: scsjSvn
    repository_url: https://source.example/gss/product/yyy/SYS-yyy
    checkout_paths:
      - pages/SYS-yyy
```

点击项目树标题栏的“选择当前项目”只显示一个项目；“初始化配置项目”会按对应项目的 `repository_url` 和 `checkout_paths` 创建目录并执行 SVN checkout。密码不写入配置，使用本机 SVN 凭据缓存或 SVN 的交互认证。

插件会把中文源码目录识别到的当前项目直接绑定到 SVN 源代码管理。只有一个有效项目时会自动选中并显示变更，不需要再执行“选择当前项目”；多个项目时才使用该命令切换当前项目，目录树、搜索和 SVN 变更会一起切换。

Windows 下项目路径、SVN XML 返回路径和 VS Code 文件路径即使大小写不同也会视为同一路径；macOS/Linux 仍按大小写区分路径。

项目树标题栏中的“检查 SVN 状态”会输出当前使用的 SVN 程序、当前项目、递归找到的每个 `.svn` 工作副本、`svn status` 是否成功以及本地变更数量。插件会监听当前项目内文件的创建、修改、删除和重命名；外部程序修改文件后通常会在文件系统事件触发后自动刷新，也可以手动点击“刷新变更列表”。如果一次状态检查失败，插件保留上一次成功的变更列表并在输出中显示失败原因。

如果当前 VS Code 工作区不是项目根目录，点击页面树中的“选择 SVN 工作副本”。旧结构可以选择包含 `.svn` 和 `pages` 的完整工作副本：

```text
.svn/
info.json
pages/
```

新版分片结构应选择所有 checkout 目录的共同上层目录。这个目录自身可以没有 `.svn`：

```text
项目目录/
  skill/.svn/
  public/.svn/
  pages/SYS-.../.svn/
  procedures/0000/.svn/
  system-script/SYS-.../.svn/
  tables/0000/.svn/
  views/0000/.svn/
```

插件把这些独立工作副本聚合成一个逻辑项目，不会要求改回旧目录结构。若项目根目录残留无效的 `.svn`，只要下级存在分片 checkout，插件仍会优先扫描真实子工作副本。

## 使用

### 生成 AI 索引

点击页面树顶部的“AI 索引”按钮，选择“重建当前项目 AI 索引”或“重建全部项目 AI 索引”。索引使用插件自带的 Node.js 代码生成，不依赖 Python，也不需要 SQLite。

每个项目单独生成以下文件；如果项目没有 `docs/`，插件会自动创建目录：

```text
项目根目录/
  docs/
    ai-index/
      manifest.json       # 项目、生成时间、文件清单和数量
      objects.jsonl       # 页面、过程函数、系统脚本、表、视图及中文别名
      relations.jsonl     # 页面/脚本/过程函数与表、视图、过程函数的关系
      pages/*.md          # 每个页面的结构、事件脚本、SQL 和依赖说明
```

`objects.jsonl` 和 `relations.jsonl` 使用一行一个 JSON 对象，适合 AI 先读索引再按 `path` 读取真实源码。索引中的路径均相对于项目根目录，项目之间不会互相覆盖。表和视图只生成读取索引，不会改变它们的 JSON，也不会执行索引中提取出的 SQL。

“搜索 AI 索引并定位”支持页面中文名、页面编码、过程函数 `@functionId`、表/视图中文名和编码、系统名、数据源名及路径；选中结果后会展开左侧目录并打开真实文件。对页面、过程函数、系统脚本、表或视图右键“复制 AI 上下文”，可把项目身份、对象路径和已提取关系复制给 AI。

索引是源码的定位投影，不替代 SVN checkout；源码发生较大变化后重新执行“重建 AI 索引”即可。

### 跳转过程函数和服务组件

生成 AI 索引后，编辑器会根据当前文件所属项目读取 `objects.jsonl`。以下调用可以直接跳转：

```gss
$vs.proc.invoke('com.golden.bdp.gdrm.report.queryFuturesExposureMatch', 'run', $form)

#set($proc = $vs.proc.find('com.golden.bdp.gdrm.common'))
$proc.setMainState($inputForm)

$vs.proc.runServiceComp('com.golden.bdp.gdrm.project.checkHedgingSetting', $form)
```

变量名不固定，插件会先识别“变量 = `$vs.proc.find(...)`”的绑定，再让 `$proc`、`$service` 等任意变量名的方法调用跳转到对应过程函数。一个 GSS 文件内如果同一个变量被多次绑定，插件按调用前最近的一次绑定解析，避免把前面的调用错误跳到后面重新绑定的过程包。

服务组件会按当前页面所属系统优先解析。AI 索引存在时优先使用索引；索引未建立、索引未及时更新或目标没有写入索引时，会按真实源码目录兜底查找，因此源码跳转不要求每次都先重建索引。索引主要用于搜索、中文名称展示和调用关系定位。

### 当前 GSS 片段内的方法跳转

页面虚拟脚本、过程函数 GSS 和页面服务组件 GSS 都支持页面/脚本内部的方法调用跳转。方法名不固定，不会把示例名称写死：

```gss
@buildProjectData($inputForm);

#function buildProjectData($form)
  ## 当前方法实现
#end
```

使用 macOS 的 `Command+点击` 或 Windows 的 `Ctrl+点击`，会跳到当前 GSS 文档中的 `#function buildProjectData` 定义。此类方法只在当前打开的 GSS 文档内解析，不会跨页面、跨虚拟片段或跨其他 GSS 文件寻找同名方法；过程函数和服务组件调用仍按上一节的跨文件规则处理。

跳到方法定义后，定义行上会显示“返回调用位置”CodeLens。点击它会调用 VS Code 的导航历史返回上一次调用位置；也可以使用 VS Code 自带的后退快捷键：macOS 通常为 `Command+[`，Windows 通常为 `Alt+Left`。如果看不到 CodeLens，请打开 VS Code 设置中的 `Editor: Code Lens`。

插件会忽略注释和字符串中的伪调用，例如下面的文本不会生成跳转：

```gss
// @notAFunction();
#set($message = "@alsoNotAFunction()")
```

### 浏览和打开页面

1. 打开左侧 `Guthon SVN`。
2. 展开产品、系统、中文目录和菜单。
3. JSON 页面单击后会展开组件树；继续展开组件即可选择字段、按钮、事件或数据源 SQL。
4. 单击最末级控件，只查看该字段、按钮、事件或 SQL 片段；模块行右侧的预览按钮可以只查看整个模块。
5. 右键虚拟节点执行“在原始 JSON 中定位”可回到真实文件；页面行右侧的“打开文件”按钮可直接打开完整 JSON。
6. 脚本、SQL 和字段集合虚拟文档保存后会同步到唯一的原始 JSON 文件；不会生成额外的虚拟文件。GSS 页面仍然单击即打开。

### 搜索页面

点击页面树标题栏的搜索按钮，或运行：

```text
    Guthon SVN: 搜索源码对象
```

搜索支持页面名称、系统 ID、页面类型、过程函数、系统脚本、表、视图名称、数据源编号和源码路径。选中结果后会自动展开左侧目录到对应系统/数据源及文件，并打开目标源码。

### 更新 SVN

点击项目页标题栏的下载按钮，或执行“全量更新项目”。旧结构更新项目根工作副本；新版结构会按顺序更新所有独立 checkout，并在结束时汇总成功和失败结果。每个中文存储库标题栏上的下载按钮只更新当前 checkout。更新前会读取本地状态：存在未解决冲突时阻止更新；存在本地修改时经确认后先把每个工作副本的真实 Patch 备份到插件全局缓存目录。命令使用系统安装的 `svn` 客户端逐个执行：

```text
svn update --ignore-externals -- <工作副本目录>
```

完成后中文页面树会自动刷新。SVN 输出位于 VS Code 的 `Guthon SVN` 输出通道。

### SVN 环境诊断

如果“源代码管理”没有显示变更，先在页面树标题栏执行“检查 SVN 状态”。输出会显示：

1. 插件最终使用的 SVN 可执行文件路径。
2. 当前选中的项目根目录和项目配置。
3. 自动发现的每个 `.svn` 工作副本目录。
4. 对每个工作副本实际执行的状态检查及返回结果。
5. 成功识别到的 `M`、`A`、`D`、冲突和未版本控制文件数量。

插件对分片 checkout 会逐个执行状态检查，不要求外层目录本身存在 `.svn`。例如：

```text
gmeSvn/
  pages/SYS-AAAA/.svn/
  procedures/0000/.svn/
  system-script/SYS-AAAA/.svn/
  tables/0000/.svn/
  views/0000/.svn/
```

终端中对某个真实文件执行 `svn status "文件路径"` 显示 `M`，说明 SVN 工作副本本身正常；如果插件诊断显示的工作副本路径不是这个文件所属的 `.svn` 子目录，说明项目根目录或配置路径没有选对。Windows 路径大小写差异会自动兼容，目录移动后必须确保目录内的 `.svn` 元数据仍然完整。

### 查看变更与提交

打开 VS Code 左侧“源代码管理”（分支图标），即可看到当前工作副本的“工作副本更改”。新版会按实际 checkout 显示中文存储库，例如“国际贸易 · 页面”“贸易系统 · 过程函数”“风险管理 · 系统脚本”；页面文件优先显示 `index.md` 中的中文页面名称，悬浮提示仍保留原始 SVN 路径和编码。默认点击文件打开“脚本/SQL 可读差异”：页面 JSON 只展开事件脚本和数据源 SQL，便于看业务修改。右键选择“查看真实文件差异”可核对 SVN `BASE` 与当前原始文件的完整文本；两种查看方式都不会改动源码。

右键实际文件或 Guthon SVN 变更项，选择“查看文件 SVN 历史”，可查看最近 50 个版本的版本号、作者、时间和提交说明。选中版本后可打开该版本、与当前文件或 BASE 比较，也可选择另一个历史版本比较。JSON 页面每次比较都会询问使用“事件脚本与 SQL 可读差异”还是“原始源码差异”。存储库菜单中的“搜索提交历史”可在最近 100 次提交中搜索版本号、作者和提交说明。

存储库标题上的“远程”按钮执行 `svn status -u`，结果显示在独立的“远程变更”分组中；点击远程文件可比较 `BASE` 与 `HEAD`。该操作只在手动触发时访问服务器，适合由多个独立 checkout 组成的项目。

提交行为与通用 SVN 插件一致：每个独立 checkout 单独提交，先勾选要提交的文件，再输入提交说明。不会再把多个 checkout 拼成一条 `svn commit` 命令。未纳入版本控制的文件显示在独立分组中，右键选择“加入 SVN”后才会进入可提交列表。顶部下载按钮执行更新；提交实际执行：

```text
svn commit -F <UTF-8 提交说明文件> --encoding UTF-8 --depth empty -- <已选择文件...>
```

提交说明会通过 UTF-8 文件并携带 `--encoding UTF-8` 写入 SVN，避免中文说明出现乱码。

提交前会再次展示选中的真实文件、状态和提交说明。右键变更文件可设置 SVN changelist，设置后源代码管理中会显示“变更集 · 名称”分组；提交时仍可自由勾选文件。右键文件或存储库可导出真实 SVN Patch。

冲突文件显示在单独的“冲突”分组。执行“处理冲突”可先查看 BASE 与当前文件差异，确认当前内容正确后再执行 `svn resolve --accept working`。存储库菜单提供安全的 `svn cleanup`，不会自动删除未纳入版本控制的文件。

未纳入版本控制的文件也会显示在列表中；提交前请确认它们是否应加入 SVN。

## 配置

插件不依赖其他 SVN 扩展，但依赖本机 SVN 命令行。默认会扫描 VS Code 的 `PATH`，并自动检查 macOS 的 `/usr/bin/svn`、Homebrew、Xcode，以及 Windows 的 TortoiseSVN、SlikSVN、Chocolatey、Scoop 等常见安装位置。找不到时会明确提示并提供“选择 SVN 程序”按钮。

通过文件选择器选中的路径会保存在插件本机存储中；即使某个 VS Code 版本没有注册设置项，也能立即使用，不需要手工修改 `settings.json`。

也可以运行命令“Guthon SVN: 选择 SVN 命令行程序”，或在设置中填写完整路径：

```json
{
  "guthonSvnNavigator.svnExecutable": "/opt/homebrew/bin/svn"
}
```

Windows 示例：

```json
{
  "guthonSvnNavigator.svnExecutable": "C:\\Program Files\\TortoiseSVN\\bin\\svn.exe"
}
```

### Windows 与 macOS 注意事项

- macOS 常见 SVN 路径为 `/usr/bin/svn`、`/opt/homebrew/bin/svn` 或 `/usr/local/bin/svn`。
- Windows 常见 SVN 路径为 `C:\Program Files\TortoiseSVN\bin\svn.exe`、SlikSVN、Chocolatey 或 Scoop 安装目录。
- 插件使用 SVN 命令行，不依赖 `johnstoncode.svn-scm` 等通用 SVN 扩展；通用 SVN 扩展可以禁用。
- 如果 VS Code 扩展进程的 `PATH` 找不到 SVN，使用“Guthon SVN: 选择 SVN 命令行程序”手动选择 `svn` 或 `svn.exe`。
- 如果手动选择后提示设置项未注册，插件会把路径保存到插件自己的全局状态中，重启窗口后仍然有效。
- `svn: E175002: 502 Bad Gateway` 是 SVN 服务端或网关连接问题，不是本地变更检测问题；本地状态仍可以在不访问服务器的情况下检查。
- `--ignore-externals` 只是不进入 SVN external 指向的外部工作副本，不会忽略当前项目 checkout 内的普通本地修改。

### 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 中文源码目录能显示，但“源代码管理”没有变更 | 执行“检查 SVN 状态”，确认诊断中的工作副本路径包含实际修改文件，并点击“刷新变更列表” |
| 终端有 `M`，插件显示 0 个变更 | 检查当前项目是否选错、工作副本是否被移动后缺少 `.svn`，以及插件诊断中是否使用了正确的 SVN 程序 |
| 打开项目父目录后没有识别 | 配置 `guthon-projects.yaml` 的项目 `path`，或选择包含所有分片 checkout 的共同上层目录 |
| 页面虚拟 GSS 能跳，真实 GSS 不能跳 | 安装最新版 VSIX，执行“重新加载窗口”，确认真实文件扩展名是 `.gss`；过程函数/服务组件跳转不需要依赖通用 SVN 扩展 |
| `@方法()` 没有跳转 | 确认当前文档中存在同名 `#function 方法(...)`，且调用和定义在同一个 GSS 文档内 |
| 跳转到了后面错误的过程包 | 使用 0.7.8 或更高版本；插件按调用前最近的 `$vs.proc.find(...)` 绑定解析 |
| 更新时报 502 | 先在终端对同一工作副本执行 `svn info` 或 `svn update`；502 通常需要检查 SVN 网关、服务器和网络 |
| 初始化或更新覆盖了本地修改 | 插件更新前会检查状态；出现确认提示时不要直接继续，先查看真实 Patch 备份或提交/导出本地修改 |

其他 SVN 源代码管理扩展创建的 `SYS-* pages`、`0008 procedures` 等原始存储库标题无法由本插件改名。若只希望看到中文列表，请在扩展管理中对该通用 SVN 扩展选择“禁用（工作区）”；Guthon SVN 的更新、查看差异和提交功能不受影响。

如仍需使用通用 SVN 扩展扫描多个独立 checkout，请在 VS Code 用户设置中开启：

```json
"svn.multipleFolders.enabled": true,
"svn.multipleFolders.depth": 4
```

- `guthonSvnNavigator.repositoryRoot`：手工指定完整工作副本根目录，或新版分片 checkout 的共同上层目录。
- `guthonSvnNavigator.svnExecutable`：本机 SVN 命令行程序完整路径；留空时按当前系统自动探测。
- `guthonSvnNavigator.autoRefresh`：索引变化时自动刷新，默认开启。
- `guthonSvnNavigator.showIds`：在系统节点旁显示 SYSTEM_ID。
- `guthonSvnNavigator.showMissingPages`：显示索引中存在但目标文件已经缺失的历史节点，默认关闭。
- `guthonSvnNavigator.trustServerCertificate`：临时信任 SVN 服务器证书，默认关闭。仅当服务器证书过期、主机名不匹配或颁发者未知且暂时无法修复时开启。

如需临时开启，可在工作区 `.vscode/settings.json` 中加入：

```json
{
  "guthonSvnNavigator.trustServerCertificate": true
}
```

这会对更新、提交、状态查询和差异读取放宽证书校验；服务器证书修复后请关闭。

## 开发验证

打包工具要求 Node.js 20.18 或更高版本；插件本身运行在 VS Code 扩展宿主中，没有第三方 npm 依赖。

```bash
npm test
npm run check
npm run package
```
