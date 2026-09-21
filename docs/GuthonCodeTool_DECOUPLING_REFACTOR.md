# GuthonCodeTool 与 var/config 解耦改造任务书

> 用途：将本文件直接交给 Codex，在 **GuthonCodeTool 源码仓库根目录**执行。
>
> 要求：不要只给方案。先检查当前仓库实际状态，在满足安全约束的前提下直接修改代码、文档和测试并完成验证。
>
> 本任务的首要目标不是“大重构”，而是以最小风险实现 **工具源码 / 本机运行数据 / 谷神业务工作区** 的物理解耦，并减少后续 AI 开发 GuthonCodeTool 时的仓库扫描、上下文污染和 token 消耗。

---

## 1. 背景

当前 GuthonCodeTool 源码仓库中同时存在：

- 工具源码：`scripts/`、`plugins/`、`skills/`、`docs/`、`tests/`；
- 本机运行配置：`config/datasource.yaml`、`products.yaml`、`projects.yaml` 等；
- 私有业务工作区：`var/`；
- `var/workspace`、`var/checkout` 中可能包含大量谷神业务源码、索引、文档和 SVN working copy。

这使 Codex / ZCode 在维护 GuthonCodeTool 本身时容易扫描到大量业务文件，造成：

- 上下文体积过大；
- token 消耗明显增加；
- 搜索和定位变慢；
- AI 容易混淆“工具源码”和“业务源码”；
- 工具仓库与私有数据的边界不够清晰。

当前源码已经存在较好的运行时解耦基础：

- CLI 公开入口 `scripts/guthon_tool.py` 强制使用 `--home`；
- `GUTHON_HOME` 用于运行期定位 `config/` 和 `var/`；
- Guthon Nexus 已同时存在：
  - `gushenCompletion.developmentRoot`
  - `gushenCompletion.toolHome`
- `plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js`
  已明确把源码入口与数据 home 分开；
- `tool-runtime.test.js` 已存在 `/repo` + `/data` 分离测试。

因此本次改造应优先复用已有契约，而不是重新设计一套运行时。

---

## 2. 最终目标目录

改造后建议形成：

```text
<BASE>/
├── GuthonCodeTool/                  # 独立 Git：工具源码
│   ├── AGENTS.md
│   ├── AI_CODE_INDEX.md
│   ├── README.md
│   ├── VERSION
│   ├── scripts/
│   ├── plugins/
│   ├── skills/
│   ├── docs/
│   ├── tests/
│   └── config/
│       ├── README.md
│       ├── example/                 # 可发布模板
│       └── schema/                  # 可发布 schema
│
├── config/                          # 本机真实运行配置
│   ├── datasource.yaml
│   ├── database-testing.yaml
│   ├── products.yaml
│   ├── projects.yaml
│   ├── source-tables.yaml
│   ├── sync.yaml
│   └── system-data.json
│
└── var/                             # 独立 Git / 私有业务数据
    ├── .git/
    ├── AGENTS.md
    ├── tools/
    ├── docs/
    ├── nexus/
    ├── checkout/
    └── workspace/
```

关键定义：

```text
sourceRoot / developmentRoot
= <BASE>/GuthonCodeTool

toolHome / GUTHON_HOME
= <BASE>

runtimeConfig
= <BASE>/config

runtimeVar
= <BASE>/var
```

特别注意：

```text
toolHome != var
```

正确关系始终是：

```text
<toolHome>/
├── config/
└── var/
```

---

## 3. 非目标

本任务不要顺带进行以下重构：

- 不重写 Guthon Nexus 架构；
- 不重写 workspaceKey 路由；
- 不改变 DATABASE / SVN 双 provider 业务语义；
- 不改变 Workcopy 语义；
- 不改变 Bridge 协议；
- 不改变 runtime descriptor 的核心结构；
- 不修改真实业务源码内容；
- 不把 `var` 合并回 GuthonCodeTool Git；
- 不建立 `GuthonCodeTool/var -> ../var` 软链接；
- 不为了“统一路径”重新引入源码仓库相对路径推断；
- 不自动执行 git add / commit / push / merge / reset。

优先做最小充分改造。

---

# 4. 必须保持的核心契约

## 4.1 CLI

继续保持：

```bash
python scripts/guthon_tool.py <command> --home <toolHome>
```

