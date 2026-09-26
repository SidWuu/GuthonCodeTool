# Guthon Nexus

Guthon Nexus is the VS Code development surface for GuthonCodeTool.

It manages local Guthon workspaces, runs source and metadata synchronization, exposes workcopy maintenance tools, and provides offline Gushen API completions, hover documentation, and source navigation. It does not depend on IntelliCode or Copilot.

It can also run the packaged `GuthonCodeTool` executable. This lets users initialize and sync local sources without installing Python.

## Packaged source tool

Build `dist/GuthonCodeTool` (or `GuthonCodeTool.exe` on Windows) on each target OS with `python scripts/build_guthon_tool.py`, then distribute that executable together with this VSIX. In VS Code, run these commands in order:

1. `Guthon Nexus: 设置/切换工作空间` — choose the executable and a local data directory. It creates missing configuration files without overwriting existing ones.
2. Run `Guthon Nexus: 添加产品或项目` on first use and whenever development adds another project. Products and projects are peer workspaces: a project is an independent exported version snapshot, so the wizard creates it directly without selecting another workspace. The wizard ends immediately after SVN or DATABASE is selected and creates an initially unconfigured Nexus. For SVN, expand that Nexus and use `设置工作区 SVN 登录`, `导入/粘贴 SVN checkout 配置`, and `编辑 SVN 地址配置`. Each workspace stores one `svn.url` and checks out the complete repository visible to that account. DATABASE datasource settings are added later. Do not add a `source_mode` field. Legacy exact entries and `checkoutPaths` remain compatible; imported scripts are parsed but never executed.
3. Expand `项目` and choose a `PRD` or `PRJ` workspace.
4. For DATABASE, configure its datasource and run the selected workspace's full synchronization command. For SVN, use `导入/粘贴 SVN checkout 配置`, review the YAML, then run `检出/更新完整 SVN 仓库`.

To remove an obsolete PRD/PRJ, right-click its workspace node and choose `删除产品或项目`. Nexus previews the exact config and directory scope, requires modal confirmation, moves the workspace and checkout directories to the system trash, and then removes only that workspace's config, dedicated datasources, and database-diagnosis entries.

After setup, the Nexus tree displays `切换工作空间`. Confirming lets the user select a new local data directory and initializes its missing configuration files; cancelling keeps the current workspace.

Database workspace nodes retain their existing source/metadata synchronization and Workcopy flow. Nexus lists DATABASE and SVN workspaces together; each node changes only its own provider and immediately refreshes the tree. SVN nodes use one reviewed root URL, one physical working copy, a business source tree, and virtual documents that write directly back to that checkout. `systems.include.mappings` provides system/data-source identity and grouping but never filters checkout content. SVN does not use Bridge pull. Checkout, update, status, edit, revert, and save all operate on the same root working copy. `Ctrl+S` is local-only. PAGE changes open a readable script/SQL/field projection by default, while the context menu retains the exact raw JSON diff. `管理本地源码变更` lists Nexus and external modifications and supports multi-select save/revert. Text conflicts use VS Code's three-way merge editor. `保存到谷神` remains available, and the SCM commit message is optional.

Each virtual-document open receives an independent edit lease. Stale whole-file saves are rejected, unchanged PAGE fragments may safely rebase over another fragment save, and short concurrent writes wait on a bounded cross-process lock. Automation can read multiple objects through `svn read-batch`, or pass source identities directly to the JSON-only `svn write-batch` endpoint without collecting session/document IDs first; batch writes preflight every item, roll back partial filesystem writes, and reindex the written files together.

Each SVN node also provides `设置工作区 SVN 登录`. The shared username comes from `sync.yaml` at `svn.username`; product/project YAML contains no per-item login. Nexus prompts only for the shared password, sends it once through backend stdin, and lets the native SVN auth cache/system keychain persist it. The password never enters VS Code SecretStorage, YAML, process arguments, manifests, or logs. Every product and project in the same authentication realm reuses that system credential. Remote SVN commands are non-interactive and directly trust certificate failures from the internal self-signed HTTPS service.

The extension also adds a dedicated `Guthon Nexus` icon to VS Code's left activity bar. Its tree exposes workspace setup, source/index operations, metadata export, environment checks, source diagnosis, and workcopy status/diff/package actions, so colleagues do not need to use the command palette.

