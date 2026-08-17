# GuthonCodeTool 期现产品 SVN 源码双模式调整方案

> 状态：开发实现已落地；本地临时 SVN 回归已通过，真实仓库、打包插件和谷神平台闭环仍待验收，详见第 14 节。
> 范围：外层 `GuthonCodeTool` 的源码读取、索引、Workcopy、Bridge 和 Nexus；不修改现有过渡目录 `var/workspace/prd_gme` 的 SVN 内容，目标目录结构见第 3 节。
> 目标：保留数据库模式，同时增加 SVN 模式；每个工作区通过配置只启用其中一种。

## 1. 结论

建议采用：

```text
SVN checkout（真实源码）
        │ 只读扫描、解析、建立映射
        ▼
本地 SQLite 索引 ── 查询 / AI / 调用方分析
        │ 按对象懒加载
        ▼
Workcopy 方法投影 ── 编辑、检查、保存
        │ 校验 JSON Pointer、源文件哈希和 SVN 版本
        ▼
SVN checkout 对应源码
        │ 用户执行 svn diff / svn commit
        ▼
谷神平台（由 SVN 提交链路自动同步）
```

核心原则：

- SVN checkout 是 SVN 模式的唯一源码事实来源；Workcopy 是可编辑投影，不是第二个长期源码库。
- 页面 `raw.json` 只作为原始快照和回写基线，不作为方法编辑入口。
- 每个拆出的方法必须保存稳定的 `JSON Pointer`（或等价结构路径）、原始值摘要、源文件路径和 SVN 版本；回写不能根据展示文件名反推位置。
- “自动同步回 SVN”只指用户点击保存/写回后由工具安全写入本地 SVN checkout；不自动执行 `svn commit`，避免未经 review 就发布到谷神平台。
- 不使用后台文件监听器持续覆盖 SVN 文件。编辑器保存动作触发一次有边界的写回，校验失败就停止并保留 Workcopy。
- SVN checkout 是受保护的上游源码区，AI 和开发人员都不得直接编辑其中的文件；修改已检出源码内容的唯一入口是封装的 `save-svn` 回写命令。`svn init/refresh` 只允许执行配置范围内的 working copy 管理操作。
- SVN 模式下只有工具目录中的 Workcopy 可编辑；打开 checkout 只能查看状态、路径和差异，不能作为编辑目录。
- SVN 模式允许 `svn init/refresh` 为生成或补全 `system-data.json` 执行一次受控的当前 datasource 主数据查询；源码扫描、索引、调用分析、Workcopy 和普通刷新不得访问数据库。

覆盖结论需要分两层理解：SVN 模式在完成解析、反向写回和平台同步验证后，可以替代当前“已提交源码拉取、
本地索引、查询和 Workcopy”主链路；但不能完全替代所有数据库查询。`system-data.json` bootstrap、
谷神签出/签入状态、错误状态、项目继承快照、单据类型和业务数据诊断仍没有等价的 SVN 数据来源，详见第 13 节。

这比把整个 SVN checkout 复制到 `source/readonly`，或根据 `scripts/` 文件名直接拼回 `raw.json` 更安全，也避免复制当前约 838 MB 的 checkout。

## 2. 当前 SVN checkout 事实

本次只读核对对象为历史过渡目录 `var/workspace/prd_gme`，SVN 工作副本状态干净，核对时为 revision 219。以下数量是本次快照，不是永久配置契约；正式结构迁移到 `var/checkout/<配置 ID>/` 后仍需重新扫描：

| 目录 | 当前结构 | 快照数量 |
|---|---|---:|
| `pages/<SYSTEM_ID>/.../*.json` | 页面原始 JSON，另有系统/页面索引 Markdown | 30 个系统目录、6069 个 JSON |
| `procedures/<DATA_SOURCE_ID>/<package path>/*.gss` | 按数据源和包路径保存的过程函数源码 | 27 个数据源目录、4256 个 GSS |
| `tables/<DATA_SOURCE_ID>/*.json` | 表结构 JSON，包含 `tableId`、`tableName`、`fields` | 29 个数据源目录、3009 个 JSON |
| `views/<DATA_SOURCE_ID>/*.json` | 视图 JSON，包含 `viewId`、`viewName`、`viewSql`、`fields` | 26 个数据源目录、364 个 JSON |
| `system-script/<SYSTEM_ID>/*` | 系统脚本，当前可见 `.js` 和系统名称标记文件 | 30 个系统目录、75 个 JS |
| `info.json` | checkout 产品标识元数据 | 1 个 |

当前 checkout 顶层没有独立的 `billtype/` 目录。因此 `export-bill-type` 在 SVN 模式不能假定可以从表结构推导；没有确定的 SVN 单据类型格式前，必须标记为“不支持”或继续由明确的数据库工作区提供。

`pages/index.md` 只用于导航展示，不能作为源码事实来源。页面和方法的身份必须从 JSON 内容、路径及生成的映射清单取得。

本次 `svn proplist -R` 没有发现 `svn:needs-lock`、`svn:externals`、`svn:eol-style` 等属性，说明当前仓库
没有依靠 SVN 属性强制只读、锁定或换行策略；“禁止直接编辑 checkout”必须由工具边界、外部修改检测和
必要的文件系统权限实现，不能假设 SVN working copy 自带保护。当前 `info.json` 只提供 `proId`，也不足以
单独证明 repository 与 `workspaceKey`、产品/项目层和全部子系统范围一致。

## 3. 双模式配置契约

在产品或项目工作区配置中增加唯一的 `source_mode`：

```yaml
products:
  gdrm-product:
    name: 期现产品
    source_mode: svn       # database | svn，必须二选一

    # source_mode=database 时用于全部数据库能力；source_mode=svn 时仅供受控 system-data bootstrap 使用。
    datasource: gdrm-product-dev
    # SVN 和数据库模式共用现有子系统选择配置。
    systems:
      include:
        system_aliases:
          - com.golden.bdp.gdrm
          - com.golden.bdp.sdp

    svn:
      # 仅用于 svn init；不保存用户名、密码或 token。
      repository_url: ${GDRM_PRODUCT_SVN_URL}
      # 根目录默认 var/checkout；最终目录由 products.yaml 的配置 ID 计算。
      checkout_root: ${GUTHON_CHECKOUT_ROOT}
      capabilities:
        initialize: true       # 按 systems.include.system_aliases 创建/补齐稀疏 checkout
        refresh: true          # 按配置执行受控 svn update
        system_data_bootstrap: true # 缓存缺失/不完整时，初始化阶段允许补全 system-data.json
        status: true           # 查看 svn status/diff，只读
        reindex: true          # 扫描已检出目录并重建本地索引
        workcopy: true         # 创建/打开 Workcopy
        writeback: true        # 通过 save-svn 回写 checkout
        commit: false          # 固定禁止由工具执行 svn commit
      # 只检出 systems.include.system_aliases 解析出的子系统，不默认检出整个仓库。
      sparse_checkout: true
      include: [pages, procedures, system-script]
      # svn update 由工具按配置生成清单后受控执行。
      update_policy: manual
      no_auth_cache: true
      # 只保存环境变量名；密码值经 stdin 交给 SVN，不进入命令行和日志。
      username_env: GDRM_SVN_USERNAME
      password_env: GDRM_SVN_PASSWORD
      # 默认拒绝全部证书异常；确需信任时逐项显式列出。
      allowed_cert_failures: []

    # 工具自己的 context/index/workcopy 根目录默认 var/workspace；最终目录由产品类型和 name 计算。
    workspace_root: ${GUTHON_WORKSPACE_ROOT}
```

目录计算契约固定为：

```text
products.<id>  -> checkout/<id>/ -> workspace/PRD <name>/
projects.<id>  -> checkout/<id>/ -> workspace/PRJ <name>/
```

例如：

```text
products.gdrm-product  -> var/checkout/gdrm-product/ -> var/workspace/PRD 期现产品/
projects.project-aggm   -> var/checkout/project-aggm/  -> var/workspace/PRJ 鞍钢国贸/
```

