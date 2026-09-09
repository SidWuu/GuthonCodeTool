---
name: gushen-development-testing
description: Develop or fix GuShen business functionality and verify it with explicitly mapped read-only development or test databases. Use for 谷神需求理解、功能开发、数据库验证、平台结果核验; do not use for generic repository tooling work or production database operations.
---

# 谷神开发与数据库测试

用户明确要求优先于本 Skill。继续使用当前项目的谷神开发规则与源码 provider；本 Skill 只补充开发后的数据库测试闭环，不另建开发流程。

## 开发入口

1. 读取目标目录的 `AGENTS.md`，并按其中路由加载谷神基线、模块/运行模式、实际 API、业务事实、当前 provider 源码和结构资料。
2. 使用显式 `workspaceKey`，保留开始时已有差异；按需求完成理解、验收条件、调用链分析、实现、静态检查和定向回归。
3. DATABASE 只修改 workcopy；SVN 只通过已授权读写会话修改并定向刷新索引。不要用数据库测试切换或回退源码 provider。
4. 本地保存、SVN working-copy 修改、平台提交和平台运行是不同证据。需要平台行为验证时，先取得待测代码实际生效的版本和触发证据。

## 进入数据库测试

从开发产物提取 `taskId`、`workspaceKey`、`sourceMode`、相关源码摘要、验收条件、系统/数据源路由、涉及表、租户字段和业务主键。缺少动态路由时只阻塞依赖该目标的用例，不重复整份需求分析。

读取 [DBX 执行流程](references/dbx-workflow.md)。创建私有 `database-test-plan.json`，契约见仓库 `config/schema/database-test-plan.schema.json`，参考 [演示计划](assets/database-test-plan.example.json)。先运行：

```bash
PYTHONPATH=scripts .venv/bin/python scripts/common/database_test_artifacts.py validate-plan \
  <database-test-plan.json> --config <descriptor.home>/config/database-testing.yaml
```

真实连接由 DBX 管理。映射只保存在 `<descriptor.home>/config/database-testing.yaml`；从仓库 `config/example/database-testing.example.yaml` 复制后替换占位值。不要询问、读取、复制或输出密码。

使用工作区、实际 `systemId` 和 `dataSourceId` 解析唯一 target。没有匹配返回 `BINDING_MISSING`，多个匹配返回 `BINDING_AMBIGUOUS`；不得按连接名称、目录、同名表或上次连接隐式选择。

## 执行和反馈

- 只用专用只读账号执行可确认安全的 MySQL/Oracle `SELECT`；Oracle 目标必须同时核验连接数据库和业务 schema。不执行 DML、DDL、存储过程、锁、副作用函数或自动清理；不连接生产环境。
- 先核验 connection ID、端点、database、环境身份、相关表结构和租户范围，再执行业务查询。连接成功本身不代表目标正确。
- `query` 用例只证明当前库的数据与查询条件。保存、确认、取消、事件和调度通常使用 `platform-result`：由既有流程发布并触发，DBX 只查询前后状态和最终结果。
- 结果规范化为仓库 `config/schema/database-test-results.schema.json`；必须保留原始工具证据引用和 `none/rows/cell/unknown` 完整性。不能补造缺失行或把工具错误当空结果。
- 用本地模块计算断言并生成 `database-test-report.md`。若源码摘要、计划摘要、target 映射或平台版本变化，创建新 runId 并重跑受影响用例，不覆盖历史报告。
- 将 `ASSERTION_FAILED`、`SCHEMA_DRIFT`、`PRECONDITION_UNMET`、`VERSION_UNVERIFIED` 等具体证据返回原开发流程。先分类原因，再修改代码；不要放宽断言制造通过。

## 完成标准

所有必需用例均为 PASS、平台用例具有可核验版本/触发证据且必要清理完成时，才能称为数据库测试闭环通过。真实 DBX 工具、连接、平台入口或授权缺失时，完成不依赖它们的开发和计划校验，并明确标记 BLOCKED；不得声称真实业务验证完成。
