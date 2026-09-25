# GuthonCodeTool

GuthonCodeTool 是谷神低代码开发平台的本地开发工具集。每个产品或项目可显式选择数据库或 SVN 源码模式，并为 AI、VS Code 和 Chrome 提供统一的多工作区路由。

GuthonCodeTool 是独立工具源码仓库，只保存公开的工具代码、配置模板和说明文档。真实运行配置和私有数据在仓库之外的**本地数据目录（toolHome）**，两者物理分离：

```text
<toolHome>/
├── GuthonCodeTool/     工具源码（本仓库）
├── config/             真实运行配置
├── docs/private/       维护者私有资料和谷神 API bundle
└── var/                私有谷神工作区，独立 Git
```

工具代码只通过显式 `--home`、runtime descriptor 或 `GUTHON_HOME` / `GUTHON_TOOL_HOME` 获取 `toolHome`，不从源码仓库相对路径推断运行数据。

## AI 开发入口

工具开发读取 [AGENTS.md](AGENTS.md)，先经 [AI_CODE_INDEX.md](AI_CODE_INDEX.md) 定位模块；谷神业务开发从独立私有工作区的 `<toolHome>/var/AGENTS.md` 进入。排查开发库/测试库，或在功能开发后执行数据库验证时，使用 [Guthon Testing Skill](skills/guthon-testing/SKILL.md)。Skill 可调用工具内置只读连接器；已有 DBX 时也可继续使用。专项规范按任务加载，README 不维护第二套 Agent 流程。

## 核心能力

- 产品、项目各自拥有完整工作区，使用稳定键 `products.<id>`、`projects.<id>` 路由。
- 数据库模式把页面、过程函数和系统脚本同步到 readonly；SVN 模式按唯一根地址完整检出一个 working copy，不复制第二份 readonly/workcopy 源码。
- 每个工作区拥有独立 SQLite 轻量事实索引；除调用关系外，还记录 PAGE 片段定位、字段到表列映射、单据路由、
  表读写和条件/赋值/异常事实，不保存第二份完整源码，也不建立膨胀的源码全文倒排。
- SVN MCP 共用 PAGE 节点目录和过程函数对象索引；AI 可按完整工作区与对象身份查询，并在编辑租约与授权复核后修改稳定 PAGE 脚本/SQL 节点、同集合新增/拷贝单个界面字段或修改精确过程函数，写入仅进入本地 working copy。
- SVN 模式由 Nexus 的“谷神源码”聚合展示源码，并为每个工作区注册一个 SCM provider；支持 PAGE 分块、过程函数、系统脚本虚拟编辑并直接回写 checkout，表和视图保持只读。
- 数据库模式一次执行源码、表结构、单据类型、系统脚本、视图五步同步。
- Guthon Nexus 同时展示并操作多个产品、项目。
- Guthon Nexus 在每个项目下提供“工作区驾驶舱”，集中显示本地事实索引、同步状态、SVN working copy、本地变更和最近一次 SVN 提交；各状态行可直接进入对应操作。
- “搜索工作区完整索引”把源码身份与条件、赋值、异常、表读写和调用事实放入同一个结果列表，不依赖树节点是否展开；任一源码结果都可复制精简或详细 AI 上下文。
- Guthon Bridge 根据 `workspaceKey` 或页面身份自动路由；存在多个候选时由 Chrome 只为当前请求选择。
- 手动拉取和全量同步只自动暂存本次新生成、未被忽略的文件，不暂存已跟踪修改或无关文件。

## 目录

