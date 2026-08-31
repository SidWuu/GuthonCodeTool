# GuthonCodeTool

GuthonCodeTool 是谷神低代码开发平台的本地开发工具集。每个产品或项目可显式选择数据库或 SVN 源码模式，并为 AI、VS Code 和 Chrome 提供统一的多工作区路由。

根仓库只保存公开工具代码、配置模板和说明文档；私有源码、数据库元数据、索引和日志位于 `var/`，由 `var/.git` 单独管理。

## 核心能力

- 产品、项目各自拥有完整工作区，使用稳定键 `products.<id>`、`projects.<id>` 路由。
- 数据库模式把页面、过程函数和系统脚本同步到 readonly；SVN 模式按授权清单检出一个或多个精确 URL，不复制第二份 readonly/workcopy 源码。
- 每个工作区拥有独立 SQLite 轻量事实索引；除调用关系外，还记录 PAGE 片段定位、字段到表列映射、单据路由、
  表读写和条件/赋值/异常事实，不保存第二份完整源码，也不建立膨胀的源码全文倒排。
- SVN 模式由 Nexus 的“谷神源码”聚合展示源码，并为每个工作区注册一个 SCM provider；支持 PAGE 分块、过程函数、系统脚本虚拟编辑并直接回写 checkout，表和视图保持只读。
- 数据库模式一次执行源码、表结构、单据类型、系统脚本、视图五步同步。
- Guthon Nexus 同时展示并操作多个产品、项目。
- Guthon Bridge 根据 `workspaceKey` 或页面身份自动路由；存在多个候选时由 Chrome 只为当前请求选择。
- 手动拉取和全量同步只自动暂存本次新生成、未被忽略的文件，不暂存已跟踪修改或无关文件。

## 目录

```text
config/                         配置模板和配置说明
docs/                           使用手册和全功能说明
plugins/GuthonBridge/           Chrome 扩展及本地 Bridge
plugins/GuthonVSCodeExtension/  Guthon Nexus
scripts/
├── guthon_tool.py             唯一运行入口和命令编排
├── build_guthon_tool.py       独立应用构建入口
├── common/                    双模式共享的路由、索引、查询和 Workcopy 基础能力
└── providers/
    ├── database/              数据库源码、metadata 导出和只读诊断
    └── svn/                   SVN 清单、working copy、虚拟编辑和 SCM
tests/                          Python 测试
var/
├── AGENTS.md                   谷神任务路由规则
├── docs/                       公共业务与开发文档
├── tools/                      私有辅助工具
├── nexus/                      Nexus、Bridge 公共运行状态
├── checkout/<配置 ID>/         SVN 模式唯一源码事实来源
└── workspace/
    ├── PRD <产品名称>/
    └── PRJ <项目名称>/
```

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

SVN 新模式的工作区只创建 `docs` 和 `context` 等派生资料；授权清单中的多个精确 URL 检出到同一
`var/checkout/<配置 ID>/` 逻辑根下。资源管理器保留这些原始目录供查看，日常修改从“谷神源码”进入并
回写同一份文件，不再生成额外 `source/readonly` 或 `source/workcopy` 代码副本。

## 配置

复制模板后填写本机配置：

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

`mappings` 的键就是系统 alias，每项只配置一对一的 `system_id`、`data_source_id`。SVN 用它筛选范围配置（首次可由签出脚本导入）；DATABASE 仍按 alias 查询并使用本地 `system-data.json` 缓存。项目必须配置自己的数据源 ID，不能复用产品值。

产品/项目 YAML 不设置源码模式。Nexus 在每个项目节点单独选择 DATABASE/SVN，选择结果写入该工作区
`context/source-mode.json`，缺失时默认 DATABASE。`sync.yaml` 保存公共 SVN 用户名、全局同步窗口和安全规则，不包含当前或默认工作区。
完整格式见 [config/README.md](config/README.md)。

## CLI

准备配置并查看全部工作区：