公开 CLI 不允许依赖当前 cwd 猜测运行数据位置。

`--home` 的定义统一为：

> 保存真实 `config/` 和私有 `var/` 的共同父目录。

例如：

```bash
python scripts/guthon_tool.py workspaces \
  --home /Users/example/Guthon
```

对应：

```text
/Users/example/Guthon/config
/Users/example/Guthon/var
```

---

## 4.2 Nexus development 模式

保持并强化：

```json
{
  "gushenCompletion.executionMode": "development",
  "gushenCompletion.developmentRoot": "/.../Guthon/GuthonCodeTool",
  "gushenCompletion.toolHome": "/.../Guthon"
}
```

其中：

- `developmentRoot` 只负责寻找源码仓库的：
  - `.venv`
  - `scripts/guthon_tool.py`
- `toolHome` 只负责：
  - `config`
  - `var`
  - runtime descriptor
  - linter
  - workspace / checkout / index

不得重新把两者耦合。

---

## 4.3 packaged 模式

发行版仍允许应用安装在任意目录。

应用路径与数据目录必须完全独立：

```text
applicationPath != toolHome
```

升级/替换应用不能删除或迁移 `toolHome/config`、`toolHome/var`。

---

# 5. 第一阶段：检查当前实际仓库

修改前先完成定向检查，不要全量读取 `var/workspace`、`var/checkout` 的正文。

至少确认：

```bash
pwd
git status --short
git rev-parse --show-toplevel

find . -maxdepth 2 -type d | sort
```

确认：

1. 当前目录确实是 GuthonCodeTool 工具源码根；
2. `var/` 是否存在；
3. `var/.git` 是否存在；
4. 真实运行配置是否仍位于源码仓库 `config/*.yaml`；
5. Guthon Nexus 当前真实目录是否为：

```text
plugins/GuthonNexus/gushen-vscode-completion
```

6. 是否仍有旧路径：

```text
plugins/GuthonVSCodeExtension
```

只检查路径和必要文本，不递归扫描大型业务源码正文。

推荐：

```bash
rg -n \
  "GuthonVSCodeExtension|repoRoot.*var|var/docs|GUTHON_HOME|GUTHON_TOOL_HOME|toolHome|developmentRoot" \
  AGENTS.md README.md scripts plugins config docs \
  --glob '!docs/private/**'
```

---

# 6. 第二阶段：明确源码根与运行数据根

## 6.1 Python 运行期

重点检查：

```text
scripts/guthon_tool.py
scripts/common/gusen_hub.py
scripts/common/workspace_config.py
scripts/providers/**
```

当前核心设计可以保留：

```python
GUTHON_HOME -> <toolHome>
CONFIG_DIR = <toolHome>/config
VAR_DIR = <toolHome>/var
```

不要为了本次改造进行大面积无收益变量重命名。

但需要保证：

- 所有 **用户可见入口** 最终都通过显式 `--home` 或明确 runtime descriptor 获得 `toolHome`；
- 不新增任何：
  - `SOURCE_ROOT / "var"`
  - `repoRoot / "var"`
  - `Path(__file__)... / "var"`
  的运行时数据访问；
- 源码仓库目录只能用于读取：
  - Python/JS 程序代码；
  - `config/example`;
  - `config/schema`;
  - `VERSION`;
  - 发行资源。

允许内部模块为单元测试保留当前受控行为，但正式 CLI 与 Nexus/Bridge 路径不得靠源码位置猜数据目录。

---

# 7. 第三阶段：修复当前已发现的硬编码

## 7.1 `scripts/sync_guthon_api.mjs`

当前源码存在类似：

```js
const repoRoot = ...
const apiDir = path.join(repoRoot, 'var', 'docs', '谷神方言API');
const syncConfigPath = path.join(repoRoot, 'config', 'sync.yaml');
```

这是本次必须解耦的重点。

调整为明确区分：

```text
repoRoot
= GuthonCodeTool 源码根

toolHome
= 真实运行数据根
```

推荐支持：

```bash
node scripts/sync_guthon_api.mjs \
  --home /path/to/toolHome
```

并兼容环境变量：

```text
GUTHON_TOOL_HOME
GUTHON_HOME
```

建议优先级：