Each project starts with a `工作区驾驶舱`. It summarizes local-index readiness, synchronization state, SVN working-copy/local-change state, and the latest SVN revision; each row opens the corresponding action directly. `搜索工作区完整索引` queries source identities and indexed conditions, assignments, exceptions, table access, and call facts together without depending on expanded tree nodes. A selected result can open its source or copy a compact AI context by default, with a detailed variant available for deeper analysis; neither variant copies the entire source implicitly.

SVN virtual GSS documents warn about repeated local `#function` names and complete `@` calls from declarations in that document. PAGE field-collection documents warn about repeated `fieldId` values and complete `selectCodefieldId` from the current collection when its JSON is valid. After two typed characters, bounded PAGE index lookup also suggests fields from other collections with their source; unsaved sibling fragments suppress those indexed suggestions. The source tree's `预览源码影响` command shows bounded index evidence for PAGE JSON (table access, explicit field relations, logic facts) and procedures (incoming, outgoing, dynamic calls). `浏览影响证据` opens a source fragment at the indexed line for PAGE access/facts or procedure calls, and opens a field collection for explicit relations. The preview shows index generation and source hash; it does not certify deletion safety or platform behavior. `查找其他 PAGE 的字段` searches source-backed UI fields by literal prefix in the selected PAGE namespace, with relations marked unverified. `按页面编码定位本地 PAGE` searches an explicitly selected SVN workspace for an exact platform PAGE ID and prompts when multiple source identities match.

The Bridge popup and lower-left page control can pass the active PAGE ID or the active procedure's package and function name through a VS Code URI. `按页面编码定位本地 PAGE` and `按包名和函数名定位本地过程函数` provide equivalent manual checks. Nexus asks for the SVN workspace and any duplicate source identity before opening a controlled virtual document. Procedure lookup uses the package and function name, never the platform PR identifier.

Every successful SVN save appends a durable delivery receipt instead of overwriting the previous save state. Nexus displays recent receipt IDs, revisions, files, and commit times. A receipt proves the SVN commit only; the separate Guthon platform submission and runtime validation remain outside Nexus tracking.

`工作区` → `运行模式` defaults to `发行模式`. Maintainers can switch to `开发模式` and select a GuthonCodeTool source checkout containing `.venv` and `scripts/guthon_tool.py`. `调试模式` uses a local Python and the verified Release `.pyz`; the mode menu can reselect both files. Sidebar commands and Bridge requests use the selected runtime; switching back reuses the saved packaged application and the same data directory.

`运行模式` is a collapsed node. It shows the selected mode, current entry path, local data directory, GuthonCodeTool application version, the configurable GitHub/Gitee update source, an explicit update check, and the previous-version rollback action. Nexus never checks for application updates on startup or on a timer. A manual update downloads only the current platform asset, verifies it against `GuthonCodeTool-checksums.txt`, runs the packaged `self-test` in a temporary home, switches to a versioned directory in extension global storage, and keeps the former executable for rollback. PAGE semantic browsing offers a file refresh or workspace reindex when the index reports `INDEX_STALE`, `PARTIAL`, or `REBUILD_REQUIRED`.

Nexus writes the selected runtime to `<本地数据目录>/var/nexus/tool-runtime.json`. Its `command` array uses the packaged executable, the source checkout's `.venv` plus `scripts/guthon_tool.py`, or a local Python plus the verified Release `.pyz`. The descriptor records the mode, code source, protocol version and shared `home`. It also exposes workspace/target resolution, built-in database probe/describe/query commands and `linterCommand`, so AI tools resolve cwd without guessing paths or names.

Each project exposes `配置资料 → 配置数据库排查`. The wizard accepts a MySQL/PostgreSQL/Oracle URL, environment and a dedicated read-only login, verifies the connection, writes only non-secret routing data to `database-testing.yaml`, and stores the password in the operating-system credential store. Expand `工作区` → `配置文件` to edit generated configuration files directly in VS Code.

Synchronization, checkout, submit, revert, and other operations that can change source state ask for confirmation. The add-workspace wizard writes only the values just entered and does not add a redundant confirmation; opening configuration files and local folders remains single-click.