`checkout/<id>/` 必须对应配置中的一个真实 SVN repository URL；`workspace/` 只保存
GuthonCodeTool 的 context、index 和 Workcopy。配置 ID 必须是安全的单级目录名，并在
`products.yaml`、`projects.yaml` 之间保持唯一；CLI、Bridge 和插件不得允许调用方传入其他目标路径。
checkout 已存在时必须校验 `svn info` 的 URL 与当前配置一致；URL、配置 ID 或工作区类型不一致时停止，
不得把已有 checkout 静默复用到其他工作区。`workspace/PRD|PRJ <name>/` 是可读目录名，真实身份仍是
`products.<id>` 或 `projects.<id>`；name 变更只能通过受控迁移更新目录，不能创建第二个工作区。

实现时字段名称可以沿用现有配置风格，但语义必须满足：

| 模式 | 必须使用 | 禁止隐式使用 |
|---|---|---|
| `database` | 当前 `datasource.yaml`、`source-tables.yaml`、数据库源码查询和现有 Workcopy 流程 | SVN checkout |
| `svn` | `systems.include.system_aliases`、`system-data.json`、计算后的 checkout 路径、本地扫描器、SVN 映射和本地索引；初始化/刷新阶段可受控补全系统映射 | 源码查询、业务数据查询、非 bootstrap 的索引/刷新数据库访问、源码表拉取 |

配置校验规则：

- `source_mode` 缺失、非法或同时指定两种事实来源时直接报错，不自动降级。
- SVN 模式已有 checkout 时必须检查目录包含 `.svn`，并能取得 `svn info`；checkout 不存在时，只有配置启用 `initialize` 且提供 `repository_url` 才允许通过 `svn init` 创建，失败时停止，不猜测其他路径。
- SVN 模式的 `datasource` 仍用于选择 `system-data.json` 的缓存分区；除 `svn init/refresh` 的映射 bootstrap 外，当前工作区不得因为它存在而连接数据库。
- SVN 模式使用现有 `systems.include.system_aliases` 作为唯一范围选择器；优先读取本地 `system-data.json`，缓存缺失或不覆盖当前 checkout 子系统时，才由 `checkout.py` 调用现有数据库查询逻辑执行当前 datasource 的全量映射查询并写回缓存。
- `system_data_bootstrap: false` 或数据库暂时不可用时，不得偷偷查询或猜测：页面仍可按 `index.md` 解析；
  已检出的过程函数仍可索引，但只保留 `DATA_SOURCE_ID` 和 SVN 原始路径，不生成数据源名称/系统归属。
  只有需要根据 alias 新增检出 `procedures/<DATA_SOURCE_ID>/` 时，才因缺少映射而阻断该范围展开。
- `svn.capabilities` 只控制当前工作区允许暴露的动作；服务端返回的 effective capabilities 必须同时经过 provider 安全白名单计算。`commit` 永远为 `false`，配置为 `true` 时直接报错，不能通过配置打开自动提交。
- 配置文件不是 VS Code 插件的安全边界；CLI/Bridge 服务端必须再次校验 `workspaceKey` 和 capability，插件只负责展示和发起请求。
- `workspace_root`、context、Workcopy 和索引不要写入 SVN checkout，避免把工具生成物变成 SVN 未跟踪文件。

### 3.1 按 `systems.include.system_aliases` 执行稀疏 checkout

`systems.include.system_aliases` 是 SVN 模式的唯一子系统选择器。它只负责声明“要启用哪些
逻辑子系统”，不要求配置文件直接填写 SVN 目录中的 `SYSTEM_ID`。脚本按以下顺序解析范围：

1. 读取当前工作区已有的 `systems.include.system_aliases` 和 `datasource`。
2. 读取现有 `config/system-data.json` 中与 datasource、alias 匹配的记录，得到 `SYSTEM_ALIAS_ID`、
   `SYSTEM_ID` 和 `DATA_SOURCE_ID`。
3. 如果 `system-data.json` 不存在，或已扫描的 checkout 子系统/配置 alias 没有对应记录，且
   `system_data_bootstrap=true`，由 `checkout.py` 调用现有数据库查询逻辑，对当前 datasource 执行
   全量系统映射查询，合并并原子写回新的 `system-data.json`，然后重新计算范围。
4. 全量查询后只接受别名到系统记录的唯一匹配；仍缺失、重复、datasource 不一致或映射过期时，
   阻断 alias 范围展开，但不影响已检出过程函数按 `DATA_SOURCE_ID` 降级索引。
5. 数据库查询只允许出现在 `svn init/refresh` 的 system-data bootstrap 阶段；扫描器、索引器、
   查询、调用分析和 Workcopy 流程不得调用 `gd_system`、认证表或其他谷神数据库。

当前 checkout 中的 `system-script/<SYSTEM_ID>/$<SYSTEM_NAME>` 标记文件可以作为系统名称一致性校验，
但不能在缺少本地映射时臆测出 `SYSTEM_ALIAS_ID`。

当数据库不可用且没有对应 `system-data.json` 时，已经存在的 `procedures/<DATA_SOURCE_ID>/` 可以继续
扫描和投影，但只能显示 `DATA_SOURCE_ID`。新建稀疏 checkout 时无法仅凭 alias 推导过程函数目录，
不得因此拉取全部 `procedures/`；必须等待 bootstrap 成功，或由受控配置显式提供数据源 ID。

解析结果写入 `checkout-scope.json`，至少包含选中的 aliases、映射后的 IDs、路径白名单、映射文件 hash
和生成 revision。配置中没有声明的 `SYSTEM_ID`、`DATA_SOURCE_ID` 或顶层目录不得进入 checkout、
索引和 Workcopy。

解析结果转换为以下 SVN 相对路径白名单：

| 配置和映射结果 | 实际检出路径 |
|---|---|
| alias 对应的 `SYSTEM_ID` + `include: pages` | `pages/<SYSTEM_ID>/` |
| alias 对应的 `SYSTEM_ID` + `include: system-script` | `system-script/<SYSTEM_ID>/` |
| alias 对应的 `DATA_SOURCE_ID` + `include: procedures` | `procedures/<DATA_SOURCE_ID>/` |
| alias 对应的 `DATA_SOURCE_ID` + `include: tables` | `tables/<DATA_SOURCE_ID>/`，初期只读 |
| alias 对应的 `DATA_SOURCE_ID` + `include: views` | `views/<DATA_SOURCE_ID>/`，初期只读 |

多个 alias 引用同一个 `DATA_SOURCE_ID` 时合并为一个路径，不重复检出。

实现上保持一个 checkout 根工作副本，不为每个目录创建独立 working copy：

```text
svn checkout --depth empty <svn-url> <checkout-path>
svn update --parents --set-depth infinity <checkout-path>/pages/<system-id>
svn update --parents --set-depth infinity <checkout-path>/procedures/<data-source-id>
```

真实命令由工具根据 `checkout-scope.json` 生成，不接受调用方传入任意本地路径。`svn init/refresh` 的
顺序固定为“读取/补全 system-data.json → 计算范围 → 执行 SVN working copy 操作 → 复核 checkout
子系统与缓存覆盖关系”。除 alias 计算出的源码目录外，清单还必须显式包含 `info.json`、`pages/index.md`
等解析和指纹所需的仓库级文件；`--depth empty` 不会自动把这些文件取到本地。首次初始化、配置增加 alias
或配置增加目录时只展开新增路径；配置删除 alias 时先报告未配置的残留路径，确认 checkout 没有
未提交修改后才允许执行受控的 `svn update --set-depth exclude` 清理，避免误删本地待提交内容。

`refresh-svn` 每次执行前都重新计算并保存 `checkout-scope.json`，扫描器只读取该清单中的路径。
因此“本地目录存在”不等于“当前工作区已启用”，范围以配置和清单为准。

本机多工作区建议使用以下目录边界：

```text
var/
├── checkout/                       # 只保存受保护的 SVN working copy
│   ├── gdrm-product/               # products.yaml -> products.gdrm-product
│   └── project-aggm/               # projects.yaml -> projects.project-aggm
└── workspace/                      # GuthonCodeTool 的 context/index/Workcopy
    ├── PRD 期现产品/
    └── PRJ 鞍钢国贸/
```