```bash
.venv/bin/python scripts/guthon_tool.py setup --home .
.venv/bin/python scripts/guthon_tool.py workspaces --home .
```

工作区命令必须显式传入 `--workspace`：

```bash
.venv/bin/python scripts/guthon_tool.py sync-source-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py reindex --home . --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py export-markdown --home . --workspace products.demo-product
```

SVN 工作区要求 SVN 1.10+ 客户端。在 Nexus 的目标项目节点选择 SVN，紧凑范围配置直接写在已有的
`config/products.yaml`（项目写在 `config/projects.yaml`）对应条目的 `svn.url`/`svn.scope` 下，可手动编辑。
`svn.url` 是公共根地址；`systems`、`datasources` 会从 `systems.include.mappings` 拼接 ID。省略 `scope` 时只检出这两类映射目录。
首次没有 `svn.url` 时，也可把谷神平台下载的 `svnCheckoutHere.sh`（macOS/Linux）或 `svnCheckoutHere.bat`
（Windows）放入工程 `context/`，Nexus 只解析一次其中的 checkout 命令；脚本不会被执行。之后检出/更新以配置为准：

```bash
.venv/bin/python scripts/guthon_tool.py source-mode --home . --workspace products.demo-product -- set --mode svn
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- scope-import  # JSON stdin: {"text":"...","source":"script"}
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- scope-preview
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- sync-from-script --accept-scope-change
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- refresh
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- status --diff
.venv/bin/python scripts/guthon_tool.py reindex --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- facts --keyword 保存失败
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- explain --table T_ORDER
```

配置变更会在执行前显示新增、移除和变更数量，确认后将展开结果写入工作区 `context/authorized-scope.json` 并检出/更新；该 JSON 仅供程序使用。
旧的逐条 `svn.scope`/`checkoutPaths` 写法仍兼容。用户名只在本地 <code>sync.yaml</code> 配置，密码只由 SVN 系统凭据存储；二者都不会进入配置清单、日志或参数。旧的 `sync-from-script`、`sync-from-bat` 命令仍兼容，另提供 `sync-from-config` 别名。移出配置的旧 working copy 不会自动删除。
`import-svn-scope` 仍保留为高级手工入口，但日常不再要求配置 `svn.scope_manifest`。

`svn init` 会全量建立索引；`svn refresh` 按更新结果增量刷新，遇到目录级新增/删除等无法安全定位的结构变化时
退回全量扫描。普通浏览、虚拟编辑、SCM 和调用查询只使用本地 working copy，不查询源码数据库。
AI 排查时优先使用 <code>svn facts</code> 定位事实，使用 <code>svn explain</code> 按表或单据号返回有界写入链；结果直接携带
SVN 相对路径、PAGE JSON Pointer、行号、控制条件和调用者，只有事实不足或实际修改前才读取对应局部源码。

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
.venv/bin/python scripts/guthon_tool.py export-schema --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-bill-type --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-system-script --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py export-view --home . --workspace products.demo-product
```

额外筛选参数放在 `--` 后，例如：

```bash
.venv/bin/python scripts/guthon_tool.py export-view --home . \
  --workspace products.demo-product -- \
  --data-source-ids 0015 --view-ids V_RM_EXAMPLE
