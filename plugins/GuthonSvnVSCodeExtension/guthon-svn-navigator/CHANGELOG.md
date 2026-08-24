# Change Log

## 0.7.16

- 工作副本变更优先使用项目 AI 索引显示页面、过程函数、服务组件、系统脚本、数据表和视图的中文名称；索引未命中时继续从现有源码元数据读取。
- 删除或缺失的文件仍可打开差异：左侧读取 SVN BASE，右侧显示空内容，完整呈现被删除的源码。

## 0.7.15

- 首次初始化刚输入用户名后，始终继续显示密码输入框，不再先依赖本机凭据缓存。
- 将首次 `E175013 Forbidden` 也视为可能缺少登录凭据并提示密码；提交密码后仍 Forbidden 才明确报告路径权限不足。

## 0.7.14

- SVN 登录预检改为访问首个真实 `checkout_path`，不再要求账号拥有项目根 URL 的目录读取权限。
- 修复账号可 checkout `skill`、`pages/...` 等源码子路径，但因项目根目录返回 Forbidden 而无法初始化的问题。

## 0.7.13

- 在编辑器标签页和资源管理器右键菜单中增加“与 SVN 基线对比”。
- JSON 文件额外提供事件脚本与 SQL 的可读差异；普通文件提供原始文件差异。
- 从标签页或资源管理器发起对比时，只允许当前 VS Code 工作区内已识别项目的文件。
- “全量更新项目”成功后自动重建当前项目 AI 索引，并单独报告索引生成失败。

## 0.7.12

- 初始化前先验证 SVN 登录信息；本机没有缓存凭据时，在 VS Code 内提示输入用户名和密码。
- 密码使用隐藏输入框并通过标准输入传给 SVN，不写入项目配置，也不输出到日志。
- 登录失败时在批量 checkout 前停止并给出明确提示，避免所有源码路径重复报认证错误。

## 0.7.11

- 项目发现严格限制在当前 VS Code 打开的文件夹内，不再向父级目录搜索项目或配置。
- 空工作区初始化增加可见进度，生成配置后自动打开 `guthon-projects.yaml` 并提示下一步。
- 未初始化时点击选择项目、搜索、AI 索引或刷新，统一提示先生成配置或初始化项目。
- 项目扫描跳过 `.svn` 管理目录，并在缺少 `pages` 时立即停止，避免扩展宿主无响应。

## 0.7.10

- 在当前 GSS 文件的 `#function` 定义上增加“返回调用位置”CodeLens，使用 VS Code 导航历史返回上一次方法调用。

## 0.7.9

- 在页面虚拟 GSS、过程函数 GSS 和页面服务组件 GSS 中支持当前文件内的 `@方法(...)` 跳转到 `#function 方法(...)` 定义。
- 页面方法只在当前 GSS 文档内解析，不跨页面或跨 GSS 文件匹配；原有过程函数、服务组件跨文件跳转保持不变。

## 0.7.8

- 修复同一服务组件脚本内重复使用 `$proc` 变量时的跳转错误：每个方法调用按其前方最近一次 `$vs.proc.find(...)` 绑定解析。
- 支持同一脚本中先后调用不同过程包，避免把 `checkMainState` 等方法错误解析到后面重新绑定的过程包。

## 0.7.7

- 即使项目 AI 索引未及时重建，过程函数和页面服务组件也会按真实源码路径兜底解析。
- 过程函数按 `procedures/*/<包路径>/<方法名>.gss` 查找，服务组件按 `pages/**/*.gss` 的文件名和 `@pageAliasId` 查找。

## 0.7.6

- 修复 `$proc.method(...)` 只能识别变量名、点击方法名无反应的问题。
- 过程绑定调用现在将完整的 `$proc.method` 作为可点击跳转范围。

## 0.7.5

- 真实 `.gss` 服务组件按文件后缀注册源码跳转，不再依赖其他扩展提供的 `languageId`。
- 虚拟 GSS 与磁盘上的服务组件统一使用过程函数、服务组件跳转解析。

## 0.7.4

- 将 `pages/<SYS-*>/.../*.gss` 页面服务组件加入项目 AI 索引。
- `$vs.proc.runServiceComp('组件编码', ...)` 现在可以跳转到页面服务组件源码，并优先匹配当前页面所属系统。

## 0.7.3

- 修复普通 VM 变量方法（如 `$futuresTable.isEmpty()`、`$partsnameTypeMap.put()`）被误识别为过程函数并出现额外链接高亮的问题。
- 只有 `$vs.proc.find(...)` 绑定的过程变量、`$vs.proc.invoke(...)` 和 `$vs.proc.runServiceComp(...)` 才会显示源码跳转链接。