`checkout_root` 和 `workspace_root` 只定义两个根目录；实际路径必须由配置类型、配置 ID 和
`name` 按上述规则计算。不得从 checkout 目录名反推工作区，也不得把 SVN checkout 放进
`workspace/`。当前 `var/workspace/prd_gme` 仅是历史过渡目录，迁移后不再作为正式路径。

## 4. SVN 目录到逻辑对象的解析

### 4.1 身份映射

| 逻辑对象 | SVN 身份来源 | 本地索引主键建议 |
|---|---|---|
| 页面 | 文件内容中的 `pageId`，并校验文件名/路径中的页面编码 | `page + pageId` |
| 页面方法/事件 | 页面 JSON 中的稳定结构路径和字段名，例如事件节点下的 `onClickScript`、`serviceEvents` | `pageId + jsonPointer` |
| 过程函数 | `.gss` 路径、包路径和自动注释中的 `functionId` | `procedure + package + functionId` |
| 系统脚本 | `system-script/<SYSTEM_ID>/` 与脚本类型文件名 | `system-script + systemId + scriptType` |
| 表结构 | JSON 中的 `tableId`，文件名只作为一致性校验 | `table + dataSourceId + tableId` |
| 视图 | JSON 中的 `viewId`，文件名只作为一致性校验 | `view + dataSourceId + viewId` |

过程函数的 `DATA_SOURCE_ID` 直接取 `procedures/<DATA_SOURCE_ID>/` 的第一级目录，
不依赖数据源名称解析；数据源名称、系统 alias 和系统名称都是可选展示字段。没有映射时使用
`data-source-<DATA_SOURCE_ID>` 作为临时显示名，禁止根据包名或 SQL 内容猜测归属。

不能把 `SYSTEM_ID`、`DATA_SOURCE_ID`、系统别名和权限/认证表中的 ID 强行视为同一层级。当前数据库模式通过 `resolve_system_scope()` 查询系统与数据源关系；SVN 模式优先读取本地静态映射，只有 `svn init/refresh` 的 bootstrap 才允许复用该查询逻辑，不能在普通扫描或查询中补数据库查询。

### 4.2 扫描结果

扫描器每次为工作区生成或更新以下信息：

- `provider=svn`、checkout 绝对路径的规范化摘要、SVN revision、扫描时间。
- 每个对象的类型、业务 ID、相对 SVN 路径、文件 SHA-256、解析状态和错误信息。
- 过程函数至少保存路径第一级的 `DATA_SOURCE_ID`；没有可用 `system-data.json` 时，名称和系统归属为空，状态记为 `UNRESOLVED_DATA_SOURCE`。
- 页面每个可编辑脚本字段的 JSON Pointer、字段类型、原始字符串摘要、有效展示值摘要和投影文件路径。
- 页面脚本、过程函数和系统脚本的静态调用索引；动态调用仍标记为低置信度，不伪造确定目标。
- 未解析、重复身份、文件名与内容 ID 不一致、JSON 损坏和本地修改状态。

扫描时只读当前 checkout：不执行 `svn update`、不访问谷神数据库、不修改 SVN 文件。

## 5. Workcopy 投影与反向写回

### 5.1 页面投影

选中页面或页面方法时按对象懒加载，不一次性复制全部 checkout。建议保留当前 Workcopy 的目录习惯，并增加可机器校验的映射清单：

```text
source/workcopy/<system>/page/<page-id>/
├── raw.json                 # 原始快照，仅作基线，不允许直接编辑
├── scripts/
│   ├── <稳定名称>.js
│   ├── <稳定名称>.vm
│   └── <稳定名称>.sql
└── source-meta.json         # SVN 路径、revision、hash、JSON Pointer、映射版本
```

现有 `parse_page_scripts()`、`_walk_scripts()` 和脚本扩展名判断逻辑可以复用，但必须补足以下能力：

- 输出文件名只用于阅读，不能作为回写定位依据；同名节点必须通过 JSON Pointer 区分。
- 映射清单保存原始字段值，不能只保存已经展开 `@inherit()` 的有效脚本。否则未修改的继承脚本回写时会被错误改成完整脚本。
- 原始值和有效值分开记录；默认编辑原始值，继承关系保持不变。
- 支持 SQL、前端 JS、后端 VM 和空脚本字段的明确类型；不把所有字符串字段都当作可执行脚本。
- `raw.json` 的手工修改默认拒绝，提示用户修改对应的 `scripts/` 文件；这样可以避免整个页面 JSON 被格式化覆盖。

### 5.2 过程函数、系统脚本、表和视图

- 过程函数 `.gss` 已经是方法级文件，Workcopy 保存 `svnPath + fileHash + functionId` 后可直接回写；回写前仍需检查源文件未被其他人更新。
- 系统脚本按 `SYSTEM_ID + 脚本类型` 建立映射，不能用系统显示名称作为唯一键。
- 表结构和视图 JSON 默认只读投影；如果后续要求编辑，必须使用同样的文件哈希、原子写入和冲突检查。
- `viewSql` 可以从本地 JSON 读取并建立视图索引，不再调用 `gdp_tables_views`。
- 单据类型当前没有 SVN 输入格式，不能用表结构或视图名称临时拼造。

### 5.3 保存/回写流程

Workcopy 的“保存到 SVN”动作按以下顺序执行：

1. 读取 `source-meta.json`，确认映射版本、checkout 路径、源文件相对路径和基线 hash 仍匹配。
2. 重新读取当前 SVN 文件；源文件 hash、SVN revision 或 JSON 结构发生变化时停止，生成冲突信息，不覆盖他人修改。
3. 只读取发生变化的投影文件，检查扩展名、编码、JSON Pointer、脚本类型和重复映射。
4. 对页面按 JSON Pointer 定位原始字符串 token；使用保留原文布局的最小文本替换，禁止直接 `json.dump()` 重写整个页面造成无关 diff。
5. 对过程函数和系统脚本使用临时文件写入后 `os.replace()` 原子替换；失败时不留下半文件。
6. 回写成功后重新计算 hash，刷新本地索引和 Workcopy 映射，状态标记为 `SVN_DIRTY`。
7. 只能由封装的 `save-svn` 写回入口修改 checkout；输出 `svn diff` 检查提示。工具不执行 `svn commit`，提交由开发人员 review 后完成，提交链路再负责同步谷神平台。

写回入口的限制：

- 对外只暴露 `guthon_tool.py workcopy save-svn`（或等价 Bridge/Nexus 操作）；调用方只能提交 `workspaceKey` 和已生成的 Workcopy，不接收任意 checkout 目标路径。
- 修改 checkout 源码内容的代码只存在于 `scripts/providers/svn/writeback.py`；`checkout.py` 只能执行按配置生成的 `svn checkout/update --set-depth` working copy 管理操作，扫描器、索引器、Workcopy 投影器和数据库 provider 都不得直接写源码文件。
- 写回前必须确认 checkout 没有外部未预期修改；写回后只允许预期映射文件出现差异，否则标记为 `CHECKOUT_EXTERNAL_CHANGED` 并停止。
- 不允许 AI 或人工通过编辑器、通用文件复制、`raw.json` 修改、临时脚本或直接 `Path.write_text()` 绕过回写入口。
- 如需执行 `svn update`，也必须作为受控的刷新流程执行，并在有未提交 checkout 修改时先阻断；不能用 update 覆盖 Workcopy 或绕过冲突检查。

上述是工具层约束。同一 OS 账号如果仍拥有 checkout 的普通写权限，无法仅靠 Python 阻止其使用 Shell 绕过工具；若要求系统层强制隔离，需再将 checkout 设为只读，并由独立写入服务/受控 helper 执行回写。不能把脚本校验误报为操作系统级权限控制。

必须拒绝的情况：

- 映射清单缺失、版本不兼容、JSON Pointer 不存在或指向的字段类型已改变。
- SVN 文件在 Workcopy 创建后被 `svn update`、其他编辑器或其他人员修改。
- 同一页面方法存在多个无法区分的投影文件。
- 页面 JSON 解析失败、脚本编码非法或用户直接修改 `raw.json`。

## 6. 同步、查询和调用链调整

### SVN 模式保留

