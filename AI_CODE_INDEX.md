# AI Code Index

导航索引，不是规范来源：规则见 `AGENTS.md`，用户文档见 `README.md` 与 `docs/`，行为事实以源码和测试为准。

维护 GuthonCodeTool 时先读本文件定位模块，只打开任务相关的少量文件；索引不足时才扩大搜索范围。修改模块职责、入口、目录名或主要调用关系后同步更新本文件，并执行 `python scripts/check_ai_code_index.py` 校验引用的路径仍然存在（`tests/` 是本地忽略目录，缺失时只跳过）。

## Runtime roots

```text
sourceRoot / developmentRoot = <toolHome>/GuthonCodeTool   工具源码（本仓库）
toolHome / GUTHON_HOME       = <toolHome>                  本地数据目录
runtimeConfig                = <toolHome>/config           真实运行配置
runtimeVar                   = <toolHome>/var              私有谷神工作区（独立 Git）
```

- 本仓库只提供程序代码、`config/example/`、`config/schema/`、`VERSION`、发行资源；不含 `var/` 和真实 `config/*.yaml`。
- `toolHome` 只来自显式 `--home`、runtime descriptor 或 `GUTHON_HOME` / `GUTHON_TOOL_HOME`；不得用源码仓库相对路径推断运行数据。
- CLI 统一入口：`python scripts/guthon_tool.py <command> --home <toolHome>`。
- runtime descriptor：`<toolHome>/var/nexus/tool-runtime.json`；linter：`<toolHome>/var/tools/guthon-lint`。

## Task to files

| 需求 | 首选文件 | 常见联动 | 测试 |
|---|---|---|---|
| CLI 命令与参数 | `scripts/guthon_tool.py` | `scripts/common/gusen_hub.py` | `tests/test_guthon_tool.py` |
| 工作区配置/创建 | `scripts/common/workspace_config.py` | `scripts/common/gusen_hub.py` | `tests/test_workspace_config.py` |
| 工作区路由与解析 | `scripts/common/gusen_hub.py` | `scripts/providers/svn/nexus/workspace.py` | `tests/test_workspace_routing.py` |
| 工作区助手/状态摘要 | `scripts/common/workspace_assistant.py` | `scripts/common/gusen_hub.py` | `tests/test_workspace_assistant_features.py` |
| DATABASE 拉取/导出 | `scripts/providers/database/export_table_schema_sql.py` | `scripts/providers/database/pull_source_to_work_copy.py` | `tests/test_export_table_schema_sql.py` |
| DATABASE 只读排查 | `scripts/common/database_readonly.py` | `scripts/providers/database/run_source_diagnosis.py` | `tests/test_run_source_diagnosis.py` |
| 数据库测试计划/结果 | `scripts/common/database_test_artifacts.py` | `config/schema/database-testing.schema.json` | `tests/test_database_test_artifacts.py` |
| Workcopy | `scripts/common/workcopy.py` | `scripts/common/gusen_hub.py` | `tests/test_workcopy.py` |
| 上下文有界查询 | `scripts/common/query_hub_context.py` | `scripts/providers/svn/nexus/index_queries.py` | `tests/test_gusen_hub.py` |
| SVN 检出与范围导入 | `scripts/providers/svn/checkout.py` | `scripts/providers/svn/scope_import.py` | `tests/test_svn_scope_import.py` |
| SVN 索引与浏览 | `scripts/providers/svn/nexus/catalog.py` | `scripts/providers/svn/nexus/documents.py` | `tests/test_svn_nexus_workspace.py` |
| SVN SCM/差异/写回 | `scripts/providers/svn/nexus/scm.py` | `scripts/providers/svn/writeback.py` | `tests/test_svn_provider.py` |
| Nexus 运行模式/toolHome | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/tool-runtime.test.js` |
| Nexus UI 命令 | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` | `plugins/GuthonNexus/gushen-vscode-completion/package.json` | `plugins/GuthonNexus/gushen-vscode-completion/test/rules.test.js` |
| Nexus SVN 集成 | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/backend-client.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/scm-manager.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/svn-backend-client.test.js` |
| Bridge 服务端 | `plugins/GuthonBridge/bridge/server.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/bridge-process.js` | `plugins/GuthonBridge/bridge/server.test.js` |
| Chrome Bridge 扩展 | `plugins/GuthonBridge/extension/content.js` | `plugins/GuthonBridge/extension/page-bridge.js` | `plugins/GuthonBridge/extension/fields-mover-core.test.js` |
| 发行构建 | `scripts/build_guthon_tool.py` | `GuthonCodeTool.spec` | `tests/test_build_guthon_tool.py` |
| 谷神 API 补全数据 | `scripts/sync_guthon_api.mjs` | `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs` | 两个脚本的 `--self-test` |
| 工具自更新 | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-updater.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/tool-updater.test.js` |
| 环境自检 | `scripts/common/doctor.py` | `scripts/guthon_tool.py` | `scripts/guthon_tool.py self-test --home <临时目录>` |

