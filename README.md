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

### 1. 初始化源码索引

初始化源码索引库：

```bash
.venv/bin/python scripts/run_sync_once.py --init-only
```

首次使用时先执行初始化。

### 2. 同步源码

按当前 `sync.ACTIVE` 同步源码：

```bash
.venv/bin/python scripts/run_sync_once.py
```

仅在调用识别规则升级后，从现有只读源码重建调用索引：

```bash
.venv/bin/python scripts/run_sync_once.py --reindex-calls
```

### 3. 拉取源码并创建工作副本

从已有源码索引生成工作副本：

```bash
.venv/bin/python scripts/create_work_copy.py --product <product_id> --type procedure --alias <procedure_alias> --fun <fun_id>
.venv/bin/python scripts/create_work_copy.py --project <project_id> --type page --alias <page_alias>
```

从源码表直接拉取并生成工作副本：

```bash
.venv/bin/python scripts/pull_source_to_work_copy.py --type procedure --alias <procedure_alias> --fun <fun_id>
.venv/bin/python scripts/pull_source_to_work_copy.py --type page --source-id <page_id>
.venv/bin/python scripts/pull_source_to_work_copy.py --type page --alias <page_alias>
```

手动拉取使用 `config/sync.yaml` 的 `sync.ACTIVE`；显式传入的项目或产品必须与 ACTIVE 一致。

### 4. 检查与交付工作副本

检查工作副本、刷新差异和生成交付清单：

```bash
.venv/bin/python scripts/workcopy.py status <workcopy_path>
.venv/bin/python scripts/workcopy.py diff <workcopy_path>
.venv/bin/python scripts/workcopy.py package <workcopy_path>
```

状态包括 `CLEAN`、`LOCAL_CHANGED`、`UPSTREAM_CHANGED`、`CONFLICT` 和 `UPSTREAM_MISSING`。本地修改未被新上游包含时才进入 `CONFLICT`，手动拉取会保留工作副本并返回失败提示。

### 5. 导出平台元数据

默认输出到当前 `sync.ACTIVE` 对应的产品或项目名称目录；`--output-dir` 可显式覆盖。

导出表结构：

```bash
.venv/bin/python scripts/export_table_schema_sql.py
```

临时覆盖数据源范围：

```bash
.venv/bin/python scripts/export_table_schema_sql.py --data-source-ids 0015,0018
```

导出单据类型：

```bash
.venv/bin/python scripts/export_bill_type_sql.py
```

临时覆盖数据源范围：

```bash
.venv/bin/python scripts/export_bill_type_sql.py --data-source-ids 0015,0008
```

导出视图源码：

```bash
.venv/bin/python scripts/export_view_sql.py
```

只导出指定视图：

```bash
.venv/bin/python scripts/export_view_sql.py --data-source-ids 0015 --view-ids V_RM_EXAMPLE
```

导出系统脚本：

```bash
.venv/bin/python scripts/export_system_script_sql.py
```

临时覆盖数据源范围：

```bash
.venv/bin/python scripts/export_system_script_sql.py --data-source-ids 0015
```

只导出指定应用系统和脚本类型：

```bash
.venv/bin/python scripts/export_system_script_sql.py \
  --system-ids SYS-EXAMPLE \
  --script-types 20 \
  --workcopy
```

### 6. 同步谷神 API 文档与补全数据

从谷神开发平台保存 `app.<hash>.js` 后：

1. 将 bundle 放入 `docs/private/guthon-api/<版本>/`。
2. 在 `config/sync.yaml` 的 `guthon_api` 中配置 `active_version` 和对应的 `bundle_files` 路径。
3. 先检查，再执行同步：

```bash
node scripts/sync_guthon_api.mjs --check
node scripts/sync_guthon_api.mjs
```

同步结果无差异时，不会覆盖已有的 Markdown 和 JSON 文件。

### 7. 启动浏览器桥接服务

启动浏览器桥接服务：

```bash
cd plugins/GuthonBridge
npm run start:bridge
```

### 8. 环境诊断

只读检查配置、Python/Node、Bridge 状态和 VS Code 补全数据：

```bash
.venv/bin/python scripts/doctor.py
```

Bridge 未启动时只显示 `WARN`；配置或必要运行环境异常时返回非零退出码。使用 `--json` 可输出机器可读结果。

### 9. 恢复全量同步

手动删除当前 ACTIVE 的 `var/source/readonly` 源码后，需要先删除对应同步游标，再重新全量同步：

```bash
sqlite3 var/runtime/index/products/demo-product.db "DELETE FROM gusen_sync_state WHERE state_key='last_success_time:products.demo-product';"
.venv/bin/python scripts/run_sync_once.py
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

```bash
python3 -m unittest discover -s tests
python3 -m unittest scripts/test_workcopy.py
python3 -m py_compile \
  scripts/gusen_hub.py \
  scripts/run_sync_once.py \
  scripts/create_work_copy.py \
  scripts/pull_source_to_work_copy.py \
  scripts/workcopy.py \
  scripts/export_table_schema_sql.py \
  scripts/export_bill_type_sql.py \
  scripts/export_view_sql.py \
  scripts/export_system_script_sql.py
```

浏览器扩展和本地 bridge：

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

## 文档

- [config/README.md](config/README.md)
- [plugins/GuthonBridge/README.md](plugins/GuthonBridge/README.md)
- [var/README.md](var/README.md)
