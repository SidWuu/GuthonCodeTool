const path = require('node:path');
const { operationTimer } = require('../output-logging');

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
    this.running = new Map();
    this.generations = new Map();
    this.disposed = false;
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
    if (this.disposed) return;
    const sourcePath = logicalSourcePath(workingCopy, uri.fsPath);
    if (!sourcePath) return;
    const key = `${workspace.workspaceKey}\0${sourcePath}`;
    const suppressedUntil = this.suppressedUntil.get(key) || 0;
    if (suppressedUntil > Date.now()) return;
    this.suppressedUntil.delete(key);
    this.pending.set(key, { workspace, sourcePath });
    this._arm(workspace.workspaceKey);
  }

  _arm(workspaceKey) {
    if (this.disposed || this.running.has(workspaceKey) || this.timers.has(workspaceKey)) return;
    if (![...this.pending.keys()].some(key => key.startsWith(`${workspaceKey}\0`))) return;
    this.timers.set(workspaceKey, setTimeout(() => {
      this.timers.delete(workspaceKey);
      void this._flush(workspaceKey).catch(error => {
        if (!this.disposed) this.onOutput?.(`[SVN] 文件监听｜批次刷新失败：${error.message}\n`);
      });
    }, this.debounceMs));
  }

  async _flush(workspaceKey) {
    if (this.disposed) return;
    if (this.running.has(workspaceKey)) return this.running.get(workspaceKey);
    clearTimeout(this.timers.get(workspaceKey));
    this.timers.delete(workspaceKey);
    const task = Promise.resolve().then(() => this._drain(workspaceKey));
    this.running.set(workspaceKey, task);
    try {
      return await task;
    } finally {
      this.running.delete(workspaceKey);
      this._arm(workspaceKey);
    }
  }

  async _drain(workspaceKey) {
    const items = [];
    for (const key of [...this.pending.keys()]) {
      if (!key.startsWith(`${workspaceKey}\0`)) continue;
      items.push(this.pending.get(key));
      this.pending.delete(key);
    }
    if (!items.length || this.disposed) return;
    const elapsed = operationTimer();
    const failures = [];
    const paths = new Set();
    let changed = 0;
    let deleted = 0;
    let generationChanged = false;
    // Bound the JSON request while keeping each workspace strictly serial.
    for (let offset = 0; offset < items.length && !this.disposed; offset += 1000) {
      const batch = items.slice(offset, offset + 1000).map(item => item.sourcePath);
      try {
        const result = await this.backend.reindexFiles(workspaceKey, batch);
        changed += result.reindex?.changed || 0;
        deleted += result.reindex?.deleted || 0;
        for (const sourcePath of result.paths || []) paths.add(sourcePath);
        if (result.indexGeneration && result.indexGeneration !== this.generations.get(workspaceKey)) {
          generationChanged = true;
          this.generations.set(workspaceKey, result.indexGeneration);
        }
        if (result.stale || result.ok === false) {
          const errors = result.reindex?.errors || [];
          for (const error of errors) failures.push({ sourcePath: error.path || batch[0], error: new Error(error.error || '索引未发布') });
          if (!errors.length) failures.push({ sourcePath: batch[0], error: new Error('批次索引未发布') });
        }
      } catch (error) {
        failures.push({ sourcePath: batch[0], error });
      }
    }
    if (this.disposed) return;
    if (changed || deleted || failures.length) {
      for (const failure of failures) this.onOutput?.(`[SVN] 文件监听｜失败 · ${failure.sourcePath} · ${failure.error.message}\n`);
      this.onOutput?.(`[SVN] 文件监听｜批量索引汇总 · 文件 ${items.length} · 更新对象 ${changed} · 删除对象 ${deleted} · 失败 ${failures.length} · 完整耗时 ${elapsed()}\n`);
    }
    if (!changed && !deleted && !failures.length && !generationChanged) return;
    // An external CLI may already have updated the index. Refresh its visible
    // snapshot once per generation without parsing the same files again.
    if (generationChanged) for (const item of items) paths.add(item.sourcePath);
    await this.onChanged?.(workspaceKey, {
      ok: failures.length === 0,
      stale: failures.length > 0,
      paths: [...paths],
      sourcePath: failures[0]?.sourcePath || [...paths][0] || '',
      failures,
    });
  }

  dispose() {
    this.disposed = true;
    this.generations.clear();
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
