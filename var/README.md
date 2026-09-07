# var 目录说明

`var/` 是本机私有数据仓库，根仓库默认忽略其内容；查看本地资料变更时进入本目录执行 `git status`、`git diff`。

## 目录结构

```text
AGENTS.md                    谷神任务路由与开发规则
docs/                        所有工作区共享的公共文档
tools/                       私有辅助工具
nexus/                       Nexus、Bridge 公共运行状态
checkout/                    SVN working copy；由 SVN/Nexus 独占，Git 忽略
workspace/
├── PRD <产品名称>/          产品工作区
└── PRJ <项目名称>/          项目工作区
```

产品和项目目录只负责展示排序，程序使用配置中的稳定键 `products.<id>`、`projects.<id>` 识别工作区，不解析目录名。

## Git 与 SVN 边界

- `var` Git 管理 `AGENTS.md`、`docs/`、`nexus/`、`workspace/` 中的配置、上下文、索引资料和 DATABASE 源码；使用 `git -C var status`、`git -C var diff` 查看这些变化。
- `var/checkout/` 是 SVN 模式唯一源码事实来源，已由根级 `.gitignore` 排除；Git 不暂存、不提交、也不负责恢复其中源码。
- SVN 源码差异统一在 VS Code 的 Guthon Nexus 源代码管理中查看，或由 Nexus 对目标 working copy 执行受控 `svn diff`；更新、放弃和“保存到谷神”也只走 Nexus/SVN。
- 不对 `var/checkout/` 执行 `git add -f`，不使用 Git restore/checkout 处理 SVN 源码。这样同一文件只属于 SVN，一份源码不会形成两套版本历史。

## DATABASE 工作区

```text
docs/                        当前产品或项目的业务文档
source/
├── readonly/                上游只读镜像，禁止人工修改
└── workcopy/                开发工作副本，只在需要修改时创建
database/
├── schema/                  表结构 JSON
├── billtype/                单据类型 JSON
└── views/                   视图 SQL
context/
├── README.md                轻量工作区入口
├── index.db                 源码与调用关系索引
├── state.json               DATABASE 五步同步状态和配置摘要
└── logs/                    当前工作区日志
```

页面源码通常包含 `meta.json`、`raw.json` 和拆分后的 `scripts/`；过程函数通常包含 `meta.json`、`source.vm`；系统脚本通常包含 `meta.json`、`source.js` 或 `source.css`。

源码修改只改 `source/workcopy` 中的拆分脚本，不改 `source/readonly` 和 `raw.json`。手动拉取与全量拉取只自动暂存本次新生成且未被 Git 忽略的文件，不暂存已跟踪文件修改或无关文件。

## SVN 工作区

```text
docs/                        当前产品或项目的业务文档
context/
├── svnCheckoutHere.sh       谷神平台下载的精确授权输入（旧 .bat 兼容）
├── authorized-scope.json    脱敏授权上限
├── checkout-scope.json      多 working copy 运行清单
├── source-mode.json         当前源码模式
├── README.md                轻量工作区入口
├── index.db                 源码与调用关系索引
└── state.json               SVN 检出、更新和索引状态
```

SVN 原始源码位于根级 `checkout/`，不在工作区中生成 readonly/workcopy 代码副本。`.svn-operation.lock`、
`svn-edit-session.json` 和 `logs/*.ndjson` 是本机运行状态，不应提交到 Git；全量源码 Markdown 只在显式执行
`export-markdown` 时生成。

## 命令

以下是工具源码开发模式的示例，须在外层 GuthonCodeTool 根目录执行；Agent 实际入口以 `nexus/tool-runtime.json` 为准。工作区级命令显式指定稳定键：

```bash
.venv/bin/python scripts/guthon_tool.py workspaces --home .
.venv/bin/python scripts/guthon_tool.py sync-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home . --workspace projects.demo-project
```

Nexus 同时展示所有配置工作区；Bridge 使用 `workspaceKey`，或根据页面的 `pageOrigin + dataSourceId + systemId` 路由。多个工作区匹配时，由 Chrome 扩展只为当前请求选择一次，不保存默认绑定。

## AI 开发入口

谷神任务从 [AGENTS.md](AGENTS.md) 进入，按其导航读取基线、模块规范、API、场景模式和业务事实；查询命令按需查阅[源码定位与有界查询](docs/AGENTS排查与源码调整提速方案.md)。README 只说明目录与工具用法，不另设执行流程。Claude 入口 [CLAUDE.md](CLAUDE.md) 引用同一规则。

## 注意

- `var/.git` 是全部工作区共用的私有 Git 仓库，不配置公开远端。
- 根仓库的 `git status` 通常看不到 `var/` 内生成资料。
- Nexus 已将 `*.gss` 和兼容保留的 `*.vm` 都关联为 Java 语言模式和 Java 高亮。
