# DBX 只读测试流程

仅在当前会话实际提供 DBX 或等价数据库工具时执行。本文件描述能力，不固定工具前缀；先读取当时工具 schema。

## 目标核验

1. 用 `database_test_artifacts.py resolve-target` 按 `workspaceKey + systemId + dataSourceId` 取得唯一 target，并把输出的 `targetDigest` 写入该 target 的核验结果。
2. 列出连接并按精确 connection ID 定位；名称只用于显示。连接不存在时返回 `CONNECTION_MISSING`，不匹配同名新连接。
3. 比较连接类型、端点、database、schema（Oracle 必填）、环境身份与 target 引用的私有环境身份。代理或集群按授权服务身份核验。任何不一致返回 `ENVIRONMENT_MISMATCH`，停止该 target 的全部用例。
4. 显式指定 connection ID 和 database，只读取用例涉及表的 schema。字段、类型或主键与代码/计划不一致时返回 `SCHEMA_DRIFT`，不自动 DDL。

## 查询顺序

1. 执行前再次确认 SQL 只引用 target 的 database 和 `allowedTables`，过滤条件包含已核验租户/业务主键范围。
2. 依次执行 preconditions。断言不满足时记 `PRECONDITION_UNMET`，停止该用例，不触发平台动作；其他独立用例可继续。
3. `query` 直接执行 checks。`platform-result` 先由既有流程提供与当前 `sourceDigest`、target 绑定的版本、关联 ID 和触发证据，再执行 checks。
4. 每次调用保存开始/结束时间、列、行、工具状态、截断状态和原始证据引用。普通查询不需要有状态 session；确需连续上下文时才开启，并在结束或失败时关闭。

DBX 返回上限或格式不能证明完整性时，标为 `rows`、`cell` 或 `unknown`。优先改为 COUNT、聚合或精确主键查询；集合断言不能使用不完整结果。没有可靠取消能力时，不自动重试超时查询。

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

非零退出表示 FAIL 或 BLOCKED。报告只保存脱敏目标摘要和证据引用；真实 SQL 参数、业务记录和 DBX 原始结果留在现有任务私有产物目录，不进入公开仓库或自动暂存。
