# GuthonCodeTool

GuthonCodeTool 是面向谷神低代码开发平台的本地开发工具集。它负责把平台源码、数据库结构、单据类型和页面辅助信息整理到本地，方便检索、分析和辅助开发。

根仓库只保存工具代码、配置模板和说明文档；源码、表结构、运行索引等本机私有内容放在 `var/`，并由 `var/` 自己的私有 Git 仓库管理。

## 功能

### 源码 Hub

- 从谷神源码表拉取页面和过程函数源码。
- 支持相互隔离的产品层和项目层源码。
- 支持 `sync.ACTIVE` 只处理当前产品或项目，每个 ACTIVE 使用独立 SQLite 索引库。
- 支持按子系统和数据源过滤。
- 支持已签入源码，也支持配置指定签出人的未签入源码。
- 手动源码表拉取与同步共用 `VERSION_MAC` 优先的变更判断；未变更时复用本地 readonly 镜像，变更时才重写并重新生成调用索引。

### 页面源码

- 页面按 `{子系统}/page/{模型序号}_{模型}/{模块序号}_{模块}/{页面名 页面ID}` 组织，序号补齐为三位。
- 页面原始 JSON 保存为 `raw.json`。
- 页面脚本、SQL、服务组件脚本拆到 `scripts/`。
- 项目 PAGE 后台 `script` 出现独立的 `@inherit();` 标记行时，导出源码使用同级 `superScript` 产品快照代码。
- 项目 PAGE 的 `serviceEvents`、`pageEvents` 继承标记使用对应 `superServiceEvents`、`superPageEvents` 源码替换；替换后为空时不生成脚本文件。
- 服务组件 `compScript` 即使为空，也会生成空的 `compScript.vm`。
- 手动拉取 PAGE 时只处理当前页面。目录规则变化后可使用“强制刷新”重建本地路径。

### 过程函数源码

- 过程函数按 `{子系统}/procedure/{过程别名}/{函数名}` 组织。
- 过程函数源码保存为 `source.vm`。
- 项目过程函数出现独立的 `@inherit();` 标记行时，导出源码使用配置字段映射的产品快照脚本。
- 多个子系统共用同一个数据源时，过程函数只保存一份，其余子系统目录用链接指向同一份源码。

### 工作副本

- 从 readonly 源码生成 `var/source/workcopy`。
- 工作副本保留 `.guthon-baseline`、`source-meta.json` 和自动生成的 `diff.md`。
- 再次拉取前检查本地修改和上游版本；本地修改已回写到上游时刷新基线，内容分叉时拒绝覆盖。
- `scripts/workcopy.py` 可查看状态、刷新差异并生成 `delivery.md` 交付清单。
- 工具不自动回写平台，修改结果由人工复制回谷神平台保存、提交、签入。

### 索引和知识

- 生成产品源码索引。
- 生成仅包含对应项目快照的源码索引，不混入当前产品源码。
- 生成静态调用索引。
- 记录低置信动态调用点。
- 默认只生成轻量状态入口；全量 Markdown 仅在显式运行 `scripts/export_hub_markdown.py` 时生成。AI 助手通过 SQLite 局部上下文查询定位源码和调用链。

### 数据库结构

- `scripts/export_table_schema_sql.py` 直接通过 SQL 查询 `gd_tables`、`gd_tables_field`、`gd_system`。
- 数据库连接默认读取 `sync.ACTIVE` 对应产品或项目配置的 `datasource`。
- 根据 `config/sync.yaml` 的 `systems.include.system_aliases` 查询当前库的 `gd_system`，自动解析数据源 ID。
- 输出精简后的表结构 JSON 到 `var/database/schema/{products|projects}/<名称>`。

### 单据类型

- `scripts/export_bill_type_sql.py` 直接通过 SQL 查询 `gd_bill_type`、`gd_system`。
- 数据库连接默认读取 `sync.ACTIVE` 对应产品或项目配置的 `datasource`。
- 根据同一组子系统别名自动解析数据源 ID。
- 输出精简后的单据类型 JSON 到 `var/database/billtype/{products|projects}/<名称>`。

### 视图源码

- `scripts/export_view_sql.py` 从 `gdp_tables_views.VIEW_SQL` 拉取视图管理中的当前源码。
- 数据库连接和数据源范围与表结构、单据类型一致。
- 输出 SQL 到 `var/database/views/{products|projects}/<名称>`。