## Python

| 模块 | 职责 |
|---|---|
| `scripts/guthon_tool.py` | 统一 CLI、`--home` 契约、命令编排与 `self-test`。 |
| `scripts/common/gusen_hub.py` | 工作区解析、索引连接、同步、Workcopy、状态与自动暂存的共享实现。 |
| `scripts/common/workspace_config.py` | 工作区创建/删除与 YAML 读写。 |
| `scripts/common/workspace_assistant.py` | 工作区摘要、就绪状态与助手输出。 |
| `scripts/common/source_facts.py` | 源码身份与事实解析。 |
| `scripts/common/page_projection.py` | PAGE 虚拟文档投影。 |
| `scripts/common/source_format.py` | 源码编解码与格式元数据。 |
| `scripts/common/export_hub_markdown.py` | 全量 Markdown 导出。 |
| `scripts/common/run_sync_once.py` / `scripts/common/sync_workspace_all.py` | 单次同步与全工作区同步入口。 |
| `scripts/common/create_work_copy.py` | Workcopy 创建入口。 |
| `scripts/common/database_readonly.py` | 只读数据库连接、凭据引用与诊断目标解析。 |
| `scripts/common/database_test_artifacts.py` | 测试计划/结果校验、评估与摘要。 |
| `scripts/check_ai_code_index.py` | 校验本索引引用的路径存在。 |

## Providers

DATABASE：

- `scripts/providers/database/export_table_schema_sql.py`（表结构）、`export_bill_type_sql.py`（单据类型）、`export_view_sql.py`（视图）、`export_system_script_sql.py`（系统脚本）。
- `scripts/providers/database/pull_source_to_work_copy.py`：拉取源码到 Workcopy。
- `scripts/providers/database/run_source_diagnosis.py`：只读业务排查执行器。

SVN：

- `scripts/providers/svn/checkout.py`：检出/更新、操作锁与 working copy 清单。
- `scripts/providers/svn/scanner.py`、`projection.py`、`group_inference.py`、`dedup.py`：扫描、虚拟文档投影、模块归并与去重。
- `scripts/providers/svn/writeback.py`：受控写回与差异校验。
- `scripts/providers/svn/nexus/catalog.py`、`documents.py`、`index_queries.py`、`manifest.py`、`scm.py`、`workspace.py`、`bootstrap.py`：Nexus 目录、文档、有界查询、清单、SCM 与工作区初始化。

## Guthon Nexus

`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` 是命令与视图注册入口；`tool-runtime.js` 决定 development/packaged 命令并写入 runtime descriptor；`tool-workspace.js` 负责设置/切换工作空间；`workspace-registry.js` 与 `workspace-assistant.js` 维护工作区列表；`bridge-process.js` 启停 Bridge；`definition.js`、`selector.js`、`rules.js`、`tool-json-client.js`、`source-mode.js`、`database-config.js`、`tool-updater.js` 分别承担跳转、选择器、补全规则、CLI JSON 调用、源码模式、数据库配置与自更新。

## Guthon Bridge

`plugins/GuthonBridge/bridge/server.js` 是本地服务入口，读取 `GUTHON_TOOL_HOME`；`plugins/GuthonBridge/extension/` 下 `content.js`、`background.js`、`page-bridge.js`、`workspace-selection.js` 分别负责页面注入、后台路由、页面桥与工作区选择。

## Build and release

- `scripts/build_guthon_tool.py`：PyInstaller 打包，只打包 `config/example` 与 `VERSION`。
- `GuthonCodeTool.spec`：打包配置。
- `scripts/sync_guthon_api.mjs`：从 `<toolHome>/config/sync.yaml` 读取谷神版本，更新 `<toolHome>/var/docs/谷神方言API/` 与插件补全数据。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs`：从 API 文档目录生成 `plugins/GuthonNexus/gushen-vscode-completion/data/index.json`。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-bridge.mjs`：生成 `plugins/GuthonBridge/bridge/server.js`。
- `docs/GuthonCodeTool_使用手册.html`、`docs/GuthonCodeTool_全功能说明.html`、`docs/GuthonCodeTool_QA.html`：用户手册、全功能说明与 QA 页，行为变化时同步。

## Validation

```bash
python scripts/check_ai_code_index.py
PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests
.venv/bin/python scripts/guthon_tool.py self-test --home "$(mktemp -d)"
node scripts/sync_guthon_api.mjs --self-test
cd plugins/GuthonNexus/gushen-vscode-completion && npm test
cd plugins/GuthonBridge && npm test
```

`var/` 和真实 `config/` 不在本仓库，涉及真实运行数据的验证必须显式传入 `--home` 并保持只读。