```text
显式 --home
> GUTHON_TOOL_HOME
> GUTHON_HOME
> 无
```

当运行逻辑需要真实私有数据、但没有获得 `toolHome` 时：

- 明确报错；
- 不自动回退到 `repoRoot`;
- 不猜 `../var`;
- 不访问源码仓库内旧 `var/`。

路径应成为：

```text
<toolHome>/var/docs/谷神方言API
<toolHome>/config/sync.yaml
```

同时检查该文件中：

```text
plugins/GuthonVSCodeExtension/...
```

旧路径。

当前实际 Nexus 路径是：

```text
plugins/GuthonNexus/gushen-vscode-completion
```

若旧路径已失效，应彻底改正，并全局清理相关失效引用。

保留：

```text
repoRoot
```

用于定位工具源码中的 Nexus build script、源码文件或其它发布资源。

---

## 7.2 Nexus `scripts/build-data.mjs`

当前存在：

```js
const defaultApiDir =
  path.resolve(rootDir, '..', '..', '..', 'var', 'docs', '谷神方言API');
```

不得继续以“从插件目录向上数几层”寻找 `var`。

要求：

- 显式传入 API 目录时仍支持；
- 未显式传入时，只能从已明确提供的 `toolHome` 计算；
- 推荐兼容：
  - `GUTHON_TOOL_HOME`
  - `GUTHON_HOME`
- 无有效来源时给出清晰错误。

例如：

```text
apiDir = <toolHome>/var/docs/谷神方言API
```

而不是：

```text
apiDir = <sourceRoot>/var/...
```

更新：

```text
plugins/GuthonNexus/gushen-vscode-completion/package.json
plugins/GuthonNexus/README.md
plugins/GuthonNexus/gushen-vscode-completion/README.md
```

中的调用说明。

显式路径形式：

```bash
npm run build:data -- /path/to/api-docs
```

仍应继续工作。

---

# 8. 第四阶段：迁移真实 config

源码仓库的：

```text
config/
```

最终只保留可公开内容：

```text
config/
├── README.md
├── example/
└── schema/
```

将以下真实运行文件迁移到：

```text
<toolHome>/config/
```

包括当前存在时的：

```text
datasource.yaml
database-testing.yaml
products.yaml
projects.yaml
source-tables.yaml
sync.yaml
system-data.json
```

原则：

- 保持内容不变；
- 不打印密码；
- 不把真实配置内容复制进 README、测试 fixture 或日志；
- 不将真实运行配置重新加入工具源码 Git；
- `system-data.json` 仍是运行时 cache；
- 对其他疑似私有运行文件先判断职责，不能简单删除。

源码中的：

```text
config/example/**
config/schema/**
```

必须保留用于：

- `setup`;
- PyInstaller 打包；
- 配置初始化；
- schema 校验。

检查：

```text
scripts/build_guthon_tool.py
```

继续只打包：

```text
config/example
VERSION
```

不得把真实配置打入 Release。

---

# 9. 第五阶段：安全迁移 var

如果当前实际结构为：

```text
<BASE>/GuthonCodeTool/var
```

目标是：

```text
<BASE>/var
```

要求：

1. **不要修改 var 内业务文件内容。**
2. 若 `var/.git` 存在，必须完整保留。
3. 不允许删除后重新生成。
4. 不允许 rsync 时遗漏隐藏文件。
5. 不允许创建回指源码仓库的 symlink。
6. 迁移后确认 `.git`、`AGENTS.md`、`workspace/`、`checkout/`、`tools/` 等仍存在。
7. 分别检查两个 Git 仓库状态。

若目标：

```text
<BASE>/var
```

已经存在：

- 禁止自动覆盖；
- 禁止自动合并两个 var；
- 禁止删除任一目录；
- 本次仍完成代码解耦；
- 最终明确报告目录冲突及未执行的物理迁移。

如果可安全移动，可使用文件系统 rename/mv，优先避免复制大量业务数据。

迁移前后至少记录目录尺寸/关键目录存在性用于核对，但不要扫描源码内容建立巨大清单。

---

# 10. 第六阶段：Nexus 与 Bridge 路径契约

重点检查：

```text
plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js
plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js
plugins/GuthonNexus/gushen-vscode-completion/src/bridge-process.js
plugins/GuthonBridge/bridge/server.js
```

