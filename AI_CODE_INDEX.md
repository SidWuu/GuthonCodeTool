# AI Code Index

导航索引，不是规范来源：规则见 `AGENTS.md`，用户文档见 `README.md` 与 `docs/`，行为事实以源码和测试为准。

维护 GuthonCodeTool 时先读本文件定位模块，只打开任务相关的少量文件；索引不足时才扩大搜索范围。修改模块职责、入口、目录名或主要调用关系后同步更新本文件，并执行 `python scripts/check_ai_code_index.py` 校验引用的路径仍然存在（`tests/` 是本地忽略目录，缺失时只跳过）。

## Runtime roots

```text
sourceRoot / developmentRoot = <toolHome>/GuthonCodeTool   工具源码（本仓库）
toolHome / GUTHON_HOME       = <toolHome>                  本地数据目录
runtimeConfig                = <toolHome>/config           真实运行配置
runtimeVar                   = <toolHome>/<workspaceDirectory>  私有谷神工作区（独立 Git，默认 var）
```

- 本仓库只提供程序代码、`config/example/`、`config/schema/`、`VERSION`、发行资源；不含 `var/` 和真实运行配置 `guthon.json`。
- `toolHome` 只来自显式 `--home`、runtime descriptor 或 `GUTHON_HOME` / `GUTHON_TOOL_HOME`；不得用源码仓库相对路径推断运行数据。
- CLI 统一入口：`python scripts/guthon_tool.py <command> --home <toolHome>`；命令参数自省用 `help <command>` 或 `<command> --help`。
- 新项目登记的目录为 `<workspaceRoot>/workspace/<项目目录>`。相对目录与既有直置项目由 `scripts/common/workspace_layout.py` 和 `scripts/common/workspace_registry.py` 解析。
- 开发根由 `<toolHome>/config/guthon.json` 的可选 `workspaceDirectory` 指定。公共解析位于 `scripts/common/runtime_paths.py` 与 `plugins/GuthonNexus/gushen-vscode-completion/src/workspace-root.js`；运行描述与 Linter 分别位于 `<workspaceRoot>/nexus/tool-runtime.json` 和 `<workspaceRoot>/tools/guthon-lint`。

## Task to files

