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
- CLI 统一入口：`python scripts/guthon_tool.py <command> --home <toolHome>`；命令参数自省用 `help <command>` 或 `<command> --help`。
- runtime descriptor：`<toolHome>/var/nexus/tool-runtime.json`；linter：`<toolHome>/var/tools/guthon-lint`。

## Task to files

| 需求 | 首选文件 | 常见联动 | 测试 |
|---|---|---|---|
| CLI 命令与参数 | `scripts/guthon_tool.py` | `scripts/common/gusen_hub.py` | `tests/test_guthon_tool.py` |
| 工作区配置/创建 | `scripts/common/workspace_config.py` | `scripts/common/gusen_hub.py` | `tests/test_workspace_config.py` |
| 工作区路由与解析 | `scripts/common/workspace_registry.py` | `scripts/providers/svn/nexus/workspace.py` | `tests/test_workspace_routing.py` |
| 工作区助手/状态摘要 | `scripts/common/workspace_assistant.py` | `scripts/common/gusen_hub.py` | `tests/test_workspace_assistant_features.py` |
| DATABASE 拉取/导出 | `scripts/providers/database/export_table_schema_sql.py` | `scripts/common/gusen_hub.py` | `tests/test_export_table_schema_sql.py` |
| DATABASE 只读排查 | `scripts/common/database_readonly.py` | `scripts/providers/database/run_source_diagnosis.py` | `tests/test_run_source_diagnosis.py` |
| 数据库 CLI / 目标管理 / 单连接排查 | `scripts/common/database_cli.py` | `scripts/common/database_readonly.py`、`scripts/common/database_sql.py`、`scripts/guthon_tool.py` | `tests/test_audit_regressions.py` |
| 数据库查询 XLSX 结果与证据导出 | `scripts/common/query_xlsx.py` | `scripts/common/database_cli.py`、`scripts/common/persistence.py` | `tests/test_audit_regressions.py` |
| Nexus 最近诊断历史视图 | `plugins/GuthonNexus/gushen-vscode-completion/src/diagnosis-history-view.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js`、`scripts/common/database_operations.py` | `plugins/GuthonNexus/gushen-vscode-completion/test/diagnosis-history-view.test.js` |
| 数据库测试计划/结果 | `scripts/common/database_test_artifacts.py` | `config/schema/database-testing.schema.json` | `tests/test_database_test_artifacts.py` |
| Workcopy | `scripts/common/workcopy_store.py` | `scripts/common/gusen_hub.py`（公开门面/运行时覆盖） | `tests/test_workcopy.py` |
| 上下文有界查询 | `scripts/common/query_hub_context.py` | `scripts/providers/svn/nexus/index_queries.py` | `tests/test_gusen_hub.py` |
| SVN 检出与范围导入 | `scripts/providers/svn/checkout.py` | `scripts/providers/svn/scope_import.py` | `tests/test_svn_scope_import.py` |
| SVN 索引与浏览 | `scripts/providers/svn/nexus/catalog.py` | `scripts/providers/svn/nexus/documents.py`（会话写入与内部 PAGE 操作记录） | `tests/test_svn_nexus_workspace.py` |
| 通用有界源码读取 / 摘要 / 索引健康度 | `scripts/providers/svn/nexus/source_queries.py` | `scripts/providers/svn/nexus/mcp_server.py`、`scripts/common/workspace_assistant.py` | `tests/test_svn_nexus_workspace.py` |
| SVN PAGE 语义节点/界面字段与 MCP | `scripts/providers/svn/nexus/page_nodes.py` | `scripts/common/page_projection.py`、`scripts/common/source_facts.py`、`scripts/providers/svn/nexus/page_mutation.py`（节点编辑租约）、`scripts/providers/svn/nexus/page_field_mutation.py`（单字段新增/拷贝）、`scripts/providers/svn/nexus/mcp_server.py`、`scripts/guthon_tool.py` | `tests/test_page_semantics.py`、`tests/test_page_mcp.py`、`tests/test_svn_nexus_workspace.py` |
| SVN 过程函数 MCP 读写 | `scripts/providers/svn/nexus/procedure_sources.py` | `scripts/providers/svn/nexus/procedure_mutation.py`、`scripts/providers/svn/nexus/documents.py`（共享租约/写回与操作记录）、`scripts/providers/svn/nexus/mcp_server.py` | `tests/test_svn_nexus_workspace.py`、`tests/test_page_mcp.py` |
| SVN 项目继承源码 | `scripts/common/inheritance.py` | `scripts/common/page_projection.py`、`scripts/providers/svn/nexus/inheritance_sources.py`、`scripts/providers/svn/nexus/catalog.py`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/virtual-fs.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/inheritance-view.js` | `tests/test_svn_inheritance.py`、`tests/test_svn_nexus_workspace.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/svn-virtual-fs.test.js` |
| SVN SCM/差异/写回 | `scripts/providers/svn/nexus/scm.py` | `scripts/providers/svn/writeback.py` | `tests/test_svn_provider.py` |
| Nexus 运行模式/toolHome | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-runtime.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-workspace.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/tool-runtime.test.js` |
| ToolHost 与三运行模式 | `scripts/guthon_tool.py` | `plugins/GuthonNexus/gushen-vscode-completion/src/tool-process-client.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/script-runtime.js`、`scripts/build_script_tool.py` | `tests/test_toolhost.py`、`tests/test_build_script_tool.py`、`plugins/GuthonNexus/gushen-vscode-completion/test/tool-process-client.test.js` |
| Nexus UI 命令 | `plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` | `plugins/GuthonNexus/gushen-vscode-completion/package.json` | `plugins/GuthonNexus/gushen-vscode-completion/test/rules.test.js` |
| Nexus SVN 集成 | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/backend-client.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/scm-manager.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/svn-backend-client.test.js` |
| Nexus 方言辅助、影响预览与 PAGE/过程函数定位 | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/editor-assistance.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/svn/impact-preview.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/page-locator.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/activate.js` | `plugins/GuthonNexus/gushen-vscode-completion/test/editor-assistance.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/impact-preview.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/page-locator.test.js` |
| Bridge 服务端与持久异步任务 | `plugins/GuthonBridge/bridge/server.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/bridge-process.js` | `plugins/GuthonBridge/bridge/server.test.js` |
| Nexus → 平台定位、有界 pageContext 与 Bearer SSE | `plugins/GuthonBridge/bridge/page-context.js` | `plugins/GuthonBridge/extension/event-client.js`、`plugins/GuthonBridge/extension/background.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/browser-navigation.js` | `plugins/GuthonBridge/bridge/page-context.test.js`、`plugins/GuthonBridge/bridge/navigation-server.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/browser-navigation.test.js` |
| Chrome Bridge 扩展与 PAGE/过程函数定位入口 | `plugins/GuthonBridge/extension/content.js`、`plugins/GuthonBridge/extension/popup.js` | `plugins/GuthonBridge/extension/page-bridge.js`、`plugins/GuthonBridge/extension/nexus-locator.js`、`plugins/GuthonBridge/extension/background.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/svn/page-locator.js` | `plugins/GuthonBridge/bridge/server.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/page-locator.test.js` |
| 发行构建 | `scripts/build_guthon_tool.py` | `GuthonCodeTool.spec` | `tests/test_build_guthon_tool.py` |
| 谷神 API 补全数据 | `scripts/sync_guthon_api.mjs` | `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs` | 两个脚本的 `--self-test` |
| 三组件更新 | `plugins/GuthonNexus/gushen-vscode-completion/src/update-center.js` | `plugins/GuthonNexus/gushen-vscode-completion/src/component-update.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/release-catalog.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/update-archive.js`、`plugins/GuthonNexus/gushen-vscode-completion/src/tool-updater.js`、`scripts/build_release_catalog.mjs` | `plugins/GuthonNexus/gushen-vscode-completion/test/component-update.test.js`、`plugins/GuthonNexus/gushen-vscode-completion/test/update-center.test.js` |
| 环境自检 | `scripts/common/doctor.py` | `scripts/guthon_tool.py` | `scripts/guthon_tool.py self-test --home <临时目录>` |

