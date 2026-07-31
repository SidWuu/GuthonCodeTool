# GuthonCodeTool

GuthonCodeTool 是谷神低代码开发平台的本地开发工具集，用于同步源码、数据库结构、单据类型、视图和系统脚本，并为 AI、VS Code 和 Chrome 提供统一的多工作区路由。

根仓库只保存公开工具代码、配置模板和说明文档；私有源码、数据库元数据、索引和日志位于 `var/`，由 `var/.git` 单独管理。

## 核心能力

- 产品、项目各自拥有完整工作区，使用稳定键 `products.<id>`、`projects.<id>` 路由。
- 页面、过程函数和系统脚本同步到 readonly；需要修改时才创建 workcopy。
- 每个工作区拥有独立 SQLite 源码与调用索引。
- 一次执行源码、表结构、单据类型、系统脚本、视图五步同步。
- Guthon Nexus 同时展示并操作多个产品、项目。
- Guthon Bridge 根据 `workspaceKey` 或页面身份自动路由；存在多个候选时由 Chrome 只为当前请求选择。
- 手动拉取和全量同步只自动暂存本次新生成、未被忽略的文件，不暂存已跟踪修改或无关文件。

## 目录

```text
config/                         配置模板和配置说明
docs/                           使用手册和全功能说明
plugins/GuthonBridge/           Chrome 扩展及本地 Bridge
plugins/GuthonVSCodeExtension/  Guthon Nexus
scripts/                        CLI、同步与导出脚本
tests/                          Python 测试
var/
├── AGENTS.md                   谷神任务路由规则
├── docs/                       公共业务与开发文档
├── tools/                      私有辅助工具
├── nexus/                      Nexus、Bridge 公共运行状态
└── workspace/
    ├── PRD <产品名称>/
    └── PRJ <项目名称>/
```

单个产品或项目工作区：

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
        system_aliases:
          - demo.system
    page_origins: []
```

`sync.yaml` 只保存全局同步窗口和安全规则，不包含当前或默认工作区。完整格式见 [config/README.md](config/README.md)。

## CLI

准备配置并查看全部工作区：

```bash
.venv/bin/python scripts/guthon_tool.py setup --home .
.venv/bin/python scripts/guthon_tool.py workspaces --home .
```

工作区命令必须显式传入 `--workspace`：

```bash
.venv/bin/python scripts/guthon_tool.py init --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py reindex --home . --workspace projects.demo-project
```

也可以使用完整同步包装脚本：

```bash
.venv/bin/python scripts/sync_workspace_all.py --workspace projects.demo-project
```

Windows PowerShell 使用 `.\.venv\Scripts\python.exe`，其余参数不变。

`sync-all` 固定按以下顺序串行执行：

```text
源码与索引 → 表结构 → 单据类型 → 系统脚本 → 视图
```

任一步失败立即停止并写入该工作区的 `context/state.json`。只有五步全部成功且配置摘要一致时，状态才是 `SYNCED`。

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

### 工作副本

- `source/readonly` 是上游镜像，禁止人工修改。
- 所有源码改动只进入同一工作区的 `source/workcopy`。
- 页面源码只修改拆分脚本，不修改 `raw.json`。
- 再次拉取会比较本地修改与上游版本；出现分叉时拒绝覆盖。
- 工具不自动回写谷神平台，交付内容仍由人工复制、保存、提交和签入。

目标对象明确时直接通过 Bridge 或 Nexus 拉取，不需要先执行全量同步。目标不明确或需要影响分析时，再查询该工作区的局部索引。

## Guthon Nexus

Nexus 是随 VSIX 发布的 VS Code 扩展：

1. 安装发布包中的 VSIX，执行 `Developer: Reload Window`。
2. 打开左侧 “Guthon Nexus”，选择应用和长期保留的本地数据目录。
3. 编辑 `config/*.yaml`。
4. 在“项目”树中选择具体 `PRD` 或 `PRJ` 节点执行同步、打开目录、查询或 Workcopy 操作。
5. 需要网页功能时从 Nexus 启动 Guthon Bridge。

维护者可切换到调试模式并选择本仓库；Nexus 会直接调用 `.venv` 和 `scripts/guthon_tool.py`。当前运行模式写入：

```text
var/nexus/tool-runtime.json
```

## Guthon Bridge

Bridge 默认监听 `127.0.0.1:17361`，支持：

- PAGE、过程函数和系统脚本拉取。
- 数据表结构、单据类型和视图导出。
- 模块页面字段复制。
- 请求级工作区自动匹配和歧义选择。

Bridge 请求携带 `workspaceKey` 时会验证页面身份；未携带时按 `pageOrigin + dataSourceId + systemId` 匹配配置。多个候选只影响当前请求，不保存默认绑定。详细说明见 [plugins/GuthonBridge/README.md](plugins/GuthonBridge/README.md)。

## 源码逻辑排查

`scripts/run_source_diagnosis.py` 只连接显式标记为测试、启用只读排查并声明数据库白名单的数据源。每一步只执行单条绑定参数的 `SELECT`，在首个不满足条件的位置停止，报告写入 `var/docs/业务排查文档/`。

模板见 `config/example/source-diagnosis.example.json`。

## 验证

```bash
python3 scripts/test_workspace_routing.py
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