```text
config/                         配置模板和配置说明
docs/                           使用手册和全功能说明
skills/guthon-testing/          谷神需求开发、数据库快速排查与只读验证工作流
plugins/GuthonBridge/           Chrome 扩展及本地 Bridge
plugins/GuthonNexus/            Guthon Nexus
scripts/
├── guthon_tool.py             唯一运行入口和命令编排
├── build_guthon_tool.py       独立应用构建入口
├── sync_guthon_api.mjs        谷神 API 文档与补全数据同步
├── check_ai_code_index.py     校验 AI_CODE_INDEX.md 的路径
├── common/                    双模式共享的路由、索引、查询和 Workcopy 基础能力
└── providers/
    ├── database/              数据库源码、metadata 导出和只读诊断
    └── svn/                   SVN 清单、working copy、虚拟编辑和 SCM
tests/                          Python 测试
```

真实配置和私有数据不在本仓库：`<toolHome>/config/` 保存运行配置，`<toolHome>/var/` 保存私有谷神工作区（含 `checkout/`、`workspace/`、`nexus/`、`tools/`），详见 [配置说明](config/README.md)。

正式 Release 同时提供 `guthon-testing.zip`。其他用户无需安装 DBX/MCP：安装 GuthonCodeTool 应用和 Guthon Nexus VSIX，将压缩包中的 `guthon-testing` 解压到 Codex Skills 目录，然后在 Nexus 为目标工作区配置一次专用只读数据库账号即可。

数据库模式的产品或项目工作区：

```text
docs/
source/
├── readonly/                   上游只读镜像
└── workcopy/                   本地开发副本
database/
├── schema/
├── billtype/
└── views/
context/
├── README.md
├── index.db
├── state.json
└── logs/
```

目录中的 `PRD`、`PRJ` 只控制显示顺序；程序不会通过目录名判断身份。

SVN 新模式的工作区只创建 `docs` 和 `context` 等派生资料；唯一根 URL 完整检出到
`<toolHome>/var/checkout/<配置 ID>/`。资源管理器保留原始目录供查看，日常修改从“谷神源码”进入并
回写同一份文件；过程函数节点可右键复制函数名或 `包名.函数名`，也可选择索引识别的调用方并跳转到精确调用行。过程函数调用支持转到索引中的定义，`@子方法(...)` 支持跳转到当前源码中的 `#function` 声明；从定义打开的源码可在“谷神源码”树中定位，并与树节点共用编辑器文档。不再生成额外 `source/readonly` 或 `source/workcopy` 代码副本。

## 配置

发行模式优先在 Nexus 的“工作区”或“项目”区域点击“添加产品或项目”。向导只收集产品/项目、名称、稳定 ID 和源码来源；选择 SVN 或 DATABASE 后即创建对应 Nexus 并结束。新建 SVN Nexus 中的“设置工作区 SVN 登录”、“导入/粘贴 SVN checkout 配置”和“编辑 SVN 地址配置”用于后续配置；每个产品或项目只保存一个 `svn.url`，默认完整 checkout 该地址，不会探测其他工作区的脚本。DATABASE Nexus 可先创建，后续再补充 datasource。生成的 `workspaceKey` 写入 `products.yaml` / `projects.yaml`；`systems.include.mappings` 可选，只用于身份匹配、命名和路由子系统，不过滤 SVN 目录。后续增加项目使用同一入口，无需重新初始化数据目录。
项目无需先创建或选择产品：项目是产品某个版本的完整导出快照，导出后与产品并列，拥有独立配置、源码、索引和数据源范围。
不再需要的 PRD/PRJ 可在工作区节点右键选择“删除产品或项目”；确认框会列出精确范围，确认后相关目录进入系统废纸篓，并删除该工作区配置、独占数据源和数据库排查条目。

`setup` 对首次使用生成空的 datasource/products/projects 注册表，并保留 source-tables/sync 模板；已有文件绝不覆盖。维护者也可手工复制完整示例：

```bash
cp config/example/datasource.example.yaml config/datasource.yaml
cp config/example/products.example.yaml config/products.yaml
cp config/example/projects.example.yaml config/projects.yaml
cp config/example/source-tables.example.yaml config/source-tables.yaml
cp config/example/sync.example.yaml config/sync.yaml
```

