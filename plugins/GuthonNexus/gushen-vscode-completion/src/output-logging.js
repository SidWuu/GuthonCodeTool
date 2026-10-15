const { performance } = require('node:perf_hooks');

function timestamp(now = new Date()) {
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
    + `.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

// Buffer partial process chunks so a timestamp is added once per physical line.
function timedOutput(channel) {
  let pending = '';
  const write = (value) => {
    pending += String(value);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      channel.appendLine(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(line) ? line : `[${timestamp()}] ${line}`);
    }
  };
  return {
    append: write,
    appendLine: value => write(`${value ?? ''}\n`),
    show: (...args) => channel.show(...args),
    dispose: () => channel.dispose(),
  };
}

function operationTimer() {
  const started = performance.now();
  return () => {
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor(elapsed / 60000) % 60;
    const seconds = Math.floor(elapsed / 1000) % 60;
    return `${[hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':')}.${String(elapsed % 1000).padStart(3, '0')}`;
  };
}

function indexResultSummary(command, result) {
  if (command !== 'svn') return undefined;
  let payload = result;
  if (typeof result?.stdout === 'string') {
    try { payload = JSON.parse(result.stdout); } catch { return undefined; }
  }
  if (!payload?.reindex || typeof payload.reindex !== 'object' || Array.isArray(payload.reindex)) return undefined;
  const index = payload.reindex;
  return JSON.stringify({ ok: payload.ok, action: payload.action, workspaceKey: payload.workspaceKey,
    workingCopies: payload.workingCopies, skippedWorkingCopies: payload.skipped?.length,
    reindex: { mode: index.mode, changed: index.changed, counts: index.counts, failures: index.failures,
      ignoredCount: index.ignored?.length || 0, errors: (index.errors || []).slice(0, 10),
      omittedErrors: Math.max(0, (index.errors?.length || 0) - 10) } }, null, 2);
}

module.exports = { timestamp, timedOutput, operationTimer, indexResultSummary };
