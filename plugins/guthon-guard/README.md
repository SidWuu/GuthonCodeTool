# Guthon Guard

`guthon-guard` 将谷神可机械判断的开发限制固化为独立的
`guthon-lint`，并通过 Codex Hook、Git Hook 和 CI 共用同一套规则。插件只包含
可公开的通用引擎；仅在当前工作区存在 `.guthon/config.json` 时启用，项目 API
索引从同目录的 `.guthon/api-index.json` 加载。其他项目不会触发 Guthon 门禁。

## 当前硬规则

| 编号 | 规则 |
|---|---|
| `GUTHON000` | 禁止普通文件工具修改 `source/readonly`、`checkout`、`raw.json`、`meta.json`、`source-meta.json` |
| `GUTHON001` | 禁止 Java `Map.keySet()`，使用 `$vs.util.getMapKeys(map)` |
| `GUTHON002` | 同一方法内 `#foreach` 元素不得与任意 `#set` 局部变量重名 |
| `GUTHON003` | 禁止直接赋值 `$result.FIELD`，使用 `#set` |
| `GUTHON004` | `#if/#elseif/#else/#end` 必须独占物理行 |
| `GUTHON005` | Velocity 块指令必须闭合 |
| `GUTHON006` | `$vs.*`、`SQLTools.*` 调用必须存在于权威 API 索引 |
| `GUTHON007` | `#if/#elseif` 条件中禁止直接进行算术运算 |
| `GUTHON008` | 禁止把比较或逻辑表达式直接赋给布尔变量；显性分支或三元表达式除外 |
| `GUTHON009` | `newHashSet/newLinkedHashSet` 创建的 Set 必须先通过 `setToList` 赋给变量再循环 |
| `GUTHON010` | 同一页面 JavaScript 事件脚本只能保留一个 `$vm.save(...)` 入口 |
| `GUTHON011` | SQL 禁止使用 `ifnull/nvl/date_add/to_date`，改用对应的 `SQLTools.*` API |
| `GUTHON901` | 私有工作区 API 索引缺失或为空时拒绝继续，防止静默降级 |

扫描范围包括 `.gss`、`.vm`、`.js` 和 `.sql`。Velocity 结构规则只作用于
`.gss/.vm`，页面保存规则只作用于 `*.onClickScript.js`，SQL 可移植性规则作用于
`.gss/.vm/.sql`。

## 本地使用

```bash
python3 plugins/guthon-guard/scripts/guthon_lint.py path/to/source.vm
```

在包含私有 API Markdown 的谷神工作区中重新生成索引：

```bash
python3 ../plugins/guthon-guard/scripts/generate_api_index.py
```

## Codex 团队安装

首次将仓库注册为团队市场并安装插件：

```bash
codex plugin marketplace add /absolute/path/to/GuthonCodeTool
codex plugin add guthon-guard@personal
```

安装后在 Codex 中审查并信任插件 Hook。Hook 成功时不输出上下文；失败时只返回精简诊断。

## Git 门禁

私有工作区保留自己的 `.githooks/pre-commit`。每位同事在该工作区执行一次：

```bash
git config core.hooksPath .githooks
```

CI 从私有工作区调用外层引擎即可复用相同门禁：

```bash
python3 ../plugins/guthon-guard/scripts/guthon_lint.py \
  --changed --write-target --quiet
```

Agent、Git 和 CI 只负责触发；规则实现只维护在
`scripts/guthon_lint.py` 中。

## 推荐移植架构

以 Codex 插件作为最便利的主入口，同时保持规则引擎与 Agent 无关：

```text
guthon-lint（唯一规则实现）
├── Codex：PreToolUse / PostToolUse / Stop
├── 其他 Agent：各自的写前 / 写后 / 停止 Hook 薄适配器
├── Git：pre-commit
└── CI：合并前最终门禁
```

团队发布时使用唯一 Marketplace 名称（建议 `guthon-team`），不要复用当前
本机开发用的 `personal`。同事只需克隆工具仓库、注册 Marketplace、安装插件、
信任 Hook，并在私有项目中生成 `.guthon/api-index.json`。API 文档和生成索引
继续保留在私有工作区；公开插件只携带通用规则实现。

其他 Agent 不复制规则代码，只把其生命周期事件转换为以下三个动作：

1. 写前：检查写入路径和可从补丁确定的行级错误。
2. 写后：对完整目标文件运行 `guthon-lint`。
3. 停止或提交前：运行 `guthon-lint --changed --write-target`。

不支持同步 Hook 的 Agent 仍可直接调用 CLI，并由 Git Hook 与 CI 兜底。这样
Codex 获得最短安装路径，Claude Code、Gemini CLI、IDE Agent 和人工编辑共享
同一规则结果，不会因维护多份规范实现而漂移。

## 测试

```bash
python3 -B -m unittest discover -s plugins/guthon-guard/tests -v
```
