# 本地配置参考

真实运行配置和业务数据保存在显式指定的本地数据目录 <code>&lt;toolHome&gt;</code>；仓库中的 `config/example/` 仅提供公开示例。通过 `setup --home <toolHome>` 初始化。新目录只生成 `config/guthon.json`；已有配置保持原样，不自动合并。日常从 Nexus 的“项目设置”向导调整拉取范围、平台连接和数据库目标，不需要逐个编辑配置文件。

新目录生成 `schemaVersion: 3` 的 `guthon.json`，包含 `workspaces`、`sync`、`datasource`、`databaseTesting`、`apiWorkspaces` 和 `sourceTables`。已有 API schema 2 保持版本与原文，不在加载时升级。完整的旧分类 YAML 可只读接入公共解析，包括 `source-tables.yaml` 字段映射；`setup` 核验已有旧配置后直接返回，不初始化 Git 或重写目录。旧 JSON schema 1、不支持的版本及统一 JSON 与活动 YAML 同时存在会报错，不自动回退或转换。凭据仍使用原引用。

公开配置样例见 [guthon.example.json](example/guthon.example.json)。新数据目录初始化使用样例中 PAGE、过程函数和系统脚本的默认字段映射。以下名称是统一配置中的分区，不代表独立活动配置文件。

项目总览展示已登记的 API、SVN 与 DATABASE。各模式使用既有的授权和路径规则。SVN 优先读项目的 `svn.username`，缺省时沿用共享 `sync.svn.username`，并使用工作副本设置和授权清单。DATABASE 项目的主数据连接通过 `workspaces[workspaceKey].datasource` 绑定，系统凭据库通过 `credentialRef` 引用。DATABASE 从 `sourceTables` 或旧 `source-tables.yaml` 读取字段映射，从 `sync.sync` 和 `sync.rules` 读取增量与 Workcopy 保护设置。统一配置省略增量策略时，沿用 10 分钟回看窗口。完整更新在建立数据库连接和打开索引前检查 PAGE、过程函数与系统脚本的字段映射。配置格式升级和项目同步方式切换各有独立的验收条件。


新建空间时，Nexus 可直接初始化 IDE 当前打开的开发目录。其上一级是 `toolHome`，配置写入 `<toolHome>/config/guthon.json`。命令行等价入口为 `setup --home <toolHome> -- --workspace-directory <目录名>`。非默认名称保存在 schema 3 的 `workspaceDirectory` 字段中，已有空间沿用原目录，未指定时继续使用 `var`。

## 工作区

`workspaces` 以稳定 workspaceKey 为键，记录 `name`、`directory`、`aliases`。`directory` 相对于开发根，新增登记保存为 `workspace/<项目目录>`，原来直接登记的单级目录和显式绝对 `root` 仍按原路径解析。schema 3 还要求每项明确 `sourceMode` 为 `api`、`svn` 或 `database`；API schema 2 的原登记继续按 API 解析。创建只需名称，默认生成 `ws_` 加 UUID 的稳定 key，也可显式提供 ID、单级目录名和别名。CLI 的 `directory` 入参填写单级目录名，由创建命令添加 `workspace/`。新项目目录名应避开受管目录名，例如 `context` 和 `runtime`。每个工作区独立设置 API 地址、系统与数据源范围，凭据不写入公开配置。默认布局的 API 和 SVN 项目源码位于 `<开发根>/workspace/<项目目录>/checkout/`；显式登记的 SVN checkout 路径与旧分类项目按原配置解析。同级 `context/` 保存索引、基线、冲突与回执，`runtime/` 保存日志和缓存，`docs/` 初始为空。`context/` 中除可重建索引外的恢复记录必须保留。

明确选择全部或指定子系统；空选择不会自动拉取全部。首次同步前，Nexus 范围向导先保存选择，由“更新源码”启动拉取和索引；已同步项目切换范围时，向导同时同步源码并刷新索引。将移出范围的文件有本地修改时先停止，用户处理并重新选择后才备份清理已同步文件；CLI 的 `api scope-apply --stdin` 提供同一流程，`api configure` 仍用于单独保存设置。关联数据源和显式共享数据源的对象按数据源粒度处理。密码通过标准输入和可选系统凭据库处理；本地保存、上传回读及业务验收分别核对。

### 公共解析字段

