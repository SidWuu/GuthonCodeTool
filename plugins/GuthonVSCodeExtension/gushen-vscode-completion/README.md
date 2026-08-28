# Guthon Nexus

Guthon Nexus is the VS Code development surface for GuthonCodeTool.

It manages local Guthon workspaces, runs source and metadata synchronization, exposes workcopy maintenance tools, and provides offline Gushen API completions, hover documentation, and source navigation. It does not depend on IntelliCode or Copilot.

It can also run the packaged `GuthonCodeTool` executable. This lets users initialize and sync local sources without installing Python.

## Packaged source tool

Build `dist/GuthonCodeTool` (or `GuthonCodeTool.exe` on Windows) on each target OS with `python scripts/build_guthon_tool.py`, then distribute that executable together with this VSIX. In VS Code, run these commands in order:

1. `Guthon Nexus: 设置/切换工作空间` — choose the executable and a local data directory. It creates missing configuration files from templates without overwriting existing ones.
2. Fill the generated `<本地数据目录>/config/*.yaml`; do not add a `source_mode` field. Each product/project defaults to DATABASE and has its own `源码来源：DATABASE/SVN` action. For SVN, select it on that node and place the downloaded `svnCheckoutHere.sh` (macOS/Linux) or `svnCheckoutHere.bat` (Windows) in the workspace's `context/`; Nexus stores the choice in `context/source-mode.json` and derives the sanitized manifest automatically. Both script formats are first-class supported inputs for their operating systems.
3. Expand `项目` and choose a `PRD` or `PRJ` workspace.
4. For DATABASE, run the selected workspace's full synchronization command. For SVN, run `从签出脚本检出/更新 SVN`.

After setup, the Nexus tree displays `切换工作空间`. Confirming lets the user select a new local data directory and initializes its missing configuration files; cancelling keeps the current workspace.

Database workspace nodes retain their existing source/metadata synchronization and Workcopy flow. Nexus lists DATABASE and SVN workspaces together; each node changes only its own provider and immediately refreshes the tree. SVN nodes use a reviewed exact-URL manifest, aggregate multiple physical working copies, expose a business source tree and virtual documents that write directly back to the checkout, and register one source-control provider per workspace. `systems.include.mappings` uses each system alias as a key with one `system_id` and one `data_source_id`; Nexus intersects those IDs with the checkout-script scope, while SVN never reads the DATABASE-only `system-data.json` cache. Missing or invalid mappings block checkout. Every repository in one script reuses the same workspace credential. `Ctrl+S` is local-only. SCM labels reuse the local SQLite/index.md business metadata, and an explicit remote check fills a separate remote-change group without turning every local refresh into a network call. PAGE changes open a readable script/SQL/field projection by default, while the context menu retains the exact raw JSON diff. `管理本地源码变更` lists Nexus and external modifications and supports multi-select save/revert. `保存到谷神` is always available in Nexus SVN mode; selections spanning physical working copies are committed in groups and never claim that the later Guthon platform submission is complete.

Each SVN node also provides `设置工作区 SVN 凭据`. One credential is scoped to the configured local data workspace (`toolHome`) and shared by all product and project SVN providers in that workspace. It is stored in VS Code SecretStorage and passed only through the spawned tool environment/password stdin, never through YAML, manifests, arguments, or output logs. Certificate exceptions require an exact host/port SHA-256 pin before the configured SVN exception flags are used.

