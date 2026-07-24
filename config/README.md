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

## sync.yaml 中的 systems

用于限制只同步指定子系统源码。

```yaml
systems:
  include:
    # 只配置别名；系统和数据源信息不需要人工维护
    system_aliases:
      - demo.system
```

页面源码按 `source-tables.yaml` 中配置的页面子系统字段过滤。

过程函数按 `source-tables.yaml` 中配置的数据源字段过滤。

源码、表结构和单据类型拉取会在各自 datasource 的 `gd_system` 中按别名反查系统与数据源 ID。每个 datasource 只在首次使用或别名变化时查询，结果写入 `config/system-data.json`；删除该文件可强制重建缓存。

如果多个子系统共用同一个数据源 ID，过程函数只存一份。根目录使用 `system_aliases` 中第一个匹配子系统的名称，后续重复子系统的 `procedure` 目录会链接到第一个目录。

## source-tables.yaml

页面源码除页面和模块字段外，还需配置模块排序、模型关联、模型名称、模型排序和父模型字段。PAGE 目录按完整模型父子链分组，并使用三位模型/模块序号自然排序；手动拉取会自动迁移路径和清理旧目录。

过程函数的 `content_field` 配置项目脚本字段，`product_content_field` 配置继承标记对应的产品快照脚本字段。PAGE 后台脚本的产品快照直接读取 JSON 中与 `script` 同级的 `superScript`。

## sync.yaml

`sync.ACTIVE` 控制当前开发对象：全量拉取和定时拉取只同步 ACTIVE 指向的源码，表结构和单据类型也默认连接该产品或项目配置的 `datasource`：

```yaml
sync:
  ACTIVE: products.demo-product
```

开发项目源码时改成：

```yaml
sync:
  ACTIVE: projects.demo-project
```

`products.<id>` 来自 `products.yaml`，只拉取并比较该产品源码；`projects.<id>` 来自 `projects.yaml`，只拉取并比较该项目自己的 readonly 源码。readonly 源码分别保存到 `var/source/readonly/products/<产品名称>/` 和 `var/source/readonly/project/<项目名称>/`；每个 ACTIVE 的索引分别保存到 `sync.index_dir/{products|projects}/<id>.db`，表结构、单据类型和视图源码分别保存到 `var/database/{schema|billtype|views}/{products|projects}/<名称>/`，不同对象之间不会互相覆盖；首次切换到一个对象时执行全量同步。

## 源码逻辑排查

复制排查定义模板到私有 `var/` 目录后，按已拉取源码填写参数、逻辑步骤和查询 SQL：

```bash
cp config/example/source-diagnosis.example.json var/diagnosis/cases/<排查名称>.json
.venv/bin/python scripts/run_source_diagnosis.py var/diagnosis/cases/<排查名称>.json
```

排查定义中的 `database` 指定默认数据库；某一步需要查询另一个数据库时，在该步骤增加同名 `database` 覆盖。数据库必须存在于数据源的 `databases` 白名单中，脚本不会执行 `USE`。

执行器只接受单条 `SELECT`，使用绑定参数，每一步在对应数据库的新只读事务中执行。首个不满足 `continue_when` 的步骤停止，报告写入 `var/docs/业务排查文档/<日期>/`。完整参数、数据库、原生 SQL 和查询结果保存在报告中；终端只输出状态、停止步骤、结论和报告路径。
