const path = require('node:path');
const crypto = require('node:crypto');
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

function sourceWorkingCopy(copies, sourcePath) {
  if (typeof sourcePath !== 'string') return undefined;
  return copies.find(copy => {
    if (!copy.root || !copy.localSubdir) return false;
    const prefix = copy.localSubdir === '.' ? '' : copy.localSubdir + '/';
    return sourcePath.startsWith(prefix)
      && logicalSourcePath(copy, path.resolve(copy.root, sourcePath.slice(prefix.length))) === sourcePath;
  });
}

class SvnSourceWatcher {
  constructor({ vscode, backend, onChanged, onOutput, state, onRecoveryChanged, debounceMs = 250, retryDelays = [1000, 5000] }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onChanged = onChanged;
    this.onOutput = onOutput;
    this.debounceMs = debounceMs;
    this.state = state; this.onRecoveryChanged = onRecoveryChanged; this.retryDelays = retryDelays;
    this.scopes = new Map(); this.persistence = Promise.resolve();
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
    if (this.disposed) return;
    const expected = new Set();
    const keys = new Set(workspaces.map(workspace => workspace.workspaceKey));
    for (const [key, record] of this.scopes) if (!keys.has(key)) {
      clearTimeout(record.retryTimer); clearTimeout(this.timers.get(key));
      this.timers.delete(key); this.scopes.delete(key); this.generations.delete(key);
      for (const [pendingKey, item] of this.pending) if (item.workspace.workspaceKey === key) this.pending.delete(pendingKey);
    }
    for (const workspace of workspaces) {
      this._scope(workspace);
      for (const workingCopy of workspace.workingCopies || []) {
        if (!workingCopy.root || !workingCopy.localSubdir) continue;
        const key = `${workspace.workspaceKey}\0${workingCopy.id}\0${workingCopy.root}\0${workingCopy.localSubdir}`;
        expected.add(key);
        if (this.watchers.has(key)) continue;
        const watcher = this.vscode.workspace.createFileSystemWatcher(
          new this.vscode.RelativePattern(workingCopy.root, '**/*')
        );
        const schedule = uri => {
          const current = this.scopes.get(workspace.workspaceKey);
          if (current?.copies.some(copy => copy.root === workingCopy.root && copy.localSubdir === workingCopy.localSubdir))
            this._schedule(current.workspace, workingCopy, uri);
        };
        const subscriptions = [watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule)];
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

  _scope(workspace, workingCopy) {
    const copies = [...(workspace.workingCopies || (workingCopy ? [workingCopy] : []))]
      .sort((a, b) => String(b.localSubdir || '').length - String(a.localSubdir || '').length);
    const identity = JSON.stringify([workspace.workspaceKey, workspace.root || '',
      copies.map(copy => [copy.id || '', copy.root, copy.localSubdir]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    let record = this.scopes.get(workspace.workspaceKey);
    if (record?.identity === identity) { record.workspace = workspace; return record; }
    if (record) {
      clearTimeout(record.retryTimer); clearTimeout(this.timers.get(workspace.workspaceKey));
      this.timers.delete(workspace.workspaceKey); this.generations.delete(workspace.workspaceKey);
      for (const [key, item] of this.pending) if (item.workspace.workspaceKey === workspace.workspaceKey) this.pending.delete(key);
    }
    const storageKey = 'guthon.svn.indexRecovery.' + crypto.createHash('sha256')
      .update(JSON.stringify([workspace.workspaceKey, workspace.root || ''])).digest('hex');
    const saved = this.state?.get(storageKey);
    const entries = Array.isArray(saved?.failures) ? [...saved.failures] : [];
    if (record?.storageKey === storageKey) for (const [sourcePath, message] of record.failures) {
      const copy = sourceWorkingCopy(record.copies, sourcePath);
      if (copy) entries.push({path: sourcePath, message, blocked: record.blocked.has(sourcePath), workingCopyId: copy.id || '', root: copy.root, localSubdir: copy.localSubdir});
    }
    const failures = new Map();
    const blocked = new Set();
    for (const failure of entries) {
      if (!failure || typeof failure.path !== 'string' || typeof failure.message !== 'string') continue;
      const copy = sourceWorkingCopy(copies, failure.path);
      if (copy && (copy.id || '') === failure.workingCopyId && copy.root === failure.root && copy.localSubdir === failure.localSubdir)
        { failures.set(failure.path, failure.message.slice(0, 500)); if (failure.blocked) blocked.add(failure.path); }
    }
    record = {workspace, copies, identity, storageKey, failures, blocked, autoAttempts: 0};
    this.scopes.set(workspace.workspaceKey, record);
    if (failures.size) this.onRecoveryChanged?.(workspace.workspaceKey);
    return record;
  }

  recoveryState(workspaceKey) {
    const record = this.scopes.get(workspaceKey);
    return {failedCount: record?.failures.size || 0, retryScheduled: Boolean(record?.retryTimer),
      retrying: Boolean(record?.failures.size && this.running.has(workspaceKey))};
  }

  _publishRecovery(record) {
    const value = record.failures.size ? {failures: [...record.failures].map(([sourcePath, message]) => {
      const copy = sourceWorkingCopy(record.copies, sourcePath);
      return {path: sourcePath, message, blocked: record.blocked.has(sourcePath), workingCopyId: copy.id || '', root: copy.root, localSubdir: copy.localSubdir};
    })} : undefined;
    this.persistence = this.persistence.then(() => this.state?.update(record.storageKey, value))
      .catch(error => this.onOutput?.(`[SVN] 索引恢复记录保存失败：${error.message}\n`));
    this.onRecoveryChanged?.(record.workspace.workspaceKey);
  }

  _queueFailures(record, automatic = false) {
    for (const sourcePath of record.failures.keys()) if (!automatic || !record.blocked.has(sourcePath)) this.pending.set(`${record.workspace.workspaceKey}\0${sourcePath}`,
      {workspace: record.workspace, sourcePath});
  }

  _armRetry(record) {
    if (this.disposed || ![...record.failures.keys()].some(sourcePath => !record.blocked.has(sourcePath))
      || record.retryTimer || record.autoAttempts >= this.retryDelays.length) return;
    record.retryTimer = setTimeout(() => {
      record.retryTimer = undefined;
      if (this.disposed || this.scopes.get(record.workspace.workspaceKey) !== record) return;
      record.autoAttempts++;
      this._queueFailures(record, true);
      void this._flush(record.workspace.workspaceKey).catch(error => this.onOutput?.(`[SVN] 索引定向重试失败：${error.message}\n`));
    }, this.retryDelays[record.autoAttempts]);
  }

  async retry(workspaceKey) {
    const record = this.scopes.get(workspaceKey);
    if (!record) throw new Error('当前 SVN 工作区未登记，请刷新工作区后重试');
    clearTimeout(record.retryTimer); record.retryTimer = undefined;
    await this.running.get(workspaceKey);
    if (this.disposed || this.scopes.get(workspaceKey) !== record) return;
    record.autoAttempts = 0; record.blocked.clear();
    this._queueFailures(record);
    return this._flush(workspaceKey);
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
    const current = this.scopes.get(workspace.workspaceKey);
    const record = current?.workspace === workspace ? current : this._scope(workspace, workingCopy);
    if (record.failures.has(sourcePath)) {
      clearTimeout(record.retryTimer); record.retryTimer = undefined; record.autoAttempts = 0;
      record.blocked.delete(sourcePath);
    }
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
    const record = this.scopes.get(workspaceKey);
    if (record && [...this.pending.values()].some(item => item.workspace.workspaceKey === workspaceKey && record.failures.has(item.sourcePath))) {
      clearTimeout(record.retryTimer); record.retryTimer = undefined;
    }
    const task = Promise.resolve().then(() => this._drain(workspaceKey));
    this.running.set(workspaceKey, task);
    if (record?.failures.size) this.onRecoveryChanged?.(workspaceKey);
    try {
      return await task;
    } finally {
      this.running.delete(workspaceKey);
      this._arm(workspaceKey);
      if (!this.disposed && this.scopes.get(workspaceKey)?.failures.size) this.onRecoveryChanged?.(workspaceKey);
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
    const record = this.scopes.get(workspaceKey), previousFailures = record.failures.size;
    const elapsed = operationTimer();
    const failures = [];
    const paths = new Set();
    let changed = 0;
    let deleted = 0;
    let generationChanged = false;
    // Bound the JSON request while keeping each workspace strictly serial.
    const batches = [];
    for (let offset = 0; offset < items.length; offset += 1000) batches.push(items.slice(offset, offset + 1000).map(item => item.sourcePath));
    while (batches.length && !this.disposed) {
      if (this.scopes.get(workspaceKey) !== record) return;
      const batch = batches.shift();
      try {
        const result = await this.backend.reindexFiles(workspaceKey, batch);
        if (this.scopes.get(workspaceKey) !== record || this.disposed) return;
        changed += result.reindex?.changed || 0;
        deleted += result.reindex?.deleted || 0;
        for (const sourcePath of result.paths || []) paths.add(sourcePath);
        if (result.indexGeneration && result.indexGeneration !== this.generations.get(workspaceKey)) {
          generationChanged = true;
          this.generations.set(workspaceKey, result.indexGeneration);
        }
        if (result.stale || result.ok === false || result.reindex?.errors?.length || result.reindex?.failures) {
          const errors = result.reindex?.errors || [];
          for (const error of errors) failures.push({ sourcePath: error.path || batch[0], error: new Error(error.error || '索引未发布') });
          if (!errors.length) failures.push({ sourcePath: batch[0], error: new Error('批次索引未发布') });
          const messages = new Map(errors.map(error => [error.path, error.error]));
          // A failed transaction preserves the old index for the entire submitted batch.
          for (const sourcePath of batch) record.failures.set(sourcePath,
            String(messages.get(sourcePath) || errors[0]?.error || '批次索引未发布').slice(0, 500));
          // Only exact parse failures are separable; identity and associated-file failures keep the batch intact.
          if (errors.length && !errors.every(error => error.code === 'SOURCE_READ_RETRYABLE')) {
            for (const sourcePath of batch) record.blocked.add(sourcePath);
            if (errors.every(error => error.code === 'SOURCE_PARSE_FAILED' && batch.includes(error.path))) {
              const healthy = batch.filter(sourcePath => !messages.has(sourcePath));
              if (healthy.length) batches.unshift(healthy);
            }
          }
        } else for (const sourcePath of batch) { record.failures.delete(sourcePath); record.blocked.delete(sourcePath); }
      } catch (error) {
        if (this.scopes.get(workspaceKey) !== record || this.disposed) return;
        failures.push({ sourcePath: batch[0], error });
        for (const sourcePath of batch) record.failures.set(sourcePath, error.message.slice(0, 500));
      }
    }
    if (this.disposed) return;
    if (!record.failures.size) record.autoAttempts = 0;
    this._armRetry(record);
    if (previousFailures || failures.length) this._publishRecovery(record);
    if (changed || deleted || failures.length) {
      for (const failure of failures) this.onOutput?.(`[SVN] 文件监听｜失败 · ${failure.sourcePath} · ${failure.error.message}\n`);
      this.onOutput?.(`[SVN] 文件监听｜批量索引汇总 · 文件 ${items.length} · 更新对象 ${changed} · 删除对象 ${deleted} · 失败 ${failures.length} · 完整耗时 ${elapsed()}\n`);
    }
    if (!changed && !deleted && !failures.length && !generationChanged && !previousFailures) return;
    // An external CLI may already have updated the index. Refresh its visible
    // snapshot once per generation without parsing the same files again.
    if (generationChanged || previousFailures) for (const item of items) paths.add(item.sourcePath);
    await this.onChanged?.(workspaceKey, {
      ok: record.failures.size === 0,
      stale: record.failures.size > 0,
      paths: [...new Set([...paths, ...record.failures.keys()])],
      sourcePath: failures[0]?.sourcePath || [...paths][0] || '',
      failures,
    });
  }

  dispose() {
    this.disposed = true;
    for (const record of this.scopes.values()) clearTimeout(record.retryTimer);
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