产品和项目分别声明数据源、子系统和可选页面来源：

```yaml
products:
  demo-product:
    name: 示例产品
    datasource: demo-product-dev
    systems:
      include:
        mappings:
          demo.system:
            system_id: SYS-DEMO
            data_source_id: "0000"
    page_origins: []
```

`mappings` 的键就是系统 alias，每项只配置一对一的 `system_id`、`data_source_id`。SVN 用它识别和分组完整 checkout 中的源码；DATABASE 仍按 alias 查询并使用本地 `system-data.json` 缓存。项目必须配置自己的数据源 ID，不能复用产品值。

产品/项目 YAML 不设置源码模式。Nexus 在每个项目节点单独选择 DATABASE/SVN，选择结果写入该工作区
`context/source-mode.json`，缺失时默认 DATABASE。`sync.yaml` 保存公共 SVN 用户名、全局同步窗口和安全规则，不包含当前或默认工作区。
完整格式见 [config/README.md](config/README.md)。

## CLI

以下命令在工具源码仓库根执行，`$GUTHON_HOME` 是**本地数据目录（toolHome）**而非本仓库：先 `export GUTHON_HOME=/path/to/toolHome`。工具只通过显式 `--home` 读取 `config/` 和 `var/`，不会在源码仓库里创建运行数据。

准备配置并查看全部工作区：

```bash
.venv/bin/python scripts/guthon_tool.py setup --home "$GUTHON_HOME"
.venv/bin/python scripts/guthon_tool.py workspace-create --home "$GUTHON_HOME"  # JSON 从 stdin 输入
.venv/bin/python scripts/guthon_tool.py workspaces --home "$GUTHON_HOME"
.venv/bin/python scripts/guthon_tool.py workspace-resolve --home "$GUTHON_HOME"  # 从当前 cwd 解析工作区与索引状态
.venv/bin/python scripts/guthon_tool.py database-target-resolve --home "$GUTHON_HOME" -- --path "$PWD"  # 自动选择该 cwd 的默认诊断库
.venv/bin/python scripts/guthon_tool.py database-target-resolve --home "$GUTHON_HOME" -- --path "$PWD" --environment test
.venv/bin/python scripts/guthon_tool.py database-probe --home "$GUTHON_HOME" -- --path "$PWD"
.venv/bin/python scripts/guthon_tool.py database-describe --home "$GUTHON_HOME" -- --path "$PWD" --table DEMO_ORDER
printf '%s' '{"sql":"SELECT COUNT(*) AS total FROM DEMO_ORDER","maxRows":100}' | .venv/bin/python scripts/guthon_tool.py database-query-readonly --home "$GUTHON_HOME" -- --path "$PWD"
```

工作区命令必须显式传入 `--workspace`：

```bash
.venv/bin/python scripts/guthon_tool.py sync-source-all --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-all --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py reindex --home "$GUTHON_HOME" --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py export-markdown --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py search --home "$GUTHON_HOME" --workspace products.demo-product -- --query 订单保存
.venv/bin/python scripts/guthon_tool.py context-pack --home "$GUTHON_HOME" --workspace products.demo-product -- --source-id '<source-id>' --fun-id '<fun-id>'
```

SVN 工作区要求 SVN 1.10+ 客户端。在 Nexus 的目标项目节点选择 SVN，并在已有的
`config/products.yaml`（项目写在 `config/projects.yaml`）对应条目中配置唯一 `svn.url`。Nexus 对该地址执行一次完整 checkout；`systems.include.mappings` 不参与目录筛选。地址无效、权限不足、网络或认证失败都会终止本次 checkout 并显示错误。
新增工作区时也可选择谷神平台为当前产品/项目下载的 `svnCheckoutHere.sh`（macOS/Linux）或 `svnCheckoutHere.bat`
（Windows），Nexus 只解析一次其中的 checkout 命令；脚本不会被执行，也不会从 `context/` 或其他工作区自动发现。之后检出/更新以配置为准。简明步骤见 [发行模式新增 SVN 产品或项目](docs/GuthonCodeTool_发行模式新增SVN产品项目.md)：

