# 配置说明

YAML 配置文件首行说明各自用途；`system-data.json` 只是在 DATABASE 拉取时自动生成的本地缓存，SVN 不读取它。

发行模式通常不再手工复制这些模板：先执行 Nexus“设置工作空间”，再用始终可见的“添加产品或项目”向导。首次设置会创建空的
`datasource.yaml`、`products.yaml`、`projects.yaml`，向导在选择 SVN 或 DATABASE 后只生成对应 Nexus，不继续询问登录、checkout 或数据库连接；已有配置不会覆盖。SVN 登录、导入/粘贴 checkout 和范围编辑在新建 Nexus 节点内完成，DATABASE 的 datasource 后续补充。
生成后 Nexus 会询问是否立即调整对应 YAML，因为系统 alias、`system_id`、`data_source_id` 仍须以实际谷神环境为准。

以下完整示例只供维护者手工配置或查阅字段：

```bash
cp config/example/datasource.example.yaml "$GUTHON_HOME/config/datasource.yaml"
cp config/example/products.example.yaml "$GUTHON_HOME/config/products.yaml"
cp config/example/projects.example.yaml "$GUTHON_HOME/config/projects.yaml"
cp config/example/source-tables.example.yaml "$GUTHON_HOME/config/source-tables.yaml"
cp config/example/sync.example.yaml "$GUTHON_HOME/config/sync.yaml"
```

`datasource.yaml` 和 `system-data.json` 不提交。

上面命令在工具源码仓库根执行，`config/example/` 是仓库内的公开模板；真实运行配置和 `var/` 位于仓库之外。本文后续示例中的 `$GUTHON_HOME` 就是**本地数据目录（toolHome）**，与工具源码仓库是两个目录：先 `export GUTHON_HOME=/path/to/toolHome`，工具再通过显式 `--home` 读取其中的 `config/` 和 `var/`。`python scripts/guthon_tool.py setup --home "$GUTHON_HOME"` 会按模板在 `$GUTHON_HOME/config/` 创建缺失文件。

谷神数据库快速排查和功能开发后的只读验证使用独立私有映射。日常从 Nexus 项目的“配置资料 → 配置数据库排查”创建 `diagnosis-only` 目标；连接密码写入操作系统凭据库，不进入 YAML、命令参数或日志。已有 DBX 的用户也可继续填写 `connectionId`。维护者可复制模板手工建立 `full` 正式验证目标：

```bash
cp config/example/database-testing.example.yaml <运行数据-home>/config/database-testing.yaml
```

填写后可用 `scripts/common/database_test_artifacts.py validate-config` 校验。`defaults.diagnosisTargetId` 指定 cwd 未明确环境时的默认诊断库，`defaults.byEnvironment.dev/test` 指定明确环境的默认目标；引用必须指向同一工作区内环境一致的 target。支持 MySQL、PostgreSQL、Oracle，只允许 `dev/test` 与 `read-only`；Oracle 必须明确服务 database 和业务 `schema`。内置连接使用 `connections` + `connectionRef`，DBX 使用 `connectionId`，可并存。`diagnosis-only` 只供快速排查；正式计划必须使用包含 `systemId`、`dataSourceId`、`allowedTables`、`tenantScope` 的 `full` target。完整流程见 [Guthon Testing Skill](../skills/guthon-testing/SKILL.md)，字段契约位于 `config/schema/`。

## sync.yaml

`svn.username` 配置当前本地数据工作区共用的 SVN 用户名，所有产品和项目使用同一个值：

```yaml
svn:
  username: "公共SVN用户名"
```

密码不写入任何 YAML。点击 Nexus 的“设置工作区 SVN 登录”输入一次密码；Nexus 只通过 stdin 传递本次输入，认证成功后由
SVN auth cache/系统钥匙串保存并供所有产品和项目复用。

`rules.pull_diff_check` 缺省为 `true`：Bridge 拉取源码后直接比较 `source/readonly` 与 `source/workcopy`，存在差异时保留 workcopy 并生成差异报告。设为 `false` 后，每次拉取都会直接覆盖 readonly/workcopy，且不生成 `source-meta.json` 或差异文件。

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

