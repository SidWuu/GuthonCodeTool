# Guthon Nexus

Guthon Nexus is the VS Code development surface for GuthonCodeTool.

It manages local Guthon workspaces, runs source and metadata synchronization, exposes workcopy maintenance tools, and provides offline Gushen API completions, hover documentation, and source navigation. It does not depend on IntelliCode or Copilot.

It can also run the packaged `GuthonCodeTool` executable. This lets users initialize and sync local sources without installing Python.

## Packaged source tool

Build `dist/GuthonCodeTool` (or `GuthonCodeTool.exe` on Windows) on each target OS with `python scripts/build_guthon_tool.py`, then distribute that executable together with this VSIX. In VS Code, run these commands in order:

1. `Guthon Nexus: 初始化工作区` — choose the executable and a local data directory. It creates missing configuration files from templates without overwriting existing ones.
2. Fill the generated `<本地数据目录>/config/*.yaml`; each product or project defines its datasource and system aliases.
3. Expand `项目` and choose a `PRD` or `PRJ` workspace.
4. Run the selected workspace's full synchronization command.

Clicking `Guthon Nexus: 初始化工作区` again after initialization asks whether to switch workspaces. Confirming lets the user select a new local data directory and initializes its missing configuration files; cancelling keeps the current workspace.

Each workspace node can synchronize source, table schemas, bill types, system scripts, and views. All command output is shown in the `GuthonCodeTool` output channel.

The extension also adds a dedicated `Guthon Nexus` icon to VS Code's left activity bar. Its tree exposes initialization, source/index sync, metadata export, environment checks, source diagnosis, and workcopy status/diff/package actions, so colleagues do not need to use the command palette.

`工作区` → `运行模式` defaults to `发行模式`. Maintainers can switch to `调试模式` and select a GuthonCodeTool source checkout containing `.venv` and `scripts/guthon_tool.py`. Sidebar commands and Bridge requests then run the current Python sources directly; switching back reuses the saved packaged application and the same data directory.

Nexus writes the selected runtime to `<本地数据目录>/var/nexus/tool-runtime.json`. Its `command` array is either the packaged executable or the development Python executable plus `scripts/guthon_tool.py`; `home` is the shared local data directory. AI tools use this file instead of guessing the VS Code setting.

Expand `工作区` → `配置文件` to edit the selected local data directory's `datasource.yaml`, `products.yaml`, `projects.yaml`, `source-tables.yaml`, or `sync.yaml` directly in VS Code.

Each sidebar action that runs the packaged tool asks for confirmation before it starts. Opening configuration files and local folders remains single-click.

The sidebar also starts and stops Guthon Bridge with VS Code's bundled Node runtime. It automatically passes the active packaged or development runtime and local data directory, so users do not need to set Bridge environment variables. Switching a workspace or execution mode restarts a running Bridge.

Both runtimes retain the non-UI entry points: `create-workcopy`, `workcopy`, `query`, `diagnose`, `doctor`, `export-markdown`, and each metadata export command. Workspace commands include an explicit key, for example `command + ["query", "--home", home, "--workspace", "projects.demo-project", "--", "callers", "--alias", "<别名>", "--fun", "<函数>"]`.

## Features

- Initializes or switches the GuthonCodeTool local workspace.
- Opens and edits the five local YAML configuration files.
- Lists all configured product and project workspaces and binds every action to its `workspaceKey`.
- Exports table schemas, bill types, system scripts, views, and source Markdown.
- Runs environment checks and readonly source diagnosis.
- Inspects workcopy status, generates diffs, and packages delivery files.
- Starts and stops Guthon Bridge without a separate Node.js installation or terminal command.
- Switches between the packaged application and live Python source development.
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
code --install-extension GuthonCodeTool-vscode.vsix --force
```