## 0.7.2

- 多项目源码跳转按当前文件所属的最具体项目根目录解析，避免嵌套项目或路径异常时串用其他项目的索引。
- 找不到文件所属项目时不再错误回退到第一个项目。

## 0.7.1

- 修复过程函数包目录跳转：`$vs.proc.find('包名')` 绑定变量后，点击 `$proc.方法名(...)` 会定位到对应的 `procedures/<dataSourceId>/<包路径>/<方法名>.gss`。
- 支持 `$vs.proc.invoke('过程名', '方法名', ...)` 的方法名解析。

## 0.7.0

- 增加项目内 AI 索引：自动创建 `docs/ai-index/`，不要求项目事先存在 `docs/` 目录。
- 为页面、过程函数、系统脚本、表和视图生成对象索引、调用/依赖关系索引和页面结构 Markdown。
- 每个项目独立生成索引，保留项目名、系统名、数据源名、编码和中文别名，支持多项目分别搜索。
- 顶部“AI 索引”菜单支持重建当前项目、重建全部项目、搜索索引并定位；源码节点右键支持复制 AI 上下文。
- GSS、页面事件脚本和 SQL 支持 Ctrl/Cmd+点击跳转过程函数及服务组件；支持任意变量名绑定 `$vs.proc.find(...)`。

## 0.6.14

- 补齐 Windows 路径大小写兼容：原文件差异、撤销变更、中文目录变更颜色和工作副本匹配统一使用规范化路径。
- 恢复稳定的 SVN 工作副本标识，避免 VS Code 源代码管理复用不到已有的变更容器。

## 0.6.13

- 修复 Windows 路径大小写不同导致 SVN XML 变动被错误过滤的问题。
- Windows 路径比较统一按不区分大小写处理，macOS/Linux 继续保持大小写敏感。

## 0.6.12

- 新增“检查 SVN 状态”，显示实际使用的 SVN 程序、识别到的工作副本、变更数量和失败原因。
- 工作副本改为从当前项目范围递归发现 `.svn`，不再只依赖固定源码目录名称。
- 监听本地文件创建、修改、删除和重命名，自动刷新 SVN 变更；状态命令执行失败时保留上一次成功结果。

## 0.6.11

- 中文源码目录识别到的配置项目路径会直接用于 SVN 变动检测，单项目无需再手动选择一次项目。
- 打开多个项目的共同父目录时优先识别直接子项目，避免外层残留目录或 `.svn` 把 SCM 错误绑定到父目录。
- 项目目录移动后，旧的当前项目路径失效时会自动切换到当前识别到的有效项目。

## 0.6.10

- 分片 checkout 优先于项目根目录的 `.svn`，避免根目录残留无效 `.svn` 时误执行 `svn status` 并报 `W155007`。
- 源代码管理改为扫描 `pages/SYS-*`、`procedures/*` 等真实子工作副本，恢复分片项目的本地变更显示。

## 0.6.9

- 修复部分 VS Code 环境提示 `svnExecutable is not a registered configuration`，导致手动选择 SVN 程序失败的问题。
- 手动选择的 SVN 路径优先保存到插件本机存储，设置项未注册或写入失败时仍可正常刷新变更。

## 0.6.8

- 自动探测 macOS PATH、Homebrew、Xcode 及 Windows PATH、TortoiseSVN、SlikSVN、Chocolatey、Scoop 中的 SVN 命令行。
- 增加 `guthonSvnNavigator.svnExecutable` 设置和“选择 SVN 命令行程序”命令。
- SVN 程序不可用或状态读取失败时明确提示，不再只把源代码管理变更列表清空。

## 0.6.7

- 在 SVN Quick Diff 单个变更浮窗中增加与 Git 一致的撤销按钮。
- 当前变更撤销只恢复浮窗中这一处 hunk，并保留同一文件中的其他修改。
- 默认启用全部 SCM 差异装饰，使左侧 gutter、右侧 minimap/overview ruler 都能显示变更标记。

## 0.6.6

- 在脚本/SQL可读差异编辑器标题栏和右键菜单增加“取消当前差异块”。
- 单块撤销只把光标所在事件或 SQL 恢复到 SVN BASE，不影响同一 JSON 文件中的其他修改。

## 0.6.5

- 增加 SVN 文件装饰：中文源码树和 VS Code 资源管理器中的文件/目录会按变更状态显示颜色与标记。
- 目录节点按下级变更汇总显示，支持已修改、新增、删除、冲突和未纳入版本控制状态。

## 0.6.4