- `query find/context/callers`：只读取本地 SQLite 索引和映射，不查询谷神数据库。
- `reindex`：扫描当前 checkout、更新对象索引并重建调用索引。
- `export-markdown`：从本地索引生成源码索引、调用索引和动态调用点文档。
- `sync-all`：在 SVN 模式改为“扫描本地 checkout + 重建本地索引 + 生成本地资料摘要”，不再执行源码拉取或数据库 metadata export。
- `open workspace`、创建/查看 Workcopy、查看映射和写回 SVN。

### SVN 模式隐藏或禁用

以下入口仍可为数据库模式保留，但在 SVN 工作区不应显示，也不能只依赖前端隐藏：

- 页面/过程函数的“拉取页面当前源码”“拉取源码表版本”“强制刷新源码”。
- 系统脚本、表结构、单据类型和视图的数据库导出/拉取入口。
- Bridge 的 `/pullHubSource`、`/exportTableSchema`、`/exportBillType`、`/exportViewSql`、`/exportSystemScripts` 在 SVN 模式应返回明确的模式错误。
- 过期扩展仍可能直接调用旧接口，因此服务端必须做能力校验；不能只删除 Nexus 菜单。

建议在 SVN 模式把菜单改成：

- “扫描/刷新本地 SVN 索引”；
- “打开对象 Workcopy”；
- “查看 SVN 映射与差异”；
- “写回 SVN”；
- “查看 SVN checkout 状态（只读）”。

### 6.1 配置驱动的脚本和 VS Code 功能

不为每个产品或子系统生成一套专用 Python 脚本；统一脚本读取工作区配置，按
`systems.include.system_aliases` 解析范围，再按 `svn.capabilities` 决定是否执行。建议入口如下：

| 配置能力 | CLI/脚本入口 | 功能 |
|---|---|---|
| `svn.initialize` | `guthon_tool.py svn init` | 先检查/补全 `system-data.json`，创建根 working copy，并只展开配置 alias 对应路径 |
| `svn.refresh` | `guthon_tool.py svn refresh` | 先检查/补全 `system-data.json`，重算 alias 范围、受控 `svn update`、刷新 `checkout-scope.json` |
| `svn.status` | `guthon_tool.py svn status` | 只读查看 revision、稀疏范围、外部修改和 `svn diff` |
| `svn.reindex` | `guthon_tool.py reindex` | 只扫描当前范围，重建 SQLite 和调用索引 |
| `svn.workcopy` | `guthon_tool.py workcopy open` | 创建或打开对象 Workcopy |
| `svn.writeback` | `guthon_tool.py workcopy save-svn` | 预检后按映射安全写回 checkout |

`system_data_bootstrap` 是 `svn init/refresh` 的内部能力，不在 VS Code 菜单中单独展示。
缓存完整时不触发数据库；缓存缺失、数据库不可用时，过程函数仍按 `DATA_SOURCE_ID` 降级解析。

`guthon_tool.py` 只做命令编排，实际 checkout 和范围处理进入 `providers/svn/checkout.py`；
脚本不接收任意 checkout 路径、任意 SVN 相对路径或额外 alias 参数，避免调用方绕过配置白名单。

VS Code/Nexus 的工作区打开和切换时调用 workspace summary，服务端返回类似以下的 effective capabilities：

```json
{
  "sourceMode": "svn",
  "capabilities": {
    "svn.initialize": true,
    "svn.refresh": true,
    "svn.status": true,
    "svn.reindex": true,
    "svn.workcopy": true,
    "svn.writeback": true,
    "svn.commit": false
  }
}
```

插件根据能力显示“初始化/刷新 SVN 范围、查看状态、重建索引、打开 Workcopy、预检/写回”等命令；
`svn.commit`、数据库源码拉取和 metadata export 不显示。服务端仍必须对每个请求重新校验 capability，
插件隐藏按钮不能替代权限控制。配置变更后重新获取 workspace summary，不保留旧能力缓存。

### 数据库模式保持

数据库工作区继续使用当前 `gusen_hub.py` 的数据库查询、`source/readonly`、`source/workcopy`、源码表拉取和配置资料导出。不要为了 SVN 模式删除或旁路修复数据库模式；两条线只在 provider 入口分流。

当前需要分流的主要位置：

| 位置 | 现状 | 调整方向 |
|---|---|---|
| `scripts/gusen_hub.py` | 工作区强依赖 datasource；源码同步、系统范围和单对象拉取均走数据库 | 增加 provider 分发；SVN 分支禁止 `db_connect()` |
| `scripts/guthon_tool.py` | `sync-source*`、`sync-all`、metadata export 为数据库语义 | 按 `source_mode` 暴露能力和提示 |
| `scripts/export_*_sql.py` | 表、单据类型、系统脚本、视图直接执行 SQL | 数据库模式保留；SVN 模式改为本地读取或禁用 |
| `scripts/query_hub_context.py` | 已主要读取本地 SQLite | 保持入口，补充 SVN 对象路径和映射信息 |
| `plugins/GuthonBridge/bridge/server.js` | Bridge 调用源码拉取和数据库导出命令 | 根据 workspace capability 拒绝不适用动作 |
| `plugins/GuthonBridge/extension/` | 弹窗和页面脚本提供拉取动作 | SVN 模式隐藏/禁用，并保留服务端兜底 |
| `plugins/GuthonVSCodeExtension/.../src/extension.js` | Nexus 显示拉取、全量同步和 metadata export | 根据 `sourceMode` 显示本地扫描、Workcopy、SVN 写回 |
| `plugins/GuthonVSCodeExtension/.../src/definition.js` | 只识别 `PRD/PRJ/source/readonly|workcopy` | 增加 SVN Workcopy/映射路径识别，不从目录名推断工作区 |

`diagnose` 是测试数据库上的业务数据排查，不属于源码同步。SVN 模式默认不提供该动作；如确有需要，必须显式选择一个经过只读白名单校验的数据库工作区，不能因 SVN 工作区配置而恢复数据库连接。

## 7. 工作区路由

Bridge 当前会根据 `pageOrigin`、`systemId`、`dataSourceId` 和 `workspaceKey` 路由。SVN 模式调整为：

- 优先验证请求中的显式 `workspaceKey`。
- `systemAlias` 必须同时存在于当前配置和 `checkout-scope.json`；不为别名匹配请求补做数据库查询。
- `systemId` 只与 checkout 的 `pages/`、`system-script/` 目录和本地 manifest 比较。
- `dataSourceId` 只与 checkout 的 `procedures/`、`tables/`、`views/` 目录比较。
- 没有直接身份或出现多个候选时，仍弹出当前请求的工作区选择框；不创建默认工作区、不写全局 ACTIVE 状态。
- 不为匹配请求而调用 `resolve_system_scope()` 或访问 `gd_system`。

## 8. 分阶段实施顺序

### 第一阶段：配置和只读索引

- 增加 `source_mode` 和 SVN checkout 配置校验。
- 根据 `systems.include.system_aliases` 和 `system-data.json` 生成稀疏 checkout 路径清单；缓存缺失时验证
  bootstrap 查询和原子写回，未配置子系统不进入本地工作副本。
- 实现 SVN 扫描器、对象身份解析、文件 hash、SVN revision/status 记录。
- 验证无数据库时过程函数仍能以 `DATA_SOURCE_ID` 建立索引，页面仍能从 `index.md` 建立系统名称。
- 让 `find/context/callers/reindex/export-markdown` 在 SVN 模式只读本地资料。
- 用临时 SVN fixture 验证，不把真实 checkout 当可写测试目录。

### 第二阶段：页面方法投影

- 复用现有页面脚本遍历逻辑，增加稳定 JSON Pointer 和反向映射清单。
- 支持原始脚本、继承脚本、SQL、空字段、重复显示名称和特殊字符。
- Workcopy 懒加载单个页面/过程函数，避免全量复制 checkout。

### 第三阶段：安全回写

- 增加 `workcopy save-svn` 或等价统一入口。
- 实现基线 hash/revision 冲突保护、最小文本替换、原子写入、回写后索引刷新。
- 不实现自动 `svn commit`；交付前输出 `svn diff` 和待提交文件列表。

### 第四阶段：Bridge/Nexus 能力裁剪

