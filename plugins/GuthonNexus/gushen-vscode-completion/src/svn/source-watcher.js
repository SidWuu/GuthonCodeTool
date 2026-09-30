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
    // 每个工作区一个批量刷新定时器；pending 记录该批次待处理的源码路径。
    this.timers = new Map();
    this.pending = new Map();
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
    this.suppressedUntil.set(key, now + durationMs);
    this._dropPending(key, workspaceKey);
  }

  _dropPending(key, workspaceKey) {
    if (!this.pending.delete(key)) return;
    for (const candidate of this.pending.keys()) {
      if (candidate.startsWith(`${workspaceKey}\0`)) return;
    }
    clearTimeout(this.timers.get(workspaceKey));
    this.timers.delete(workspaceKey);
  }

  _schedule(workspace, workingCopy, uri) {
    const sourcePath = logicalSourcePath(workingCopy, uri.fsPath);
    if (!sourcePath) return;
    const key = `${workspace.workspaceKey}\0${sourcePath}`;
    const suppressedUntil = this.suppressedUntil.get(key) || 0;
    if (suppressedUntil > Date.now()) return;
    this.suppressedUntil.delete(key);
    this.pending.set(key, { workspace, sourcePath });
    if (this.timers.has(workspace.workspaceKey)) return;
    this.timers.set(workspace.workspaceKey, setTimeout(() => {
      this.timers.delete(workspace.workspaceKey);
      void this._flush(workspace.workspaceKey);
    }, this.debounceMs));
  }

  async _flush(workspaceKey) {
    const items = [];
    for (const key of [...this.pending.keys()]) {
      if (!key.startsWith(`${workspaceKey}\0`)) continue;
      items.push(this.pending.get(key));
      this.pending.delete(key);
    }
    if (!items.length) return;
    const results = [];
    const failures = [];
    for (const { workspace, sourcePath } of items) {
      try {
        const result = this.onOutput
          ? await this.backend.reindexFile(
            workspace.workspaceKey,
            sourcePath,
            { onOutput: this.onOutput }
          )
          : await this.backend.reindexFile(workspace.workspaceKey, sourcePath);
        results.push({ sourcePath, result });
      } catch (error) {
        failures.push({ sourcePath, error });
      }
    }
    // 同一批源码变化只触发一次级联刷新；逐个文件回调会让一次保存产生多轮目录树、虚拟文档与 SCM 刷新。
    await this.onChanged?.(workspaceKey, {
      ok: failures.length === 0,
      stale: results.some(({ result }) => result?.stale),
      paths: results.map(({ sourcePath }) => sourcePath),
      sourcePath: failures[0]?.sourcePath || results[0]?.sourcePath || '',
      failures,
    });
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.suppressedUntil.clear();
    for (const record of this.watchers.values()) {
      for (const subscription of record.subscriptions) subscription.dispose();
      record.watcher.dispose();
    }
    this.watchers.clear();
  }
}

module.exports = { SOURCE_EXTENSIONS, SvnSourceWatcher, logicalSourcePath };
