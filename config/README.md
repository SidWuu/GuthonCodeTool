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

`svn.username` 配置当前本地数据工作区共用的 SVN 用户名，所有产品和项目使用同一个值：

```yaml
svn:
  username: "公共SVN用户名"
```

密码不写入任何 YAML。点击 Nexus 的“设置工作区 SVN 登录”输入一次密码；Nexus 只通过 stdin 传递本次输入，认证成功后由
SVN auth cache/系统钥匙串保存并供所有产品和项目复用。

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
      # 一个产品/项目只配置一次根地址；不要把每个 checkout URL 重复写入 YAML。
      url: "https://source.example/repo/product"
      # scope 可省略；省略时只检出 mappings 对应的 systems/datasources。
      scope: [skill, public, datasources, systems]
```

在 Nexus 的该产品节点选择 SVN，紧凑配置直接放在已有的 `products.yaml`（项目则放在 `projects.yaml`）对应条目的
`svn.url`/`svn.scope` 下，可以手动修改。首次没有 `svn.url` 时，把谷神平台下载的 `svnCheckoutHere.sh`
（macOS/Linux）或 `svnCheckoutHere.bat`（Windows）放到工程 `context/`，Nexus 只解析其中的 checkout 命令作为一次性
导入来源，脚本不会被执行。Nexus 仍自动生成 `context/authorized-scope.json`，并把唯一真实 working copy 放在
`var/checkout/<配置 ID>`，因此通常不需要配置 `svn.scope_manifest`、`checkout_layout` 或 `checkout_root`。工作区配置 ID 仍须在产品/项目之间唯一。

也兼容旧的逐条范围配置。新配置建议只写 `svn.url` 和分类 `scope`，程序会在内存中按
`systems.include.mappings` 展开为精确 URL，并把展开结果写到当前工作区 `context/authorized-scope.json`；该 JSON 是内部生成文件，日常不需要手动修改。

紧凑配置支持的分类为 `skill`、`public`、`systems`、`datasources`，以及需要时的
`pages`、`procedures`、`tables`、`views`、`system-script`。其中 `systems` 会拼接每个 mapping 的
`system_id`，`datasources` 会拼接每个 mapping 的 `data_source_id`：

```yaml
products:
  demo-product:
    svn:
      url: "https://source.example/repo/product"
      scope:
        - skill
        - public
        - datasources
        - systems
```

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

项目只有一个包含全部授权目录的根地址时，优先使用上面的紧凑写法；旧格式仍可用
`checkoutPaths` 只检出指定子系统：

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

直接粘贴只有一条根地址的 `svn checkout` 命令时，Nexus 会写入紧凑的 `svn.url`，并按当前项目已填写的
`systems.include.mappings` 生成实际清单；若希望包含公共目录，在 `scope` 中增加 `skill`、`public`。

也可以每行直接写 `<url> <localSubdir>`（支持 `->` 或 `=>` 分隔）。配置文件只允许字面量 URL 和相对目录，
不会保存用户名、密码或脚本变量；修改 `svn.url`/`scope` 后执行“从 SVN 范围配置检出/更新”即可重建当前工作区的内部清单。

Nexus 的“导入 SVN checkout 配置”可选择 `.sh/.bat` 或粘贴 checkout 内容，并把根地址和分类合并到当前 `products.yaml/projects.yaml` 的 `svn`；随后“从 SVN 范围配置检出/更新”会先显示清单条目及增删改数量，确认后再写入脱敏清单、检出或更新。等价 CLI：

```bash
.venv/bin/python scripts/guthon_tool.py source-mode --home . --workspace products.demo-product -- set --mode svn
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- scope-preview
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- scope-import  # JSON stdin: {"text":"...","source":"script"}
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- sync-from-script --accept-scope-change
# 已在 products.yaml/projects.yaml 配置 svn.scope 后可使用同义入口：
.venv/bin/python scripts/guthon_tool.py svn --home . --workspace products.demo-product -- sync-from-config --accept-scope-change
```

配置了 `systems.include.mappings` 时，紧凑 `scope` 是分类授权范围，实际清单只保留该映射明确声明的范围：
`systems/<SYSTEM_ID>` 聚合 `pages` 与 `system-script`，
`datasources/<DATA_SOURCE_ID>` 聚合 `procedures`、`tables` 与 `views`，`skill/public` 作为公共目录保留。映射缺失或格式无效时会在检出前
阻断，并要求为每个别名提供 `system_id` 和 `data_source_id`；映射 ID 不在范围配置（首次导入时则不在签出脚本）
中时则要求提供同一产品、同一账号最新下载的脚本，或说明对应源码分类确实不存在。

一次性脚本导入支持 UTF-8/UTF-16/GB18030 BAT 和 UTF-8 shell 脚本，只接受字面量精确 URL 和安全的相对检出目录；会忽略 `rem`、`echo` 与 shell 注释
中的命令以及 `--username`、`--password` 等认证参数。变量 URL、绝对目标目录、重复/重叠 URL、重复/重叠本地目录
或无法识别的业务分类都会阻止生成。凭据不会进入范围配置、清单、日志或公开配置，移出清单的旧 working copy 也不会自动删除。

仅在需要覆盖默认 checkout 根或调整非核心高级能力时，才在产品/项目配置中增加 `svn:` 块。公共用户名只在 `sync.yaml` 的
`svn.username` 配置一次；密码由 Nexus 临时交给 SVN 系统凭据存储。内部 SVN 使用 HTTPS 自签证书，所有远程命令固定
以非交互方式信任证书异常。Nexus 的多 working-copy SVN 模式固定支持“保存到谷神”，不再使用 `platform_save` capability 开关；
保存仍需经过文件选择、内容哈希复核和远程最新状态检查；SVN 提交说明可选，留空可直接保存。

Nexus 的“设置工作区 SVN 登录”读取 `sync.yaml` 中的公共用户名，只弹出一次密码输入框；密码不会进入 VS Code SecretStorage、
YAML、授权清单、参数或日志。认证成功后由 SVN 自身按认证域保存，同一认证域下的所有产品和项目直接复用。

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
