# 本地配置参考

真实运行配置和业务数据保存在显式指定的本地数据目录 <code>&lt;toolHome&gt;</code>；仓库中的 `config/example/` 仅提供公开示例。通过 `setup --home <toolHome>` 初始化。新目录只生成 `config/guthon.json`；已有配置保持原样，不自动合并。日常从 Nexus 的“项目设置”向导调整拉取范围、平台连接和数据库目标，不需要逐个编辑配置文件。

`guthon.json` 是统一模式唯一有效配置源，包含 `products`、`projects`、`sync`、`datasource`、`databaseTesting`、`apiWorkspaces`。凭据仍通过原有系统凭据或环境引用处理。旧目录可在“项目设置 → 配置文件 → 合并为单一配置文件”先预览，再确认；原配置备份到 `config/archive/`，成功后不再作为活动配置读取。迁移失败或归档未完成时按返回结果检查当前文件和备份，不重复覆盖。

公开空配置样例见 [guthon.example.json](example/guthon.example.json)。下文中的旧文件名称也是对应配置分区的参考；旧模式继续支持这些文件，统一模式通过同一向导和 CLI 读写 `guthon.json`。

## 产品与项目

`products.yaml`、`projects.yaml` 注册名称、稳定 ID 和可选别名；身份分别为 `products.<id>`、`projects.<id>`，ID 在两类配置中唯一。每个项目使用独立 API 地址、系统与共享数据源范围；在 Nexus 或 `api configure --stdin` 设置，不将账号密码写进 YAML。默认源码目录为 `<toolHome>/var/checkout/<配置ID>`，可通过项目 `api.checkout_root` 指定绝对根；API 配置及远端基线位于对应工作区 `context/api/`。

明确选择全部或指定子系统；空选择不会自动拉取全部。Nexus 范围向导会自动同步新范围并刷新索引；将移出范围的文件有本地修改时先停止，用户处理并重新选择后才备份清理已同步文件；CLI 的 `api scope-apply --stdin` 提供同一流程，`api configure` 仍用于单独保存设置。关联数据源和显式共享数据源的对象按数据源粒度处理。密码通过标准输入和可选系统凭据库处理；本地保存、上传回读及业务验收分别核对。

## sync.yaml

`guthon_api` 保存谷神方言文档资源的版本及本机 bundle 位置，供 `scripts/sync_guthon_api.mjs` 使用；它不控制业务源码同步。

## datasource.yaml

配置产品库、项目库和独立测试库。数据源键名统一使用“对象 ID-环境”，`name` 统一使用“项目名_环境”。Nexus 会从连接地址自动填写 `type`、`host`、`port`、`database`，当前支持 MySQL、MariaDB 和 PostgreSQL：

```text
demo-product-dev   -> 示例产品_开发
demo-product-test  -> 示例产品_测试
demo-project-dev   -> 示例项目_开发
```

测试数据源必须额外配置：

```yaml
object: products.demo-product
environment: test
diagnosis:
  enabled: true
  query_only: true
databases:
  - demo_basic
  - demo_trade
```

源码排查脚本只连接同时满足 `environment: test`、`diagnosis.enabled: true` 和 `diagnosis.query_only: true` 的数据源。`databases` 是该测试服务器允许查询的数据库白名单，开发库不配置 `diagnosis`。

## 源码逻辑排查

复制排查定义模板到私有 `<toolHome>/var/` 目录后，按已拉取源码填写参数、逻辑步骤和查询 SQL：