预期继续成立：

```text
developmentRoot
    ↓
GuthonCodeTool/.venv
GuthonCodeTool/scripts/guthon_tool.py
```

以及：

```text
toolHome
    ↓
config/
var/
```

`writeRuntimeDescriptor()` 继续写：

```text
<toolHome>/var/nexus/tool-runtime.json
```

其中：

```json
{
  "home": "<toolHome>"
}
```

保持不变。

`linterCommand` 继续为：

```text
<toolHome>/var/tools/guthon-lint
```

Bridge 继续接收：

```text
GUTHON_TOOL_HOME=<toolHome>
```

不要把 `developmentRoot` 写入业务 runtime home。

---

# 11. 第七阶段：更新 AGENTS.md，强制 AI 边界

重写根 `AGENTS.md` 中已经过时的目录描述。

必须明确：

```text
GuthonCodeTool 是独立工具源码仓库。
真实 config 与 var 位于仓库外部 toolHome。
```

建议加入以下强规则：

```markdown
## AI 上下文边界

工具开发默认只在当前 GuthonCodeTool 源码仓库内搜索和读取。

不得为了理解 GuthonCodeTool 功能而递归扫描仓库外的：
- ../var
- ../config
- 业务 workspace
- SVN checkout

只有任务明确涉及真实运行数据验证时，才允许通过正式
toolHome / runtime descriptor / CLI --home 契约访问，并应优先读取
元数据、摘要和索引，不直接全量扫描业务源码。

禁止工具代码通过源码仓库相对路径推断 var 或真实 config。
运行时数据只能从显式 toolHome / GUTHON_HOME 获取。
```

并删除/调整旧描述：

```text
var/ 是本仓库内部目录
```

以及失效的：

```text
plugins/GuthonVSCodeExtension/...
```

---

# 12. 第八阶段：新增 `AI_CODE_INDEX.md`

## 12.1 结论

**需要增加。**

但不要做成函数级百科，也不要复制 README。

目标是让 Codex / ZCode 在修改 GuthonCodeTool 时：

```text
先读 5~10 KB 索引
→ 确定模块
→ 只打开相关 2~6 个源码/测试文件
→ 避免全仓 rg + 全量阅读
```

---

## 12.2 文件位置

放在仓库根：

```text
GuthonCodeTool/AI_CODE_INDEX.md
```

原因：

- 与 `AGENTS.md` 同级；
- AI 进入项目即可发现；
- 不依赖某一插件；
- 文件足够小；
- 可以被 Codex、ZCode、Claude 等共同使用。

---

## 12.3 大小约束

硬性要求：

```text
建议 5~10 KB
最大尽量不超过 15 KB
```

不要：

- 列每个函数；
- 粘贴代码；
- 罗列所有 package.json command；
- 重复 README 功能介绍；
- 记录历史改造过程；
- 记录业务源码结构。

---

## 12.4 内容结构

建议只保留：

```markdown
# AI Code Index

## Start here
- 公共 CLI -> scripts/guthon_tool.py
- 工作区/同步/索引共享实现 -> scripts/common/gusen_hub.py
...

## Task -> Files
| 需求 | 首选文件 | 联动文件 | 测试 |
...

## Runtime roots
sourceRoot / developmentRoot / toolHome / var / config 的定义

## Python
...

## Nexus
...

## Bridge
...

## Build & release
...

## Validation
...
```

---

## 12.5 当前源码至少应覆盖的模块

### CLI / shared core

```text
scripts/guthon_tool.py
scripts/common/gusen_hub.py
scripts/common/workspace_config.py
scripts/common/workspace_assistant.py
scripts/common/workcopy.py
scripts/common/source_facts.py
scripts/common/database_readonly.py
scripts/common/database_test_artifacts.py
```

### DATABASE provider

```text
scripts/providers/database/export_table_schema_sql.py
scripts/providers/database/export_bill_type_sql.py
scripts/providers/database/export_view_sql.py
scripts/providers/database/export_system_script_sql.py
scripts/providers/database/pull_source_to_work_copy.py
scripts/providers/database/run_source_diagnosis.py
```

### SVN provider