- workspace summary 返回 `sourceMode` 和能力集合。
- SVN 模式隐藏源码拉取和数据库导出按钮，增加本地扫描、Workcopy、写回 SVN 操作。
- 服务端接口按能力拒绝旧客户端调用。
- VS Code/Nexus 只读取 workspace summary 的 effective capabilities，不直接解析配置文件；配置关闭的 SVN 命令同时在 CLI、Bridge 和服务端拒绝。
- 同步 README、配置说明、Bridge 文档、Nexus 文档和两份 HTML 手册。

### 第五阶段：数据库模式回归

- 使用临时配置确认数据库模式的现有源码拉取、Workcopy 和 metadata export 不变。
- 确认两个工作区可以同时存在，但每个请求只使用自己 `workspaceKey` 对应的 provider。

## 9. 验收标准

- 稀疏 checkout 只包含 `systems.include.system_aliases` 解析出的 `SYSTEM_ID`、`DATA_SOURCE_ID` 和配置目录类型；未配置目录不会被索引或投影。
- `system-data.json` 缺失时，`svn init/refresh` 能通过现有逻辑查询当前 datasource 全量映射并原子生成缓存；缓存已覆盖时不重复查询。
- alias 映射缺失、重复或与 datasource 不一致时，禁止猜测目录；数据库不可用时过程函数仍保留 `DATA_SOURCE_ID`，状态为 `UNRESOLVED_DATA_SOURCE`。
- 增加配置范围后只展开新增路径；减少配置范围时，存在未提交修改必须阻断清理并给出残留路径。
- `system-data.json` 已完整时，SVN 模式执行扫描、查询、调用方分析和索引重建时，即使 `pymysql` 不可用或数据库地址不可达也能完成；运行日志没有 SQL 查询。
- `system-data.json` 缺失且数据库不可用时，页面仍有系统名称，过程函数只有 `DATA_SOURCE_ID`，不能产生伪造名称或系统归属。
- 未执行 SVN update 时，索引明确显示 checkout revision 和本地修改状态。
- 修改一个页面方法后，只有对应 JSON 字符串发生变化；页面其他字段、继承标记、缩进和换行不被无关重写。
- 页面方法显示名称重复时仍能准确回写到正确 JSON 节点。
- 过程函数、系统脚本能够按文件映射回写；源文件 hash 变化时安全阻断。
- 回写后 `svn diff` 可审阅，工具不自动 commit，提交后平台自动同步由 SVN 链路负责。
- 直接编辑 checkout、修改 `raw.json`、使用通用复制脚本或绕过 `save-svn` 的写入都会被阻断或被检测为外部修改。
- SVN 模式的 Bridge/Nexus 不再提供源码拉取和数据库导出；直接调用旧接口也得到明确错误。
- 关闭任一 `svn.capabilities` 后，对应 CLI、Bridge 和 VS Code 命令均不可执行；重新加载配置后 workspace summary 与界面能力一致。
- 数据库模式原有行为和 Workcopy 冲突保护通过回归测试。
- `billtype` 在没有 SVN 来源格式前不会产生伪造数据。

## 10. Python 脚本目录与依赖边界

新增实现不继续堆在 `scripts/` 根目录；工具的 context、index 和 Workcopy 不写入 `var/checkout/`。建议采用以下最小分层：

```text
scripts/
├── guthon_tool.py                 # CLI 兼容入口，只负责参数和命令编排
├── gusen_hub.py                   # 工作区、能力判断和 provider 分发外观
    ├── common/                        # 两种模式都可依赖，不访问业务数据库或 SVN
│   ├── index.py                   # SQLite 源码/调用索引
│   ├── workcopy.py                # Workcopy 元数据、差异和冲突基础能力
│   └── page_projection.py         # 页面 JSON 方法拆分、映射和最小文本替换
└── providers/
    ├── database/                  # 只放数据库模式实现
    │   ├── source.py              # 源码表查询、增量同步、单对象拉取
    │   └── metadata.py            # 表结构、单据类型、视图、系统脚本导出
    └── svn/                       # 只放 SVN 模式实现
        ├── checkout.py            # 读取 alias 配置和本地映射，创建/刷新稀疏 checkout
        ├── scanner.py             # svn info/status、目录扫描和对象解析
        ├── projection.py          # SVN 对象到 Workcopy 的懒加载
        └── writeback.py           # 哈希/revision 校验和安全回写
```

依赖规则：

- `providers/database/` 可以依赖 `pymysql` 和数据库配置；`providers/svn/scanner.py`、`projection.py` 和 `writeback.py` 不得导入数据库连接或 SQL。
- `providers/svn/checkout.py` 可以在 `svn init/refresh` 阶段调用现有 system-data bootstrap 逻辑；该逻辑负责当前 datasource 的全量映射查询和 `system-data.json` 原子写回，不能被普通扫描/查询调用。
- `providers/svn/` 可以调用本机 `svn info/status/update/list`；不得自动 `svn commit`。
- `providers/svn/checkout.py` 是 `svn init`、`svn refresh` 和范围清单生成的唯一实现；不为每个产品或子系统复制一套 Python 脚本。
- `providers/svn/scanner.py`、`projection.py` 和 `common/` 对 checkout 只能读；`checkout.py` 只负责受控的 SVN working copy 管理，`writeback.py` 是唯一允许修改源码内容的模块。
- `common/` 不反向依赖任何 provider；provider 之间不得互相导入。
- `guthon_tool.py` 不实现业务解析；`gusen_hub.py` 只做一次模式分发，不在各调用方复制 `if database / if svn`。
- 现有根目录 `export_*.py`、`run_sync_once.py` 等先保留为兼容入口；新增逻辑放入上述目录，后续再用薄包装逐步收敛，避免第一阶段大范围移动文件破坏调用方。
- 初期不新增抽象 `base.py` 或复杂插件注册表；两种 provider 的稳定公共契约确认后再提取，先保持目录边界和依赖边界清晰。

测试目录同步分层：`tests/common/`、`tests/providers/database/`、`tests/providers/svn/`。SVN 测试只使用临时 checkout/fixture，不能把真实 `var/checkout/` 或历史 `prd_gme` checkout 当写入测试目录。

## 11. 已确认与仍需确认的业务选择

以下内容已经确认或仍会影响第一版范围：

1. 已确认：`products.gdrm-product` 按现有 `systems.include.system_aliases` 选择性 checkout，优先通过本地 `system-data.json` 解析为 SVN 的 `SYSTEM_ID`、`DATA_SOURCE_ID` 和目录类型；缓存缺失时仅在 `svn init/refresh` bootstrap 阶段复用数据库查询，数据库不可用时过程函数降级保留 `DATA_SOURCE_ID`。
2. 第一版可写对象是否包含页面、过程函数、系统脚本；表结构和视图是否继续只读。
3. 已确认：SVN checkout 统一放在 `var/checkout/<products.yaml 或 projects.yaml 配置 ID>/`，工具数据统一放在 `var/workspace/`；产品和项目分别使用 `PRD <name>`、`PRJ <name>` 目录。
4. 已确认：修改保存后由封装的 `save-svn` 回写本地 checkout，但不自动 `svn commit`。
5. SVN 仓库未来是否会补充单据类型目录；在格式确认前保持 `billtype` 不支持。
6. 若需要防止同一 OS 账号通过 Shell 绕过工具，是否增加只读权限或独立写入服务；默认先完成工具层限制。

## 12. 进一步建议（脑暴）

### 12.1 把 checkout 定义成受保护的 `provider_source_root`

不要让 SVN provider 继续复用名称和行为都带有“可覆盖”含义的 `readonlyDir`。工作区内部建议明确保存：

```text
provider_source_root  # database=source/readonly，svn=受保护 checkout
workcopy_root         # 两种模式都由工具管理的可编辑投影
context_root          # index.db、manifest、日志和状态
```

这样可以避免当前 `remove_source_path()`、`write_source()` 等默认允许删除/覆盖 readonly 的逻辑误用于 SVN checkout。SVN provider 只读扫描；源码内容写入单独进入 `writeback.py`，working copy 展开/收缩单独进入 `checkout.py`。

### 12.2 给每个 checkout 建立不可混用的指纹

在索引和 Workcopy 元数据中固定保存：

- `workspaceKey`；
- checkout 规范路径摘要；
- SVN repository root、relative URL 和 revision；
- 扫描器/映射格式版本；
- 源文件相对路径和基线 hash。