## Python

| 模块 | 职责 |
|---|---|
| `scripts/guthon_tool.py` | 统一 CLI、`--home` 契约、命令编排、子命令 parser 构建器与帮助自省、`self-test`。 |
| `scripts/common/gusen_hub.py` | 工作区解析、索引连接、同步、Workcopy、状态与自动暂存的共享实现；`workspace_agent_context` 输出 `indexFirst` 可运行示例。 |
| `scripts/common/workspace_config.py` | 工作区创建/删除与 YAML 读写。 |
| `scripts/common/workspace_assistant.py` | 工作区摘要、就绪状态与助手输出。 |
| `scripts/common/source_facts.py` | 源码身份、事实解析与可重建 PAGE 节点/界面字段投影。 |
| `scripts/common/index_schema_comments.py` | SQLite 索引表及字段的可查询注释。 |
| `scripts/common/page_projection.py` | PAGE 虚拟文档投影、共享脚本/字段集合提取、语义节点/界面字段描述符及保留已有字段原文的单项插入。 |
| `scripts/common/inheritance.py` | 过程函数与 PAGE 项目脚本的继承标记识别、有效内容派生与来源片段；派生结果不作为可写物理文件。 |
| `scripts/common/source_format.py` | 源码编解码与格式元数据。 |
| `scripts/common/export_hub_markdown.py` | 全量 Markdown 导出。 |
| `scripts/common/workspace_registry.py` | 工作区身份、存储根、provider 选择、路由元数据与同步状态；gusen_hub 公开 API 直接别名到实现。 |
| `scripts/common/workspace_identity.py` | 从共享元数据定义配置 ID 和 workspaceKey 的唯一词法契约。 |
| `scripts/common/build_info.py` | 只用公开后端源码/模板生成稳定构建标识；pyz/发行应用内置 BUILD_INFO。 |
| `scripts/common/credential_vault.py` | 明确范围/确认后的 keyring 加密迁移，拒绝跨工作区共享凭据写入；Node AES-GCM/scrypt 只处理 stdin。 |
| `scripts/common/database_dbx.py` | DBX 公开元数据导入、身份优先调用交接与保守结果规范化；不读取 DBX 凭据。 |
| `scripts/common/database_operations.py` | 脱敏查询历史、目标摘要/TTL 描述缓存、多环境 COUNT 对比与 SQL 模板。 |
| `scripts/common/source_changes.py` | 500 个已提交索引代次的新增/修改/删除元数据与固定边界分页。 |
| `scripts/common/page_field_search.py` | 可选 PAGE 标签 trigram FTS 与精确子串残余；字段前缀/标签关键词游标保持确定性。 |
| `scripts/common/source_text_search.py` | 私有片段正文及可选紧凑 trigram FTS，显式全量索引版本与部分覆盖。 |
| `scripts/common/pull_history.py` | 工作区/Bridge 拉取历史有界观察窗口，只投影允许的元数据并显式标注缺口。 |
| `scripts/common/parser_feedback.py` | 经显式脱敏确认的最小解析反馈草稿，只写目标私有工作区。 |
| `scripts/common/operation_control.py` | 请求上下文协作取消与原子发布屏障；只读扫描取消必须绕过坏文件异常折叠。 |
| `scripts/common/toolhost_requests.py` | 串行 ToolHost 命令执行期间继续读取取消控制帧，有界队列及请求控制生命周期。 |
| `scripts/common/runtime_paths.py` | 惰性显式 toolHome 与线程请求上下文，帮助不绑定源码根。 |
| `plugins/GuthonNexus/gushen-vscode-completion/src/workspace-scheduler.js` | Bridge 按明确工作区串行、最多 4 个工作区并行；有界独立 ToolHost 池，仅回收闲置客户端。 |
| `scripts/common/persistence.py` | 跨线程/进程锁及带 fsync 的原子文本持久化。 |
| `scripts/common/source_store.py` | DATABASE 镜像与 SQLite 的备份、回滚及进程中断恢复。 |
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

