---
name: guthon-testing
description: Diagnose GuShen development or test database issues through GuthonCodeTool's built-in read-only connector or optional DBX, and develop or verify GuShen business functionality against explicitly mapped targets. Use for 数据库排查、开发库、测试库、DBX、谷神需求开发、数据库验证、平台结果核验; do not use for generic tooling work or production databases.
---

# Guthon 开发与数据库测试

用户明确要求优先于本 Skill。继续使用当前项目的谷神开发规则与源码 provider。本 Skill 包含快速只读排查和正式数据库验证两种模式，不把普通排查强制升级为测试计划或源码修改。

## 模式选择

- 用户要求“排查、看看为什么、查开发库/测试库、用 DBX 看数据”时使用快速排查。默认只读，不创建测试计划，不修改源码或数据。
- 用户要求功能开发、修复后验收、回归或数据库测试闭环时，先完成开发入口，再使用正式验证。
- 用户只要求分析时，数据库证据只能用于定位和解释；不得据此扩大为修复、发布或数据处理。

## 开发入口

1. 读取目标目录的 `AGENTS.md`，并按其中路由加载谷神基线、模块/运行模式、实际 API、业务事实、当前 provider 源码和结构资料。
2. 使用显式 `workspaceKey`，保留开始时已有差异；按需求完成理解、验收条件、调用链分析、实现、静态检查和定向回归。
3. DATABASE 只修改 workcopy；SVN 只通过已授权读写会话修改并定向刷新索引。不要用数据库测试切换或回退源码 provider。
4. 本地保存、SVN working-copy 修改、平台提交和平台运行是不同证据。需要平台行为验证时，先取得待测代码实际生效的版本和触发证据。

## 自动解析数据库目标

读取本地数据目录（toolHome）的 `var/nexus/tool-runtime.json`，使用其中的 `databaseTargetResolveCommand`，追加 `--path <当前 cwd>`。`toolHome` 是保存真实 `config/` 和私有 `var/` 的目录，与工具源码仓库分开；找不到该文件时按 Nexus 的“设置工作空间”确认，不要自行拼接 Python、应用或配置路径，也不要把业务单号、SQL 或完整问题文本放入进程参数。

- 明确出现“开发库、开发环境、dev”时追加 `--environment dev`。
- 明确出现“测试库、测试环境、test”时追加 `--environment test`；“测试一下”不视为环境选择。
- 同时要求对比开发库和测试库时分别解析两个目标并分环境查询。
- 未明确环境时不传 `--environment`，使用工作区的 `diagnosisTargetId`。
- 解析失败或歧义时只询问缺少的项目/环境，不要求用户重新描述连接。

目标解析后按目标字段选择适配器：存在 `connectionRef` 且 runtime descriptor 提供内置数据库命令时优先使用内置适配器；只有 `connectionId` 时使用当前会话实际提供的 DBX。两者都不可用时返回 `CONNECTOR_UNAVAILABLE`，并提示用户从 Nexus 的工作区“配置资料 → 配置数据库排查”完成一次配置，不要求重新描述连接。

内置适配器用 `databaseProbeCommand`、`databaseDescribeCommand`、`databaseQueryCommand`，均追加与目标解析相同的 `--path` 和可选环境。SQL 只通过 `databaseQueryCommand` 的 JSON 标准输入传递：`{"sql":"...","maxRows":100}`，不得放入命令参数。DBX 首次查询前仍按精确 `connectionId` 核验引擎、端点、database；Oracle 还要核验业务 schema。与 `expectedIdentity` 不一致时返回 `ENVIRONMENT_MISMATCH` 并停止。

## 快速数据库排查

读取 [数据库执行流程](references/database-workflow.md) 的快速排查部分。先简短告知本次选择的工作区、开发/测试环境和实际适配器，再从本地索引定位相关源码、表、租户字段和业务主键。陌生表或字段先读取结构，再执行有业务主键或租户范围的只读查询。

正式计划的 `allowedTables` 不限制快速排查；快速排查可查询本地索引已关联的表，或用户明确点名且已在目标 database/schema 中完成结构核验的表。不得跨目标 database/schema 扩张查询。

输出区分源码、数据库、平台版本和运行证据。连接成功、查无数据或静态源码结论都不能单独证明根因；结果受 100 行上限影响时优先改用 COUNT、聚合或精确主键查询。

## 正式数据库验证

从开发产物提取 `taskId`、`workspaceKey`、`sourceMode`、相关源码摘要、验收条件、系统/数据源路由、涉及表、租户字段和业务主键。缺少动态路由时只阻塞依赖该目标的用例，不重复整份需求分析。

读取 [数据库执行流程](references/database-workflow.md)。创建私有 `database-test-plan.json`，契约见仓库 `config/schema/database-test-plan.schema.json`，参考 [演示计划](assets/database-test-plan.example.json)。先运行：

```bash
PYTHONPATH=scripts .venv/bin/python scripts/common/database_test_artifacts.py validate-plan \
  <database-test-plan.json> --config <descriptor.home>/config/database-testing.yaml
```

真实连接由 DBX 或 GuthonCodeTool 内置只读适配器管理。映射只保存在 `<descriptor.home>/config/database-testing.yaml`；内置密码只保存在操作系统凭据库。不要询问用户在对话中粘贴密码，也不要读取、复制或输出密码。

正式计划继续使用工作区、实际 `systemId` 和 `dataSourceId` 解析唯一 target，并严格限制在声明的 `allowedTables`。没有匹配返回 `BINDING_MISSING`，多个匹配返回 `BINDING_AMBIGUOUS`。

## 执行和反馈

- 只用专用只读账号执行可确认安全的 MySQL/PostgreSQL/Oracle `SELECT`；Oracle 目标必须同时核验连接数据库和业务 schema。不执行 DML、DDL、存储过程、锁、副作用函数或自动清理；不连接生产环境。
- 先核验 `connectionRef` 或 connection ID、端点、database、环境身份、相关表结构和租户范围，再执行业务查询。连接成功本身不代表目标正确。
- `query` 用例只证明当前库的数据与查询条件。保存、确认、取消、事件和调度通常使用 `platform-result`：由既有流程发布并触发，数据库适配器只查询前后状态和最终结果。
- 结果规范化为仓库 `config/schema/database-test-results.schema.json`；必须保留原始工具证据引用和 `none/rows/cell/unknown` 完整性。不能补造缺失行或把工具错误当空结果。
- 用本地模块计算断言并生成 `database-test-report.md`。若源码摘要、计划摘要、target 映射或平台版本变化，创建新 runId 并重跑受影响用例，不覆盖历史报告。
- 将 `ASSERTION_FAILED`、`SCHEMA_DRIFT`、`PRECONDITION_UNMET`、`VERSION_UNVERIFIED` 等具体证据返回原开发流程。先分类原因，再修改代码；不要放宽断言制造通过。

## 完成标准

所有必需用例均为 PASS、平台用例具有可核验版本/触发证据且必要清理完成时，才能称为数据库测试闭环通过。真实数据库连接、平台入口或授权缺失时，完成不依赖它们的开发和计划校验，并明确标记 BLOCKED；不得声称真实业务验证完成。
