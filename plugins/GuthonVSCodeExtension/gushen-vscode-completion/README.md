# Gushen VS Code Completion

Local VS Code completion provider for Gushen dialect APIs.

This extension provides offline snippets and API completions for Gushen Java service scripts, JavaScript page scripts, and SQL dialect scripts. It does not depend on IntelliCode or Copilot.

It can also run the packaged `GuthonCodeTool` executable. This lets users initialize and sync local sources without installing Python.

## Packaged source tool

Build `dist/GuthonCodeTool` (or `GuthonCodeTool.exe` on Windows) on each target OS with `python scripts/build_guthon_tool.py`, then distribute that executable together with this VSIX. In VS Code, run these commands in order:

1. `Guthon: 初始化工作区` — choose the executable and a local data directory. It creates missing configuration files from templates without overwriting existing ones.
2. Fill the generated `<本地数据目录>/config/*.yaml`, including datasource and `sync.ACTIVE`.
3. `Guthon: 初始化源码索引`.
4. `Guthon: 同步当前 ACTIVE 源码`.

`Guthon: 同步当前 ACTIVE 全部资料` additionally exports table schemas, bill types, system scripts, and views. All command output is shown in the `GuthonCodeTool` output channel.

The extension also adds a dedicated `谷神工具` icon to VS Code's left activity bar. Its tree exposes initialization, source/index sync, metadata export, environment checks, source diagnosis, and workcopy status/diff/package actions, so colleagues do not need to use the command palette.

Expand `工作区` → `配置文件` to edit the selected local data directory's `datasource.yaml`, `products.yaml`, `projects.yaml`, `source-tables.yaml`, or `sync.yaml` directly in VS Code.

Each sidebar action that runs the packaged tool asks for confirmation before it starts. Opening configuration files and local folders remains single-click.

For the existing Chrome Bridge's current-PAGE pull, set `GUTHON_TOOL_PATH` to this executable and `GUTHON_TOOL_HOME` to the same local data directory before starting the Bridge. Without these variables, the Bridge retains its current Python-script development fallback.

The executable also retains the non-UI entry points: `create-workcopy`, `workcopy`, `query`, `diagnose`, `doctor`, `export-markdown`, and each metadata export command. Pass original script arguments after `--`, for example: `GuthonCodeTool query --home <目录> -- callers --alias <别名> --fun <函数>`.

## Features

- Java, JavaScript, and SQL completions from generated local data.
- Java syntax snippets for Gushen backend script directives.
- Route-based cross-source completions:
  - In Java files, `sqltools` shows SQL `SQLTools.*` completions.
  - In Java files, `sql` shows Java `$vs.sqlTools.*` completions.
  - In Java files, `sqlh` shows Java `$vs.sqlHelper.*` completions.
- Completion details:
  - Suggestion row shows the prefix and a short description.
  - Detail panel shows the snippet body and full description.
- Works for saved files and untitled files when the language mode is `Java`, `JavaScript`, or `SQL`.
- Shows the completion signature and description when hovering over a Gushen API.
- Opens local procedure sources from `$vs.proc.invoke(...)` and `$proc.*` calls with Go to Definition (`Cmd+Click` on macOS, `Ctrl+Click` on Windows/Linux, or `F12`).

## Configuration

The default route table is stored in:

```text
rules.json
```

Example:

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
    }
  ]
}
```

You can also set a custom absolute rules path with:

```text
gushenCompletion.rulesPath
```

## Data Files

Generated completion data:

```text
data/index.json
```

Manual syntax snippets:

```text
data/manual.json
```

`manual.json` is merged at runtime and is not overwritten by `npm run build:data`.

## Development

Regenerate API completion data:

```bash
npm run build:data
```

Run tests:

```bash
npm test
```

Debug in VS Code:

```text
Open this folder, then press F5.
```

Package:

```bash
npm run package
```

Install the packaged extension:

```bash
code --install-extension gushen-vscode-completion-0.1.0.vsix --force
```