## 每个产品/项目的源码来源

`products.yaml`、`projects.yaml` 不配置 `source_mode`。产品与项目是并列工作区；项目是产品某个版本的完整导出快照，其定义完全独立，也不要求先创建产品。Nexus 会在全部产品和项目节点下显示
`源码来源：DATABASE/SVN`；选择结果写入该工作区自己的 `context/source-mode.json`。未选择时默认 DATABASE，
同一个产品/项目同一时刻仍只启用一种源码 provider。

```yaml
products:
  demo-product:
    name: 示例产品
    datasource: demo-product-dev
```

`database` 保持现有源码表、metadata 导出和业务诊断流程。新 `svn` 模式由审阅后的授权清单声明全部精确 URL，
把 `<toolHome>/var/checkout/<配置 ID>` 下的一个或多个物理 working copy 聚合为唯一源码事实来源；不再依赖 datasource 或
系统别名扩大范围，也不生成额外 readonly/workcopy 代码副本。

SVN 示例（紧凑配置）：

```yaml
products:
  demo-product:
    name: 示例产品
    systems:
      include:
        mappings:
          demo.system:
            system_id: SYS-DEMO
            data_source_id: "0000"
    svn:
      # 唯一根地址包含当前账号有权读取的全部目录，默认完整 checkout。
      url: "https://source.example/repo/product"
```

在 Nexus 的该产品节点选择 SVN，紧凑配置直接放在已有的 `products.yaml`（项目则放在 `projects.yaml`）对应条目的
`svn.url` 下，可以手动修改。新增 SVN 产品/项目时粘贴唯一 SVN 根地址或完整 checkout 命令；输入期间不解析，保存并关闭后再解析。该地址已包含当前账号有权限的全部目录，Nexus 不按 `systems.include.mappings` 或 `scope` 缩小检出范围。也可选择谷神平台为它下载的 `svnCheckoutHere.sh`
（macOS/Linux）/`svnCheckoutHere.bat`（Windows）作为一次性导入来源；脚本不会被执行。未显式选择的
`context/svnCheckoutHere.*` 不会被自动读取。Nexus 自动生成只有一个根条目的 `context/authorized-scope.json`，并把唯一真实 working copy 放在
`<toolHome>/var/checkout/<配置 ID>`，因此通常不需要配置 `svn.scope_manifest`、`checkout_layout` 或 `checkout_root`。工作区配置 ID 仍须在产品/项目之间唯一。

旧的逐条 `svn.scope` 配置仍可读取，但新配置只写 `svn.url`。`systems.include.mappings` 继续用于页面身份匹配和业务分组，不参与 SVN checkout 授权或目录过滤。SVN 服务端返回无权限时 checkout 直接失败，不会把同一仓库拆成多个可跳过的 scope。

旧范围配置仍支持完整条目和简单条目（直接增加到产品/项目已有的 `svn:` 块中）：

```yaml
products:
  demo-product:
    svn:
      scope:
        - url: "https://source.example/repo/pages/SYS-1"
          localSubdir: "pages/SYS-1"
          # category、writable 可省略，工具会从 URL/目录推断。
        - "https://source.example/repo/skill skill"
```

旧格式仍可用 `checkoutPaths` 只检出指定子系统：

```yaml
projects:
  demo-project:
    svn:
      scope:
        - url: "https://source.example/repo/project"
          checkoutPaths:
            - skill
            - public
            - systems/SYS-DEMO
            - datasources/0000
```

直接粘贴只有一条根地址的 `svn checkout` 命令时，Nexus 只写入 `svn.url`，并完整检出该地址。

也可以每行直接写 `<url> <localSubdir>`（支持 `->` 或 `=>` 分隔）。配置文件只允许字面量 URL 和相对目录，
不会保存用户名、密码或脚本变量；修改 `svn.url` 后执行“检出/更新完整 SVN 仓库”即可重建当前工作区的内部清单。

Nexus 的“导入/粘贴 SVN checkout 配置”可选择 `.sh/.bat` 或粘贴 checkout 内容，并把唯一根地址写入当前 `products.yaml/projects.yaml` 的 `svn.url`；随后“检出/更新完整 SVN 仓库”会先显示地址及清单变更，确认后再写入脱敏清单、检出或更新。等价 CLI：