```text
scripts/providers/svn/checkout.py
scripts/providers/svn/scanner.py
scripts/providers/svn/scope_import.py
scripts/providers/svn/projection.py
scripts/providers/svn/writeback.py
scripts/providers/svn/nexus/bootstrap.py
scripts/providers/svn/nexus/catalog.py
scripts/providers/svn/nexus/documents.py
scripts/providers/svn/nexus/index_queries.py
scripts/providers/svn/nexus/manifest.py
scripts/providers/svn/nexus/scm.py
scripts/providers/svn/nexus/workspace.py
```

### Guthon Nexus

```text
plugins/GuthonNexus/gushen-vscode-completion/src/extension.js
plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js
plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js
plugins/GuthonNexus/gushen-vscode-completion/src/workspace-registry.js
plugins/GuthonNexus/gushen-vscode-completion/src/workspace-assistant.js
plugins/GuthonNexus/gushen-vscode-completion/src/bridge-process.js
plugins/GuthonNexus/gushen-vscode-completion/src/database-config.js
plugins/GuthonNexus/gushen-vscode-completion/src/definition.js
plugins/GuthonNexus/gushen-vscode-completion/src/source-mode.js
plugins/GuthonNexus/gushen-vscode-completion/src/tool-updater.js
```

### Guthon Bridge

```text
plugins/GuthonBridge/bridge/server.js
plugins/GuthonBridge/extension/background.js
plugins/GuthonBridge/extension/content.js
plugins/GuthonBridge/extension/page-bridge.js
plugins/GuthonBridge/extension/workspace-selection.js
```

### Build / generated data

```text
scripts/build_guthon_tool.py
scripts/sync_guthon_api.mjs
plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs
```

---

# 13. `AI_CODE_INDEX.md` 推荐任务映射

Codex 根据实际实现核对后写入，不要机械照抄错误映射。

至少提供下列“任务 → 首选代码”：

| 修改目标 | 首先查看 | 常见联动 |
|---|---|---|
| CLI 新命令/参数 | `scripts/guthon_tool.py` | `gusen_hub.py`、Nexus client/tests |
| workspace 解析 | `scripts/common/gusen_hub.py` | `workspace_config.py`、workspace tests |
| DATABASE 拉取/导出 | `scripts/providers/database/` | `gusen_hub.py` |
| 数据库只读排查 | `database_readonly.py`、`database_test_artifacts.py` | `run_source_diagnosis.py`、Nexus database config |
| Workcopy | `gusen_hub.py`、`workcopy.py` | Nexus commands/tests |
| SVN checkout | `providers/svn/checkout.py` | nexus bootstrap/workspace |
| SVN 索引/浏览 | `providers/svn/nexus/` | Nexus source view |
| SVN SCM/差异/提交 | `providers/svn/nexus/scm.py`、`writeback.py` | Nexus `extension.js` / SCM tests |
| Nexus 设置 toolHome/developmentRoot | `src/tool-runtime.js`、`src/tool-workspace.js` | `extension.js` |
| Nexus UI 命令 | `src/extension.js` | `package.json`、对应 test |
| Bridge 后端 | `plugins/GuthonBridge/bridge/server.js` | Nexus `bridge-process.js` |
| Chrome Bridge | `plugins/GuthonBridge/extension/` | bridge protocol tests |
| 发行构建 | `scripts/build_guthon_tool.py` | Release workflow/docs |
| API 补全数据 | `sync_guthon_api.mjs`、`build-data.mjs` | Nexus data/docs |
| 工具更新 | `src/tool-updater.js` | extension/package/tests |

---

# 14. 索引的维护策略

不要实现一个复杂的“自动理解源码并生成说明”的系统。

第一版采用：

```text
人工维护的稳定模块映射
+
自动校验路径存在
```

这是成本最低、稳定性最高的方案。

新增一个很小的校验脚本，例如：

```text
scripts/check_ai_code_index.py
```

职责只能是：

1. 从 `AI_CODE_INDEX.md` 提取反引号中的仓库相对路径；
2. 对看起来是源码/目录的路径检查是否存在；
3. 发现已删除/改名路径时返回非 0；
4. 不解析业务语义；
5. 不扫描 `var`;
6. 不生成巨大索引。

例如：

```bash
python scripts/check_ai_code_index.py
```

通过：

```text
AI_CODE_INDEX: ok
```

失败：