`scripts/common/workcopy_store.py` 负责镜像比较、保护/覆盖备份、回收恢复与 Workcopy CLI，gusen_hub 直接别名保持公开入口及 host override。

## Providers

DATABASE：

- `scripts/providers/database/export_table_schema_sql.py`（表结构）、`export_bill_type_sql.py`（单据类型）、`export_view_sql.py`（视图）、`export_system_script_sql.py`（系统脚本）。
- `scripts/providers/database/_export_common.py`：共享输出规范化、精确产出登记和最近 100 条导出摘要。
- `scripts/common/gusen_hub.py`：由统一 CLI 的 pull/create-workcopy/workcopy/sync-source 编排；退役的仅转发脚本不再分发。
- `scripts/providers/database/run_source_diagnosis.py`：只读业务排查执行器。

SVN：

- `scripts/providers/svn/cli.py`：按生命周期、文档、索引查询、PAGE查询、SCM、维护分组的 action→handler 编排；统一 CLI 注入原进度/reindex 回调。

- `scripts/providers/svn/checkout.py`：检出/更新、操作锁与 working copy 清单。
- `scripts/providers/svn/scanner.py`、`projection.py`、`group_inference.py`、`dedup.py`：扫描、虚拟文档投影、模块归并与去重。
- `scripts/providers/svn/writeback.py`：受控写回与差异校验。
- `scripts/providers/svn/nexus/edit_sessions.py`：会话加载、结构校验与活跃租约容量；`operation_records.py`：共享日志 schema、原子保存和 phase 时间。documents 保留直接 API 别名与物理写回内核；损坏会话不重建。
- `scripts/providers/svn/nexus/edit_leases.py`：未过期、源码未变更的租约续期与精确释放；`operation_maintenance.py`：有界巡检与确认后归档完成记录，拒绝 pending、损坏或活动租约记录。
- `scripts/providers/svn/nexus/page_nodes.py`、`page_mutation.py`、`page_field_mutation.py`、`mcp_server.py`：PAGE 节点/界面字段有界查询、未解析映射及引用风险诊断、源码新鲜度核验、编辑租约、受控节点写入及同集合单字段新增/拷贝；MCP 提供显式 `--read-only`，CLI `svn page-query` 和 Nexus 后端共用查询层。
- `scripts/providers/svn/nexus/procedure_sources.py`、`procedure_mutation.py`：独立于 PAGE 投影的 SVN 对象索引就绪检查、过程函数无会话有界读取/调用方证据、精确身份编辑租约、预览和幂等本地写入；共用 `documents.py` 的授权与物理文件写回内核。
- `scripts/providers/svn/nexus/inheritance_sources.py`：基于授权索引与两层源码哈希，有界读取项目原文、产品原文和展开内容；Nexus `virtual-fs.js` 默认将展开内容投影到项目可编辑标签页，并按编辑范围决定保留标记或物化，同时校验产品哈希；`diff-content.js` 将相同投影用于虚拟编辑器 Quick Diff 基线，物理 SVN diff 不变；`catalog.py` 将 `.inherit.gss` 记为独立物理产品层，但从逻辑过程函数目录和可写入口排除。
- `scripts/providers/svn/nexus/source_queries.py`（无租约当前读、批读、分页对象摘要与健康度）、`catalog.py`、`documents.py`、`index_queries.py`、`manifest.py`、`scm.py`、`workspace.py`、`bootstrap.py`：Nexus 目录、文档与内部 PAGE 操作记录、有界查询、清单、SCM 与工作区初始化。

