const { spawn } = require('node:child_process');
const readline = require('node:readline');

const READ_COMMANDS = new Set([
  'version', 'workspaces', 'workspace-resolve', 'workspace-summary', 'route',
  'database-target-resolve', 'database-probe', 'database-describe',
  'database-query-readonly', 'search', 'context-pack', 'query', 'doctor',
]);
const SVN_READ_ACTIONS = new Set([
  'catalog', 'fragments', 'read', 'read-batch', 'status', 'scm-status', 'diff',
  'history', 'definition', 'callers', 'find', 'context', 'facts', 'explain',
  'scope-preview', 'delivery-status',
]);

function requestKind(command, args = []) {
  return READ_COMMANDS.has(command) || (command === 'svn' && SVN_READ_ACTIONS.has(args[0]))
    ? 'read' : 'write';
}

function runtimeKey(tool) {
  return JSON.stringify([tool.toolPath, tool.toolEntry || '', tool.toolHome]);
}

class ToolProcessClient {
  constructor({ spawnProcess = spawn, env = process.env, onError = () => {}, onProgress = () => {} } = {}) {
    this.spawnProcess = spawnProcess;
    this.env = env;
    this.onError = onError;
    this.onProgress = onProgress;
    this.child = null;
    this.key = '';
    this.starting = null;
    this.startTimer = null;
    this.startReject = null;
    this.jobs = [];
    this.active = null;
    this.sequence = 0;
    this.disposed = false;
  }

  async _start(tool) {
    const key = runtimeKey(tool);
    if (this.child && this.key === key && !this.starting) return;
    if (this.starting && this.key === key) return this.starting;
    if (this.child) await this.stop();
    if (tool.mode === 'script') {
      require('./script-runtime').verifyScriptChecksum(tool.toolEntry);
    }
    this.key = key;
    const args = [
      ...(tool.toolEntry ? [tool.toolEntry] : []),
      'serve', '--stdio', '--home', tool.toolHome,
    ];
    const child = this.spawnProcess(tool.toolPath, args, {
      shell: false, env: this.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let readyResolve;
    let readyReject;
    this.starting = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.startReject = readyReject;
    this.startTimer = setTimeout(() => {
      readyReject(new Error('ToolHost 启动超时'));
      child.kill();
    }, 30000);
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.onError(new Error(`ToolHost 协议输出无效：${line.slice(0, 200)}`));
        child.kill();
        return;
      }
      if (message.type === 'ready') {
        if (message.protocolVersion !== 1) {
          readyReject(new Error(`ToolHost 协议版本不匹配：${message.protocolVersion}`));
          child.kill();
        } else {
          clearTimeout(this.startTimer);
          this.startTimer = null;
          this.startReject = null;
          readyResolve();
          this.starting = null;
          this._next();
        }
        return;
      }
      if (message.type === 'progress') {
        this.active?.onOutput?.(`${message.message}\n`);
        this.onProgress(message);
        return;
      }
      if (message.type !== 'result' || !this.active || message.id !== this.active.id) {
        this.onError(new Error('ToolHost 返回了未匹配的请求结果'));
        child.kill();
        return;
      }
      const job = this.active;
      this.active = null;
      clearTimeout(job.timer);
      if (!job.settled) {
        job.settled = true;
        if (message.ok) job.resolve(message.result);
        else job.reject(new Error(message.error?.message || 'ToolHost 命令失败'));
      }
      this._next();
    });
    child.stderr.on('data', (chunk) => {
      this.active?.onOutput?.(chunk.toString());
      this.onProgress({ type: 'stderr', message: chunk.toString() });
    });
    const failed = (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.key = '';
      clearTimeout(this.startTimer);
      this.startTimer = null;
      if (this.starting) {
        error.code = 'TOOLHOST_EXIT';
        readyReject(error);
        this.starting = null;
        this.startReject = null;
      }
      const jobs = [this.active, ...this.jobs].filter(Boolean);
      this.active = null;
      this.jobs = [];
      for (const job of jobs) {
        clearTimeout(job.timer);
        if (!job.settled) {
          job.settled = true;
          const failure = job.timeoutError || new Error(job.kind === 'write'
            ? `ToolHost 已退出，写入结果未知；请先重新读取状态。${error.message}`
            : `ToolHost 已退出：${error.message}`);
          failure.code = 'TOOLHOST_EXIT';
          job.reject(failure);
        }
      }
    };
    child.on('error', failed);
    child.on('close', (code) => failed(new Error(`退出码 ${code}`)));
    return this.starting;
  }

  _next() {
    if (this.active || !this.child || this.starting) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.active = job;
    job.timer = setTimeout(() => {
      if (!job.settled) {
        job.timeoutError = new Error(job.kind === 'write'
          ? 'ToolHost 写入等待超时，结果未知；请先重新读取状态。'
          : 'ToolHost 读取等待超时');
        this.child?.kill();
      }
    }, job.timeoutMs);
    this.child.stdin.write(`${JSON.stringify(job.request)}\n`);
  }

  async request(tool, command, args = [], workspaceKey = '', input = undefined, options = {}) {
    if (this.disposed) throw new Error('ToolHost 客户端已关闭');
    const kind = requestKind(command, args);
    for (let attempt = 0; attempt <= (kind === 'read' ? 1 : 0); attempt += 1) {
      try {
        await this._start(tool);
        const id = `req-${++this.sequence}`;
        return await new Promise((resolve, reject) => {
          this.jobs.push({
            id, kind, resolve, reject, settled: false,
            timeoutMs: options.timeoutMs || 120000,
            onOutput: options.onOutput,
            request: { id, command, args, workspaceKey, input, requestKind: kind },
          });
          this._next();
        });
      } catch (error) {
        if (kind !== 'read' || attempt === 1 || error.code !== 'TOOLHOST_EXIT') throw error;
      }
    }
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.key = '';
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startReject?.(new Error('ToolHost 已停止'));
    this.startReject = null;
    this.starting = null;
    const jobs = [this.active, ...this.jobs].filter(Boolean);
    this.active = null;
    this.jobs = [];
    for (const job of jobs) {
      clearTimeout(job.timer);
      if (!job.settled) {
        job.settled = true;
        job.reject(new Error(job.kind === 'write'
          ? 'ToolHost 已停止，写入结果未知；请先重新读取状态。'
          : 'ToolHost 已停止'));
      }
    }
    await new Promise((resolve, reject) => {
      const terminate = setTimeout(() => child.kill(), 2000);
      const deadline = setTimeout(() => reject(new Error('ToolHost 停止超时')), 5000);
      child.once('close', () => {
        clearTimeout(terminate);
        clearTimeout(deadline);
        resolve();
      });
      try { child.stdin.end(); } catch { child.kill(); }
    });
  }

  dispose() {
    this.disposed = true;
    void this.stop().catch(this.onError);
  }
}

module.exports = { ToolProcessClient, requestKind, runtimeKey };