任何一个关键值不匹配都不自动复用旧 Workcopy，要求重新扫描。这样可以防止把产品 A 的 Workcopy 写回产品 B，或把旧目录迁移后的映射误写入新 checkout。

### 12.3 第一版只允许“脚本叶子节点”回写

为了控制反向解析风险，第一版建议只支持修改已经存在的脚本字符串叶子节点：

- 支持已有 `onClickScript`、`onOpenScript`、`serviceEvents`、`sql` 等字段的内容变更；
- 保留 `@inherit()` 原文，不把继承脚本展开后写回；
- 页面组件新增、删除、数组重排、字段结构调整和未知 JSON 节点修改先拒绝；
- 过程函数、系统脚本继续按独立文件回写。

页面结构变更可以在后续版本增加完整 JSON Patch，但不应在第一版用“前后 JSON 深度比较”猜测结构意图。

### 12.4 写回采用“预检—应用—复核”三段式

`save-svn` 内部建议固定为：

```text
预检：Workcopy、manifest、checkout 状态、hash、JSON Pointer
  ↓
应用：只写预期文件，临时文件 + 原子替换
  ↓
复核：重新扫描、校验对象身份、输出 svn diff 和结果日志
```

另外提供 `save-svn --check` 只生成预期差异而不写文件，便于 AI 或人员在真正写回前查看结果。预检失败时不得创建部分写入。

### 12.5 增加每工作区写锁和外部修改清单

- 同一个 `workspaceKey` 同时只允许一个写回任务；锁文件放在 `context_root`，不要放入 checkout。
- 写回前记录 checkout 的 `svn status --xml` 和文件 hash。
- 写回后只接受本次 manifest 计算出的预期差异；其他文件变化统一标记为外部修改。
- 存在上一次写回未提交的预期差异时，可以继续修改同一映射文件，但遇到 `svn update`、路径变化或非预期文件变化必须先停止。

### 12.6 SVN update 与 SVN commit 分成两个动作

- `refresh-svn`：重新计算 `systems.include.system_aliases` 对应的路径白名单，受控执行 `svn update`；只允许在 checkout 没有未提交修改时执行，完成后重新扫描索引。
- `save-svn`：只负责把 Workcopy 反向写回 checkout，不执行 update 和 commit。
- `svn commit`：继续由标准 SVN 工具完成，平台自动同步属于 SVN 提交流程，不进入 GuthonCodeTool 的写回事务。

查询、打开 Workcopy 和调用分析都不自动触发 `refresh-svn`，避免一次普通查询改变本地源码状态。

### 12.7 将“允许写入的文件集合”做成白名单

SVN writer 只允许写入 checkout 下的以下业务目录：`pages/`、`procedures/`、`system-script/`；`tables/`、`views/` 初期只读，`.svn/`、`info.json`、索引 Markdown 和未知目录一律拒绝写入。所有路径先做 realpath 校验，拒绝符号链接逃逸和 `..` 路径。

### 12.8 让审计记录能回答“谁、何时、改了什么”

每次扫描、预检、写回和阻断记录到工作区 `context/logs/`：

- workspaceKey、操作类型、对象 ID、checkout revision；
- Workcopy 路径、目标 SVN 相对路径、基线 hash 和新 hash；
- 预期 diff 文件列表、阻断原因和结果；
- system-data bootstrap 是否执行、查询结果是否覆盖 checkout，以及降级为 `DATA_SOURCE_ID` 的对象数量；
- 本机操作者和工具版本，但不记录 SVN 密码或数据库凭据。

日志只作为本机审计和排查材料，不复制业务源码正文。

### 12.9 UI 只展示“可做的事”

SVN 工作区不要再显示“拉取源码”“打开 checkout 编辑”等容易误导的动作。建议固定显示：

- 刷新本地索引；
- 打开 Workcopy；
- 预检写回；
- 写回 SVN；
- 查看 checkout 状态和差异。

数据库工作区继续显示现有拉取和数据库资料导出。两种模式共用 UI 外壳，但按钮由 workspace capability 决定。

### 12.10 迁移顺序保持可回退

先以 `products.gdrm-product` 建立只读 SVN 索引和查询能力，再开启单个页面/过程函数的 Workcopy 回写；确认 `svn diff`、映射、冲突和平台同步链路均正常后，才扩大到系统脚本和更多工作区。数据库模式在整个阶段保持不变，不把两种模式混合迁移。

## 13. SVN 签出、写回和签入卡点

### 13.1 先区分四个动作

文档和界面不能都简称为“签出/签入”，否则会把 SVN 操作与谷神源码状态混在一起：

| 动作 | 实际含义 | GuthonCodeTool 第一版职责 |
|---|---|---|
| `svn checkout/update` | 从 repository 建立或刷新本地 working copy | 由 `svn init/refresh` 按配置范围受控执行 |
| 谷神源码签出/签入 | 数据库源码表中的当前签出人、签出时间、签入时间和版本状态 | SVN 没有等价字段，不由 SVN 模式模拟 |
| `save-svn` | 将 Workcopy 的预期变化反向写入本地 working copy | 由唯一封装写回入口执行，不提交 repository |
| `svn commit` | 将 working copy 的变更提交到 repository，随后触发平台同步 | 第一版仍由标准 SVN 客户端人工执行，工具只提供预检、清单和 diff |

因此，当前方案完成的是“SVN 检出/更新 + 安全本地写回”；不等于已经实现“插件自动 SVN 提交”，也不等于
恢复了谷神数据库中的签出锁和签入状态。如果后续要求插件执行 `svn commit`，必须作为新的高风险能力单独设计，
不能把现有固定为 `false` 的 `svn.commit` 配置直接打开。

### 13.2 SVN checkout/update 卡点

以下问题在开启真实 `svn init/refresh` 前必须关闭：

| 优先级 | 卡点 | 处理要求 |
|---|---|---|
| P0 | repository 粒度与工作区身份 | 确认一个 `repository_url` 究竟对应产品、项目还是单个系统；首次初始化记录 repository UUID、relative URL、`proId` 和 `workspaceKey` 指纹，后续不一致立即停止 |
| P0 | 稀疏路径并非只靠 alias 就能得到 | 页面和系统脚本需要 `SYSTEM_ID`，过程/表/视图需要 `DATA_SOURCE_ID`；缓存不完整时按既定 bootstrap 规则处理，不能退化成全仓 checkout |
| P0 | 根级文件容易被 `--depth empty` 漏掉 | `checkout-scope.json` 必须把 `info.json`、`pages/index.md` 等必要文件作为固定白名单，并使用 `svn update --parents` 建立缺失父目录 |
| P0 | 凭据与 HTTPS 证书 | YAML 不保存密码/token；密码只能由安全提示或 stdin 传入，不能放在命令行参数或日志中；默认 `--no-auth-cache`。证书异常只接受显式列出的失败类型，不能无条件信任全部证书 |
| P0 | 已有 working copy 的污染 | 初始化和刷新前检查 `.svn`、repository 指纹、mixed revision、switched/partial 状态、文本/树冲突、未跟踪阻塞文件和非预期修改；不使用 `--force` 吞掉阻塞 |
| P1 | 范围收缩 | alias 删除后先报告残留目录；只有 working copy 无本地修改且用户确认时才执行 `--set-depth exclude` |
| P1 | 客户端兼容 | 启动时检查 `svn` 可执行文件和最低支持版本；脚本与 VS Code/Nexus 使用同一运行时和参数构造，不各自拼命令 |
| P1 | 仓库属性策略 | 当前仓库未发现锁、externals 和 EOL 属性。后续仓库新增属性时扫描器必须识别，不能继续按“无属性”处理 |

SVN 认证建议只在配置中保存非敏感策略，例如用户名来源、是否禁用认证缓存以及允许的证书失败类型；
真正密码不得进入 `products.yaml`、`projects.yaml`、`tool-runtime.json`、命令历史或 Bridge 请求日志。VS Code
如果无法安全提供交互输入，应打开受控终端完成认证，不得退化成明文配置。

### 13.3 `save-svn` 与人工 `svn commit` 卡点

写回和提交之间仍有以下边界：