- `configuration` 返回格式、版本和权威路径；`workspaceBinding` 是来源绑定摘要，随 provider、源码路径、平台或范围变化而改变。它供受控入口重新核验，不表示所有旧会话停用流程已完成。
- `sourceRoots` 区分 API checkout、SVN 已授权 working copy、DATABASE readonly/workcopy。schema 3 可通过绝对 `root` 和 `paths` 保留旧位置；`paths` 支持 `contextDir`、`runtimeDir`、`docsDir` 和适用的 `checkoutPath`。旧 YAML 的默认路径和 source-mode 优先级不变。
- `providerCapabilities` 是目标配置声明；`capabilities` 是当前后端可用入口，`executionReady` 表示当前后端提供该模式的执行入口。索引就绪情况另看 `index.ready`；SVN/DATABASE 继续读取旧索引格式。
- `workspaces` 与 `workspace-resolve` 返回局部 `configErrors`，异常项目不影响无冲突的其他项目；无法解析的整份配置仍报全局错误。源码绑定变化的核验使用当前权威配置，不把同一个 key 视为旧租约仍有效。

### 旧配置读取范围

完整旧空间需要 `products.yaml`、`projects.yaml`、`sync.yaml`、`datasource.yaml`、`source-tables.yaml`。`database-testing.yaml` 若已配置，继续使用原文件。读取不会新增统一 JSON、运行记录或业务目录；同时存在活动统一 JSON 和任何旧配置文件时明确报 `CONFIG_AUTHORITY_CONFLICT`。旧 YAML 和 API schema 2 可使用离线配置升级命令。

升级旧配置时，`sourceTables` 保留原 `source-tables.yaml` 中的 `source_tables`。运行适配仍输出 `source_tables.source_tables` 供 DATABASE 调用。不同主库表结构需配置匹配的映射。


### 显式升级到 schema 3

以下示例从工具源码目录执行。使用已选择的本地数据目录替换 `<toolHome>`。先预览登记与路径，关闭写入同一目录的 IDE 窗口、Bridge、ToolHost、MCP 和其他旧入口，再用实际预览 ID 确认发布。

```bash
python scripts/guthon_tool.py configuration-upgrade --home "<toolHome>" -- plan
python scripts/guthon_tool.py configuration-upgrade --home "<toolHome>" -- apply --offline --confirm "<planId>"
```

命令重新核对源配置和有效工作区映射，备份保存在 `config/.configuration-upgrades/<transactionId>/`。升级后的旧模式项目用 `legacyConfig` 记录原 provider 参数，显式 `sourceMode` 仍保持原模式。工作副本、索引、项目名、环境变量和凭据引用沿用原配置。确认新后端能列出原项目后，在 Nexus 重新连接该目录。

若出现 `CONFIG_UPGRADE_PENDING`，先保持原写入入口关闭，再核对状态并使用其返回的事务 ID 恢复。

```bash
python scripts/guthon_tool.py configuration-upgrade --home "<toolHome>" -- status
python scripts/guthon_tool.py configuration-upgrade --home "<toolHome>" -- recover --offline --confirm "<transactionId>"
```