- 保留页面 JSON 的 SVN Quick Diff 变更行显示。
- 在差异编辑器标题栏增加“取消本地更改”按钮，和上下变更按钮并列显示。

## 0.6.3

- 在编辑器文件右键菜单中增加“取消本地更改”，差异编辑器右侧文件也可直接恢复到 SVN BASE。

## 0.6.2

- 在编辑器 JSON 文件右键菜单中增加“查看文件 SVN 历史”。
- JSON 历史版本继续支持事件脚本/SQL 可读差异和原始文件差异。

## 0.6.1

- 为页面 JSON 增加 SVN BASE Quick Diff，可在普通编辑器左侧显示本地变更行。
- 缩短源代码管理存储库名称，去掉重复的“Guthon SVN”前缀，保留项目名和对象中文名。

## 0.6.0

- Add selected-file commit preview, safe updates with automatic Patch backups, incoming remote changes, Cleanup and conflict resolution.
- Add real Patch export, SVN changelist groups, repository history search and GSS/VM/JS/SQL gutter Quick Diff.
- Let JSON file history compare either readable event/SQL projections or complete raw source between revisions.

## 0.5.8

- Let VS Code render the configured Guthon SCM label instead of replacing it visually with the child checkout folder name.

## 0.5.7

- Prefix Source Control repository labels with `Guthon SVN` and the configured project name so the active provider and project are unambiguous.

## 0.5.6

- Prefix source-control repositories with the active project name.
- Keep Chinese system and data-source labels in Guthon SVN SCM entries.

## 0.5.5

- Generate the full plugin README beside the project configuration on first initialization.
- Keep the README at the workspace configuration root instead of placing it inside the SVN source directory.
- Upgrade the legacy generated project README to the full plugin README when detected.

## 0.5.4

- Generate the extension README content during first project initialization instead of a project metadata README.

## 0.5.3

- Generate a new configuration in the current empty workspace instead of reusing a parent workspace configuration.

## 0.5.2

- Generate `guthon-projects.yaml` from the built-in project template when initialization starts without a configuration file.
- Replace the SVN phone-number placeholder with `your-svn-user`.
- Generate a project `README.md` once during the first initialization without overwriting an existing file.

## 0.5.1

- Use the project configuration directly for project switching.
- Show configured but uninitialized projects in the project picker.
- Use a folder icon for initialization and keep the cloud icon for updates.

## 0.5.0

- 支持外层工作区下的多个谷神项目，并保存当前选中的项目。
- 搜索、目录、更新、提交和源代码管理只作用于当前项目。
- 支持读取 `谷神项目配置.yaml`，并按项目 SVN 地址和 checkout 路径初始化项目。
- 兼容旧名称 `谷神项目编码字典.yaml`。

## 0.4.7

- 变量、系统变量、参数和控制指令改用 VM 插件相同的语法作用域，适配现有主题的紫色变量高亮。

## 0.4.6

- 为 `.gss` 增加与 VM 插件一致的 API 悬浮文档、参数片段和语法快捷补全。
- 将 VM 插件的补全规则与 API 资料随本插件打包，安装本插件即可使用。

## 0.4.5

- `.gss` 高亮改为与 Guthon VM 一致的 Java 基础语法加 Guthon 指令注入规则。
- 增加 `$vs`、普通变量、`#{参数}` 和完整 Velocity 控制指令高亮。

## 0.4.4

- 在 SVN 变更文件的行内菜单增加“取消本地更改”，执行前需要确认，完成后刷新状态和源码目录。

## 0.4.3

- 源码对象名称读取改为异步处理，避免扫描过程函数、表和视图时阻塞扩展宿主。
- 将过程函数、表和视图的中文名称缓存到 VS Code 插件全局缓存目录，按文件修改时间和大小失效。
- 合并并防抖目录刷新请求，减少页面索引连续变化时的重复扫描。

## 0.4.2

- 过程函数读取源码头部的 `@description` 和 `@functionId`，在目录中显示中文说明和函数编码。

## 0.4.1

- 将活动栏图标改为可直接由 VS Code 渲染的 SVG 图标，避免旧图标缓存或内嵌图片不显示。

## 0.4.0

- 系统节点按 `docs/谷神项目编码字典.yaml` 中的数据源和系统顺序展示，避免中文名称排序导致顺序倒置。
- 页面树增加过程函数、系统脚本、表和视图源码对象；表和视图标记为只读资料。
- 搜索覆盖页面、过程函数、系统脚本、表和视图，选中结果后自动展开并定位左侧目录。

## 0.3.4