```text
AI_CODE_INDEX stale path:
plugins/OldPlugin/...
```

如认为独立脚本没有必要，也可用轻量单元测试实现同一约束，但必须保证改名后能提醒维护 `AI_CODE_INDEX.md`。

不要加入 AST 全函数索引器。

---

# 15. 修改 AGENTS.md 的索引加载规则

在根 `AGENTS.md` 中增加：

```markdown
## AI 导航

维护 GuthonCodeTool 时先读取 `AI_CODE_INDEX.md`，根据任务定位最小相关模块；
不要以“理解整个项目”为由预先遍历全部源码。

只有索引信息不足时才扩大搜索范围。
修改模块职责、入口、目录名或主要调用关系时同步更新 `AI_CODE_INDEX.md`。
```

同时明确：

```text
AI_CODE_INDEX.md 是导航索引，不是规范来源。
AGENTS.md 仍负责规则。
README/docs 仍负责用户文档。
源码和测试仍是最终行为事实。
```

避免职责重复。

---

# 16. README / docs 同步

至少检查并更新：

```text
README.md
config/README.md
plugins/GuthonNexus/README.md
plugins/GuthonNexus/gushen-vscode-completion/README.md
plugins/GuthonBridge/README.md
docs/GuthonCodeTool_使用手册.html
docs/GuthonCodeTool_全功能说明.html
docs/GuthonCodeTool_QA.html
```

重点统一术语：

```text
工具源码目录
本地数据目录 / toolHome
真实配置目录
私有 var
developmentRoot
```

README 中不要继续表达：

```text
工具仓库内部包含私有 var
```

开发者示例应明确：

```text
<BASE>/
├── GuthonCodeTool/
├── config/
└── var/
```

普通用户发行模式文档中原有“应用目录”和“本地数据目录分离”语义应保持，不要强迫普通用户使用与源码开发者完全相同的物理目录。

---

# 17. 清理旧目录名和失效引用

当前检查已发现根 `AGENTS.md` 存在：

```text
plugins/GuthonVSCodeExtension/gushen-vscode-completion/
```

但实际目录为：

```text
plugins/GuthonNexus/gushen-vscode-completion/
```

`scripts/sync_guthon_api.mjs` 也存在旧目录引用的可能。

执行：

```bash
rg -n "GuthonVSCodeExtension" .
```

排除确实需要保留的历史文档后，删除所有当前行为中的失效引用。

同理搜索：

```bash
rg -n \
  "GuthonCodeTool/var|repoRoot.*var|rootDir.*var|SOURCE_ROOT.*var|\\.\\./.*var" \
  AGENTS.md README.md scripts plugins config docs \
  --glob '!docs/private/**'
```

对每一处分类：

```text
A. 正常的 <toolHome>/var 语义 -> 保留
B. 文档中的相对示例但默认 cwd 已不成立 -> 修改
C. 从源码目录推断 var -> 必须修复
```

---

# 18. 测试要求

## 18.1 新增核心解耦测试

必须增加测试证明：

```text
sourceRoot != toolHome
```

典型 fixture：

```text
/tmp/test/
├── repo/
│   └── GuthonCodeTool/
└── data/
    ├── config/
    └── var/
```

验证：

```text
developmentRoot = /tmp/test/repo/GuthonCodeTool
toolHome        = /tmp/test/data
```

以及：

- CLI 从 `/tmp/test/data/config` 读取配置；
- 输出写入 `/tmp/test/data/var`;
- 源码仓库下不自动生成 `var`;
- 源码仓库下不自动生成真实 `config/*.yaml`;
- runtime descriptor 位于 `/tmp/test/data/var/nexus/tool-runtime.json`;
- linter path 位于 `/tmp/test/data/var/tools/guthon-lint`;
- development runtime 仍从源码仓库 `.venv` 和 `scripts/guthon_tool.py` 启动。

---

## 18.2 Node 脚本测试

为：

```text
scripts/sync_guthon_api.mjs
plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs
```

增加或调整最小测试，覆盖：

1. 显式 home；
2. sourceRoot 与 toolHome 不同；
3. 缺少 home 时不会偷偷访问源码仓库 `var`;
4. 显式 API 文档目录仍可覆盖默认值；
5. 当前 Nexus 真实目录名正确。

---

