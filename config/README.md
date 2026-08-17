# 配置说明

YAML 配置文件首行说明各自用途；`system-data.json` 是工具自动生成的缓存。

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

## products.yaml / projects.yaml 的源码模式

每个产品、项目都必须显式配置且只能启用一种源码 provider：

```yaml
products:
  demo-product:
    name: 示例产品
    source_mode: database  # database | svn
    datasource: demo-product-dev
```

`database` 保持现有源码表、metadata 导出和业务诊断流程。`svn` 把 `var/checkout/<配置 ID>` 作为唯一源码事实来源，普通扫描不访问数据库；`datasource` 仅在 `system-data.json` 缺失时供 `svn init/refresh` 受控补全系统映射。

SVN 示例：

```yaml
products:
  demo-product:
    name: 示例产品
    source_mode: svn
    datasource: demo-product-dev
    systems:
      include:
        system_aliases:
          - demo.system
    svn:
      repository_url: ${DEMO_PRODUCT_SVN_URL}
      sparse_checkout: true
      include: [pages, procedures, system-script, tables, views]
      update_policy: manual
      no_auth_cache: true
      username_env: DEMO_SVN_USERNAME
      password_env: DEMO_SVN_PASSWORD
      allowed_cert_failures: []
      capabilities:
        initialize: true
        refresh: true
        system_data_bootstrap: true
        status: true
        reindex: true
        workcopy: true
        writeback: true
        commit: false
```

工作区配置 ID 必须是安全的单级目录名，并在产品/项目之间唯一。`workspace_root` 与 `svn.checkout_root` 必须分离。`username_env`、`password_env` 只保存环境变量名；密码由工具经 stdin 传给 SVN，不出现在 YAML、命令行或日志。未配置密码环境变量时，只能在交互终端按 SVN 提示输入；Nexus/Bridge 的非交互调用会快速失败，不会等待隐藏输入。证书异常默认全部拒绝，确需信任时只能从 `unknown-ca`、`cn-mismatch`、`expired`、`not-yet-valid`、`other` 中显式列出已核对项。`commit` 固定为 `false`，工具不提供自动提交。

首次初始化和日常刷新：

```bash
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- init
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- refresh
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- status --diff
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- status --remote
```

`init/refresh` 自动扫描并重建索引；普通 `reindex` 只扫描本地文件。范围缩小时默认只报告残留目录，明确增加 `--prune` 才会在 working copy 干净时执行受控排除。

## products.yaml / projects.yaml 中的 systems

每个产品、项目分别配置用于限制同步范围的子系统：

```yaml
products:
  demo-product:
    name: 示例产品
    source_mode: database
    datasource: demo-product-dev
    systems:
      include:
        system_aliases:
          - demo.system
    page_origins: []
```

页面源码按 `source-tables.yaml` 中配置的页面子系统字段过滤。

过程函数按 `source-tables.yaml` 中配置的数据源字段过滤。

源码、表结构和单据类型拉取会在各自 datasource 的 `gd_system` 中按别名反查系统与数据源 ID。每个 datasource 只在首次使用或别名变化时查询，结果写入 `config/system-data.json`；删除该文件可强制重建缓存。

如果多个子系统共用同一个数据源 ID，过程函数只存一份。根目录使用 `system_aliases` 中第一个匹配子系统的名称，后续重复子系统的 `procedure` 目录会链接到第一个目录。

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

数据库工作区独立包含 `source/readonly`、`source/workcopy`、`database/{schema,billtype,views}`、`docs` 和 `context/index.db`。SVN 工作区只在工具目录保留 `source/workcopy`、`docs` 和 `context/index.db`，源码来自独立的 `var/checkout/<配置 ID>`。状态检查按 provider 的有效步骤计算：数据库为五步，SVN 为本地源码扫描一步。

## 源码逻辑排查

复制排查定义模板到私有 `var/` 目录后，按已拉取源码填写参数、逻辑步骤和查询 SQL：

```bash
cp config/example/source-diagnosis.example.json var/diagnosis/cases/<排查名称>.json
.venv/bin/python scripts/run_source_diagnosis.py var/diagnosis/cases/<排查名称>.json
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `var/docs/业务排查文档/<日期>/`。完整参数、数据库、原生 SQL 和查询结果保存在报告中；终端只输出状态、停止步骤、结论和报告路径。