```bash
.venv/bin/python scripts/guthon_tool.py source-mode --home "$GUTHON_HOME" --workspace products.demo-product -- set --mode svn
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- scope-import  # JSON stdin: {"text":"...","source":"script"}
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- scope-preview
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- sync-from-script --accept-scope-change
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- refresh
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- status --diff
.venv/bin/python scripts/guthon_tool.py reindex --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- find --keyword 订单保存
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- facts --keyword 保存失败
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- explain --table T_ORDER
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- delivery-status
```

SVN MCP 是与 Nexus、Bridge 并列的 AI 查询和受控源码修改入口，以独立 stdio 进程运行。将以下命令及参数交给支持 MCP 的客户端配置，推荐服务别名为 `guthon-svn`；已有 `guthon-page` 配置仍可指向同一入口，不必覆盖。不要在普通终端交互使用。

```bash
.venv/bin/python scripts/guthon_tool.py mcp --stdio --home "$GUTHON_HOME"
```

默认提供 27 个工具：14 个只读工具（含独立的 SVN 对象索引状态、过程函数有界读取与调用方证据）和 13 个受控编辑/恢复工具；`--read-only` 仅暴露 14 个只读工具。PAGE 写入限于授权 SVN working copy 中稳定的脚本/SQL 字符串节点及同一已识别 UI 字段集合内的单字段新增/拷贝，不支持任意 PAGE JSON、跨集合复制或反射组修改。过程函数按 `workspaceKey + sourceNamespace + sourceId + funId + workingCopyId` 精确定位，先读取、取得编辑租约、预览，再以幂等键写入本地物理文件并核对索引和 SVN diff；不提交 SVN。字段目录仅索引有组件宿主的界面字段；无原生身份的数据源列仍从字段集合按需读取。关系查询保留显式 `selectCodefieldId` 指向及未解析的 `otherSetFields` 证据；引用检查始终不批准自动删除，不能作为完整引用证明。协议固定为 MCP `2025-11-25` stdio；工具要求显式 `workspaceKey`。PAGE 语义索引和 SVN 对象索引分别用 `get_index_status`、`get_source_index_status` 检查；`REBUILD_REQUIRED` 需显式重建，`PARTIAL` 且 `projectionGapCount>0` 表示某些 JSON PAGE 有片段但缺少语义节点，可先按精确 `sourcePath` 执行 `svn reindex-file --path`，范围较多时重建工作区索引。缺口目标会返回 `INDEX_STALE`，不会误作空 PAGE。MCP 不会自行迁移真实索引。索引 generation 改变时旧分页游标会被拒绝。Nexus 的现有编辑入口不受影响。

同一只读 PAGE 服务也可由 `svn page-query` 使用 JSON stdin 调用，并供 Nexus 后端按相同结果结构查询。Nexus 源码版的 SVN 源码树可对 PAGE JSON 使用“浏览 PAGE 语义节点”命令按页选择，再经过源码复核打开现有虚拟文档；尚无独立新面板，已安装 VSIX 需重新打包安装后才包含此命令。示例：

```bash
echo '{"name":"list_page_nodes","arguments":{"sourceNamespace":"pages-SYS-1","sourceId":"PG-1","limit":20}}' | .venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- page-query
```