1. 创建 Workcopy 前，先在干净 working copy 上执行受控 refresh，并记录文件 BASE revision、仓库 HEAD、
   文件 hash、编码和换行；不能只记录 checkout 根 revision。
2. `save-svn --check` 先验证映射、JSON Pointer、对象 ID、文件 hash、外部修改和目标白名单；页面 JSON
   必须使用最小文本替换，过程函数和脚本必须保留原编码、BOM、CRLF/LF 和末尾换行。
3. 写入使用工作区锁和原子替换。多文件对象先全部生成并验证，再一次应用；中途失败必须恢复本次写入前内容，
   不能留下半个对象已修改。
4. 写回后只允许 manifest 声明的文件出现在 `svn status`，并输出机器可读提交清单和 `svn diff`；
   未跟踪文件、属性变化、删除/新增和清单外变化默认阻断。
5. 提交前执行需要联网的 out-of-date 检查。远端已经变化时不自动 update/merge，也不覆盖 Workcopy；先重新扫描并
   由用户处理冲突。`svn update`、`save-svn` 和 `svn commit` 不能并发。
6. 人工 commit 只提交工具生成清单中的文件，必须提供提交说明，并满足 repository 权限、hook、锁和审批规则；
   不能在 checkout 根目录无目标地提交全部本地变化。
7. commit 成功后记录新 revision，再验证谷神平台是否完成自动同步。平台同步是 SVN 提交后的异步外部步骤，
   失败不能回滚已经产生的 SVN revision，只能告警并通过后续修复提交处理。

当前 working copy 没有 `svn:needs-lock`，所以暂时无需 `svn lock/unlock`。但提交逻辑仍须检测 repository lock；
若以后仓库增加 `svn:needs-lock`，再按文件清单显式 lock，禁止自动 steal lock。

### 13.4 数据库功能覆盖矩阵

这里的“覆盖”以当前 CLI 的 `sync-source*`、`pull`、`sync-all`、metadata export、`query` 和 `diagnose`
实际语义为准，不只比较最终是否能看到一段源码。

| 当前数据库能力 | SVN 可用数据 | 覆盖结论 | 主要缺口或前提 |
|---|---|---|---|
| PAGE/过程函数全量与增量拉取 | `pages/`、`procedures/`、SVN revision/status | 可替代主链路 | 完成对象解析、删除识别、范围清单和项目/产品层语义验证；SVN 只能看到已提交 revision |
| 单对象 `pull` 到 Workcopy | 本地对象索引和原始文件 | 可替代 | 改为本地懒加载，不再查询源码表；需先验证索引 revision 和源文件 hash |
| 本地源码查找、上下文和调用方分析 | 扫描后写入 SQLite | 可覆盖 | 当前 `query` 本来就主要读本地 SQLite；需让 SVN scanner 生成同等索引字段 |
| PAGE 模块/模型目录 | `pages/index.md`、JSON 和目录 | 部分覆盖 | 数据库当前还联查模块/模型表；需用真实仓库样本证明层级、排序和重名信息不丢失 |
| 过程函数参数、别名、名称和项目继承快照 | GSS 路径、头部及脚本正文 | 部分覆盖 | SVN 目录能稳定给出 `DATA_SOURCE_ID`，但未证明可等价提供全部参数、别名及 `PROD_SCRIPT` 继承语义 |
| 系统脚本及产品/项目继承 | `system-script/` | 部分覆盖 | 脚本文本可读；`PROD_SCRIPT`、`IS_PRODUCT`、说明和有效继承结果是否完整仍需对照验证 |
| 表结构导出 | `tables/<DATA_SOURCE_ID>/*.json` | 部分覆盖 | 可作为静态 schema；需做字段级兼容测试，不能宣称等于数据库当前实时结构 |
| 视图导出 | `views/<DATA_SOURCE_ID>/*.json` | 部分覆盖 | 有 `viewSql` 和 fields，但仍需验证输出契约、系统名称映射和实时性 |
| 单据类型导出 | 无 `billtype/` | 不覆盖 | 继续走明确的 database 工作区，或等待 SVN 提供正式格式 |
| `system-data.json` 系统/数据源映射 | 页面索引、系统名称标记不包含完整 alias 映射 | 部分覆盖 | 缓存缺失/不完整时仍需 bootstrap 数据库查询；数据库不可用时按既定规则降级 |
| 签出人、签出/签入时间、`VERSION_MAC`、错误标记 | SVN revision/log/status | 不等价 | SVN 只能表达 repository 提交和本地修改，不能重建谷神源码表的编辑锁、错误状态和允许未签入源码规则 |
| `diagnose` 业务数据排查 | SVN 不含运行数据库数据 | 不覆盖 | 必须显式选择只读 database 工作区，不能挂在 SVN 源码 provider 上 |
| SVN commit 后谷神自动同步 | repository revision | 尚未验证 | 需在测试工作区验证触发条件、延迟、失败反馈、权限/hook 和平台最终内容 |

结论是：

- 如果“原来的数据库查询功能”特指源码内容拉取、单对象打开、本地索引和调用分析，SVN 模式目标上可以覆盖，
  但必须先通过第 13.5 节的退役门槛。
- 如果指当前 `sync-all`、全部 metadata export、谷神签出状态和 `diagnose`，则不能完全覆盖；数据库 provider
  仍需保留，而且必须与 SVN provider 分目录、分 capability、分调用入口。
- 即使源码主链路切到 SVN，也不能写成“完全不使用数据库”：只要 `system-data.json` 还依赖 bootstrap，
  SVN 初始化仍存在一个受控的主数据数据库依赖。

### 13.5 数据库源码链路的退役门槛

只有以下条件全部满足，某个工作区才可以默认隐藏数据库“源码拉取”功能；未满足时继续保留双模式回退：

1. 对该工作区的 PAGE、过程函数和系统脚本完成数据库与 SVN 对象数量、ID、源码 hash、继承语义抽样对照，
   差异有明确解释。
2. 稀疏 checkout 能在空目录、增加 alias、删除 alias、数据库不可用和缓存过期场景下稳定得到正确范围。
3. 页面脚本 JSON Pointer、过程函数和系统脚本完成正向投影—反向写回往返测试，除目标脚本外无字节变化。
4. 编码、CRLF/LF、BOM、中文、超大文件、空脚本、继承脚本、重复名称和结构冲突测试通过。
5. 外部直接编辑、mixed revision、远端新 revision、文本/树冲突、repository lock 和并发写回均能安全阻断。
6. 至少在一个非生产工作区完成“refresh → Workcopy → `save-svn` → 人工 commit → 平台自动同步 → 平台内容复核”闭环。
7. 明确接受 PAGE/过程函数的谷神签出元数据不再由 SVN 模式展示；需要该信息时仍切换到 database 工作区。
8. `billtype`、业务 `diagnose` 和仍未等价的 metadata 能力继续有明确 database 入口，不被 SVN 菜单误导性替代。

满足这些门槛后可以隐藏该工作区的数据库源码拉取按钮，但不建议删除 `providers/database/`；它仍承担
双模式回退、system-data bootstrap、未覆盖 metadata 和业务诊断。等未来 `system-data.json` 有可靠静态来源、
SVN 仓库补齐必要对象格式且项目继承语义完成验证后，再单独评估是否能移除对应数据库依赖。

## 14. 2026-08-17 实现与交接状态

本节按“代码已实现”“本地已验证”“仍待实现或真实环境验证”记录当前边界。未列入“已验证”的内容不能视为通过生产验收。

### 14.1 已实现

1. 双模式配置与路由
   - `products.yaml`、`projects.yaml` 强制显式声明 `source_mode: database | svn`，现有本机工作区已补为 `database`，未发生隐式切换。
   - 产品/项目配置 ID 跨集合唯一且只能是安全单级目录名；`workspace_root` 与 `checkout_root` 强制分离。
   - workspace summary 返回 `sourceMode`、provider 源目录、checkout 路径、同步状态和服务端计算的 capabilities。
   - 数据库工作区保留原五步同步、metadata 导出、诊断和 readonly/Workcopy 语义；SVN 工作区只把本地源码扫描计为同步步骤。