## Guthon Nexus

`plugins/GuthonNexus/gushen-vscode-completion/src/extension.js` 是命令与视图注册入口；`tool-runtime.js` 决定 source-development/script/packaged 命令并写入 runtime descriptor；`tool-process-client.js` 复用 ToolHost，长写入期间可延迟启动独立只读进程，不重放写入；`script-runtime.js` 校验本地 Python 与 pyz；`tool-workspace.js` 负责设置/切换及接入已有工作空间；`workspace-registry.js` 与 `workspace-assistant.js` 维护工作区列表；`bridge-process.js` 启停 Bridge；`definition.js`、`selector.js`、`rules.js`、`tool-json-client.js`、`source-mode.js`、`database-config.js`、`tool-updater.js` 分别承担跳转、选择器、补全规则、ToolHost JSON 调用、源码模式、数据库配置与发行应用自更新。

Nexus `plugins/GuthonNexus/gushen-vscode-completion/src/svn/quick-open.js` 负责单工作区/唯一候选直接定位；`plugins/GuthonNexus/gushen-vscode-completion/src/svn/bounded-cache.js` 为虚拟文档、差异和继承提供有界缓存，打开的文档保留租约。

`plugins/GuthonNexus/gushen-vscode-completion/src/svn/page-locator.js` 验证平台定位 URI 和精确对象分享链接；URI 不携带本机路径或租约。

`plugins/GuthonNexus/gushen-vscode-completion/src/pull-history-view.js` 渲染拉取历史；`plugins/GuthonNexus/gushen-vscode-completion/src/svn/editor-assistance.js` 融合本地函数、PAGE 字段与过程函数索引候选，取消或文档变更时丢弃迟到结果。

`plugins/GuthonNexus/gushen-vscode-completion/src/diagnosis-history-view.js` 通过共享 ToolJsonClient 按明确工作区读取 diagnosis-list/show，只渲染允许的元数据，并重新验证详情记录 ID；工作区树和命令面板直接提供历史入口，不重跑数据库查询。

`plugins/GuthonNexus/gushen-vscode-completion/src/extension-build.js` 在插件加载时计算公开代码/资源 buildId，并显示状态栏和输出证据。

## Guthon Bridge

`plugins/GuthonBridge/bridge/server.js` 是本地服务入口，读取 `GUTHON_TOOL_HOME`；`plugins/GuthonBridge/extension/` 下 `content.js`、`background.js`、`page-bridge.js`、`workspace-selection.js` 分别负责页面注入与页签变化刷新、后台路由、页面桥与工作区选择。`nexus-locator.js` 为弹窗和页面左下角入口生成 PAGE/过程函数 URI，Nexus `activate.js` 的 URI handler 复用 `page-locator.js` 的精确定位流程。