PAGE 节点写入流程为 `open_page_node_edit → preview_page_nodes → update_page_nodes → get_page_operation / resume_page_operation`；字段新增/拷贝为 `open_page_field_insert → preview_page_field_insert → insert_page_field → get_page_operation / resume_page_operation`；过程函数为 `open_procedure_edit → preview_procedure → update_procedure → get_procedure_operation / resume_procedure_operation`。新增字段始终生成新 `id`；仅当候选原有 `guid` 键时才生成新 `guid`，省略时保持省略。正式写入要求工作区 `edit` 能力、授权文件、未过期的编辑令牌、当前源码与索引一致及调用方提供 `idempotencyKey`；响应丢失后先用该 key 查询原 operation，避免盲目重写。写入仅保存到本地 SVN working copy，**不会提交 SVN**。需要强制只读的客户端可在 `--stdio` 后加 `--read-only`，此时只发现 14 个查询工具。字段删除、移动和反射组写入仍不开放；真实工作区已通过 27 个工具的本地调用验证并受控撤销测试改动，但已安装 VSIX、Windows、AI 自主路由与故障矩阵尚未完成验收，使用写入后必须人工核对 SVN diff，不把工具响应当作平台运行结果。

配置变更会在执行前显示新增、移除和变更数量，确认后将唯一根地址写入工作区 `context/authorized-scope.json` 并检出/更新；该 JSON 仅供程序使用。
旧的逐条 `svn.scope`/`checkoutPaths` 写法仍兼容。用户名只在本地 <code>sync.yaml</code> 配置，密码只由 SVN 系统凭据存储；二者都不会进入配置清单、日志或参数。旧的 `sync-from-script`、`sync-from-bat` 命令仍兼容，另提供 `sync-from-config` 别名。移出配置的旧 working copy 不会自动删除。
`import-svn-scope` 仍保留为高级手工入口，但日常不再要求配置 `svn.scope_manifest`。

`svn init` 会全量建立索引；`svn refresh` 按更新结果增量刷新，遇到目录级新增/删除等无法安全定位的结构变化时
退回全量扫描。普通浏览、虚拟编辑、SCM 和调用查询只使用本地 working copy，不查询源码数据库。
SVN 表、视图和过程函数以根 working copy 内识别出的数据源与对象名组成索引身份，因此不同数据源允许存在同名对象；Nexus 打开对象时会携带 `workingCopyId` 和源码路径精确定位。PAGE_ID 仍在工作区内按版本去重。
AI 从 PRD/PRJ 目录启动时，先执行 runtime descriptor 的 `workspaceResolveCommand`，由 cwd 得到唯一
`workspaceKey`、provider 和 `index.ready`，不从目录名猜测。索引可用时第一次源码定位必须使用有界查询：对象名不明用
`svn find`，局部事实用 `svn facts`，表或单据写入原因用 `svn explain`，跨对象影响用 `svn context/callers`；结果直接携带
SVN 相对路径、PAGE JSON Pointer、行号、控制条件和调用者。仅在索引未初始化、明确漏项、查询证据不足或实际修改前读取对应局部源码，
不得遍历整个 checkout 或读取完整 PAGE JSON。

数据库快速排查时，Agent 从同一 runtime descriptor 执行 `databaseTargetResolveCommand`，按 cwd 解析
`workspaceKey`，再从私有 `config/database-testing.yaml` 选择目标：未明确环境时使用 `defaults.diagnosisTargetId`，明确开发库或测试库时使用 `defaults.byEnvironment.dev/test`。目标有 `connectionRef` 时调用内置 `databaseProbeCommand`、`databaseDescribeCommand`、`databaseQueryCommand`；只有 `connectionId` 时使用当前会话实际可用的 DBX。内置查询仅接受 stdin JSON 中的单条 `SELECT`，最大 100 行，校验 database/schema 与可见表，并始终回滚只读事务。密码仅保存在操作系统凭据库。首次配置从 Nexus 项目“配置资料 → 配置数据库排查”完成；“测试一下”不视为测试环境选择。功能验收、回归和交付仍使用 `full` 正式数据库测试目标。

Windows PowerShell 使用 `.\.venv\Scripts\python.exe`，其余参数不变。

数据库工作区的 `sync-all` 固定按以下顺序串行执行：

