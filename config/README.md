# 配置说明

复制模板后再填写真实配置：

```bash
cp config/example/datasource.example.yaml config/datasource.yaml
cp config/example/products.example.yaml config/products.yaml
cp config/example/projects.example.yaml config/projects.yaml
cp config/example/source-tables.example.yaml config/source-tables.yaml
cp config/example/sync.example.yaml config/sync.yaml
cp config/example/systems.example.yaml config/systems.yaml
```

`datasource.yaml`、`systems.yaml` 和 `system-data.json` 不提交。

## datasource.yaml

配置产品库和项目库。项目继承产品代码时，别名通常相同，因此 PRODUCT / PROJECT 靠数据库区分：

```text
product-dev   -> PRODUCT
project-dev   -> PROJECT
```

## systems.yaml

用于限制只同步指定子系统源码。`system-data.json` 放在 `config/` 同目录。

```yaml
systems:
  data_file: system-data.json
  include:
    system_codes:
      - DEMO_SYSTEM
```

页面源码按 `source-tables.yaml` 中配置的页面子系统字段过滤。

过程函数如果 `system-data.json` 能解析到数据源 ID，会按 `source-tables.yaml` 中配置的数据源字段过滤；否则不额外过滤过程函数。

如果多个子系统共用同一个数据源 ID，过程函数只存一份。根目录使用 `systems.yaml` 中第一个匹配子系统的名称，后续重复子系统的 `procedure` 目录会链接到第一个目录。

## sync.yaml

`sync.ACTIVE` 控制当前开发对象，全量拉取和定时拉取都只同步 ACTIVE 指向的源码：

```yaml
sync:
  ACTIVE: products.demo-product
```

开发项目源码时改成：

```yaml
sync:
  ACTIVE: projects.demo-project
```

`products.<id>` 来自 `products.yaml`，只拉取该产品源码；`projects.<id>` 来自 `projects.yaml`，只拉取该项目源码，并只重建该项目 effective 目录。

如果拿到的是平台导出的 `gd_system_*.json`，先整理为 `system-data.json` 的数组格式，保留这些字段即可：

```json
[
  {
    "SYSTEM_CODE": "demo.system",
    "SYSTEM_ID": "SYS-DEMO-001",
    "SYSTEM_ALIAS_ID": "demo.system",
    "SYSTEM_NAME": "示例子系统",
    "DATA_SOURCE_IDS": ["DEMO_DS"]
  }
]
```