```bash
cp config/example/source-diagnosis.example.json "$GUTHON_HOME/var/diagnosis/cases/<排查名称>.json"
.venv/bin/python scripts/guthon_tool.py diagnose --home "$GUTHON_HOME" \
  --workspace products.demo-product -- "$GUTHON_HOME/var/diagnosis/cases/<排查名称>.json"
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `<toolHome>/var/docs/业务排查文档/<日期>/`。报告保存在私有目录，默认对绑定参数脱敏；终端只输出状态、停止步骤、结论和报告路径。

## 目标维护与凭据来源

新目录的 `setup` 创建空 `databaseTesting` 分区，不绑定任何真实数据库；旧模式继续使用 `database-testing.yaml`。`database-target-list` 不读取密码，列出全部目标及选中依据；支持全局 `--workspace` 显式选择，未传时按 `--path` 解析。`database-target-configure` 的 JSON 可仅给已有 `targetId` 和新 `password`，其余连接字段沿用；目标顺序、引用及默认选择保持稳定。新增正式目标使用 `validationScope: full`，必须给出 `systemId/dataSourceId/tenantScope/evidenceRef`，`allowedTables` 为可选提示；已有正式目标更换连接身份也要提供新证据，不能复用旧探测结果。

连接可声明 `credentialRef`、`passwordEnv`、`passwordFile`，后两项为显式本机来源，文件路径须为绝对路径。keyring 引用存在时优先使用；仅在配置了 fallback 时才允许回退。独立数据库诊断和只读单据类型导出按目标配置解析连接。不要把密码输入 shell 参数；configure JSON 从 stdin 输入。配置保存串行加锁且原子替换；无 PyYAML 的依赖最小运行模式保存 JSON（合法 YAML 子集），加载器明确支持该格式，不会误送迷你 YAML 解析器。

目标删除先用 `database-target-remove --target-id <id> --check` 预览，正式删除要求 `--confirmation <id>`。只移除失去引用的连接、身份和凭据；如果凭据清理失败，错误明确区分“配置已删除”和“密码未清理”。切换密码来源后旧 keyring 项不会自动清理，需本地核查。DBX connectionId 不等于内置 connectionRef；resolve 会预告后续内置 probe/query 不可用，不能把 UUID 当作端点配置。

快速单连接排查使用 `database-diagnose`，无 SQL 时只探测，`--stdin`、`--sql`、`--sql @file.sql` 和 `--sql-file` 按互斥入口使用。查询只允许单条 SELECT/保守 CTE，跨库与未知函数/类型被拒绝；不支持 dollar-quote、Oracle 替代引号、引用标识符、嵌套 WITH 和反斜线字面量。legacy `diagnose` 专用于案例文件，报告默认参数脱敏。测试工件的 `validate-config/resolve-target/validate-plan/evaluate/init-plan` 已注册为 `database-test-artifacts` 子命令；init-plan 输出是必须补全源码摘要与验收值的草稿，不能视为验证已通过。

正式查询计划经 validate-plan 后可用统一 CLI 的 `database-test-artifacts run-readonly <plan> --config <private-config> --out-dir <new-private-run>` 执行内置只读目标；结果只写新私有目录，前置条件失败或截断不继续检查。DBX-only 计划使用交接与 capture 导入。平台版本和触发证据须由原流程提供；需要清理的用例不能交由只读执行器关闭。

查询可用 `--format xlsx --output <private-path>.xlsx` 导出不含公式的结果页和证据页。XLSX 要求实际查询结果、明确完整性和工具仓库外的文件，不将 DBX handoff/probe 伪装为空结果。长整数以文本保留；截断提示与详情留在证据页。格式不支持的 XML 字符明确拒绝，不覆盖已有文件；查询列名重复时需先使用不同 SQL 别名，避免字典转换丢失值。

Nexus 已内置发行公钥 `data/release-trust.json`，普通使用者无配置步骤。维护者可在 globalStorage 增加受信公钥，不能降低内置强制验签或覆盖同 ID 密钥；私钥不进入本仓库。CI 私钥 Secret/key ID Variable 须与内置公钥匹配；发行失败不会自动放宽签名策略。

MySQL/PostgreSQL 的 `database-query-readonly/database-diagnose --explain` 只取校验后 SELECT 的有界估计计划，不执行 ANALYZE 或业务查询，返回 queryExecuted=false。Oracle因EXPLAIN写计划表明确拒绝。导出器比较规范化内容，只覆写有变化的table/view对象，导出摘要仍按本次读取对象计数，不等于改变文件数。

0.3.0 Nexus向导可明确选择排查或正式验证；full目标须提供系统/数据源、表范围、租户字段与证据、真实身份证据。重复target ID在向导中预检并明确确认更新；后端仍进行最终校验。模板 `--case-out <private-case.json> --datasource <name> --source-evidence <ref>` 只生成草稿不连接，必须审阅业务条件后显式draft=false再执行。