```bash
.venv/bin/python scripts/guthon_tool.py source-mode --home "$GUTHON_HOME" --workspace products.demo-product -- set --mode svn
.venv/bin/python scripts/guthon_tool.py workspace-resolve --home "$GUTHON_HOME"  # 在 PRD/PRJ cwd 中解析身份、index.ready 和可复制的有界查询示例
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- scope-preview
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- scope-import  # JSON stdin: {"text":"...","source":"script"}
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- sync-from-script --accept-scope-change
# 已在 products.yaml/projects.yaml 配置 svn.url 后可使用同义入口：
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- sync-from-config --accept-scope-change
```

根 working copy 中的 `systems/<SYSTEM_ID>` 与 `datasources/<DATA_SOURCE_ID>` 会被识别为业务源码目录；`skill/public` 作为公共目录保留。`systems.include.mappings` 只用于身份匹配和展示分组，不改变 checkout 内容。

一次性脚本导入支持 UTF-8/UTF-16/GB18030 BAT 和 UTF-8 shell 脚本，只接受字面量精确 URL 和安全的相对检出目录；会忽略 `rem`、`echo` 与 shell 注释
中的命令以及 `--username`、`--password` 等认证参数。变量 URL、绝对目标目录、重复/重叠 URL、重复/重叠本地目录
或无法识别的业务分类会阻止旧范围格式生成。凭据不会进入地址配置、清单、日志或公开配置。

仅在需要覆盖默认 checkout 根或调整非核心高级能力时，才在产品/项目配置中增加 `svn:` 块。公共用户名只在 `sync.yaml` 的
`svn.username` 配置一次；密码由 Nexus 临时交给 SVN 系统凭据存储。内部 SVN 可使用 HTTPS 自签证书；默认只信任 `unknown-ca`，不放行过期、域名不匹配等异常，维护者可通过 `GUTHON_SVN_TRUSTED_CERT_FAILURES` 显式配置允许集合。Nexus 多 working-copy 模式默认启用 `platform_save`；设置 `svn.capabilities.platform_save: false` 可禁用该提交入口；
保存仍需经过文件选择、内容哈希复核和远程最新状态检查；SVN 提交说明可选，留空可直接保存。

Nexus 的“设置工作区 SVN 登录”读取 `sync.yaml` 中的公共用户名，只弹出一次密码输入框；密码不会进入 VS Code SecretStorage、
YAML、授权清单、参数或日志。认证成功后由 SVN 自身按认证域保存，同一认证域下的所有产品和项目直接复用。

首次初始化和日常刷新：

```bash
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- sync-from-script --accept-scope-change
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- refresh
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- status --diff
.venv/bin/python scripts/guthon_tool.py svn --home "$GUTHON_HOME" --workspace products.demo-product -- status --remote
```

`sync-from-script` 首次检出签出脚本中筛选后的每个精确 URL，全部仓库使用同一份工作区认证；后续更新现有 working copy 并全量建索引。`sync-from-bat` 是 Windows BAT 的命令入口。`refresh` 可用重复的 `--working-copy <entry-id>` 精确选择物理
working copy，有本地修改时必须显式增加 `--merge-local`。普通 `reindex` 只扫描本地文件。新清单布局不接受
`--prune`，范围变更必须先审阅清单和本地目录，工具不会自动删除旧 checkout。
SVN `reindex` 会在输出标签显示授权范围、每个 working copy 的状态/版本/解析进度以及索引事务结果；同一工作区的重复重建操作会被忽略。

## products.yaml / projects.yaml 中的 systems

每个产品、项目分别配置用于限制同步范围的子系统：

```yaml
products:
  demo-product:
    name: 示例产品
    datasource: demo-product-dev
    systems:
      include:
        mappings:
          demo.system:
            system_id: SYS-DEMO
            data_source_id: "0000"
    page_origins: []
```

页面源码按 `source-tables.yaml` 中配置的页面子系统字段过滤。