```text
源码与索引 → 表结构 → 单据类型 → 系统脚本 → 视图
```

任一步失败立即停止并写入该工作区的 `context/state.json`。只有五步全部成功且配置摘要一致时，状态才是 `SYNCED`。

SVN 工作区的 `sync-all` 只扫描本地 SVN 范围并更新索引和摘要，不执行 `svn update`；更新必须显式使用 `svn refresh`。

### 单项导出

所有导出同样通过统一入口绑定工作区：

```bash
.venv/bin/python scripts/guthon_tool.py export-schema --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-bill-type --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-system-script --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-view --home "$GUTHON_HOME" --workspace products.demo-product
```

额外筛选参数放在 `--` 后，例如：

```bash
.venv/bin/python scripts/guthon_tool.py export-view --home "$GUTHON_HOME" \
  --workspace products.demo-product -- \
  --data-source-ids 0015 --view-ids V_RM_EXAMPLE
```

### 源码修改

- DATABASE 模式继续只修改同一工作区的 `source/workcopy`，不修改 `source/readonly`；PAGE 仍只修改拆分脚本，
  不修改 `raw.json`。
- SVN 模式不生成额外代码副本。仅独立 PAGE GSS 服务组件的 Nexus 虚拟文档标签使用索引提供的中文名称；有函数名的过程函数仍使用英文函数名，源码 ID 仅用于内部定位；`Ctrl+S` 直接、最小化回写授权 checkout 中的原文件；
  每次打开都会取得独立编辑租约，同一文件的旧内容不能覆盖其他会话的新保存；不同文件的短时并发写入会在本机跨进程锁内有界排队。资源管理器仍显示原始目录；直接修改会标记为外部修改，并交给“管理本地源码变更”执行安全检查。
- 自动化已知“旧文本 → 新文本”时，直接把 `sourceType/sourceId/funId/jsonPointer` 和精确 `replacements` 交给 `svn write-batch`；CLI 会自动打开目标，不再要求预先收集 `sessionId/documentId`。需要先阅读多个对象或生成完整 `content` 时，可用一次 `svn read-batch` 取得全部正文和文档 ID；旧的显式会话写法继续兼容。工具会先预检整批、拒绝同一物理文件重复出现，写入失败时恢复已写文件，成功后一次性增量更新涉及的索引。不要编写临时 Python 直接读写 checkout 或自行循环重试锁。

  ```bash
  .venv/bin/python scripts/guthon_tool.py --home "$GUTHON_HOME" \
    --workspace products.demo-product svn -- \
    write-batch < /tmp/guthon-svn-change-plan.json
  ```

  ```json
  {
    "changes": [
      {
        "sourceType": "procedure",
        "sourceId": "demo.pkg#save",
        "funId": "save",
        "replacements": [
          {"old": "return true;", "new": "return false;", "expectedCount": 1}
        ]
      }
    ]
  }
  ```
- `var` 私有 Git 仓库明确忽略根级 `checkout/`：Git 只管理工具配置、上下文、索引资料和 DATABASE 工作区，
  SVN 源码差异、更新、放弃与提交只由 Nexus/SVN SCM 处理，禁止用 `git add -f` 把 checkout 纳入第二套版本历史。