| 需求 | 首选文件 | 常见联动 | 测试 |
|---|---|---|---|
| CLI 命令与参数 | `scripts/guthon_tool.py` | `scripts/common/gusen_hub.py` | `tests/test_guthon_tool.py` |
| 工作区登记与同步方式 | `scripts/common/config_store.py`、`scripts/common/workspace_config.py`、`scripts/common/workspace_layout.py` | `scripts/common/gusen_hub.py`、`scripts/guthon_tool.py`（`workspace-create`、`workspace-source-mode`） | `tests/test_unified_workspace.py`、`tests/test_config_store.py`、`tests/test_workspace_contract.py` |
| SVN / DATABASE 登录、源码连接与范围 | `scripts/common/workspace_source_settings.py`、`scripts/common/workspace_source_scope.py`、`plugins/GuthonNexus/gushen-vscode-completion/src/project-source-settings.js` | `scripts/common/svn_workspace_config.py`、`scripts/providers/svn/group_inference.py`（目录名称匹配）、`plugins/GuthonNexus/gushen-vscode-completion/src/legacy-project.js` | `tests/test_workspace_source_settings.py` |
| 工作区路由与解析 | `scripts/common/workspace_registry.py`、`scripts/common/workspace_sources.py`、`scripts/common/workspace_selection.py` | `scripts/common/workspace_config.py`、`scripts/guthon_tool.py` | `tests/test_unified_workspace.py` |
| API 批量源码与 PAGE 原生模型 | `scripts/providers/api/download.py`（按子系统分页）、`scripts/providers/api/page_source.py`（只读导出和原生基线）、`scripts/providers/api/store.py`（保护本地修改） | `scripts/providers/api/sync.py`（范围和精确更新）、`plugins/GuthonNexus/gushen-vscode-completion/src/api/source-ui.js`（编辑前按页加载） | `tests/test_api_native_source.py` |
| API 增量索引与查询 | `scripts/providers/api/index.py`（`api index-repair` 重试当前索引中的诊断项） | `scripts/providers/api/store.py`、`scripts/providers/api/mcp_server.py`、`plugins/GuthonNexus/gushen-vscode-completion/src/api/source-watcher.js`（文件事件与当前索引核对） | `tests/test_api_source.py` |
| API 原请求关闭 | `scripts/providers/api/source_requests.py`（串行关闭未开始的幂等请求，不撤销已登记操作） | `scripts/providers/api/documents.py`、`scripts/providers/api/source_batch.py`、`scripts/providers/api/mcp_server.py` | `tests/test_api_request_closure.py` |
| API 跨文件受控修改 | `scripts/providers/api/source_batch.py`（计划、预检、写入与原文恢复） | `scripts/providers/api/documents.py`、`scripts/providers/api/store.py`、`scripts/providers/api/cli.py`、`scripts/providers/api/mcp_server.py` | `tests/test_api_source_batch.py`、`tests/test_api_followup.py` |
| API 整页生命周期 | `scripts/providers/api/page_lifecycle.py`（Bridge 平台上下文、新建/复制/删除及原回执核对） | `plugins/GuthonBridge/extension/page-lifecycle.js`、`plugins/GuthonBridge/bridge/server.js`、`scripts/providers/api/mcp_server.py` | `tests/test_api_page_lifecycle.py` |
| API PAGE 可读与原文差异 | `scripts/providers/api/source_diff.py`（PAGE 语义投影、原文回退及哈希分页） | `plugins/GuthonNexus/gushen-vscode-completion/src/api/source-diff.js`（完整分页、只读快照）、`plugins/GuthonNexus/gushen-vscode-completion/src/api/source-ui.js`（SCM/上传审阅入口） | `tests/test_api_source_diff.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/api-source-diff.test.js` |
| API 批量读取与表引用 | `scripts/providers/api/query_operations.py`（总正文预算、逐项错误与显式映射） | `scripts/providers/api/index.py`、`scripts/providers/api/mcp_server.py`、`scripts/providers/api/cli.py` | `tests/test_api_followup.py` |
| API 项目导出与独立单据类型导出 | `scripts/providers/api/exports.py`、`scripts/common/database_exports/export_bill_type_sql.py` | `scripts/guthon_tool.py`、`scripts/common/database_readonly.py` | `tests/test_api_source.py` |
| Bridge 页面定位与上下文 | `plugins/GuthonBridge/bridge/page-context.js`、`plugins/GuthonBridge/extension/nexus-locator.js` | `plugins/GuthonBridge/extension/background.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/source/browser-navigation.js` | `plugins/GuthonBridge/bridge/page-context.test.js` |
| 工作空间初始化与团队规范同步 | `scripts/common/workspace_layout.py`、`scripts/common/team_governance.py` | `scripts/common/config_store.py`、`scripts/guthon_tool.py`（setup）、`plugins/GuthonNexus/gushen-vscode-completion/src/onboarding.js`（Windows 首次配置）、`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`（Nexus 初始化及手动同步） | `tests/test_unified_workspace.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/setup-runtime-selection.test.js` |
| 工作区助手/状态摘要 | `scripts/common/workspace_assistant.py` | `scripts/common/gusen_hub.py` | `tests/test_workspace_assistant_features.py` |
| 数据库 CLI / 目标管理 / 单连接排查 | `scripts/common/database_cli.py` | `scripts/common/database_readonly.py`、`scripts/common/database_sql.py`、`scripts/guthon_tool.py` | `tests/test_audit_regressions.py` |
| 数据库查询 XLSX 结果与证据导出 | `scripts/common/query_xlsx.py` | `scripts/common/database_cli.py`、`scripts/common/persistence.py` | `tests/test_audit_regressions.py` |
| Nexus 最近诊断历史视图 | `plugins/GuthonNexus/gushen-vscode-completion/src/diagnosis-history-view.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`、`scripts/common/database_operations.py` | `plugins/GuthonNexus/gushen-vscode-completion/test/diagnosis-history-view.test.js` |
| 数据库测试计划/结果 | `scripts/common/database_test_artifacts.py` | `config/schema/database-testing.schema.json` | `tests/test_database_test_artifacts.py` |
| PAGE 本地编辑与官方在线编辑 | `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/controller.js`（本地草稿、保存及在线入口）、`plugins/GuthonNexus/gushen-vscode-completion/src/api/designer.js`（官方 iframe、窗口复用和本地回读） | `plugins/GuthonNexus/gushen-vscode-completion/src/api/activate.js`（页面入口与接线） | `plugins/GuthonNexus/gushen-vscode-completion/test/api-designer.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/api-ui.test.js` |
| Nexus 运行模式/toolHome | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`（按当前窗口绑定数据目录；首启自动查找上一级后端，入口与目录在初始化成功后保存） | `plugins/GuthonNexus/gushen-vscode-completion/test/tool-runtime.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/setup-runtime-selection.test.js` |
| ToolHost 与三运行模式 | `scripts/guthon_tool.py` | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-process-client.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/script-runtime.js`、`scripts/build_script_tool.py` | `tests/test_toolhost.py`、`tests/test_build_script_tool.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/tool-process-client.test.js` |
| Nexus 项目总览与三层视图 | `plugins/GuthonNexus/gushen-vscode-completion/src/project-overview.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/view-tree.js`（总览和源码内容）、`plugins/GuthonNexus/gushen-vscode-completion/src/api/project-card.js` | `plugins/GuthonNexus/gushen-vscode-completion/package.json`（原生菜单）、`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/api/source-ui.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/project-actions.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/project-overview.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/project-workspace-view.test.js` |
| Nexus 重新登记后迁移 docs | `plugins/GuthonNexus/gushen-vscode-completion/src/project-docs-migration.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`、`plugins/GuthonNexus/gushen-vscode-completion/package.json` | `plugins/GuthonNexus/gushen-vscode-completion/test/project-docs-migration.test.js` |
| 旧模式源码树分组排序 | `scripts/common/source_tree_order.py`（解析当前项目的数据源归属）、`plugins/GuthonNexus/gushen-vscode-completion/src/source/tree-styles.js` | `scripts/common/legacy_source_read.py`、`scripts/providers/svn/nexus/index_queries.py` | `plugins/GuthonNexus/gushen-vscode-completion/test/legacy-source-editor.test.js` |
| Nexus UI 命令 | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` | `plugins/GuthonNexus/gushen-vscode-completion/package.json` | `plugins/GuthonNexus/gushen-vscode-completion/test/rules.test.js` |
| Bridge 服务端与持久异步任务 | `plugins/GuthonBridge/bridge/server.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/bridge-process.js` | `plugins/GuthonBridge/bridge/server.test.js` |
| 原生平台接口与回读 | `plugins/GuthonBridge/bridge/native-metadata.js`（身份绑定、持久请求及回执） | `plugins/GuthonBridge/bridge/native-step-registry.js`（显式冻结的服务步骤）、`plugins/GuthonBridge/bridge/native-source-plan.js`（显式冻结的开发函数、MCP登记及隐藏保存字段）、`plugins/GuthonBridge/bridge/page-context.js`、`plugins/GuthonBridge/bridge/server.js`、`plugins/GuthonBridge/extension/native-metadata.js`、`plugins/GuthonBridge/extension/background.js` | `plugins/GuthonBridge/bridge/native-metadata.test.js`、`plugins/GuthonBridge/bridge/native-step-registry.test.js`、`plugins/GuthonBridge/bridge/native-source-plan.test.js`、`plugins/GuthonBridge/extension/native-metadata.test.js`、`plugins/GuthonBridge/bridge/navigation-server.test.js` |
| 发行构建 | `scripts/build_guthon_tool.py`（macOS 与 Windows 单文件） | `.github/workflows/release.yml`、`GuthonCodeTool.spec` | `tests/test_build_guthon_tool.py` |
| Windows 统一安装器与官方依赖下载 | `scripts/installer/engine.py` | `scripts/build_windows_installer.py`、`scripts/build_installer_components.py`、`scripts/fetch_installer_inputs.py`、`scripts/common/installer_downloads.py`（构建/运行时共享的固定 HTTPS 下载与校验）、`scripts/check_installer_runtime.py`、`scripts/check_windows_installer.py`、`installer/windows/GuthonCodeSetup.iss`、`.github/workflows/build-installer.yml` | `tests/test_windows_installer.py` |
| Nexus API 补全合并与重载去重 | `plugins/GuthonNexus/gushen-vscode-completion/src/api-completion.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/api/platform-reference.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/api-completion.test.js` |
| 谷神 API 补全数据 | `scripts/sync_guthon_api.mjs` | `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs` | 两个脚本的 `--self-test` |
| 三组件更新 | `plugins/GuthonNexus/gushen-vscode-completion/src/update-center.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/component-update.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/release-catalog.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/update-archive.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/tool-updater.js`、`scripts/build_release_catalog.mjs` | `plugins/GuthonNexus/gushen-vscode-completion/test/component-update.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/update-center.test.js` |
| 环境自检 | `scripts/common/doctor.py`（按工作区能力确定依赖，保留 legacy JSON/退出码并提供结构化报告） | `scripts/guthon_tool.py`（配置载入失败前仍可进入自检）、`plugins/GuthonNexus/gushen-vscode-completion/src/environment-check.js`（报告校验与固定操作入口）、`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` | `tests/test_doctor.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/environment-check.test.js` |

## Common workspace contract

- `scripts/common/configuration_upgrade.py` 实现离线配置预览、发布与中断恢复，`scripts/common/svn_api_migration.py` 实现 SVN 源侧预检、API 候选和配置切换恢复；`scripts/common/svn_api_inventory.py` 对齐两侧对象身份和摘要。测试位于 `tests/test_configuration_upgrade.py` 和 `tests/test_svn_api_migration.py`。

- `scripts/common/config_store.py` 读取 API schema 2、新 schema 3 与完整旧 YAML，保留 `sourceTables` 和环境、凭据引用。
- `scripts/common/workspace_sources.py`、`scripts/common/workspace_registry.py` 统一配置与授权路径；`scripts/common/svn_workspace_config.py`、`scripts/common/svn_scope.py` 同时供 SVN provider 使用。
- `scripts/common/legacy_source.py` 拥有 SVN 与 DATABASE 既有索引和源码流程及 DATABASE 拉取预检和进度，`scripts/common/legacy_source_cli.py` 接入 CLI，`scripts/common/legacy_source_read.py` 提供有界本地查询，`scripts/common/database_source_exports.py` 为 DATABASE 的表、视图、系统脚本和单据类型建立本地目录与检索索引。共有工作区和连接逻辑仍由 `scripts/common/gusen_hub.py` 提供。
- `scripts/providers/svn/cli.py` 调度原生更新、索引和变更审阅，`scripts/providers/svn/nexus/scm.py` 校验并执行 SVN 提交和回执。DATABASE Workcopy 由 `scripts/common/workcopy_store.py` 管理。
- Nexus `plugins/GuthonNexus/gushen-vscode-completion/src/legacy-project.js` 从当前卡片做旧模式接线，复用 `plugins/GuthonNexus/gushen-vscode-completion/src/svn/` 的源码树、SCM、编辑租约与监听。`plugins/GuthonNexus/gushen-vscode-completion/src/database-source-tree.js` 提供 DATABASE 的源码分组和节点同步，`plugins/GuthonNexus/gushen-vscode-completion/src/database-source-editor.js` 与 `scripts/common/database_workcopy_edit.py` 提供受控工作副本编辑，`scripts/common/database_node_sync.py` 处理 readonly 节点同步，`plugins/GuthonNexus/gushen-vscode-completion/src/source/tree-styles.js` 提供三种模式共用的类别和图标。测试见 `tests/test_p3_provider_integration.py`。

## Official feature adoption

- `scripts/providers/api/content.py` 的名称派生由 `scripts/providers/api/store.py` 与索引共用，统一 CLI/MCP/源码树及上传审阅名称。

- `plugins/GuthonNexus/gushen-vscode-completion/src/api/upload-review.js`：原生多选审阅、逐项差异和取消；上传仍由 `plugins/GuthonNexus/gushen-vscode-completion/src/api/source-ui.js` 核对快照并执行。
- `plugins/GuthonNexus/gushen-vscode-completion/src/api/tree-filter.js`：仅展示过滤，保留原节点及父链；源码状态与资源管理器装饰共用 `plugins/GuthonNexus/gushen-vscode-completion/src/api/source-ui.js`。
- `plugins/GuthonNexus/gushen-vscode-completion/src/api/mcp-session-host.js` 与 `scripts/providers/api/session_proxy.py`：独立 MCP 在线工具委派到明确项目的 Nexus 登录会话；不传递登录凭据、不重放请求。
- `plugins/GuthonNexus/gushen-vscode-completion/src/api/mcp-configuration.js`：实际运行入口的 JSONC 配置预览合并、备份及工具发现/在线只读检查。
- `plugins/GuthonNexus/gushen-vscode-completion/src/api/page-custom-editor.js`：原生 PAGE 编辑器入口，复用 `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/controller.js` 的页面会话。
- `plugins/GuthonNexus/gushen-vscode-completion/src/official-assessment.js` 与 `plugins/GuthonNexus/gushen-vscode-completion/data/official-compatibility.json`：官方命令、编辑器、API 和接口差异评估，供 `plugins/GuthonNexus/gushen-vscode-completion/src/official-update.js` 报告使用。
- `docs/api-sync/official-adoption.md`：三批功能、验证及交付边界。

## API source development

当前源码接入统一使用 API。功能矩阵记录尚待完成的集成和验收，不把源码实现当成客户端或平台验收。

| 模块 | 职责 |
|---|---|
| `scripts/common/config_store.py` | 单一配置源、保留旧目录读取，以及预览/确认/备份式配置迁移；不自动迁移真实目录。 |
| `scripts/providers/api/client.py`、`workspace.py` | API 会话实时核验、只读请求登录恢复、验证码、HTTPS 信任、项目配置、待应用范围及目录名称缓存；后端凭据摘要仅驻留内存。 |
| `scripts/providers/api/download.py`、`store.py`、`sync.py` | 按范围下载、应用待同步范围、退出范围预检与备份清理、基线与冲突、上传前合并和平台回读。 |
| `scripts/providers/api/page_source.py` | 结构化 PAGE 的原生 bean/version 读取、版本绑定的基线复用、本地无损 XML 表示、原生 JSON 保存和独立回读；导出 XML 不作保存输入。 |
| `scripts/providers/api/cli.py`、`index.py`、`mcp_server.py` | CLI、索引、按精确源码查询页面/函数使用位置、查询时从已索引源码头和元数据派生过程函数签名及受控 MCP 接口。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/api/login-store.js` | 按 toolHome、workspaceKey 和平台地址隔离的 API 登录信息本地加密存储；由 Nexus 负责保存和恢复。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/api/authentication.js` | 本地加密登录恢复、失败后停止自动尝试、手动登录与当前项目退出；远程平台操作复用单个 ToolHost 的内存会话。 |
| `scripts/providers/api/progress.py` | 通过 stderr 将实际平台请求、应答和持久化阶段传至 Nexus 输出，不记录认证、请求或源码正文。 |
| `scripts/providers/api/module_parameters.py` | 按选中子系统读取模块参数列表并生成单个只读汇总清单；按复合身份加载单条完整 JSON 详情至原有缓存，复用 API 基线、冲突保护和索引。 |
| `scripts/providers/api/module_parameter_editor.py`、`module_parameter_upload.py` | data JSON 投影、保护字段校验、旧只读描述符升级与文档租约；上传预览绑定、普通签出所有者核验、保存后回读、持久待核对门闩及只读恢复，不自动签入。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/api/module-parameter-editor.js` | 模块参数数据编辑、原生差异、本地保存与上传预览确认；共用源码虚拟文件系统的视图/模块参数投影。 |
| `scripts/providers/api/reference_assets.py` | 模块参数汇总清单及官方单据类型/下拉组件各自共享 Markdown 的条目派生、配置引用，以及按工作区读取 API/结构/事件/规则和 PAGE 属性注解；原文件只读。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/api/platform-reference.js` | 按索引代次缓存的工作区 API 参考、补全/悬停与开发参考入口。 |
| `scripts/providers/api/change_bundle.py` | 当前 API 工作区的本地变更包导出、预览和按计划摘要应用；从旧 SVN 工作区切换使用旧侧提交后新侧 API 拉取。 |
| `scripts/providers/api/page.py`、`documents.py`、`editor_state.py` | PAGE 编辑、文档租约开关/续期、预览、幂等写入、原操作回读/索引恢复及编辑器状态协调。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/api/activate.js`、`source-ui.js`、`project-card.js`、`project-actions.js` | 谷神项目卡片常用按钮与设置向导、原生项目菜单及命令面板操作列表、API 项目命令、按类型展示的源码树、过程函数树签名标签、顶层过程函数分类的树形/平铺布局与范围刷新、SCM；文件事件按登记范围处理，目录复用和重复索引短路；轻量卡片不等待全项目扫描。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/official-update.js` | 官方语言资源检查、更新和回退。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/tool-updater.js` | 发行应用更新与回退；仅在合法锁持有者进程被明确判定不存在时恢复遗留锁。 |