过程函数按 `source-tables.yaml` 中配置的数据源字段过滤。

DATABASE 的源码、表结构和单据类型拉取会在各自 datasource 的 `gd_system` 中按别名反查系统与数据源 ID。每个 datasource 只在首次使用或别名变化时查询，结果写入 `config/system-data.json`；删除该文件可强制重建缓存。

SVN 不读取 `system-data.json`。产品和项目分别在 `mappings` 中维护自己的映射；alias 直接作为键，每项只有一对一的 `system_id`、`data_source_id`。项目的 `DATA_SOURCE_ID` 可能与产品不同，必须按该项目的签出脚本或平台信息配置。`data_source_id` 应写成字符串，避免 `0000` 被 YAML 解析为数字。

如果多个子系统共用同一个数据源 ID，过程函数只存一份。DATABASE 根目录使用 `mappings` 中第一个匹配子系统的名称，后续重复子系统的 `procedure` 目录会链接到第一个目录。

## source-tables.yaml

页面源码除页面和模块字段外，还需配置模块排序、模型关联、模型名称、模型排序和父模型字段。PAGE 目录按完整模型父子链分组，并使用三位模型/模块序号自然排序；手动拉取会自动迁移路径和清理旧目录。

在项目导出快照内部，过程函数的 `content_field` 配置项目脚本字段，`product_content_field` 配置继承标记对应的产品脚本字段。PAGE 后台脚本的产品快照直接读取 JSON 中与 `script` 同级的 `superScript`。这些字段属于同一个项目快照，不引用产品工作区。

## 多工作区

工具不设置默认工作区。工作区键来自 `products.yaml`、`projects.yaml`，所有工作区命令都必须显式传入：

```bash
.venv/bin/python scripts/guthon_tool.py sync-all --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source-all --home "$GUTHON_HOME" --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home "$GUTHON_HOME" --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py reindex --home "$GUTHON_HOME" --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py export-markdown --home "$GUTHON_HOME" --workspace projects.demo-project
```

目录按显示名称平铺，真实身份始终使用稳定键：

```text
<toolHome>/var/workspace/PRD 示例产品/
<toolHome>/var/workspace/PRJ 示例项目/
```

数据库工作区独立包含 `source/readonly`、`source/workcopy`、`database/{schema,billtype,views}`、`docs` 和
`context/index.db`。SVN 新模式不创建 readonly/workcopy 代码目录，源码来自独立的
根 working copy 的 `entry.localSubdir` 为 `"."`，因此源码直接位于
`<toolHome>/var/checkout/<配置 ID>/`；非根 working copy 位于
`<toolHome>/var/checkout/<配置 ID>/<entry.localSubdir>`。编辑会话只在 `context` 保存身份、独立编辑租约、hash、revision 和格式元数据，
不保存源码正文。同一工作区的短时读写通过带超时的跨进程锁排队；批量自动修改可在 `svn write-batch` 的 JSON
变更计划中直接填写对象身份，由 CLI 自动取得会话；需要先查看多个对象时使用 `svn read-batch`。不得用临时脚本直接改
checkout。状态检查按 provider 的有效步骤计算：数据库为五步，SVN 为本地源码扫描一步。

## 源码逻辑排查

复制排查定义模板到私有 `<toolHome>/var/` 目录后，按已拉取源码填写参数、逻辑步骤和查询 SQL：