- `rules.pull_diff_check` 缺省为 `true`，再次拉取会直接比较 readonly 与 workcopy，存在差异时保留 workcopy 并生成差异报告；设为 `false` 会直接覆盖 readonly/workcopy。
- SVN 的“管理本地源码变更”列出 Nexus 与外部产生的本地修改，支持类 Git 差异、多选/全选保存和撤销；SCM 文件行支持多选后直接“提交所选 Nexus 修改”，不增加 Git 式暂存区；跨
  working copy 时按组依次执行并产生多个 revision。“保存到谷神”是 SVN 模式核心能力，提交成功仅表示谷神草稿
  已保存，仍需在谷神平台执行最终提交。SVN 提交说明可选，SCM 顶部和分组提供“提交全部 Nexus 修改 / 更新全部远程变更”，每个
  Nexus 修改和远程变更行也提供所选文件提交/单文件更新；重叠更新产生文本冲突时，可从冲突文件行打开 VS Code 三方合并，保存物理 checkout 结果后显式标记 SVN 冲突为已解决。单文件更新只执行授权范围内的精确路径。检出/更新会在输出标签逐项显示
  每个子系统 working copy 的授权、checkout/update、状态检查和索引步骤；“谷神源码”树用 SVN 状态装饰修改文件及父目录，
  打开虚拟源码后按 SVN BASE 在行号槽、整行背景和概览标尺高亮新增、修改与删除位置。
  手动重建本地 SVN 索引同样逐阶段输出；同一工作区的相同操作进行中再次点击会直接忽略。
  每次 SVN 提交都会生成独立交付编号并保留回执历史，驾驶舱直接显示最近一次 revision 和文件数。回执仅证明 SVN 提交；谷神平台最终提交和运行结果不在 Nexus 内重复登记。
- 数据库模式不自动回写谷神平台，交付内容仍由人工复制、保存、提交和签入。

目标对象明确时，DATABASE 可通过 Bridge 拉取，SVN 可直接从 Nexus 的“谷神源码”打开；不需要先执行全量同步。目标不明确或需要影响分析时，再查询该工作区的局部索引。

## Guthon Nexus

Nexus 是随 VSIX 发布的 VS Code 扩展：

1. 安装发布包中的 VSIX，执行 `Developer: Reload Window`。
2. 打开左侧 “Guthon Nexus”，选择应用和长期保留的本地数据目录。
3. 编辑 `config/*.yaml`。
4. 展开目标 `PRD`、`PRJ`，在该节点选择“源码来源：DATABASE / SVN”；全部产品和项目始终混合显示。运行模式独立选择开发、调试或发行。
5. DATABASE 项目继续执行同步、诊断和 Workcopy；SVN 项目从“谷神源码”虚拟编辑，并在单一 SCM 项目中查看
   本地/远程变更，执行全部、所选文件或单文件范围的提交/更新、部分保存、放弃修改和文本冲突三方合并。PAGE 默认以脚本、SQL、字段的可读投影打开 VS Code 双栏 Diff，
   同时保留原始 JSON 差异入口；配置 `systems.include.mappings` 时按声明关系分组；未配置时根据系统/数据源根目录的 `$.中文名称` 和 `pages/index.md`/`procedures/index.md` 内容保守推断，证据不足的系统或数据源各自保留为独立业务组，Skill/Public 进入“公共源码”；页面目录、叶子顺序及 SCM 名称复用 `pages/index.md`，PAGE 分块按 GSS、JS、SQL、字段排列；过程函数包名称复用 `procedures/index.md`，包和包内函数分别按名称字母排序；`.gss` 使用独立 Guthon GSS 高亮与既有补全。
6. 在项目的“工作区驾驶舱”查看状态并直接进入对应操作；使用“搜索工作区完整索引”跨源码身份与事实检索，选择结果后可打开源码，或复制默认精简、按需详细的 AI 上下文。
7. 需要网页功能时从 Nexus 启动 Guthon Bridge。

维护者可切换到开发模式并选择本仓库作为源码目录；Nexus 使用仓库 `.venv` 和 `scripts/guthon_tool.py`。调试模式使用 Release 的 `GuthonCodeTool-python.pyz` 和用户选择的 64 位 Python 3.12+，选择前需准备同目录的 `GuthonCodeTool-checksums.txt`；Nexus 校验脚本、环境、自检和 ToolHost 握手。发行模式继续使用不依赖系统 Python 的 macOS/Windows 应用。三种模式共用本地数据目录。当前运行模式写入：

```text
<toolHome>/var/nexus/tool-runtime.json
```

