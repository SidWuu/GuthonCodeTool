# Guthon Nexus

Guthon Nexus 是 GuthonCodeTool 的 VS Code 开发入口。它把工作空间设置、DATABASE 同步与 Workcopy、SVN
“谷神源码”与 SCM，以及谷神方言编辑能力集中到 VS Code 左侧同名面板中。

扩展不依赖 IntelliCode，也不调用 Copilot；谷神 API 补全数据随 VSIX 离线提供。

## 开发工具面板

### 工作区

- 运行模式：普通用户使用“发行模式”；维护者使用“调试模式”直接运行源码仓库的 `.venv` 和 Python 入口。
- 项目源码来源：每个产品/项目节点独立选择 `DATABASE / SVN`，切换后立即刷新功能树；两种 provider 的项目混合显示。
- 运行时描述：把当前模式、命令前缀和本地数据目录写入 `var/nexus/tool-runtime.json`，供 AI 使用同一套规范调用。
- 设置工作空间：尚未配置时选择 GuthonCodeTool 应用和本地数据目录，创建缺失配置但不覆盖已有文件。
- 切换工作空间：已配置时同一位置显示“切换工作空间”，确认后选择新的本地数据目录；取消时保留当前工作空间。
- 配置文件：直接编辑 `datasource.yaml`、`products.yaml`、`projects.yaml`、`source-tables.yaml` 和 `sync.yaml`。
- 打开本地数据目录。

### 项目

- 同时列出全部 `PRD <产品名称>`、`PRJ <项目名称>` 及其同步状态。
- 每个节点绑定自己的 `workspaceKey`。DATABASE 节点可独立同步全部资料、执行只读源码排查和维护 Workcopy；SVN 节点按授权清单管理 checkout、索引和本地源码变更。
- 节点显示“数据库”或“SVN”，操作由 workspace summary 的有效 capabilities 生成，不在扩展内猜测配置。
- SVN 工程不在 YAML 配置模式；在目标节点选择 SVN，并把谷神下载的 `svnCheckoutHere.sh` 放入工程 `context/`；“从签出脚本
  检出/更新 SVN”先展示脱敏范围统计，确认后生成同目录授权清单并使用同一次认证处理全部 working copy，不执行脚本或持久化凭据；旧 `.bat` 仍兼容。
- SVN 节点按授权清单初始化或更新多个精确 URL working copy；物理目录按 `systems/<SYSTEM_ID>` 和 `datasources/<DATA_SOURCE_ID>` 聚合，在“谷神源码”中按业务分类展示 PAGE、过程函数、
  系统脚本、表和视图；页面与过程函数的名称、目录及显示顺序分别来自 `pages/index.md`、`procedures/index.md`，PAGE 脚本/SQL/字段以及过程源码通过虚拟文档编辑并直接回写原 checkout。未编入索引的对象稳定排在已索引内容之后。
- 每个 SVN workspace 在 VS Code 源代码管理中只显示一个逻辑项目，内部聚合多个 working copy，提供基于 `index.md` 中文名称的本地/远程变更、PAGE 可读/原始 diff、历史、全部/单文件提交与更新、按物理文件部分保存和放弃修改。
- 不设置当前或默认产品、项目。

### 维护

- 检查本地环境。

只读源码逻辑排查和 Workcopy 状态、差异、交付物操作位于对应 DATABASE 项目节点。SVN 的 `Ctrl+S` 只写本地
checkout；“管理本地源码变更”统一提供类 Git 差异、多选/全选保存和撤销。“保存到谷神”是 SVN 模式固定能力，
跨 working copy 时分组提交并产生多个 revision；成功后仍显示“待平台提交”。冲突、新增、删除、未跟踪和属性变化
仅展示并阻止保存或撤销。SCM 顶部、Nexus 修改组和远程变更组可执行全部操作；每个 Nexus 修改/远程文件行可
单独提交或更新。单文件更新只作用于该授权物理路径，同文件有本地修改时必须显式确认 SVN 原生合并。

`.gss` 注册为独立的 Guthon GSS 语言，继承 Java 语法并补充 Velocity/GSS 指令和变量高亮，继续复用 Nexus 的 API 补全、悬停、转到定义和查找引用；旧 `.vm` 保持 Java 兼容。更新遇到 SVN `incomplete` 或 working-copy 管理锁时，仅执行标准 `svn cleanup` 后重新检查，不删除未跟踪文件、不还原本地修改。

### Guthon Bridge

- 在左侧面板单击“启动 Guthon Bridge”或“停止 Guthon Bridge”。
- Nexus 自动复用当前运行模式和本地数据目录：发行模式调用应用，调试模式调用源码仓库 Python；无需设置 Bridge 环境变量或打开终端。
- Bridge 根据请求的 `workspaceKey` 或页面身份路由到对应产品、项目；多个候选由 Chrome 选择。
- Bridge 运行时切换运行模式，也会自动重启；调试模式下每次拉取都会读取最新 Python 脚本。

