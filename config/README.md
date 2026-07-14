# 配置说明

YAML 配置文件首行说明各自用途；`system-data.json` 及其示例必须保持标准 JSON，因此不写注释。

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

`products.<id>` 来自 `products.yaml`，只拉取并比较该产品源码；`projects.<id>` 来自 `projects.yaml`，只拉取并比较该项目自己的源码，再以该项目快照重建 effective 目录。项目 effective 不使用当前产品源码兜底。

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
