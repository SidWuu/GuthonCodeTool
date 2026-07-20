# var 目录说明

`var/` 是本机私有工作区，根仓库通过 `.gitignore` 忽略它；本目录自己是独立 Git 仓库。查看源码、文档、工具或运行数据变更时必须进入本目录：

```bash
cd var
git status
git diff
```

## 顶层目录

```text
source/      源码
database/    数据库结构 JSON，不存数据
docs/        正式文档
knowledge/   知识卡片
tools/       私有工具
runtime/     配置、日志、缓存、临时文件
```

## source

`source/` 保存从谷神平台拉取、生成或用于开发的源码文件。

```text
source/readonly/    从源码表导出的只读镜像，作为上游基线
source/workcopy/    开发工作副本，改源码优先看这里
```

常见源码结构：

```text
source/readonly/products/{产品名称}/{子系统}/page/{模型序号}_{模型}/{模块序号}_{模块}/{页面名 页面ID}/
source/readonly/products/{产品名称}/{子系统}/procedure/{过程别名}/{函数名}/
source/readonly/project/{项目名称}/{子系统}/...
source/workcopy/products/{产品名}/{子系统}/page|procedure/...
source/workcopy/projects/{项目名}/{子系统}/page|procedure/...
```

页面按 `gd_auth.MODEL_ID` 归入模型目录，同一模型内按模块 `ORDER_NO` 排序。模型、模块目录均使用三位排序号，例如 `001_往来转账/002_往来转账报表`；排序号为空时使用 `999`。

页面目录常见文件：

```text
meta.json      源码表元数据、change_key、status
raw.json       页面原始 JSON
scripts/       从 raw.json 拆出的脚本、SQL、VM 片段
README.md      单个源码对象的简要说明
```

过程函数目录常见文件：

```text
meta.json      源码表元数据、change_key、status
source.vm      过程函数源码
README.md      单个源码对象的简要说明
```

工作副本常见辅助文件：

```text
source-meta.json  工作副本对应的索引记录
diff.md           修改说明草稿
```

## database

`database/` 只放数据库结构 JSON、DDL 转换输入输出等结构信息，不放业务数据、脱敏不充分的数据或数据库备份。

建议结构：

```text
database/schema/{products|projects}/{名称}/    表结构 JSON
database/billtype/{products|projects}/{名称}/  单据类型 JSON
database/dict/                               字典、枚举、字段说明
```

表结构和单据类型按根仓库 `config/sync.yaml` 的当前 `sync.ACTIVE` 隔离，目录末级使用产品或项目配置中的 `name`。

## docs

`docs/` 放正式文档，例如开发基线、模块规范、贸易流程说明。AI 助手处理谷神任务时优先读取这里的规则文件。

## knowledge

`knowledge/README.md` 是 AI 查询入口；全量 Markdown 索引仅供人工浏览，不作为 AI 开发上下文。

```text
knowledge/source-sync-status.md
knowledge/README.md
knowledge/products/{product_id}/source-index.md
knowledge/products/{product_id}/invoke-index.md
knowledge/products/{product_id}/dynamic-invoke-points.md
knowledge/projects/{project_id}/invoke-index.md
```

## tools

`tools/` 放本机私有工具和辅助脚本。这里的工具可以进 `var` 的私有 Git，但不要放入公开仓库。

## runtime

`runtime/` 放运行时文件，不承载正式源码或正式文档。

建议结构：

```text
runtime/index/hub.db   同步、源码记录、调用索引
runtime/logs/          日志
runtime/temp/          临时文件
runtime/cache/         缓存
```

## AI 助手处理顺序

1. 先读 `AGENTS.md` 和 `docs/` 下的相关规则。
2. 先查询 `runtime/index/` 的对应DB局部上下文。
3. 看开发副本时进入 `source/workcopy/`。
4. 看上游基线时进入 `source/readonly/`。
5. 涉及本机私有工具时进入 `tools/`。
6. 涉及数据库结构时进入 `database/`，不要假设这里有业务数据。
7. 涉及源码差异时在 `var/` 仓库运行 `git status` 和 `git diff`。

## 注意

- 根仓库的 `git status` 看不到 `var/` 内差异，这是预期行为。
- Git 不跟踪空目录；只有目录变化但没有文件变化时不会显示差异。
- `var` 仓库默认不配置 remote；如需远端，只能配置私有仓库。
- 源码 `vm` 模板没有高亮时，需要设置为 `java`类型。以 VSCode 为例 `"files.associations": {"*.vm": "java"}`
