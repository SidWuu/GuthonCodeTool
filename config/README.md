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

配置产品库和项目库。项目继承产品代码时，别名通常相同，因此 PRODUCT / PROJECT 靠数据库区分：

```text
product-dev   -> PRODUCT
project-dev   -> PROJECT
```

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

`products.<id>` 来自 `products.yaml`，只拉取并比较该产品源码；`projects.<id>` 来自 `projects.yaml`，只拉取并比较该项目自己的 readonly 源码。产品和项目的增量游标按 `ACTIVE` 分别保存，首次切换到一个对象时执行全量同步。
