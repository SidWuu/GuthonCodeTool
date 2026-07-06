# GuthonCodeTool

GuthonCodeTool 是面向谷神低码开发平台的本地开发工具集。

它的目标是把平台中的源码、页面结构和调用关系整理到本地，方便检索、分析和辅助开发。仓库只保存工具代码、配置模板和说明文档，不保存业务源码、数据库凭据或本地运行数据。

## 功能

### 源码同步

- 从谷神开发平台数据库只读同步已签入源码。
- 支持产品层源码和项目层源码。
- 支持按当前开发对象同步，避免每次拉取全部产品和项目。
- 支持按子系统过滤页面和过程函数。
- 支持增量同步和全量同步。

### 本地源码组织

- 页面按子系统、模块、页面名称组织目录。
- 过程函数按子系统、过程别名、函数名组织目录。
- 多个子系统共用同一个数据源时，过程函数只保存一份，其余子系统目录通过链接指向同一份源码。
- 空源码会保留元数据，不生成空脚本文件。

### 脚本拆分

- 页面原始 JSON 会保留。
- 页面中的前端脚本、后端脚本和 SQL 会拆分为独立文件。
- 服务组件脚本会拆分为可直接阅读的脚本文件。
- 过程函数会保存为独立脚本文件。

### 索引生成

- 生成产品源码索引。
- 生成项目 effective 源码索引。
- 生成静态调用索引。
- 记录低置信动态调用点，供人工继续判断。
- 索引用 Markdown 输出，方便 Codex 和人工阅读。

### Effective 源码视图

- 项目源码优先于产品源码。
- 项目没有覆盖时使用产品源码兜底。
- 生成项目最终生效源码目录，方便按项目维度分析。

### 工作副本

- 可从产品源码生成工作副本。
- 可从项目 effective 源码生成工作副本。
- 也支持手动复制源码或通过浏览器扩展拉取到工作副本目录。
- 工具不自动回写平台，修改结果由人工复制回谷神平台保存、提交、签入。

### Guthon Bridge

仓库内包含一个 Chrome 扩展和本地 HTTP 桥接服务：

- 在谷神过程函数页面通过 `源码拉取` 按钮从源码表拉取并生成工作副本。
- 可选调用 Hub，从源码表拉取已存入源码并生成 `var/source/workcopy`。
- 在模块开发页面打开复制模式，查看并复制页面字段结构。

## 目录

```text
config/                 本地配置模板和配置说明
plugins/GuthonBridge/   Chrome 扩展和本地桥接服务
scripts/                源码同步、索引和工作副本脚本
tests/                  同步工具测试
var/                    本地生成物，不提交
开发文档.md              源码 Hub 当前实现口径
```

## 本地生成物

运行后会生成：

```text
var/source/readonly/    已签入源码只读镜像
var/source/effective/   项目最终生效源码
var/knowledge/          Markdown 索引
var/source/workcopy/    临时修改副本
var/runtime/index/      本地 SQLite 索引库
```

这些目录只用于本机开发，不提交到仓库。

## 配置

配置模板位于：

```text
config/example/
```

需要本地复制并填写：

```text
config/datasource.yaml
config/products.yaml
config/projects.yaml
config/source-tables.yaml
config/sync.yaml
config/systems.yaml
config/system-data.json
```

本地配置和系统数据默认不提交。

## 使用方式

初始化索引库：

```bash
.venv/bin/python scripts/run_sync_once.py --init-only
```

按当前配置同步：

```bash
.venv/bin/python scripts/run_sync_once.py
```

生成工作副本：

```bash
.venv/bin/python scripts/create_work_copy.py --product <product_id> --type <source_type> --alias <alias> --fun <fun_id>
```

```bash
.venv/bin/python scripts/create_work_copy.py --project <project_id> --type <source_type> --alias <alias> --fun <fun_id>
```

从源码表拉取单个对象并生成工作副本：

```bash
.venv/bin/python scripts/pull_source_to_work_copy.py --type procedure --alias <procedure_alias> --fun <fun_id>
```

```bash
.venv/bin/python scripts/pull_source_to_work_copy.py --type page --source-id <page_id>
```

未显式传 `--project-id` 或 `--product-id` 时，使用 `config/sync.yaml` 的 `sync.ACTIVE`。工作副本会按源码目录结构写入 `var/source/workcopy/{产品或项目}/{子系统}/...`。

启动浏览器桥接服务：

```bash
cd plugins/GuthonBridge
npm run start:bridge
```

## 验证

同步工具：

```bash
.venv/bin/python -m unittest discover -s tests
.venv/bin/python -m py_compile scripts/gusen_hub.py scripts/run_sync_once.py scripts/create_work_copy.py scripts/pull_source_to_work_copy.py
```

浏览器扩展和本地 bridge：

```bash
cd plugins/GuthonBridge
npm test
node --check bridge/server.js
node --check extension/content.js
node --check extension/page-bridge.js
node --check extension/popup.js
node --check extension/background.js
```

## 文档

- [config/README.md](config/README.md)
- [plugins/GuthonBridge/README.md](plugins/GuthonBridge/README.md)
- [开发文档.md](开发文档.md)
