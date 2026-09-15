# 数据库只读测试流程

使用 GuthonCodeTool 内置只读适配器，或当前会话实际提供的 DBX。Skill 只负责选择和编排，不携带驱动、连接地址或凭据。

## 快速排查

1. 从 runtime descriptor 的 `databaseTargetResolveCommand` 解析 cwd；环境由用户明确用词决定，未明确时使用工作区默认目标。对比两个环境时分别解析。
2. 有 `connectionRef` 时执行 `databaseProbeCommand` 核验目标，随后使用 `databaseDescribeCommand` 和 `databaseQueryCommand`。只有 `connectionId` 时，列出 DBX 连接并按精确 ID 核验类型、端点和 database。Oracle 始终使用解析出的业务 schema 限定对象；登录 schema 不等于业务 schema。
3. 从工作区本地索引定位相关源码和表。陌生表先读取目标 schema 中的结构。内置查询会拒绝目标 schema 中不存在或不可见的表。
4. 使用精确业务主键、租户范围、COUNT 或聚合执行只读诊断。普通排查不创建 `database-test-plan.json`；结论中保留环境、适配器、表结构/查询证据和未验证边界。

快速排查只允许可确认安全的单条 `SELECT`。不得执行 DML、DDL、存储过程、锁、副作用函数、消息发送或自动清理；不得连接生产环境。内置查询最大返回 100 行，单元格也会截断；出现 `rows` 或 `cell` 时缩小查询，而不是假定结果完整。

## 正式验证目标核验

1. 用 `database_test_artifacts.py resolve-target` 按 `workspaceKey + systemId + dataSourceId` 取得唯一 `full` target，并把输出的 `targetDigest` 写入该 target 的核验结果。`diagnosis-only` target 不能代替正式验证目标。
2. 使用 target 的可用适配器；DBX 按精确 connection ID 定位，内置适配器按 connectionRef 定位。任何引擎、端点、database 或 schema 不一致均返回 `ENVIRONMENT_MISMATCH`。
3. 显式绑定目标，只读取用例涉及表的 schema。字段、类型或主键与代码/计划不一致时返回 `SCHEMA_DRIFT`，不自动 DDL。

## 查询顺序

1. 执行前确认 SQL 只引用 target 的 database/schema 和 `allowedTables`，过滤条件包含已核验租户/业务主键范围。
2. 依次执行 preconditions。断言不满足时记 `PRECONDITION_UNMET`，停止该用例，不触发平台动作；其他独立用例可继续。
3. `query` 直接执行 checks。`platform-result` 先由既有流程提供与当前 `sourceDigest`、target 绑定的版本、关联 ID 和触发证据，再执行 checks。
4. 每次调用保存开始/结束时间、列、行、工具状态、截断状态和原始证据引用。普通查询不需要有状态 session。

结果不完整时标为 `rows`、`cell` 或 `unknown`。优先改为 COUNT、聚合或精确主键查询；集合断言不能使用不完整结果。没有可靠取消能力时，不自动重试超时查询。

## 规范化与报告

将结果保存为私有 `database-test-results.json`，参考 [演示结果](../assets/database-test-results.example.json)。`planDigest` 由下面命令的输出取得：

```bash
PYTHONPATH=scripts .venv/bin/python scripts/common/database_test_artifacts.py validate-plan \
  <database-test-plan.json> --config <database-testing.yaml>
```

执行断言并生成报告：

```bash
PYTHONPATH=scripts .venv/bin/python scripts/common/database_test_artifacts.py evaluate \
  <database-test-plan.json> <database-test-results.json> \
  --config <database-testing.yaml> --report <database-test-report.md>
```

非零退出表示 FAIL 或 BLOCKED。报告只保存脱敏目标摘要和证据引用；真实 SQL 参数、业务记录和原始结果留在现有任务私有产物目录，不进入公开仓库或自动暂存。