```bash
cp config/example/source-diagnosis.example.json "$GUTHON_HOME/var/diagnosis/cases/<排查名称>.json"
.venv/bin/python scripts/guthon_tool.py diagnose --home "$GUTHON_HOME" \
  --workspace products.demo-product -- "$GUTHON_HOME/var/diagnosis/cases/<排查名称>.json"
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `<toolHome>/var/docs/业务排查文档/<日期>/`。完整参数、数据库、原生 SQL 和查询结果保存在报告中；终端只输出状态、停止步骤、结论和报告路径。

## 目标维护与凭据来源

`setup` 同时创建空 `database-testing.yaml`，不绑定任何真实数据库。`database-target-list` 不读取密码，列出全部目标及选中依据；支持全局 `--workspace` 显式选择，未传时按 `--path` 解析。`database-target-configure` 的 JSON 可仅给已有 `targetId` 和新 `password`，其余连接字段沿用；目标顺序、引用及默认选择保持稳定。新增正式目标使用 `validationScope: full`，必须给出 `systemId/dataSourceId/allowedTables/tenantScope/evidenceRef`；已有正式目标更换连接身份也要提供新证据，不能复用旧探测结果。

连接可声明 `credentialRef`、`passwordEnv`、`passwordFile`，后两项为显式本机来源，文件路径须为绝对路径。keyring 引用存在时优先使用；仅在配置了 fallback 时才允许回退。`datasource.yaml` 的源码同步链路复用相同解析器，已有 password 字段继续兼容。不要把密码输入 shell 参数；configure JSON 从 stdin 输入。配置保存串行加锁且原子替换；无 PyYAML 的依赖最小运行模式保存 JSON（合法 YAML 子集），加载器明确支持该格式，不会误送迷你 YAML 解析器。

目标删除先用 `database-target-remove --target-id <id> --check` 预览，正式删除要求 `--confirmation <id>`。只移除失去引用的连接、身份和凭据；如果凭据清理失败，错误明确区分“配置已删除”和“密码未清理”。切换密码来源后旧 keyring 项不会自动清理，需本地核查。DBX connectionId 不等于内置 connectionRef；resolve 会预告后续内置 probe/query 不可用，不能把 UUID 当作端点配置。

快速单连接排查使用 `database-diagnose`，无 SQL 时只探测，`--stdin`、`--sql`、`--sql @file.sql` 和 `--sql-file` 按互斥入口使用。查询只允许单条 SELECT/保守 CTE，跨库与未知函数/类型被拒绝；不支持 dollar-quote、Oracle 替代引号、引用标识符、嵌套 WITH 和反斜线字面量。legacy `diagnose` 专用于案例文件，报告默认参数脱敏。测试工件的 `validate-config/resolve-target/validate-plan/evaluate/init-plan` 已注册为 `database-test-artifacts` 子命令；init-plan 输出是必须补全源码摘要与验收值的草稿，不能视为验证已通过。

正式查询计划经 validate-plan 后可用统一 CLI 的 `database-test-artifacts run-readonly <plan> --config <private-config> --out-dir <new-private-run>` 执行内置只读目标；结果只写新私有目录，前置条件失败或截断不继续检查。DBX-only 计划使用交接与 capture 导入。平台版本和触发证据须由原流程提供；需要清理的用例不能交由只读执行器关闭。

查询可用 `--format xlsx --output <private-path>.xlsx` 导出不含公式的结果页和证据页。XLSX 要求实际查询结果、明确完整性和工具仓库外的文件，不将 DBX handoff/probe 伪装为空结果。长整数以文本保留；截断提示与详情留在证据页。格式不支持的 XML 字符明确拒绝，不覆盖已有文件；查询列名重复时需先使用不同 SQL 别名，避免字典转换丢失值。

Nexus 已内置发行公钥 `data/release-trust.json`，普通使用者无配置步骤。维护者可在 globalStorage 增加受信公钥，不能降低内置强制验签或覆盖同 ID 密钥；私钥不进入本仓库。CI 私钥 Secret/key ID Variable 须与内置公钥匹配；发行失败不会自动放宽签名策略。

MySQL/PostgreSQL 的 `database-query-readonly/database-diagnose --explain` 只取校验后 SELECT 的有界估计计划，不执行 ANALYZE 或业务查询，返回 queryExecuted=false。Oracle因EXPLAIN写计划表明确拒绝。导出器比较规范化内容，只覆写有变化的table/view对象，导出摘要仍按本次读取对象计数，不等于改变文件数。

0.3.0 Nexus向导可明确选择排查或正式验证；full目标须提供系统/数据源、表范围、租户字段与证据、真实身份证据。重复target ID在向导中预检并明确确认更新；后端仍进行最终校验。模板 `--case-out <private-case.json> --datasource <name> --source-evidence <ref>` 只生成草稿不连接，必须审阅业务条件后显式draft=false再执行。