该描述符除基础 `command`/`home` 外，还写入模式、代码来源、ToolHost 协议版本，以及 cwd 无关的 `workspaceResolveCommand`、`databaseTargetResolveCommand`、`databaseProbeCommand`、`databaseDescribeCommand`、`databaseQueryCommand` 与 `linterCommand` 数组。
Agent 不再拼装 `../../scripts` 或 `../../tools/guthon-lint`；从具体 PRD/PRJ cwd 运行 `--changed` 时，Linter 只检查当前
workspace，Git pre-commit 的 `--staged` 仍检查整个暂存集合。

## Guthon Bridge

Bridge 默认监听 `127.0.0.1:17361`，支持：

- 数据库工作区的 PAGE、过程函数、系统脚本拉取，以及表结构、单据类型和视图导出。
- SVN 工作区的旧源码拉取/数据库导出按钮自动隐藏，服务端也会拒绝旧接口；checkout、虚拟编辑、索引和 SCM
  集中在 Nexus。Bridge 本身继续保留页面身份路由和与源码拉取无关的页面能力。
- 模块页面字段复制。
- 请求级工作区自动匹配和歧义选择。

Bridge 请求携带 `workspaceKey` 时会验证页面身份；未携带时按 `pageOrigin + dataSourceId + systemId` 匹配配置。多个候选只影响当前请求，不保存默认绑定。详细说明见 [plugins/GuthonBridge/README.md](plugins/GuthonBridge/README.md)。

## 源码逻辑排查

`scripts/providers/database/run_source_diagnosis.py` 只连接显式标记为测试、启用只读排查并声明数据库白名单的数据源，通过
统一 CLI 的 `diagnose` 命令运行。每一步只执行单条绑定参数的 `SELECT`，在首个不满足条件的位置停止，报告写入
`<toolHome>/var/docs/业务排查文档/`。

模板见 `config/example/source-diagnosis.example.json`。

## 验证

```bash
.venv/bin/python scripts/guthon_tool.py self-test --home "$(mktemp -d)"
PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests
python scripts/check_ai_code_index.py

cd plugins/GuthonBridge
npm test

cd ../GuthonNexus/gushen-vscode-completion
npm test
```

发布版本由根目录 `VERSION` 统一管理，每次发布同步新增 `docs/releases/v<版本>.md`。GitHub Actions 构建 macOS/Windows 应用、Python zipapp、依赖清单、校验文件、Guthon Nexus VSIX、Chrome 扩展和 Guthon Testing Skill，并同步到 GitHub/Gitee Release。发行模式可在 Nexus 的折叠“运行模式”节点中选择更新源并手动检查应用更新；不会启动检查或定时联网，安装前会校验 SHA-256、运行 `self-test` 并保留上一版本用于回退。调试模式目前使用用户提供且校验通过的本地 Python；隔离运行环境的一键下载资产尚未交付。

Nexus 与 Bridge 各自维护一个常驻 ToolHost。普通工作区请求复用该进程；工作区列表在 Nexus 两棵树之间共享。普通 Nexus 刷新只重新读取工作区并重绘，不扫描全部 SVN working copy；“刷新 SVN 变更”和“检查 SVN 远程变更”仍是独立操作。SVN 日常 SCM 展示只执行必要的 `svn info --xml` 与 `svn status --xml`，写回和更新安全检查继续使用完整状态路径。

## 文档

- [在线文档（GitHub Pages）](https://sidwuu.github.io/GuthonCodeTool/)
- [使用手册](docs/GuthonCodeTool_使用手册.html)
- [问题解决中心（QA）](docs/GuthonCodeTool_QA.html)
- [全功能说明](docs/GuthonCodeTool_全功能说明.html)
- [配置说明](config/README.md)
- [Bridge 说明](plugins/GuthonBridge/README.md)
- [AI 代码索引](AI_CODE_INDEX.md)