## 18.3 Python

按实际环境执行：

```bash
PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests
```

至少执行：

```bash
.venv/bin/python scripts/guthon_tool.py self-test \
  --home "$(mktemp -d)"
```

如果 `self-test` 的调用格式与当前 CLI 实际行为不同，以源码 `--help` 为准修正。

---

## 18.4 Nexus

```bash
cd plugins/GuthonNexus/gushen-vscode-completion
npm test
```

如有：

```bash
npm run check
```

也执行。

除非本次改动需要安装验证，否则不要无意义打包 VSIX。

---

## 18.5 Bridge

如果修改到 Bridge：

```bash
cd plugins/GuthonBridge
npm test
```

---

## 18.6 文档和路径

执行：

```bash
python scripts/check_ai_code_index.py
```

以及：

```bash
rg -n "GuthonVSCodeExtension" .
```

确认当前代码/规范不再引用已退役目录。

检查是否仍有从 source root 猜 var：

```bash
rg -n \
  "repoRoot.*var|rootDir.*var|SOURCE_ROOT.*var|parents\\[[0-9]+\\].*var" \
  scripts plugins
```

逐项确认合理性。

最后：

```bash
git diff --check
git status --short
```

若 `var` 是独立 Git：

```bash
git -C ../var status --short
```

不要修改/清理原有用户改动。

---

# 19. AI Token 降费验收标准

本任务不只以“程序能跑”为完成标准。

改造完成后，应满足：

## 工具开发

打开：

```text
<BASE>/GuthonCodeTool
```

时，仓库内不再包含：

```text
var/workspace
var/checkout
真实运行 config
```

因此 Codex 对工具代码执行：

```bash
rg
find
git status
```

不会自然遍历大量业务文件。

---

## 业务开发

Codex / ZCode 开发谷神业务时应以具体 PRD/PRJ 为 cwd，例如：

```text
<BASE>/var/workspace/PRD 期现产品
```

不应以：

```text
<BASE>
```

作为统一巨型 workspace。

---

## 导航

维护 GuthonCodeTool 时：

```text
AGENTS.md
    ↓
AI_CODE_INDEX.md
    ↓
任务对应的少量代码
```

而不是：

```text
AGENTS.md
    ↓
全仓扫描
    ↓
阅读几十个无关模块
```

---

# 20. 完成后的最终目录验收

如果允许安全执行物理迁移，最终应类似：

```text
<BASE>/
├── GuthonCodeTool/
│   ├── .git/
│   ├── AGENTS.md
│   ├── AI_CODE_INDEX.md
│   ├── README.md
│   ├── VERSION
│   ├── scripts/
│   ├── plugins/
│   ├── skills/
│   ├── docs/
│   ├── tests/
│   └── config/
│       ├── README.md
│       ├── example/
│       └── schema/
│
├── config/
│   ├── datasource.yaml
│   ├── database-testing.yaml
│   ├── products.yaml
│   ├── projects.yaml
│   ├── source-tables.yaml
│   ├── sync.yaml
│   └── system-data.json
│
└── var/
    ├── .git/
    ├── AGENTS.md
    ├── tools/
    ├── docs/
    ├── nexus/
    ├── checkout/
    └── workspace/
```

---

# 21. 交付要求

直接执行修改，不要只返回建议。

完成后只需汇报：

1. 实际修改了哪些关键文件；
2. 最终 sourceRoot / developmentRoot / toolHome 的定义；
3. `var` 和真实 `config` 是否已经完成物理迁移；
4. 如果未迁移，具体阻塞是什么；
5. 哪些硬编码被删除；
6. `AI_CODE_INDEX.md` 的最终大小和主要覆盖范围；
7. 执行了哪些测试及结果；
8. 仍存在的风险或未验证项。

不要：

- 自动提交 Git；
- 自动推送；
- 修改无关业务功能；
- 读取或展示敏感配置值；
- 为兼容旧布局长期保留“双路径猜测”逻辑。

---

# 22. 最重要的设计原则

这次改造完成后的长期规则只有一句：

> **GuthonCodeTool 源码只认识显式传入的 toolHome，不认识“自己旁边应该有一个 var”；AI 开发 GuthonCodeTool 时也只看工具仓库，业务数据按需通过正式 runtime 契约访问。**