### 系统脚本

- `scripts/export_system_script_sql.py` 从 `gd_system_script` 拉取系统脚本。
- 数据库连接默认读取 `sync.ACTIVE`，并按 `systems.include.system_aliases` 限定子系统。
- 项目脚本使用 `@inherit();` 或只有产品源码时导出 `PROD_SCRIPT`。
- 输出到 `var/source/readonly/{products|project}/<名称>/<子系统>/scripts/<脚本序号>-<脚本类型>[-<脚本描述>]/`。
- 标准脚本和自定义脚本均按 `SCRIPT_TYPE` 导出，空脚本保留 `meta.json` 和空源码文件。
- Bridge 在系统脚本页提供“选中拉取”和“全部拉取”悬浮按钮；选中拉取同时创建或安全刷新 workcopy，全部拉取只更新 readonly。

### 源码逻辑排查

- `scripts/run_source_diagnosis.py` 按已拉取源码整理的逻辑步骤查询独立测试库。
- 数据源必须显式标记为 `test`、启用 `diagnosis`、声明 `query_only` 并配置允许查询的数据库白名单。
- 排查定义指定默认数据库，步骤可切换到白名单中的其他数据库；每一步使用独立只读事务。
- 首个不满足源码继续条件的步骤停止，完整参数、原生 SQL、查询结果和结论写入 `var/docs/业务排查文档/`。
- 终端只返回状态、停止步骤、结论和报告路径，避免完整查询结果进入 AI 上下文。

### Guthon Bridge

仓库内包含 Chrome 扩展和本地 HTTP 桥接服务：

- 过程函数页右侧悬浮按钮可从源码表拉取当前函数并生成工作副本。
- Chrome 扩展弹窗可拉取过程函数或 PAGE 源码表版本。
- 数据表管理页可拉取当前数据源表结构。
- 单据类型页签可拉取配置数据源范围内的单据类型。
- 视图管理页可拉取当前数据源的视图源码。
- 系统脚本页可拉取当前应用系统的选中脚本或全部脚本。
- 模块开发页可打开复制模式，查看并复制页面字段结构。
- 本地 bridge 默认监听 `127.0.0.1:17361`。
- 开发平台地址从 `plugins/GuthonBridge/extension/host-config.js` 读取，支持多个 IPv4 CIDR 和域名后缀。

## 目录

```text
config/                 本地配置模板和配置说明
plugins/GuthonBridge/   Chrome 扩展和本地桥接服务
scripts/                源码、表结构、单据类型脚本
tests/                  Python 脚本测试
var/                    本地私有数据和源码仓库，根仓库忽略
```

`scripts/temp/` 存放旧工具脚本，仅作迁移参考，不作为新功能入口。

## var 目录

`var/` 是本机私有工作区，根仓库不跟踪。查看源码、表结构或运行结果差异时进入 `var/`：

```bash
cd var
git status
git diff
```

常用结构：

```text
var/source/readonly/    从源码表导出的只读镜像
var/source/workcopy/    开发工作副本
var/source/readonly/{products|project}/<名称>/<子系统>/scripts/  系统脚本
var/database/schema/{products|projects}/<名称>/    表结构 JSON
var/database/billtype/{products|projects}/<名称>/  单据类型 JSON
var/database/views/{products|projects}/<名称>/     视图 SQL
var/knowledge/          Markdown 索引
var/runtime/index/      本地 SQLite 索引库
var/runtime/logs/       拉取日志
var/diagnosis/cases/    AI 生成的临时排查定义
var/docs/业务排查文档/  源码逻辑排查报告
```

## 配置

复制模板后填写本地配置：

```bash
cp config/example/datasource.example.yaml config/datasource.yaml
cp config/example/products.example.yaml config/products.yaml
cp config/example/projects.example.yaml config/projects.yaml
cp config/example/source-tables.example.yaml config/source-tables.yaml
cp config/example/sync.example.yaml config/sync.yaml
```

关键配置：

```yaml
sync:
  ACTIVE: products.demo-product

systems:
  include:
    # 只维护别名，系统和数据源信息自动查询并缓存
    system_aliases:
      - demo.system

rules:
  allow_unchecked_check_out_user_ids:
    - U00000XXXX
  pull_auto_add_git: false
```