- 页面 JSON 差异视图恢复显示数据源 SQL，并与事件 Script 分段标识。

## 0.3.3

- 页面 JSON 的差异窗口只显示事件 Script，不再混入 JSON 配置外壳或触发 JSON 语法报错标红。
- 修复 Velocity `#set(...)` 等指令后的分号被错误拆成独立行的问题。

## 0.3.2

- 查看 JSON 文件差异时使用只读结构化视图，页面脚本会展开为多行代码，避免压缩 JSON 造成整行红绿差异。
- 不改变 SVN 原始文件格式、Workcopy 写回逻辑或提交内容。

## 0.3.1

- 字段脚本节点显示字段编码和字段名称，便于区分多个 `onChangeScript`。
- 虚拟脚本保存时保留原有格式，并将特殊字符按原项目规则转义回 JSON。

## 0.3.0

- 兼容新版分片签出结构：项目根目录本身可以没有 `.svn`，页面系统、过程函数数据源、表、视图和系统脚本分别是独立工作副本。
- 保留旧式单一根工作副本兼容性，并在页面树中显示当前工作区模式和工作副本数量。
- SVN 更新、状态、源代码管理和提交会聚合项目下所有独立工作副本。
- 差异和基线读取会自动路由到文件所属的实际工作副本。

## 0.2.8

- SVN 基线读取失败时不再打开“整文件新增”的误导性差异，而是提示真实错误。

## 0.2.7

- 在 Guthon SVN 仓库状态栏增加明确的“刷新”按钮。

## 0.2.6

- 使用 SVN 基线虚拟文档打开差异，避免每次查看差异都生成 `Untitled-*` 临时编辑器。

## 0.2.5

- 回写脚本时保留原始 JSON 的换行符和引号转义格式，避免 `\\r\\n`、`\\u0027` 被不必要地改成另一种表示。

## 0.2.4

- 修复 VS Code 源代码管理资源状态 API 使用错误导致变更列表刷新失败的问题。

## 0.2.3

- 扩展证书临时信任范围，覆盖 SVN 返回的 `other` 证书错误。

## 0.2.2

- 支持通过 `trustServerCertificate` 配置临时绕过 SVN 服务器证书校验失败。

## 0.2.1

- 在 Guthon SVN 源代码管理仓库状态栏固定显示“更新”和“提交”按钮，避免与其他 SVN 插件的仓库入口混淆。
- 增加默认关闭的 `trustServerCertificate` 配置，用于临时处理旧 SVN 服务器证书校验失败。

## 0.2.0

- 在 VS Code 源代码管理视图显示 SVN 工作副本的新增、修改、删除和冲突文件。
- 增加 SVN 更新和提交命令，提交说明可在源代码管理输入框中填写。
- 保存、创建、删除和重命名文件后自动刷新 SVN 变更列表。

## 0.1.5

- 补齐虚拟文件系统的目录创建、删除和重命名接口，修复扩展激活失败。

## 0.1.0

- 自动识别包含 `.svn`、`info.json` 和 `pages` 的谷神 SVN 工作副本。
- 将各系统 `index.md` 展示为中文页面树。
- 点击中文页面名称打开对应页面 JSON 或 GSS 服务组件。
- 支持跨系统快速搜索页面。
- 支持 SVN 更新、状态查看和目录自动刷新。
- 为 `.gss` 文件提供 Guthon GSS 语言和基础语法高亮。
## 0.1.4

- 修复虚拟文件系统缺少 `readDirectory` 导致扩展激活失败、`openSegment` 命令未注册的问题。

# 0.1.3

- 脚本、数据源 SQL 和字段集合虚拟文档支持编辑并通过 `Ctrl+S` 回写原始 JSON。
- 增加原始片段指纹冲突检测、JSON 校验和原子写入。
- 字段列表收敛为单个字段集合节点，字段脚本仍单独展示。

# 0.1.2

- 字段、按钮、事件和数据源 SQL 默认在只读虚拟文档中单独显示。
- 查询区、主表、页签和明细表支持预览当前模块，不拆分原始 JSON 文件。
- 虚拟节点支持通过右键菜单回到原始 JSON 的准确位置。
- 页面、组件、字段和按钮中的全部 `*Script` 拆为独立节点；前端 JavaScript 与后端 Velocity 脚本分别在虚拟预览中自动格式化，不修改原始 JSON。

# 0.1.1

- JSON 页面节点支持按组件、字段、按钮、事件和数据源 SQL 展开虚拟树。
- 点击虚拟控件时打开同一个 JSON 文件并定位到对应配置。
- 页面 JSON 修改后自动失效并刷新组件树缓存。