发布前中断恢复原配置，发布后中断以已发布的 JSON 完成登记。摘要不符时保留现场核对。SVN 源码迁移以单个项目为单位，命令与标准输入见 [SVN 切换参考](../docs/GuthonCodeTool_全功能说明.html#svn-api-migration-reference)。

## sync

`guthon_api` 保存谷神方言文档资源的版本及本机 bundle 位置，供 `scripts/sync_guthon_api.mjs` 使用；它不控制业务源码同步。

## datasource

配置产品库、项目库和独立测试库。数据源键名统一使用“对象 ID-环境”，`name` 统一使用“项目名_环境”。Nexus 会从连接地址自动填写 `type`、`host`、`port`、`database`，当前支持 MySQL、MariaDB 和 PostgreSQL：

```text
demo-product-dev   -> 示例产品_开发
demo-product-test  -> 示例产品_测试
demo-project-dev   -> 示例项目_开发
```

测试数据源必须额外配置：

```yaml
object: ws_demo
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
  --workspace ws_demo -- "$GUTHON_HOME/var/diagnosis/cases/<排查名称>.json"
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `<toolHome>/var/docs/业务排查文档/<日期>/`。报告保存在私有目录，默认对绑定参数脱敏；终端只输出状态、停止步骤、结论和报告路径。

## 目标维护与凭据来源

新目录的 `setup` 创建空 `databaseTesting` 分区，不绑定任何真实数据库。`database-target-list` 不读取密码，列出全部目标及选中依据；支持全局 `--workspace` 显式选择，未传时按 `--path` 解析。`database-target-configure` 的 JSON 可仅给已有 `targetId` 和新 `password`，其余连接字段沿用；目标顺序、引用及默认选择保持稳定。新增正式目标使用 `validationScope: full`，必须给出 `systemId/dataSourceId/tenantScope/evidenceRef`，`allowedTables` 为可选提示；已有正式目标更换连接身份也要提供新证据，不能复用旧探测结果。

连接可声明 `credentialRef`、`passwordEnv`、`passwordFile`，后两项为显式本机来源，文件路径须为绝对路径。keyring 引用存在时优先使用；仅在配置了 fallback 时才允许回退。独立数据库诊断和只读单据类型导出按目标配置解析连接。不要把密码输入 shell 参数；configure JSON 从 stdin 输入。配置保存串行加锁且原子替换；无 PyYAML 的依赖最小运行模式保存 JSON（合法 YAML 子集），加载器明确支持该格式，不会误送迷你 YAML 解析器。

目标删除先用 `database-target-remove --target-id <id> --check` 预览，正式删除要求 `--confirmation <id>`。只移除失去引用的连接、身份和凭据；如果凭据清理失败，错误明确区分“配置已删除”和“密码未清理”。切换密码来源后旧 keyring 项不会自动清理，需本地核查。DBX connectionId 不等于内置 connectionRef；resolve 会预告后续内置 probe/query 不可用，不能把 UUID 当作端点配置。

快速单连接排查使用 `database-diagnose`，无 SQL 时只探测，`--stdin`、`--sql`、`--sql @file.sql` 和 `--sql-file` 按互斥入口使用。查询只允许单条 SELECT/保守 CTE，跨库与未知函数/类型被拒绝；不支持 dollar-quote、Oracle 替代引号、引用标识符、嵌套 WITH 和反斜线字面量。legacy `diagnose` 专用于案例文件，报告默认参数脱敏。测试工件的 `validate-config/resolve-target/validate-plan/evaluate/init-plan` 已注册为 `database-test-artifacts` 子命令；init-plan 输出是必须补全源码摘要与验收值的草稿，不能视为验证已通过。

正式查询计划经 validate-plan 后可用统一 CLI 的 `database-test-artifacts run-readonly <plan> --config <private-config> --out-dir <new-private-run>` 执行内置只读目标；结果只写新私有目录，前置条件失败或截断不继续检查。DBX-only 计划使用交接与 capture 导入。平台版本和触发证据须由原流程提供；需要清理的用例不能交由只读执行器关闭。

查询可用 `--format xlsx --output <private-path>.xlsx` 导出不含公式的结果页和证据页。XLSX 要求实际查询结果、明确完整性和工具仓库外的文件，不将 DBX handoff/probe 伪装为空结果。长整数以文本保留；截断提示与详情留在证据页。格式不支持的 XML 字符明确拒绝，不覆盖已有文件；查询列名重复时需先使用不同 SQL 别名，避免字典转换丢失值。

Nexus 已内置发行公钥 `data/release-trust.json`，普通使用者无配置步骤。维护者可在 globalStorage 增加受信公钥，不能降低内置强制验签或覆盖同 ID 密钥；私钥不进入本仓库。CI 私钥 Secret/key ID Variable 须与内置公钥匹配；发行失败不会自动放宽签名策略。

MySQL/PostgreSQL 的 `database-query-readonly/database-diagnose --explain` 只取校验后 SELECT 的有界估计计划，不执行 ANALYZE 或业务查询，返回 queryExecuted=false。Oracle因EXPLAIN写计划表明确拒绝。导出器比较规范化内容，只覆写有变化的table/view对象，导出摘要仍按本次读取对象计数，不等于改变文件数。

0.3.0 Nexus向导可明确选择排查或正式验证；full目标须提供系统/数据源、表范围、租户字段与证据、真实身份证据。重复target ID在向导中预检并明确确认更新；后端仍进行最终校验。模板 `--case-out <private-case.json> --datasource <name> --source-evidence <ref>` 只生成草稿不连接，必须审阅业务条件后显式draft=false再执行。