`allow_unchecked_check_out_user_ids` 控制哪些签出人的未签入源码允许被同步或拉取。

`pull_auto_add_git` 为 `true` 时，拉取后自动查找目标文件所在的最近 Git 仓库，并只暂存本次拉取产生的未跟踪新文件；不会暂存已有文件的修改，也不会强制添加被 `.gitignore` 忽略的文件。
视图源码和系统脚本拉取同样遵循此规则：视图只暂存本次生成的新 SQL，系统脚本会分别暂存新生成的 readonly 与 workcopy 文件。

`ACTIVE` 同时决定源码同步范围、SQLite 索引库，以及表结构、单据类型默认连接的产品库或项目库。索引库位于 `sync.index_dir/{products|projects}/<id>.db`，源码查询和工作副本读取只使用当前 ACTIVE 的索引。工具按 datasource 分别查询一次 `gd_system`，结果自动缓存到 `config/system-data.json`；别名变化或缓存中没有当前 datasource 时会重新查询。

## 使用

切换 `sync.ACTIVE` 后，一键依次完成源码拉取与索引、数据库表结构、单据类型、系统脚本和视图同步：

macOS / Linux：

```bash
.venv/bin/python scripts/sync_active_all.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\sync_active_all.py
```

任一步失败时脚本立即停止；执行期间如果 `sync.ACTIVE` 发生变化，也会停止后续步骤。

### 1. 初始化源码索引

初始化源码索引库：

macOS / Linux：

```bash
.venv/bin/python scripts/run_sync_once.py --init-only
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\run_sync_once.py --init-only
```

首次使用时先执行初始化。

### 2. 同步源码

按当前 `sync.ACTIVE` 同步源码：

macOS / Linux：

```bash
.venv/bin/python scripts/run_sync_once.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\run_sync_once.py
```

仅在调用识别规则升级后，从现有只读源码重建调用索引：

macOS / Linux：

```bash
.venv/bin/python scripts/run_sync_once.py --reindex-calls
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\run_sync_once.py --reindex-calls
```

### 3. 拉取源码并创建工作副本

从已有源码索引生成工作副本：

macOS / Linux：

```bash
.venv/bin/python scripts/create_work_copy.py --product <product_id> --type procedure --alias <procedure_alias> --fun <fun_id>
.venv/bin/python scripts/create_work_copy.py --project <project_id> --type page --alias <page_alias>
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\create_work_copy.py --product <product_id> --type procedure --alias <procedure_alias> --fun <fun_id>
.\.venv\Scripts\python.exe scripts\create_work_copy.py --project <project_id> --type page --alias <page_alias>
```

从源码表直接拉取并生成工作副本：

macOS / Linux：

```bash
.venv/bin/python scripts/pull_source_to_work_copy.py --type procedure --alias <procedure_alias> --fun <fun_id>
.venv/bin/python scripts/pull_source_to_work_copy.py --type page --source-id <page_id>
.venv/bin/python scripts/pull_source_to_work_copy.py --type page --alias <page_alias>
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\pull_source_to_work_copy.py --type procedure --alias <procedure_alias> --fun <fun_id>
.\.venv\Scripts\python.exe scripts\pull_source_to_work_copy.py --type page --source-id <page_id>
.\.venv\Scripts\python.exe scripts\pull_source_to_work_copy.py --type page --alias <page_alias>
```

手动拉取使用 `config/sync.yaml` 的 `sync.ACTIVE`；显式传入的项目或产品必须与 ACTIVE 一致。

### 4. 检查与交付工作副本

检查工作副本、刷新差异和生成交付清单：

macOS / Linux：

```bash
.venv/bin/python scripts/workcopy.py status <workcopy_path>
.venv/bin/python scripts/workcopy.py diff <workcopy_path>
.venv/bin/python scripts/workcopy.py package <workcopy_path>
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\workcopy.py status <workcopy_path>
.\.venv\Scripts\python.exe scripts\workcopy.py diff <workcopy_path>
.\.venv\Scripts\python.exe scripts\workcopy.py package <workcopy_path>
```

状态包括 `CLEAN`、`LOCAL_CHANGED`、`UPSTREAM_CHANGED`、`CONFLICT` 和 `UPSTREAM_MISSING`。本地修改未被新上游包含时才进入 `CONFLICT`，手动拉取会保留工作副本并返回失败提示。

### 执行源码逻辑排查

