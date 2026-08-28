# 配置说明

YAML 配置文件首行说明各自用途；`system-data.json` 只是在 DATABASE 拉取时自动生成的本地缓存，SVN 不读取它。

复制模板后再填写真实配置：

```bash
cp config/example/datasource.example.yaml config/datasource.yaml
cp config/example/products.example.yaml config/products.yaml
cp config/example/projects.example.yaml config/projects.yaml
cp config/example/source-tables.example.yaml config/source-tables.yaml
cp config/example/sync.example.yaml config/sync.yaml
```

`datasource.yaml` 和 `system-data.json` 不提交。

## sync.yaml

`rules.pull_diff_check` 缺省为 `true`：Bridge 拉取源码后直接比较 `source/readonly` 与 `source/workcopy`，存在差异时保留 workcopy 并生成差异报告。设为 `false` 后，每次拉取都会直接覆盖 readonly/workcopy，且不生成 `source-meta.json` 或差异文件。

## datasource.yaml

配置产品库、项目库和独立测试库。数据源键名统一使用“对象 ID-环境”，`name` 统一使用“项目名_环境”：

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

`products.yaml`、`projects.yaml` 不配置 `source_mode`。Nexus 会在全部产品和项目节点下显示
`源码来源：DATABASE/SVN`；选择结果写入该工作区自己的 `context/source-mode.json`。未选择时默认 DATABASE，
同一个产品/项目同一时刻仍只启用一种源码 provider。

```yaml
products:
  demo-product:
    name: 示例产品
    datasource: demo-product-dev
```

`database` 保持现有源码表、metadata 导出和业务诊断流程。新 `svn` 模式由审阅后的授权清单声明全部精确 URL，
把 `var/checkout/<配置 ID>` 下的一个或多个物理 working copy 聚合为唯一源码事实来源；不再依赖 datasource 或
系统别名扩大范围，也不生成额外 readonly/workcopy 代码副本。

SVN 示例：

```yaml
products:
  demo-product:
    name: 示例产品
```

在 Nexus 的该产品节点选择 SVN，再把谷神平台下载的 `svnCheckoutHere.sh`（macOS/Linux）或 `svnCheckoutHere.bat`（Windows）放到该工程的 `context/`。两种文件均为正式支持格式。Nexus 自动使用
`context/authorized-scope.json` 和 `var/checkout/<配置 ID>`，因此通常不需要配置 `svn.scope_manifest`、
`checkout_layout` 或 `checkout_root`。工作区配置 ID 仍须在产品/项目之间唯一。

Nexus 的“从签出脚本检出/更新 SVN”会先显示清单条目及增删改数量，确认后再写入脱敏清单、检出或更新。等价 CLI：

```bash
.venv/bin/python scripts/guthon_tool.py source-mode --home . --workspace products.demo-product -- set --mode svn
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- scope-preview
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- sync-from-script --accept-scope-change
```

配置了 `systems.include.mappings` 时，签出脚本仍是授权上限，但实际清单只保留该映射明确声明的范围：
`systems/<SYSTEM_ID>` 聚合 `pages` 与 `system-script`，
`datasources/<DATA_SOURCE_ID>` 聚合 `procedures`、`tables` 与 `views`，`skill/public` 作为公共目录保留。映射缺失或格式无效时会在检出前
阻断，并要求为每个别名提供 `system_id` 和 `data_source_id`；映射 ID 不在签出脚本
中时则要求提供同一产品、同一账号最新下载的脚本，或说明对应源码分类确实不存在。

导入器支持 UTF-8/UTF-16/GB18030 BAT 和 UTF-8 shell 脚本，只接受字面量精确 URL 和安全的相对检出目录；会忽略 `rem`、`echo` 与 shell 注释
中的命令以及 `--username`、`--password` 等认证参数。变量 URL、绝对目标目录、重复/重叠 URL、重复/重叠本地目录
或无法识别的业务分类都会阻止生成。签出脚本不会被执行，凭据不会进入清单、日志或公开配置，移出清单的旧 working
copy 也不会自动删除。