The sidebar also starts and stops Guthon Bridge with VS Code's bundled Node runtime. It passes the active runtime and local data directory. Nexus and Bridge each keep one ToolHost; ordinary view refresh shares a workspace snapshot and does not scan every SVN working copy. Switching a workspace or execution mode restarts a running Bridge.

Both runtimes retain the non-UI entry points: `create-workcopy`, `workcopy`, `query`, `diagnose`, `doctor`, `export-markdown`, and each metadata export command. Workspace commands include an explicit key, for example `command + ["query", "--home", home, "--workspace", "projects.demo-project", "--", "callers", "--alias", "<别名>", "--fun", "<函数>"]`.

## Features

- Initializes or switches the GuthonCodeTool local workspace.
- Opens and edits the five local YAML configuration files.
- Lists all configured product and project workspaces and binds every action to its `workspaceKey`.
- Shows a workspace cockpit with index, SVN, delivery, and recommended-action status.
- Searches identities and indexed source facts through one workspace-level entry point and copies bounded AI context packages.
- Keeps durable SVN delivery receipts and records explicit manual platform-submit confirmations.
- Builds each workspace menu from the effective database/SVN capabilities returned by the tool.
- Exports table schemas, bill types, system scripts, views, and source Markdown.
- Runs environment checks and readonly source diagnosis.
- Inspects workcopy status, generates diffs, and packages delivery files.
- Starts and stops Guthon Bridge without a separate Node.js installation or terminal command.
- Switches between packaged, source development and verified Python zipapp modes. The zipapp currently requires a suitable local Python installation; managed Python runtime downloads are not yet shipped.
- Lists mixed DATABASE/SVN projects together and lets each project select its own source provider.
- Aggregates exact-URL SVN working copies into one business source tree and one SCM provider per workspace, with Chinese datasource-subsystem resource groups plus a separate public-source group.
- Distinguishes same-named tables, views, and procedures by their datasource working copy/schema and carries `workingCopyId` through virtual-document reads; PAGE identities remain workspace-global and revision-deduplicated.
- Streams each subsystem working copy's authorization, checkout/update, status, and indexing phase to the GuthonCodeTool output channel during SVN scope synchronization.
- Decorates modified SVN files and their ancestor folders in the Guthon source tree, and uses VS Code's native SCM Quick Diff against SVN BASE for GitLens-like gutter colors, line highlights, overview markers, and click-to-peek local changes.
- Adds per-file SCM actions for Nexus-identifiable changes: open in Nexus, view the existing SVN BASE diff, discard a safe local modification, and save directly through the existing Nexus/SVN flow. Resource decorations distinguish added, deleted, and modified states; no Git staging area is introduced.
- Opens SCM changes in VS Code's native side-by-side Diff Editor with an in-memory, read-only SVN BASE on the left and the current working-copy source on the right; it does not create another local source copy.
- Registers `.gss` as the dedicated Guthon GSS language, layering Velocity/GSS directives and variables over Java syntax while keeping Nexus completion, hover, definition, and reference providers. Legacy `.vm` remains Java-compatible.
- Checks remote status only on an explicit cloud/update action and preserves it in the matching subsystem group until the working copy is updated. An update repairs only SVN `incomplete`/working-copy administrative locks with standard `svn cleanup`; it never removes unversioned files or reverts edits.
- Adds workspace-level SCM actions for all Nexus submits and all remote updates, default-expanded Chinese subsystem groups directly under the SVN workspace, and inline actions for one Nexus-managed file or one remote file. Workspace and subsystem rows keep the same four SCM buttons visible by default: refresh status, check remote changes, submit Nexus changes, and update remote changes. Selecting a remote-change file opens a working-copy versus SVN HEAD diff before update.
- Streams the stages of SCM status checks, Nexus preview/commit, SVN update, post-operation indexing, and SCM refresh to the GuthonCodeTool output channel. The same workspace ignores another overlapping SVN source operation and reports that it is already running.
- When another SCM repository such as `var` is visible and the entire SVN workspace is clean, one disabled “当前无变更” resource keeps the native VS Code SCM subsystem groups visible. The placeholder does not affect counts, submit, or update scope.
- Lists Nexus-managed edits and safe externally modified tracked text files in one change manager. Selected files can be compared, reverted to the local SVN BASE, or saved. Text conflicts can be resolved through the physical working-copy merge result; additions, deletions, untracked files, property conflicts, and tree conflicts remain blocked. After an SVN update changes a clean file, an explicit Nexus update safely merges a tracked text modification, or a Nexus-managed text conflict is marked resolved, the current file becomes the edit-session baseline. Revert does not require a remote-current working copy, while `保存到谷神` checks the selected files themselves for remote out-of-date changes without being blocked by unrelated remote files in the same working copy.
- Imports a selected `.sh/.bat` file or pasted checkout command into one `svn.url`, preserving unrelated YAML comments and entries. The generated `context/authorized-scope.json` contains one repository-root entry; legacy explicit `svn.scope` and `checkoutPaths` remain readable.
- Loads the SVN tree from the local SQLite index and lazily parses only the selected PAGE file's editable fragments, avoiding a full checkout scan on every tree expansion.
- Uses normalized SQLite call edges keyed by `source_record_id`, with covering indexes for target-caller and source-outgoing lookups. Existing indexes migrate transactionally and vacuum once on first open; compatibility views keep query/export results unchanged without storing repeated source metadata on every edge.
- Opens a virtual document with an exact-file SVN status/hash check; browse actions skip unrelated working-copy and private-Git scans.
- Preserves aggregate `systems/<SYSTEM_ID>` and `datasources/<DATA_SOURCE_ID>` working copies. System and datasource roots use `$.<Chinese name>` markers. Every subsystem follows the procedure datasource group order; systems sharing one datasource use `systems.include.mappings` declaration order as the stable tie-breaker. PAGE hierarchy, leaf labels, and sibling order come from `pages/index.md`; procedure package labels come from `procedures/index.md`, while packages and their functions sort alphabetically. Unindexed objects follow indexed entries. Table/view leaves show `object-id Chinese name`.
- Provides the toolbar action `跳转所选 SVN 原文件`; selecting a module or any child method, field, SQL, or event resolves the owning module's authorized `sourcePath` and reveals the physical file in Explorer. The same action remains available from the context menu, but no longer occupies the end of every source label.
- Provides `定位当前编辑源码`, which maps the active SVN virtual document or physical checkout file back to its stable Nexus node, expands its parent chain, and selects it. Locating a PAGE fragment parses only that PAGE lazily.
- Adds native “谷神源码” toolbar actions for locating, jumping, expanding or collapsing the selected node, searching the current SVN workspace's complete local index, and refreshing. A procedure node's context menu can copy its function name or qualified `package.function` identity, and list indexed callers for exact-line navigation. Search runs once after input, does not depend on expanded nodes, and never scans the checkout; long source labels use the native horizontal scrollbar (`workbench.list.horizontalScrolling`, user-overridable).
- Opens PAGE script/SQL/field fragments and procedure/system-script sources as guarded virtual documents without a second code copy; only standalone PAGE GSS service-component tabs replace an ID with the indexed Chinese service name, while named procedure functions retain their English function name.
- Completes `Ctrl+S` after the guarded single-file write and incremental index update; SCM is updated from that verified result without synchronously rescanning every working copy, and the managed file-watcher event is suppressed to avoid duplicate indexing. Consecutive saves from the same virtual editor keep the provider version stable, while genuine external checkout changes still invalidate it and retain the hash-based overwrite guard.
- Parses backend code embedded in PAGE `raw.json` `serviceEvents` (including `beforeSaveScript`, `afterSaveScript`, and `beforeSqlSelectScript`) as named `GSS · <component/event>` fragments; these fragments remain minimal JSON Pointer writebacks to the original PAGE file.
- Orders PAGE fragments by type as `GSS`, `JS`, `SQL`, then fields while preserving the source order inside each type.
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
npm run build:data -- /path/to/api-docs     # 或设置 GUTHON_TOOL_HOME / GUTHON_HOME 使用 <toolHome>/var/docs/谷神方言API
```

The build script no longer walks up from the plugin directory to find a `var` folder: it uses the explicit directory argument, or resolves `<toolHome>/var/docs/谷神方言API` from `GUTHON_TOOL_HOME` / `GUTHON_HOME`, and fails with a clear error when neither is provided.

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