2. SVN working copy 管理
   - 新增 `scripts/providers/svn/checkout.py`，实现配置驱动的 `svn init`、`svn refresh`、`svn status`、可选远端过期检查和显式 `--prune`。
   - `systems.include.system_aliases` 通过 `system-data.json` 唯一解析为 `SYSTEM_ID`、`DATA_SOURCE_ID`；只有 `init/refresh` 在缓存缺失时可调用现有数据库映射查询，普通扫描不访问数据库。
   - 稀疏范围固定包含必要根文件，并覆盖配置选择的 `pages`、`procedures`、`system-script`、`tables`、`views`。
   - 保存 repository URL、UUID、relative URL、`proId` 和 `workspaceKey` 指纹；刷新前同时核对本地与远端 `info.json` 指纹。
   - 刷新会阻断本地修改、mixed revision、switched working copy；范围缩小默认只报告残留，只有显式 `--prune` 才排除。
   - 工作区级文件锁串行化 init、refresh、writeback，共享锁保护扫描；SVN 客户端最低版本为 1.10。
   - `repository_url`、`checkout_root` 和 `workspace_root` 支持严格的单一 `${ENV_NAME}` 引用；根目录使用真实路径做隔离校验，同时保留数据库模式既有路径语义。
   - 密码/token 不进入配置或命令参数；支持环境变量用户名、经 stdin 传入的环境变量密码、`--no-auth-cache` 和显式证书失败白名单。非交互调用缺少凭据时快速失败，不等待隐藏输入。`svn.capabilities.commit` 固定为 `false`。

3. 本地扫描、索引与查询
   - 新增 `scanner.py`，只扫描 `checkout-scope.json` 白名单，覆盖 PAGE JSON/GSS、过程函数 GSS、系统脚本、表 JSON、视图 JSON。
   - PAGE 使用真实 `pageId/pageAliasId` 和稳定 JSON Pointer；调用索引使用继承解析后的有效脚本，Workcopy 映射仍保留原始值。
   - 过程函数从 GSS 头和路径解析 package/function/description；表、视图作为只读对象进入同一 SQLite 索引。
   - 索引新增 provider、源相对路径、文件 hash、SVN BASE revision、JSON Pointer、SYSTEM_ID 和 DATA_SOURCE_ID 字段；现有 `query`、调用方分析和源码 Markdown 继续复用。
   - `sync-source*`、`reindex`、`sync-all` 在 SVN 模式只做本地扫描，不隐式执行 update 或数据库源码查询。

4. Workcopy 投影与安全写回
   - 新增 `projection.py` 和 `writeback.py`。对象按索引懒加载到现有 `source/workcopy`，checkout 不复制到 readonly。
   - PAGE 生成受保护 `raw.json`、唯一拆分脚本和 `source-meta.json`；过程函数/系统脚本使用直接文件投影；表/视图可打开但只读。
   - 保存前校验 workspace、checkout、受控相对路径、symlink、文件 hash、BASE revision、外部 checkout 修改、PAGE 身份、JSON Pointer 和生成头。
   - Workcopy 映射文件和 `raw.json` 只能解析到当前对象目录内；写回后若状态、元数据、预期 dirty 清单或审计日志更新失败，会一并回滚 checkout 与本地映射状态。
   - PAGE 只替换选中的 JSON 字符串 token；过程/系统脚本原子写回并保留 UTF-8/BOM、GB18030、CRLF/LF 和末尾换行约束。
   - `workcopy save-svn --check` 只预览；`save-svn` 写回后更新 Workcopy 映射、预期 dirty 清单、审计日志和索引，并输出 `svn diff`。中途失败恢复本轮写入前内容。
   - 工具没有 `svn commit` 命令；提交必须由用户审阅差异后按文件清单人工执行。

5. CLI、Bridge 与 Nexus
   - CLI 增加 `workspace-summary`、`svn init|refresh|status`，初始化/刷新成功后自动重建索引；`create-workcopy` 和 `workcopy save-svn` 支持 SVN 对象。
   - SVN 模式明确拒绝数据库 metadata export、业务 `diagnose` 和 Bridge 旧 `/pullHubSource`；表/视图只通过本地索引读取，billtype 不伪造。
   - Bridge 的 route 响应携带裁剪后的 workspace summary，只用于页面能力裁剪和安全路由；SVN init/refresh/Workcopy/writeback 不暴露新的本地 HTTP 修改接口，统一由 Nexus/CLI 发起。
   - Chrome popup 与页面悬浮入口按 workspace summary 隐藏 SVN 工作区的旧源码拉取/数据库导出操作；服务端仍做二次校验。
   - Nexus 节点显示数据库/SVN 模式，并按 effective capabilities 生成初始化、刷新、状态、扫描、打开 Workcopy、预检/写回菜单；不会显示自动提交。
   - 配置模板、根 README、配置说明、Bridge/Nexus README 和两份 HTML 手册已同步双模式行为。

### 14.2 本地已验证

- 使用 `svnadmin` + `file://` 临时仓库完成稀疏初始化、刷新、五类对象扫描、SQLite 索引、PAGE 投影、JSON Pointer 最小回写和 `svn diff` 闭环。
- 已验证重复展示名脚本生成不同映射文件；`raw.json` 修改、checkout 外部修改、dirty refresh、生成头修改和 `commit: true` 均会阻断。
- 已验证 PAGE 别名/索引名称、过程函数头解析，以及 GB18030 + CRLF 的 Workcopy 往返保持。
- 最终本地回归结果：Python `unittest discover` 102/102（其中 SVN provider 13/13）、workspace routing 6/6、Bridge 36/36、Nexus 43/43；GuthonCodeTool self-test、Python 语法检查、JavaScript `node --check` 和 `git diff --check` 均通过。
- 项目规则中保留的历史命令 `python3 scripts/test_workspace_routing.py` 对应文件已不在 `scripts/`；实际测试位于 `tests/test_workspace_routing.py`，已通过统一 discovery 和 `PYTHONPATH=scripts` 定向执行，不应重新在 `scripts/` 增加测试副本。
- 现有真实 `var/` 只用于只读核对历史 SVN 结构，未修改历史 working copy，也未触发真实 SVN update/commit 或数据库同步。

### 14.3 仍待真实环境验收或后续实现

以下事项依赖真实仓库、凭据、谷神平台或更完整样本，本轮不能据本地 fixture 宣称完成：

1. 在一个非生产产品/项目确认 `repository_url` 粒度、权限、HTTPS 证书白名单、repository hook 和 `info.json.proId` 与工作区身份一致。
2. 执行真实“`svn init/refresh` → 扫描 → 打开 Workcopy → `save-svn --check` → `save-svn` → 人工定向 commit → 谷神平台自动同步 → 平台内容复核”闭环，并记录延迟与失败反馈。
3. 对同一工作区做数据库/SVN PAGE、过程函数、系统脚本的对象数量、ID、源码 hash、调用关系、项目继承和产品快照抽样对照；当前不能证明所有项目继承语义等价。
4. 用真实超大 PAGE、空脚本、PAGE GSS、系统脚本、UTF-8 BOM/UTF-16、中文转义、重复 ID/别名和结构冲突补齐往返样本；确认页面模型/模块层级和排序相对数据库目录没有信息损失。
5. 验证 repository 新增 `svn:externals`、`svn:needs-lock`、`svn:eol-style`、repository lock、tree conflict、switched/mixed/partial revision 和并发多进程场景；当前实现会阻断已识别的本地冲突、mixed、switched 与外部修改，但尚未形成完整属性/锁策略。
6. 提交前应使用 `svn status --remote` 做联网 out-of-date 检查；尚未实现插件自动限制人工 SVN 客户端只能提交生成清单，仓库权限/hook 仍是最终边界。
7. 重新打包并安装 VSIX/Chrome 扩展，重启 Bridge 后验证真实页面身份路由、按钮裁剪、配置 capability 热更新和 packaged/development 两种运行时；源码测试不等于已安装验证。
8. SVN 模式仍不覆盖 billtype、谷神签出/签入状态、错误标记和业务数据 `diagnose`；这些能力按设计继续由显式 database 工作区承担，不应通过猜测补齐。

后续接手应先完成第 1、2、7 项真实闭环，再依据第 3、4 项差异决定是否扩大系统脚本写回范围或允许更多工作区切换到 SVN；在第 13.5 节门槛全部满足前，不删除数据库 provider。