仅在需要覆盖默认 checkout 根、共享凭据环境变量名或调整非核心高级能力时增加 `svn:` 块。签出脚本多 working-copy 模式
默认读取 `GUTHON_NEXUS_SVN_USERNAME` 和 `GUTHON_NEXUS_SVN_PASSWORD`，不需要每个产品或项目重复配置；
`username_env`、`password_env` 仅用于特殊覆盖且只保存环境变量名。密码由工具经 stdin 传给 SVN。证书异常默认全部
拒绝。Nexus 的多 working-copy SVN 模式固定支持“保存到谷神”，不再使用 `platform_save` capability 开关；
保存仍需经过文件选择、内容哈希复核、远程最新状态检查和提交说明确认。

证书暂时无法修复时，`allowed_cert_failures` 必须与 `certificate_pins` 同时配置；pin 是管理员通过独立渠道确认的
服务器叶证书 SHA-256。工具先读取实时证书并核对主机、端口和指纹，匹配后才向 SVN 客户端传递精确异常列表；
指纹变化立即阻断。Nexus 的“设置工作区 SVN 凭据”以当前 `toolHome` 为作用域保存一套共享用户名和密码；该本地
数据工作区内的所有产品和项目共用。凭据存入 VS Code SecretStorage，运行时仅通过子进程环境和密码 stdin 传递，
不写入 YAML、授权清单、命令参数或日志。

首次初始化和日常刷新：

```bash
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- sync-from-script --accept-scope-change
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- refresh
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- status --diff
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- status --remote
```

`sync-from-script` 首次检出签出脚本中筛选后的每个精确 URL，全部仓库使用同一份工作区认证；后续更新现有 working copy 并全量建索引。`sync-from-bat` 是 Windows BAT 的命令入口。`refresh` 可用重复的 `--working-copy <entry-id>` 精确选择物理
working copy，有本地修改时必须显式增加 `--merge-local`。普通 `reindex` 只扫描本地文件。新清单布局不接受
`--prune`，范围变更必须先审阅清单和本地目录，工具不会自动删除旧 checkout。

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

过程函数的 `content_field` 配置项目脚本字段，`product_content_field` 配置继承标记对应的产品快照脚本字段。PAGE 后台脚本的产品快照直接读取 JSON 中与 `script` 同级的 `superScript`。

## 多工作区

工具不设置默认工作区。工作区键来自 `products.yaml`、`projects.yaml`，所有工作区命令都必须显式传入：

```bash
.venv/bin/python scripts/guthon_tool.py sync-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home . --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py reindex --home . --workspace projects.demo-project
.venv/bin/python scripts/guthon_tool.py export-markdown --home . --workspace projects.demo-project
```

目录按显示名称平铺，真实身份始终使用稳定键：

```text
var/workspace/PRD 示例产品/
var/workspace/PRJ 示例项目/
```

数据库工作区独立包含 `source/readonly`、`source/workcopy`、`database/{schema,billtype,views}`、`docs` 和
`context/index.db`。SVN 新模式不创建 readonly/workcopy 代码目录，源码来自独立的
`var/checkout/<配置 ID>/<entry.localSubdir>`，编辑会话只在 `context` 保存身份、hash、revision 和格式元数据，
不保存源码正文。状态检查按 provider 的有效步骤计算：数据库为五步，SVN 为本地源码扫描一步。

## 源码逻辑排查

复制排查定义模板到私有 `var/` 目录后，按已拉取源码填写参数、逻辑步骤和查询 SQL：

```bash
cp config/example/source-diagnosis.example.json var/diagnosis/cases/<排查名称>.json
.venv/bin/python scripts/guthon_tool.py diagnose --home . \
  --workspace products.demo-product -- var/diagnosis/cases/<排查名称>.json
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `var/docs/业务排查文档/<日期>/`。完整参数、数据库、原生 SQL 和查询结果保存在报告中；终端只输出状态、停止步骤、结论和报告路径。