```

### 源码修改

- DATABASE 模式继续只修改同一工作区的 `source/workcopy`，不修改 `source/readonly`；PAGE 仍只修改拆分脚本，
  不修改 `raw.json`。
- SVN 模式不生成额外代码副本。Nexus 虚拟文档的 `Ctrl+S` 直接、最小化回写授权 checkout 中的原文件；
  资源管理器仍显示原始目录；直接修改会标记为外部修改，并交给“管理本地源码变更”执行安全检查。
- `var` 私有 Git 仓库明确忽略根级 `checkout/`：Git 只管理工具配置、上下文、索引资料和 DATABASE 工作区，
  SVN 源码差异、更新、放弃与提交只由 Nexus/SVN SCM 处理，禁止用 `git add -f` 把 checkout 纳入第二套版本历史。
- `rules.pull_diff_check` 缺省为 `true`，再次拉取会直接比较 readonly 与 workcopy，存在差异时保留 workcopy 并生成差异报告；设为 `false` 会直接覆盖 readonly/workcopy。
- SVN 的“管理本地源码变更”列出 Nexus 与外部产生的本地修改，支持类 Git 差异、多选/全选保存和撤销；跨
  working copy 时按组依次执行并产生多个 revision。“保存到谷神”是 SVN 模式核心能力，提交成功仅表示谷神草稿
  已保存，仍需在谷神平台执行最终提交。SVN 提交说明可选，SCM 顶部和分组提供“提交全部 Nexus 修改 / 更新全部远程变更”，每个
  Nexus 修改和远程变更行也提供单文件提交/更新；单文件更新只执行授权范围内的精确路径。检出/更新会在输出标签逐项显示
  每个子系统 working copy 的授权、checkout/update、状态检查和索引步骤；“谷神源码”树用 SVN 状态装饰修改文件及父目录，
  打开虚拟源码后按 SVN BASE 在行号槽、整行背景和概览标尺高亮新增、修改与删除位置。
  手动重建本地 SVN 索引同样逐阶段输出；同一工作区的相同操作进行中再次点击会直接忽略。
- 数据库模式不自动回写谷神平台，交付内容仍由人工复制、保存、提交和签入。

目标对象明确时，DATABASE 可通过 Bridge 拉取，SVN 可直接从 Nexus 的“谷神源码”打开；不需要先执行全量同步。目标不明确或需要影响分析时，再查询该工作区的局部索引。

## Guthon Nexus

Nexus 是随 VSIX 发布的 VS Code 扩展：

1. 安装发布包中的 VSIX，执行 `Developer: Reload Window`。
2. 打开左侧 “Guthon Nexus”，选择应用和长期保留的本地数据目录。
3. 编辑 `config/*.yaml`。
4. 展开目标 `PRD`、`PRJ`，在该节点选择“源码来源：DATABASE / SVN”；全部产品和项目始终混合显示，运行模式仍独立
   保留“发行模式 / 调试模式”。
5. DATABASE 项目继续执行同步、诊断和 Workcopy；SVN 项目从“谷神源码”虚拟编辑，并在单一 SCM 项目中查看
   本地/远程变更，执行全部或单文件提交/更新、部分保存或放弃修改。PAGE 默认以脚本、SQL、字段的可读投影打开 VS Code 双栏 Diff，
   同时保留原始 JSON 差异入口；所有子系统按过程函数数据源分组顺序排列，共用数据源时按 `systems.include.mappings` 声明顺序排列；页面与过程函数的目录、叶子顺序及 SCM 名称复用各自 `index.md`，`.gss` 使用独立 Guthon GSS 高亮与既有补全。
6. 需要网页功能时从 Nexus 启动 Guthon Bridge。

维护者可切换到调试模式并选择本仓库；Nexus 会直接调用 `.venv` 和 `scripts/guthon_tool.py`。当前运行模式写入：

```text
var/nexus/tool-runtime.json
```

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
`var/docs/业务排查文档/`。

模板见 `config/example/source-diagnosis.example.json`。

## 验证

```bash
.venv/bin/python scripts/guthon_tool.py self-test --home .
.venv/bin/python -m unittest discover -s tests

cd plugins/GuthonBridge
npm test

cd ../GuthonVSCodeExtension/gushen-vscode-completion
npm test
```

发布构建仍由现有脚本和 GitHub Actions 生成 GuthonCodeTool 应用、VSIX 与 Chrome 扩展压缩包。

## 文档

- [使用手册](docs/GuthonCodeTool_使用手册.html)
- [全功能说明](docs/GuthonCodeTool_全功能说明.html)
- [配置说明](config/README.md)
- [Bridge 说明](plugins/GuthonBridge/README.md)
- [私有目录说明](var/README.md)
