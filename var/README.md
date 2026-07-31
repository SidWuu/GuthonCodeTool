# var 目录说明

`var/` 是本机私有数据仓库，根仓库默认忽略其内容；查看本地资料变更时进入本目录执行 `git status`、`git diff`。

## 目录结构

```text
AGENTS.md                    谷神任务路由与开发规则
docs/                        所有工作区共享的公共文档
tools/                       私有辅助工具
nexus/                       Nexus、Bridge 公共运行状态
workspace/
├── PRD <产品名称>/          产品工作区
└── PRJ <项目名称>/          项目工作区
```

产品和项目目录只负责展示排序，程序使用配置中的稳定键 `products.<id>`、`projects.<id>` 识别工作区，不解析目录名。

## 单个工作区

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
├── state.json               五步同步状态和配置摘要
└── logs/                    当前工作区日志
```

页面源码通常包含 `meta.json`、`raw.json` 和拆分后的 `scripts/`；过程函数通常包含 `meta.json`、`source.vm`；系统脚本通常包含 `meta.json`、`source.js` 或 `source.css`。

源码修改只改 `source/workcopy` 中的拆分脚本，不改 `source/readonly` 和 `raw.json`。手动拉取与全量拉取只自动暂存本次新生成且未被 Git 忽略的文件，不暂存已跟踪文件修改或无关文件。

## 命令

工作区级命令必须显式指定稳定键：

```bash
.venv/bin/python scripts/guthon_tool.py workspaces --home .
.venv/bin/python scripts/guthon_tool.py sync-all --home . --workspace products.demo-product
.venv/bin/python scripts/guthon_tool.py sync-source --home . --workspace projects.demo-project
```

Nexus 同时展示所有配置工作区；Bridge 使用 `workspaceKey`，或根据页面的 `pageOrigin + dataSourceId + systemId` 路由。多个工作区匹配时，由 Chrome 扩展只为当前请求选择一次，不保存默认绑定。

## AI 助手处理顺序

1. 先读 `AGENTS.md` 和公共 `docs/` 中命中的规则。
2. 从用户描述、目标路径、Nexus 或 Bridge 上下文确定唯一 `workspaceKey`。
3. 读取该工作区的 `context/README.md`、局部索引、workcopy 与 readonly；默认不扫描整个 `workspace/`。
4. 涉及表、字段或单据类型时读取同一工作区的 `database/`。
5. 涉及运行入口时读取 `nexus/tool-runtime.json`。
6. 只有用户明确要求跨产品或跨项目分析时才扩大范围。

## 注意

- `var/.git` 是全部工作区共用的私有 Git 仓库，不配置公开远端。
- 根仓库的 `git status` 通常看不到 `var/` 内生成资料。
- `*.vm` 可在 VS Code 中关联为 Java：`"files.associations": {"*.vm": "java"}`。