日常使用时直接向 AI 提供“问题、排查参数、测试数据库”，不需要手工编写 JSON 或执行命令。例如：

```text
排查现货购销事件没有处理的问题。
参数：合同批号 CGHT2607230040001。
默认查询 yshj_fxglx；基础资料需要时查询 yshj_basic。
```

AI 按以下流程处理：

1. 根据源码索引定位目标对象和调用链，核对 readonly/workcopy、表结构和业务文档。
2. 按源码执行顺序生成临时排查定义到 `var/diagnosis/cases/`。
3. 使用 `gdrm-product-test` 查询指定数据库；每一步只执行单条 `SELECT` 和独立只读事务。
4. 在首个不满足源码继续条件的步骤停止。
5. 将排查参数、源码逻辑、原生 SQL、查询结果、停止位置和结论写入 `var/docs/业务排查文档/<日期>/`。

`config/example/source-diagnosis.example.json` 是排查定义的格式示例，供 AI、脚本测试和无 AI 时的手工备用方式使用，不是日常需要维护的业务文件。

需要脱离 AI 手工执行时，再复制模板并填写排查步骤：

macOS / Linux：

```bash
cp config/example/source-diagnosis.example.json var/diagnosis/cases/<排查名称>.json
.venv/bin/python scripts/run_source_diagnosis.py var/diagnosis/cases/<排查名称>.json
```

Windows PowerShell：

```powershell
Copy-Item config\example\source-diagnosis.example.json var\diagnosis\cases\<排查名称>.json
.\.venv\Scripts\python.exe scripts\run_source_diagnosis.py var\diagnosis\cases\<排查名称>.json
```

排查定义显式指定独立测试数据源和默认数据库，不跟随 `sync.ACTIVE`；单个步骤可以覆盖到同一数据源白名单中的其他数据库。详细格式见 `config/README.md`。

### 5. 导出平台元数据

默认输出到当前 `sync.ACTIVE` 对应的产品或项目名称目录；`--output-dir` 可显式覆盖。

导出表结构：

macOS / Linux：

```bash
.venv/bin/python scripts/export_table_schema_sql.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_table_schema_sql.py
```

表结构默认只导出当前 `sync.ACTIVE` 对应数据源中、被 `config/sync.yaml` 的 `systems.include.system_aliases` 命中的系统。它不会默认导出所有平台数据源；例如只配置 `com.golden.bdp.gdrm` 时，只会导出风险管理数据源。要扩大默认范围，先在 `sync.yaml` 增加所需系统别名并重新执行导出；运行结果中的 `dataSourceIds` 是本次实际导出的数据源范围。

临时覆盖数据源范围：

macOS / Linux：

```bash
.venv/bin/python scripts/export_table_schema_sql.py --data-source-ids 0015,0018
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_table_schema_sql.py --data-source-ids 0015,0018
```

导出单据类型：

macOS / Linux：

```bash
.venv/bin/python scripts/export_bill_type_sql.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_bill_type_sql.py
```

临时覆盖数据源范围：

macOS / Linux：

```bash
.venv/bin/python scripts/export_bill_type_sql.py --data-source-ids 0015,0008
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_bill_type_sql.py --data-source-ids 0015,0008
```

导出视图源码：

macOS / Linux：

```bash
.venv/bin/python scripts/export_view_sql.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_view_sql.py
```

只导出指定视图：

macOS / Linux：

```bash
.venv/bin/python scripts/export_view_sql.py --data-source-ids 0015 --view-ids V_RM_EXAMPLE
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_view_sql.py --data-source-ids 0015 --view-ids V_RM_EXAMPLE
```

导出系统脚本：

macOS / Linux：

```bash
.venv/bin/python scripts/export_system_script_sql.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_system_script_sql.py
```

临时覆盖数据源范围：

macOS / Linux：

```bash
.venv/bin/python scripts/export_system_script_sql.py --data-source-ids 0015
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_system_script_sql.py --data-source-ids 0015
```

只导出指定应用系统和脚本类型：

macOS / Linux：

```bash
.venv/bin/python scripts/export_system_script_sql.py \
  --system-ids SYS-EXAMPLE \
  --script-types 20 \
  --workcopy
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\export_system_script_sql.py `
  --system-ids SYS-EXAMPLE `
  --script-types 20 `
  --workcopy