Bridge `plugins/GuthonBridge/extension/task-client.js` 与 `background.js` 实现短请求提交/轮询及 worker 重启恢复；`host-config.js` 验证显式 IPv4/IPv6 范围，不扩大默认授权。`plugins/GuthonBridge/extension/task-history.js` 保存有界成功目标元数据，重拉丢弃旧 force/confirmation，固定原平台来源。

`plugins/GuthonBridge/bridge/page-context.js` 保留有界、有租约的身份快照及不重放的导航回执；`plugins/GuthonBridge/extension/event-client.js` 用 Bearer fetch 解析 SSE；Nexus `plugins/GuthonNexus/gushen-vscode-completion/src/svn/browser-navigation.js` 明确选择工作区平台页签并复用 page-bridge 的精确对象导航。浏览器正文不进入快照，来源/工作区在服务端及浏览器重新校验；DOM 事件替代编辑器扫描，元数据心跳只用于租约和 worker 恢复。

`plugins/GuthonNexus/gushen-vscode-completion/src/ai-context-export.js` 验证对象/快照并以0600新文件写入当前私有context/ai；`database-config.js` 提供full目标向导与精确ID预检。

## Build and release

- `scripts/build_guthon_tool.py`：PyInstaller 打包，只打包 `config/example` 与 `VERSION`；macOS 用 onedir 保持可执行文件路径稳定，Windows 用单文件 EXE。
- `scripts/build_script_tool.py`：构建不含第三方依赖和私有数据的 Python zipapp；`scripts/check_toolhost.py` 验证连续请求。
- `scripts/check_nexus_commands.mjs`：校验Nexus贡献、注册、激活、菜单与CLI元数据引用；CI重建后定向检查生成副本diff。
- `scripts/check_release_smoke.py`：用临时 toolHome 检查源码、zipapp 或应用的版本、自检、初始化与 MCP 工具发现（应用可直接传 macOS onedir 目录）；`scripts/check_public_docs.mjs` 校验四份公开 HTML 与图片引用后再部署 Pages。
- `GuthonCodeTool.spec`：打包配置。
- `scripts/sync_guthon_api.mjs`：从 `<toolHome>/config/sync.yaml` 读取谷神版本，更新 `<toolHome>/var/docs/谷神方言API/` 与插件补全数据。
- `.github/workflows/release.yml`、`.github/scripts/sync_gitee_release.sh`：按 `[build]` 构建并发布 GitHub/Gitee Release；Gitee 附件同步可重复执行，`.github/workflows/sync-gitee-release.yml` 从既有 GitHub Release 手动补齐指定 tag 的镜像附件。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-data.mjs`：从 API 文档目录生成 `plugins/GuthonNexus/gushen-vscode-completion/data/index.json`。
- `scripts/vault_crypto.mjs`：仅处理明确凭据迁移的标准输入，不创建明文文件；pyz/发行应用包含该公开辅助脚本。
- `scripts/manage_release_signing.mjs`：维护者在仓库外生成专用私钥或验证已有公钥，输出内置信任文件；`scripts/verify_release.mjs` 用受信公钥校验下载目录的全部签名资产。
- `scripts/sign_release.mjs` 与 `plugins/GuthonNexus/gushen-vscode-completion/src/release-signature.js`：外部 Ed25519 私钥签 checksum、固定独立公钥验证；私钥不进入仓库，未配置时不声称签名验证。
- `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-bridge.mjs`：从 Bridge 源码生成 Nexus 内的 Bridge 副本，并从 `scripts/common/command_metadata.json` 生成插件命令元数据。
- `docs/GuthonCodeTool_使用手册.html`、`docs/GuthonCodeTool_Windows安装步骤.html`、`docs/GuthonCodeTool_全功能说明.html`、`docs/GuthonCodeTool_QA.html`：用户手册、Windows 安装子页面、全功能说明与 QA 页，行为变化时同步。

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

Chrome 托管版本回执与更新维护锁由 `plugins/GuthonBridge/bridge/browser-updates.js` 提供；浏览器 `plugins/GuthonBridge/extension/component-client.js` 只重载自己的托管安装，主机规则独立保存在 `plugins/GuthonBridge/extension/host-settings.js`。构建脚本同步本地服务副本。

开发模式本地插件更新由 `plugins/GuthonNexus/gushen-vscode-completion/src/local-update.js` 提供；`plugins/GuthonNexus/gushen-vscode-completion/src/extension-package.js` 定义打包文件、构建标识和规范Bridge副本，供本地快照与 `plugins/GuthonNexus/gushen-vscode-completion/scripts/build-bridge.mjs` 共用。