## Python

| 模块 | 职责 |
|---|---|
| `scripts/guthon_tool.py` | 统一 CLI、`--home` 契约、命令编排、子命令 parser 构建器与帮助自省、`self-test`。 |
| `scripts/common/gusen_hub.py` | 显式 toolHome、工作区解析、索引连接和共享工具。 |
| `scripts/common/workspace_config.py` | 在开发根 `workspace/` 下登记新项目，管理同步方式和登记删除。 |
| `scripts/common/workspace_layout.py` | 初始化 var Git 根、根规则入口和受管忽略块，校验工作区目录名。 |
| `scripts/common/workspace_assistant.py` | 工作区摘要、就绪状态与助手输出。 |
| `scripts/common/index_bulk.py` | 在完整重建事务内暂停逐行检索索引触发器，批量构建并恢复；失败回滚数据和触发器。 |
| `scripts/common/index_maintenance.py` | 显式预览或压实派生索引，紧凑保存字段集合正文并整理检索索引；保留源码、定位元数据和变更历史。 |
| `scripts/common/source_facts.py` | 源码身份、事实解析与可重建 PAGE 节点/界面字段投影。 |
| `scripts/common/page_projection.py` | PAGE 虚拟文档投影、共享脚本/字段集合提取、语义节点/界面字段描述符及保留已有字段原文的单项插入；共享 PAGE 产品事件解析省略已确认的空继承分块，并供精确继承读取复用。 |
| `scripts/common/inheritance.py` | 过程函数与 PAGE 项目脚本的继承标记识别、有效内容派生与来源片段；派生结果不作为可写物理文件。 |
| `scripts/common/source_format.py` | 源码编解码与格式元数据。 |
| `scripts/common/export_hub_markdown.py` | 全量 Markdown 导出。 |
| `scripts/common/workspace_registry.py` | 工作区身份、存储根、API 路由元数据与同步状态；gusen_hub 公开 API 直接别名到实现。 |
| `scripts/common/workspace_identity.py` | 从共享元数据定义配置 ID 和 workspaceKey 的唯一词法契约。 |
| `scripts/common/build_info.py` | 只用公开后端源码/模板生成稳定构建标识；pyz/发行应用内置 BUILD_INFO。 |
| `scripts/common/credential_vault.py` | 明确范围/确认后的 keyring 加密迁移，拒绝跨工作区共享凭据写入；Node AES-GCM/scrypt 只处理 stdin。 |
| `scripts/common/database_dbx.py` | DBX 公开元数据导入、身份优先调用交接与保守结果规范化；不读取 DBX 凭据。 |
| `scripts/common/database_operations.py` | 脱敏查询历史、目标摘要/TTL 描述缓存、多环境 COUNT 对比与 SQL 模板。 |
| `scripts/common/page_field_search.py` | 可选 PAGE 标签 trigram FTS 与精确子串残余；字段前缀/标签关键词游标保持确定性。 |
| `scripts/common/source_text_search.py` | 私有片段正文及可选紧凑 trigram FTS，显式全量索引版本与部分覆盖。 |
| `scripts/common/pull_history.py` | 工作区/Bridge 拉取历史有界观察窗口，只投影允许的元数据并显式标注缺口。 |
| `scripts/common/parser_feedback.py` | 经显式脱敏确认的最小解析反馈草稿，只写目标私有工作区。 |
| `scripts/common/operation_control.py` | 请求上下文协作取消与原子发布屏障；只读扫描取消必须绕过坏文件异常折叠。 |
| `scripts/common/toolhost_requests.py` | 串行 ToolHost 命令执行期间继续读取取消控制帧，有界队列及请求控制生命周期。 |
| `scripts/common/runtime_paths.py` | 惰性显式 toolHome 与线程请求上下文，帮助不绑定源码根。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/workspace-scheduler.js` | Bridge 按明确工作区串行、最多 4 个工作区并行；有界独立 ToolHost 池，仅回收闲置客户端。 |
| `scripts/common/persistence.py` | 跨线程/进程锁及带 fsync 的原子文本持久化。 |
| `scripts/common/identity_search.py` | 可选 FTS5 身份预筛；短词、Unicode 与旧索引保留原路径。 |
| `scripts/common/cli_output.py` | 显式CLI v1信封和JSON/文本/表格/CSV渲染，保留原有顶层字段。 |
| `scripts/common/command_errors.py` | CLI / ToolHost 语义错误码，区分 SystemExit 原生退出消息。 |
| `scripts/common/database_cli.py` | 数据库命令编排、维护、输出及错误阶段。 |
| `scripts/common/query_xlsx.py` | 仅用标准库生成私有 XLSX 结果/证据双页，字符串不转公式、长整数保留文本，拒绝无查询证据的伪空结果。 |
| `scripts/common/database_sql.py` | SELECT 字面量、CTE、表范围及引擎函数/类型验证。 |
| `scripts/common/command_metadata.json` | CLI/Node 帮助、分类、超时及产出标志的唯一元数据源，构建生成 Nexus 副本。 |
| `scripts/common/database_readonly.py` | 只读数据库连接、凭据引用与诊断目标解析。 |
| `scripts/common/database_test_artifacts.py` | 测试计划/结果校验、评估与摘要；显式 run-readonly 委派执行器。 |
| `scripts/common/database_plan_runner.py` | 内置只读计划执行、前置条件停跑、平台证据门槛与新私有运行工件。 |
| `scripts/check_ai_code_index.py` | 校验本索引引用的路径存在。 |


## Providers

API：`scripts/providers/api/` 提供项目身份、下载、基线、同步、索引、PAGE 和 MCP；`scripts/common/database_exports/` 与 `scripts/common/source_diagnosis.py` 保留独立数据库导出与诊断。

原生 PAGE XML 与 JSON 共用页面模型：`scripts/providers/api/native_page.py` 负责原生编辑模型的本地 XML 表示、投影、原文保留与定向编辑，`scripts/providers/api/content.py` 负责保存和上传的对象身份及继承约束，`scripts/providers/api/page.py` 提供 Nexus 页面快照、字段集合 JSON、预览与受控保存；`scripts/providers/api/inheritance_edit.py` 负责项目脚本继承展开写回的父层核对与幂等记录。

`scripts/providers/api/xml_source.py` 提供 PAGE 与视图共用的 XML 字节位置解析、文本叶节点读取和原文保留；`scripts/providers/api/view_editor.py` 将当前视图的 `/viewSql` 映射为 SQL 虚拟文档，经租约、预览、幂等保存写回同一 checkout 文件。`scripts/providers/api/download.py` 共用解码下载与上传返回对象，并提供 PAGE 站点文件名到本地身份目录的路径映射（原生 PAGE 元数据识别复用）；`scripts/providers/api/sync.py` 核对上传应答的规范源码与独立回读结果，再以提交正文为祖先合并到当前文件。

`scripts/providers/api/local_mutation.py` 记录单文档和批次请求的源码写入阶段；MCP 错误回执保留该事实，`find_document_operation` 按原幂等键只读查找文档操作，供 Hook 核对未知结果。

## Guthon Nexus

`plugins/GuthonNexus/gushen-vscode-completion/src/onboarding.js` 和 `plugins/GuthonNexus/gushen-vscode-completion/src/onboarding-team.js`负责从零安装后的工具／插件环境确认、内网仓库检查与公钥引导；完成后日常不再弹出，不执行业务接入或索引。

`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` 是命令与视图注册入口；`tool-runtime.js` 决定 source-development/script/packaged 命令并写入 runtime descriptor；`tool-process-client.js` 复用 ToolHost，写入期间的读取可使用独立只读进程，不重放写入；`script-runtime.js` 校验本地 Python 与 pyz；`tool-workspace.js` 负责设置/切换及接入已有工作空间；`workspace-registry.js` 与 `workspace-assistant.js` 维护工作区列表；`bridge-process.js` 启停 Bridge；`definition.js`、`selector.js`、`rules.js`、`tool-json-client.js`、`source-mode.js`、`database-config.js`、`tool-updater.js` 分别承担跳转、选择器、补全规则、ToolHost JSON 调用、API 模式识别、数据库配置与发行应用自更新。


PAGE 草稿 `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/model.js` 使用字段/脚本身份索引与修改记录维护差异、50 步撤销和原子批次，不逐次复制整页；输出操作保持基线顺序并继续供原生投影、预检和恢复使用。边界测试位于 `plugins/GuthonNexus/gushen-vscode-completion/test/page-model.test.js`。

PAGE 外部修改与共用代码保存统一使用 `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/source-merge.js`：核对来源、结构、祖先原生身份及属性类型，迁移无冲突草稿并生成三方值报告。`controller.js` 管理新鲜度、逐项选择、恢复记录及最后一次文件核验；`editor.js` 展示外部冲突，原版未确认设置保持画面并暂停保存。测试见 `plugins/GuthonNexus/gushen-vscode-completion/test/page-source-merge.test.js` 和 `plugins/GuthonNexus/gushen-vscode-completion/test/page-editor.test.js`。

PAGE 消息由 `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/state.js` 重建基线及有序变化，`controller.js` 首次发送基线、后续仅发送改变的操作和状态，`editor.js` 局部更新普通属性；消息缺口请求重新同步。恢复历史由 `plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/recovery-store.js` 在明确 IDE 私有存储中写入内容寻址记录，Memento 仅保存引用，导出时展开；控制器只回收已持久化的干净关闭会话，保留草稿、未知保存及运行任务。测试位于 `plugins/GuthonNexus/gushen-vscode-completion/test/page-state.test.js` 和 `plugins/GuthonNexus/gushen-vscode-completion/test/page-recovery-store.test.js`。

Nexus `plugins/GuthonNexus/gushen-vscode-completion/src/output-logging.js` 为工具输出提供逐行毫秒时间戳和单调时钟耗时。


`plugins/GuthonNexus/gushen-vscode-completion/src/diagnosis-history-view.js` 通过共享 ToolJsonClient 按明确工作区读取 diagnosis-list/show，只渲染允许的元数据，并重新验证详情记录 ID；工作区树和命令面板直接提供历史入口，不重跑数据库查询。

`plugins/GuthonNexus/gushen-vscode-completion/src/extension-build.js` 在插件加载时计算公开代码/资源 buildId，并显示状态栏和输出证据。

## Guthon Bridge

`plugins/GuthonBridge/bridge/server.js` 是本地服务入口，读取 `GUTHON_TOOL_HOME`；`plugins/GuthonBridge/extension/` 下 `content.js`、`background.js`、`page-bridge.js`、`workspace-selection.js` 分别负责页面注入与页签变化刷新、后台路由、页面桥与工作区选择。`nexus-locator.js` 为弹窗和页面左下角入口生成 PAGE/过程函数 URI，URI 消费及目录定位依赖 Nexus 的 API 入口接线，以当前构建为准。

Bridge `plugins/GuthonBridge/extension/platform-layout.js` 核对 2.0/1.5 布局与控件结构（兼容版本栏为空）后，按管理页签和实际列表容器（含数据表管理表格/卡片、视图管理、定时任务、单据类型、数据字典）设置滚动布局，由 `content.js` 在主机校验后启停，`bridge.css` 提供列表独立滚动、固定查询/操作区及小屏横向滚动；动态页面挂载、页签切换和窗口缩放触发更新，退出页面或扩展失效时清理。

Bridge `plugins/GuthonBridge/extension/tab-sorter.js` 由 `content.js` 启停，在已知卡片标签栏内拖动排序，仅移动标签头，保留原生编辑器实例；首页与菜单固定。上层功能标签按平台 origin 保存到扩展本地存储，PAGE/过程函数标签仅在当前页面会话保留；观察挂载和重绘恢复顺序，清理时还原原顺序及属性。交互与注入回归见 `plugins/GuthonBridge/extension/tab-sorter.test.js`。

Bridge `plugins/GuthonBridge/extension/task-client.js`、`background.js` 和 `task-history.js` 提供 API 定向刷新任务、轮询恢复及按平台来源隔离的历史；`host-config.js` 维护主机范围。


`plugins/GuthonNexus/gushen-vscode-completion/src/ai-context-export.js` 验证对象/快照并以0600新文件写入当前私有context/ai；`database-config.js` 提供full目标向导与精确ID预检。

## Build and release

- `scripts/build_guthon_tool.py`：PyInstaller 打包，包含配置模板、版本/构建信息、命令元数据、凭据辅助脚本和 doctor 所需的 Nexus 补全数据；macOS 用 onedir 保持可执行文件路径稳定，Windows 用单文件 EXE。
- `scripts/build_script_tool.py`：构建不含第三方依赖和私有数据的 Python zipapp；`scripts/check_toolhost.py` 验证连续请求。
- `scripts/check_nexus_commands.mjs`：校验Nexus贡献、注册、激活、菜单与CLI元数据引用；CI重建后定向检查生成副本diff。
- `scripts/check_release_smoke.py`：用临时 toolHome 检查源码、zipapp 或应用的版本、自检、初始化、doctor 必需资源与 MCP 工具发现（应用可直接传 macOS onedir 目录）；`scripts/check_public_docs.mjs` 校验四份公开 HTML 的脚本、链接、图片、章节目录、页脚内容位置及 QA 数据后再部署 Pages。
- `GuthonCodeTool.spec`：打包配置。
- `scripts/sync_guthon_api.mjs`：从单一 `<toolHome>/config/guthon.json` 读取谷神版本，更新 `<toolHome>/var/nexus/api-reference/谷神方言API/` 与插件补全数据。
- `.github/workflows/release.yml`：按 `[build]` 发布；`.github/scripts/release_plan.py` 按最后发布源码选择全量构建或同版本组件替换，`release_metadata.py` 更新完整附件摘要和发布基线。组件更新保留应用/安装器，只替换受影响附件及签名元数据；不等待 Gitee 镜像。
- 发行说明源文件保存在本机忽略的 `<sourceRoot>/docs/private/releases/`（本机私有资料，不随 Git worktree 分发），仅作为提交和发行正文来源；CI 使用提交说明或手动传入的 `release_notes`，不读取私有目录。开发生成的 `*.vsix` 不跟踪，正式包在 Release 分发；Windows 指南配图继续跟踪，额外原始截图仅保存在忽略的私有目录。
- `scripts/sync_release_to_gitee.py`：维护者本机下载指定 GitHub 签名发行、使用系统钥匙串令牌补传 Gitee 附件、逐项下载核验哈希；`--verify-only` 为无令牌只读验收。`.github/workflows/sync-gitee-release.yml` 复用此入口作为手动备用同步；使用方式见 `docs/RELEASE_MIRROR.md`，本地测试见 `tests/test_sync_gitee_release.py`。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs`：从 API 文档目录生成 `plugins/GuthonNexus/gushen-vscode-completion/data/index.json`。
- `scripts/vault_crypto.mjs`：仅处理明确凭据迁移的标准输入，不创建明文文件；pyz/发行应用包含该公开辅助脚本。
- `scripts/manage_release_signing.mjs`：维护者在仓库外生成专用私钥或验证已有公钥，输出内置信任文件；`scripts/verify_release.mjs` 用受信公钥校验下载目录的全部签名资产。
- `scripts/sign_release.mjs` 与 `plugins/GuthonNexus/gushen-vscode-completion/src/release-signature.js`：外部 Ed25519 私钥签 checksum、固定独立公钥验证；私钥不进入仓库，未配置时不声称签名验证。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-bridge.mjs`：从 Bridge 源码生成 Nexus 内的 Bridge 副本，并从 `scripts/common/command_metadata.json` 生成插件命令元数据。
- `docs/GuthonCodeTool_使用手册.html`、`docs/GuthonCodeTool_Windows安装步骤.html`、`docs/GuthonCodeTool_全功能说明.html`、`docs/GuthonCodeTool_QA.html`：用户操作步骤、Windows 安装步骤、完整能力参考与常见疑问。文档维护按 `AGENTS.md` 的“公开文档分工”选择实际受影响章节，不逐页追加功能说明。

## Validation

首次从源码验证 Nexus 时，在插件目录先执行 `npm install --omit=dev --ignore-scripts --no-audit --no-fund`，确保运行时 JSONC 解析依赖和许可证可供标准打包与本地更新使用。

```bash
python scripts/check_ai_code_index.py
PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests
.venv/bin/python scripts/guthon_tool.py self-test --home "$(mktemp -d)"
node scripts/sync_guthon_api.mjs --self-test
cd plugins/GuthonNexus/gushen-vscode-completion && npm test
cd plugins/GuthonBridge && npm test
```

`var/` 和真实 `config/` 不在本仓库，涉及真实运行数据的验证必须显式传入 `--home` 并保持只读。

Chrome 托管版本回执与更新维护锁由 `plugins/GuthonBridge/bridge/browser-updates.js` 提供；浏览器 `plugins/GuthonBridge/extension/component-client.js` 只重载自己的托管安装，主机规则独立保存在 `plugins/GuthonBridge/extension/host-settings.js`。构建脚本同步本地服务副本。

开发模式本地插件更新由 `plugins/GuthonNexus/gushen-vscode-completion/src/local-update.js` 提供；`plugins/GuthonNexus/gushen-vscode-completion/src/extension-package.js` 定义打包文件、构建标识和规范Bridge副本，供本地快照与 `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-bridge.mjs` 共用。
