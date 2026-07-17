# Gushen VS Code Completion

Local VS Code completion provider for Gushen dialect APIs.

This extension provides offline snippets and API completions for Gushen Java service scripts, JavaScript page scripts, and SQL dialect scripts. It does not depend on IntelliCode or Copilot.

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
data/java.json
data/javascript.json
data/sql.json
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
vsce package
```

Install the packaged extension:

```bash
code --install-extension gushen-vscode-completion-0.1.0.vsix --force
```