The extension also adds a dedicated `Guthon Nexus` icon to VS Code's left activity bar. Its tree exposes workspace setup, source/index operations, metadata export, environment checks, source diagnosis, and workcopy status/diff/package actions, so colleagues do not need to use the command palette.

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
- Builds each workspace menu from the effective database/SVN capabilities returned by the tool.
- Exports table schemas, bill types, system scripts, views, and source Markdown.
- Runs environment checks and readonly source diagnosis.
- Inspects workcopy status, generates diffs, and packages delivery files.
- Starts and stops Guthon Bridge without a separate Node.js installation or terminal command.
- Switches between the packaged application and live Python source development.
- Lists mixed DATABASE/SVN projects together and lets each project select its own source provider.
- Aggregates exact-URL SVN working copies into one business source tree and one SCM provider per workspace.
- Opens SCM changes in VS Code's native side-by-side Diff Editor with an in-memory, read-only SVN BASE on the left and the current working-copy source on the right; it does not create another local source copy.
- Registers `.gss` as the dedicated Guthon GSS language, layering Velocity/GSS directives and variables over Java syntax while keeping Nexus completion, hover, definition, and reference providers. Legacy `.vm` remains Java-compatible.
- Checks remote status only on the explicit cloud action and preserves it in a separate SCM group until the working copy is updated. An update repairs only SVN `incomplete`/working-copy administrative locks with standard `svn cleanup`; it never removes unversioned files or reverts edits.
- Adds SCM toolbar/group actions for all Nexus submits and all remote updates, plus inline actions for one Nexus-managed file or one remote file. Exact-file updates are constrained to the authorized manifest path, require the row to remain a current remote change, and explicitly confirm native SVN merge when that same file is locally modified.
- Lists Nexus-managed edits and safe externally modified tracked text files in one change manager. Selected files can be compared, reverted to the local SVN BASE, or saved; conflicts, additions, deletions, untracked files, and property changes remain blocked. Revert does not require a remote-current working copy, while `保存到谷神` still performs the remote out-of-date check.
- Previews, imports, checks out, and updates a workspace's exact SVN scope from `context/svnCheckoutHere.sh` on macOS/Linux or `context/svnCheckoutHere.bat` on Windows without executing the script or persisting its credentials.
- Loads the SVN tree from the local SQLite index and lazily parses only the selected PAGE file's editable fragments, avoiding a full checkout scan on every tree expansion.
- Uses normalized SQLite call edges keyed by `source_record_id`, with covering indexes for target-caller and source-outgoing lookups. Existing indexes migrate transactionally and vacuum once on first open; compatibility views keep query/export results unchanged without storing repeated source metadata on every edge.
- Opens a virtual document with an exact-file SVN status/hash check; browse actions skip unrelated working-copy and private-Git scans.
- Preserves aggregate `systems/<SYSTEM_ID>` and `datasources/<DATA_SOURCE_ID>` working copies. System and datasource roots use `$.<Chinese name>` markers. Every subsystem follows the procedure datasource group order; systems sharing one datasource use `systems.include.mappings` declaration order as the stable tie-breaker. PAGE and procedure hierarchy, leaf labels, and sibling order come from `pages/index.md` and `procedures/index.md`. Unindexed objects follow indexed entries. Table/view leaves show `object-id Chinese name`.
- Provides the toolbar action `跳转所选 SVN 原文件`; selecting a module or any child method, field, SQL, or event resolves the owning module's authorized `sourcePath` and reveals the physical file in Explorer. The same action remains available from the context menu, but no longer occupies the end of every source label.
- Provides `定位当前编辑源码`, which maps the active SVN virtual document or physical checkout file back to its stable Nexus node, expands its parent chain, and selects it. Locating a PAGE fragment parses only that PAGE lazily.
- Adds native “谷神源码” toolbar actions for locating, jumping, expanding or collapsing the selected node, opening VS Code's directly visible tree find box, and refreshing. Find uses cached nodes with filter + fuzzy defaults, while long source labels use the native horizontal scrollbar (`workbench.list.horizontalScrolling`, user-overridable).
- Opens PAGE script/SQL/field fragments and procedure/system-script sources as guarded virtual documents without a second code copy.
- Completes `Ctrl+S` after the guarded single-file write and incremental index update; SCM is updated from that verified result without synchronously rescanning every working copy, and the managed file-watcher event is suppressed to avoid duplicate indexing. Consecutive saves from the same virtual editor keep the provider version stable, while genuine external checkout changes still invalidate it and retain the hash-based overwrite guard.
- Parses backend code embedded in PAGE `raw.json` `serviceEvents` (including `beforeSaveScript`, `afterSaveScript`, and `beforeSqlSelectScript`) as named `GSS · <component/event>` fragments; these fragments remain minimal JSON Pointer writebacks to the original PAGE file.
- Associates both current `.gss` files and legacy DATABASE `.vm` projections with VS Code's Java language mode and Java highlighting.
- Uses the workspace call index for Go to Definition and Find References from SVN virtual documents.
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
code --install-extension guthon-nexus-vscode.vsix --force
```

The extension identifier is `gushen-local.guthon-nexus-vscode`. Its current major release line starts at `2.0.0`; after each substantial feature or architecture change, increment the minor version by `0.1` (`2.0.0` → `2.1.0`) before packaging. Fix-only changes increment the patch version when a separately versioned package is required.