```

### 6. 同步谷神 API 文档与补全数据

从谷神开发平台保存 `app.<hash>.js` 后：

1. 将 bundle 放入 `docs/private/guthon-api/<版本>/`。
2. 在 `config/sync.yaml` 的 `guthon_api` 中配置 `active_version` 和对应的 `bundle_files` 路径。
3. 先检查，再执行同步：

macOS / Linux：

```bash
node scripts/sync_guthon_api.mjs --check
node scripts/sync_guthon_api.mjs
```

Windows PowerShell：

```powershell
node scripts\sync_guthon_api.mjs --check
node scripts\sync_guthon_api.mjs
```

同步结果无差异时，不会覆盖已有的 Markdown 和 JSON 文件。

### 6.1 Guthon Nexus

Guthon Nexus 提供谷神方言补全、API 悬浮说明、过程函数跳转，以及左侧活动栏的同名工具面板。面板可初始化或切换工作区、同步源码、导出表结构/单据类型/系统脚本/视图、执行排查和检查或打包 Workcopy。

同事日常使用只需从最新 GitHub Release 下载 VSIX、本机系统对应的 `GuthonCodeTool` 应用和 Bridge 浏览器插件，无需安装 Python 或克隆本仓库。首次使用：

1. 在 VS Code 通过 **Install from VSIX...** 安装发布包中的 VSIX，并执行 `Developer: Reload Window`。
2. 点击左侧活动栏“Guthon Nexus”图标，选择“初始化工作区”。依次选择下载的 `GuthonCodeTool` 应用和一个长期保留的本地数据目录，例如 `D:\GuthonCodeToolData` 或 `~/Documents/GuthonCodeToolData`。
   已初始化时再次点击“初始化工作区”，确认“切换工作区”后选择新的本地数据目录；取消确认或目录选择时继续保留原工作区。
3. 工具准备 `config/`，后续初始化和同步会在同一数据目录下按需生成 `var/`。同步源码在 `var/source/readonly/`，开发工作副本在 `var/source/workcopy/`，索引与运行数据写入 `var/knowledge/`、`var/runtime/`。
4. 在“工作区 → 配置文件”直接编辑 `datasource.yaml`、`products.yaml`、`projects.yaml`、`source-tables.yaml` 和 `sync.yaml`，填写本地数据源与 `sync.ACTIVE` 后再开始同步。
5. 需要网页 Bridge 功能时，在同一面板单击“启动 Guthon Bridge”。Nexus 自动传入当前应用和数据目录，不需要安装 Node.js、设置环境变量或打开终端。

同步、导出、排查、Workcopy 等会改动本地数据的操作，均会在单击后要求确认；配置文件、打开本地数据目录和刷新面板仍可单击直接执行。

Release 不包含个人配置、已拉取源码、数据库导出、索引、运行日志或 AI 规范；这些内容继续由同事在本地数据目录单独维护。

### 6.2 自动发布 Release

工具脚本、配置模板、VS Code 扩展或 Bridge 插件的改动合并到 `main` 后，GitHub Actions 自动创建版本号为 `v0.1.<运行序号>` 的 Release，并上传且仅上传：

- `GuthonCodeTool-windows-x64.exe`
- `GuthonCodeTool-macos-arm64.zip`
- `GuthonCodeTool-vscode.vsix`（Guthon Nexus）
- `GuthonCodeTool-chrome.zip`（Guthon Bridge 浏览器扩展）

也可以在 GitHub 的 **Actions → Build Release → Run workflow** 手动重发一个新版本。`dist/` 仍是本地构建产物目录，不提交 Git。

### 7. 启动浏览器桥接服务

在 Guthon Nexus 左侧面板单击“启动 Guthon Bridge”，状态变为“运行中 · 127.0.0.1:17361”后即可使用 Chrome 扩展。再次单击可停止服务；运行中切换工作区时会自动使用新目录重启。

Bridge 服务随 VSIX 提供，并由 Guthon Nexus 使用 VS Code 自带的 Node 运行时启动。普通用户不需要单独安装 Node.js，也不要同时在终端执行旧的 `npm run start:bridge` 命令。若输出出现 `EADDRINUSE 127.0.0.1:17361`，表示旧 Bridge 仍在占用端口；关闭对应终端服务后，再从 Nexus 启动。

### 8. 环境诊断

只读检查配置、应用运行环境、Bridge 状态和 VS Code 补全数据：

macOS / Linux：

```bash
.venv/bin/python scripts/doctor.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe scripts\doctor.py
```

Bridge 未启动时只显示 `WARN`；配置或必要运行环境异常时返回非零退出码。使用 `--json` 可输出机器可读结果。

### 9. 恢复全量同步

手动删除当前 ACTIVE 的 `var/source/readonly` 源码后，需要先删除对应同步游标，再重新全量同步：

macOS / Linux：

```bash
sqlite3 var/runtime/index/products/demo-product.db "DELETE FROM gusen_sync_state WHERE state_key='last_success_time:products.demo-product';"
.venv/bin/python scripts/run_sync_once.py
```

Windows PowerShell：

```powershell
sqlite3 var\runtime\index\products\demo-product.db "DELETE FROM gusen_sync_state WHERE state_key='last_success_time:products.demo-product';"
.\.venv\Scripts\python.exe scripts\run_sync_once.py
```

切换 ACTIVE 后，索引路径和 `last_success_time:<ACTIVE>` 必须同时改为对应产品或项目。

## 输出格式

页面源码目录常见文件：

```text
meta.json
raw.json
scripts/*.js
scripts/*.sql
scripts/*.vm
```

过程函数目录常见文件：

```text
meta.json
source.vm
```

表结构 JSON 保留常用字段：

```text
tableId, tableName, dataSourceId, systemName, systemAliasId,
cacheType, cacheKey, cacheDataField, fields
```

字段 JSON 保留常用字段：

```text
fieldId, fieldName, dataType, dataLength, dataPrecision,
isPrimary, isCanNull, isIncrement, defaultValue, fieldRemark,
dataAuthField, isCipher, orderNo
```

单据类型 JSON 保留常用字段：

```text
billTypeCode, billTypeName, tableId, tablePkids, status,
billCodeMode, billCodeMark, billSeqLength, startCode, stepNum,
billDateType, billCheck, billCheckMode, billCheckPrint, billClose,
billPrintNum, isProduct, billTypeRemark, fields
```

空值字段会被省略。

## 拉取日志

定时同步、命令行拉取和浏览器手动拉取会追加记录到：

```text
var/runtime/logs/pull-log.ndjson
```

每行是一条 JSON，常用字段：

```text
time, trigger, pullType, ok, summary, payload, result, message
```

`pullType` 取值：

```text
source, database, billtype, views, system-scripts
```

日志只记录拉取类型、时间、参数和数量/路径等摘要，不记录源码正文、表字段明细或本地连接密码。

## 验证

Python 脚本：

macOS / Linux：

```bash
.venv/bin/python -m unittest discover -s tests
.venv/bin/python -m py_compile \
  scripts/gusen_hub.py \
  scripts/run_sync_once.py \
  scripts/sync_active_all.py \
  scripts/create_work_copy.py \
  scripts/pull_source_to_work_copy.py \
  scripts/workcopy.py \
  scripts/export_table_schema_sql.py \
  scripts/export_bill_type_sql.py \
  scripts/export_view_sql.py \
  scripts/export_system_script_sql.py
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests
.\.venv\Scripts\python.exe -m py_compile `
  scripts\gusen_hub.py `
  scripts\run_sync_once.py `
  scripts\sync_active_all.py `
  scripts\create_work_copy.py `
  scripts\pull_source_to_work_copy.py `
  scripts\workcopy.py `
  scripts\export_table_schema_sql.py `
  scripts\export_bill_type_sql.py `
  scripts\export_view_sql.py `
  scripts\export_system_script_sql.py
```

浏览器扩展和本地 bridge：

macOS / Linux：

```bash
cd plugins/GuthonBridge
npm test
node --check bridge/server.js
node --check extension/host-config.js
node --check extension/content.js
node --check extension/page-bridge.js
node --check extension/popup.js
node --check extension/background.js
```

Windows PowerShell：

```powershell
Set-Location plugins\GuthonBridge
npm test
node --check bridge\server.js
node --check extension\host-config.js
node --check extension\content.js
node --check extension\page-bridge.js
node --check extension\popup.js
node --check extension\background.js
```

## 文档

- [config/README.md](config/README.md)
- [plugins/GuthonBridge/README.md](plugins/GuthonBridge/README.md)
- [var/README.md](var/README.md)
