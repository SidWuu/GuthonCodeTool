const path = require('node:path');

const SOURCE_EXTENSIONS = new Set([
  '.json', '.gss', '.js', '.vm', '.sql', '.md', '.txt', '.yaml', '.yml',
]);

function logicalSourcePath(workingCopy, filePath) {
  const relative = path.relative(workingCopy.root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  const parts = relative.split(path.sep);
  if (parts.includes('.svn') || !SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) return undefined;
  return path.posix.join(workingCopy.localSubdir, ...parts);
}

class SvnSourceWatcher {
  constructor({ vscode, backend, onChanged, onOutput, debounceMs = 250 }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onChanged = onChanged;
    this.onOutput = onOutput;
    this.debounceMs = debounceMs;
    this.watchers = new Map();
    this.timers = new Map();
    this.suppressedUntil = new Map();
  }

  sync(workspaces) {
    const expected = new Set();
    for (const workspace of workspaces) {
      for (const workingCopy of workspace.workingCopies || []) {
        if (!workingCopy.root || !workingCopy.localSubdir) continue;
        const key = `${workspace.workspaceKey}\0${workingCopy.id}\0${workingCopy.root}`;
        expected.add(key);
        if (this.watchers.has(key)) continue;
        const watcher = this.vscode.workspace.createFileSystemWatcher(
          new this.vscode.RelativePattern(workingCopy.root, '**/*')
        );
        const subscriptions = [
          watcher.onDidChange((uri) => this._schedule(workspace, workingCopy, uri)),
          watcher.onDidCreate((uri) => this._schedule(workspace, workingCopy, uri)),
          watcher.onDidDelete((uri) => this._schedule(workspace, workingCopy, uri)),
        ];
        this.watchers.set(key, { watcher, subscriptions });
      }
    }
    for (const [key, record] of this.watchers.entries()) {
      if (expected.has(key)) continue;
      for (const subscription of record.subscriptions) subscription.dispose();
      record.watcher.dispose();
      this.watchers.delete(key);
    }
  }

  suppress(workspaceKey, sourcePath, durationMs = 5000) {
    if (!workspaceKey || !sourcePath) return;
    const now = Date.now();
    for (const [candidate, expiresAt] of this.suppressedUntil.entries()) {
      if (expiresAt <= now) this.suppressedUntil.delete(candidate);
    }
    const key = `${workspaceKey}\0${sourcePath}`;
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.suppressedUntil.set(key, now + durationMs);
  }

  _schedule(workspace, workingCopy, uri) {
    const sourcePath = logicalSourcePath(workingCopy, uri.fsPath);
    if (!sourcePath) return;
    const key = `${workspace.workspaceKey}\0${sourcePath}`;
    const suppressedUntil = this.suppressedUntil.get(key) || 0;
    if (suppressedUntil > Date.now()) return;
    this.suppressedUntil.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key);
      try {
        const result = this.onOutput
          ? await this.backend.reindexFile(
            workspace.workspaceKey,
            sourcePath,
            { onOutput: this.onOutput }
          )
          : await this.backend.reindexFile(workspace.workspaceKey, sourcePath);
        await this.onChanged?.(workspace.workspaceKey, result);
      } catch (error) {
        await this.onChanged?.(workspace.workspaceKey, { ok: false, sourcePath, error });
      }
    }, this.debounceMs));
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.suppressedUntil.clear();
    for (const record of this.watchers.values()) {
      for (const subscription of record.subscriptions) subscription.dispose();
      record.watcher.dispose();
    }
    this.watchers.clear();
  }
}

module.exports = { SOURCE_EXTENSIONS, SvnSourceWatcher, logicalSourcePath };
