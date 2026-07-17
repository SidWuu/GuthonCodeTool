# 谷神 VS Code 扩展

本目录用于存放谷神方言 VS Code 本地扩展，目前支持代码补全、API 悬浮备注和本地过程函数源码快捷跳转。扩展不依赖 IntelliCode，也不调用 Copilot，补全数据随扩展离线提供。

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

从 [GuthonCodeTool Releases](https://github.com/SidWuu/GuthonCodeTool/releases) 下载 `gushen-vscode-completion-0.1.0.vsix` 后安装：

```bash
code --install-extension /path/to/gushen-vscode-completion-0.1.0.vsix --force
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
下载的 gushen-vscode-completion-0.1.0.vsix 文件
```

## 重新打包

扩展源码在 `gushen-vscode-completion/` 子目录。修改扩展代码、规则或补全数据后，重新打包并安装：

```bash
cd plugins/GuthonVSCodeExtension/gushen-vscode-completion
vsce package
code --install-extension gushen-vscode-completion-0.1.0.vsix --force
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
vsce package
code --install-extension gushen-vscode-completion-0.1.0.vsix --force
```

`/path/to/api-docs` 目录需要包含 `java.md`、`javascript.md` 和 `sql.md`。

`npm run build:data` 会重新生成：

```text
data/java.json
data/javascript.json
data/sql.json
data/index.json
```

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