所有会运行 GuthonCodeTool 的操作都要求用户确认；打开配置文件和本地目录保持单击。

## 代码补全

- 默认按当前文件类型补全：
  - Java 文件使用 `java` API 数据。
  - JavaScript 文件使用 `javascript` API 数据。
  - SQL 文件使用 `sql` API 数据。
- Java 文件中的特殊路由：
  - 输入 `sqltools`，补全 SQL 文档中的 `SQLTools.*` 片段。
  - 输入 `sql`，补全 Java 文档中的 `$vs.sqlTools.*` 片段。
  - 输入 `sqlh`，补全 Java 文档中的 `$vs.sqlHelper.*` 片段。
- Java 后端脚本基础语法片段：
  - `set`
  - `if`
  - `ifelse`
  - `foreach`
  - `while`
  - `continue`
  - `break`
  - `tryCatchFinally`
  - `function`
- 补全提示展示：
  - 左侧候选列表显示补全前缀和简短说明。
  - 右侧说明面板显示补全 body，然后换行显示完整 description。
- 支持已保存文件和未保存临时文件。临时文件需要手动把语言模式切到 `Java`、`JavaScript` 或 `SQL`。

## API 悬浮备注

鼠标悬停在 Java、JavaScript 或 SQL 文件中的谷神 API 上时，显示补全数据中的方法签名和方法备注；存在重载时会同时显示全部签名。

## 本地源码快捷跳转

使用 VS Code 打开包含本地谷神源码的工作区后，可以从 Java 后端脚本中的以下过程函数调用跳转到对应源码：

```java
$vs.proc.invoke("过程别名", "函数名", $参数)

#set($proc = $vs.proc.find("过程别名"))
$proc.函数名($参数)
```

将光标放在函数名上，通过 `Cmd+Click`（macOS）、`Ctrl+Click`（Windows/Linux）或 `F12` 执行“转到定义”。目前仅支持过程别名和函数名为固定字符串的调用。

## 安装方式

从 [GuthonCodeTool Releases](https://github.com/SidWuu/GuthonCodeTool/releases) 下载 `GuthonCodeTool-vscode.vsix` 后安装：

```bash
code --install-extension /path/to/GuthonCodeTool-vscode.vsix --force
```

安装后在 VS Code 中执行：

```text
Developer: Reload Window
```

如果终端提示 `code: command not found`，先在 VS Code 中执行：

```text
Shell Command: Install 'code' command in PATH
```

也可以在 VS Code 扩展面板右上角菜单中选择 `Install from VSIX...`，然后选择：

```text
下载的 GuthonCodeTool-vscode.vsix 文件
```

## 重新打包

扩展源码在 `gushen-vscode-completion/` 子目录。修改扩展代码、规则或补全数据后，重新打包并安装：

```bash
cd plugins/GuthonVSCodeExtension/gushen-vscode-completion
npm run package
code --install-extension GuthonCodeTool-vscode.vsix --force
```

## 修改补全规则

普通情况下只改：

```text
gushen-vscode-completion/rules.json
```

默认规则：

```json
{
  "defaults": {
    "java": "java",
    "javascript": "javascript",
    "sql": "sql"
  },
  "routes": [
    {
      "in": "java",
      "type": "sqltools",
      "use": "sql",
      "group": "sql"
    },
    {
      "in": "java",
      "type": "sql",
      "use": "java",
      "group": "sqlb"
    },
    {
      "in": "java",
      "type": "sqlh",
      "use": "java",
      "group": "sqlh"
    }
  ]
}
```

字段含义：

- `defaults`：没有命中特殊路由时，按当前文件类型使用哪个数据源。
- `routes[].in`：当前编辑器语言。
- `routes[].type`：输入的触发词。
- `routes[].use`：使用哪个数据源。
- `routes[].group`：只使用该数据源中的哪个分组。

改完后需要重新打包并安装 `.vsix`。

## 修改基础语法片段

Java 后端脚本基础语法片段维护在：

```text
gushen-vscode-completion/data/manual.json
```

这部分不会被 `npm run build:data` 覆盖。

## 更新 API 补全数据

当 API 文档更新后，在扩展目录执行：

```bash
cd plugins/GuthonVSCodeExtension/gushen-vscode-completion
npm run build:data -- /path/to/api-docs
npm test
npm run package
code --install-extension GuthonCodeTool-vscode.vsix --force
```

`/path/to/api-docs` 目录需要包含 `java.md`、`javascript.md` 和 `sql.md`。

`npm run build:data` 会重新生成 `data/index.json`。

不会覆盖：

```text
rules.json
data/manual.json
```

## 验证

修改后建议至少执行：

```bash
npm test
node --check src/extension.js
node --check src/rules.js
```
