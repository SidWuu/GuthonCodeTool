const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Generated from the Python ToolHost authority by npm run build:bridge.
const COMMAND_METADATA = require('../data/tool-command-metadata.json');

function commandMetadata(command, args) {
  const registry = command === 'svn' ? COMMAND_METADATA.svnActions : COMMAND_METADATA.commands;
  const key = command === 'svn' ? args[0] : command;
  return Object.hasOwn(registry, key) ? registry[key] : undefined;
}

function requestTimeoutMs(command, args = []) {
  return commandMetadata(command, args)?.timeoutMs ?? COMMAND_METADATA.defaultTimeoutMs;
}

function requestKind(command, args = []) {
  // Unknown actions must remain non-replayable.
  const metadata = commandMetadata(command, args);
  if (metadata?.writeFlags?.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)))) return 'write';
  if(metadata?.writeArguments?.some(argument=>args.includes(argument)))return 'write';
  return metadata?.kind ?? 'write';
}

function runtimeKey(tool) {
  return JSON.stringify([tool.toolPath, tool.toolEntry || '', tool.toolHome]);
}

class ToolProcessClient {
  constructor({ spawnProcess = spawn, env = process.env, onError = () => {}, onProgress = () => {}, allowReadLane = true } = {}) {
    this.allowReadLane = allowReadLane;
    this.capabilities = new Set();
    this.readClient = null;
    this.readClientOptions = {spawnProcess,env,onError,onProgress,allowReadLane:false};
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
    if (this.child && this.key !== key && (this.starting || this.active?.kind === 'write' || this.jobs.some(job => job.kind === 'write'))) {
      const error = new Error('旧运行环境仍有请求正在启动或写入；请等待完成后重试切换，原写入未被中断。');
      error.code = 'TOOLHOST_BUSY';
      throw error;
    }
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
      child.kill('SIGKILL');
    }, 30000);
    let protocolBytes = 0;
    child.stdout.on('data', (chunk) => {
      for (const part of chunk.toString().split(/(?<=\n)/)) {
        protocolBytes += Buffer.byteLength(part);
        if (protocolBytes > 8 * 1024 * 1024) {
          child.protocolFailure = new Error('ToolHost 协议输出超过限制');
          this.onError(child.protocolFailure);
          child.kill('SIGKILL');
          return;
        }
        if (part.endsWith('\n')) protocolBytes = 0;
      }
    });
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      if (child.protocolFailure) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        child.protocolFailure = new Error(`ToolHost 协议输出无效：${line.slice(0, 200)}`);
        this.onError(child.protocolFailure);
        child.kill('SIGKILL');
        return;
      }
      if (message.type === 'ready') {
        if (message.protocolVersion !== 1) {
          readyReject(new Error(`ToolHost 协议版本不匹配：${message.protocolVersion}`));
          child.kill('SIGKILL');
        } else {
          this.capabilities = new Set(Array.isArray(message.capabilities) ? message.capabilities : []);
          clearTimeout(this.startTimer);
          this.startTimer = null;
          this.startReject = null;
          readyResolve();
          this.starting = null;
          this._next();
        }
        return;
      }
      if (message.type === 'control') {
        if (message.operation === 'cancel' && this.active?.id === message.id) {
          this.active.onOutput?.(message.accepted
            ? '已请求协作式取消，等待安全检查点结果。\n'
            : '当前阶段未接受取消，任务继续；请以最终结果为准。\n');
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
        child.kill('SIGKILL');
        return;
      }
      const job = this.active;
      this.active = null;
      clearTimeout(job.timer);
      job.cancelSubscription?.dispose();
      if (!job.settled) {
        job.settled = true;
        if (message.ok) job.resolve(message.result);
        else {
          const error = new Error(message.error?.message || 'ToolHost 命令失败');
          error.code = message.error?.code;
          job.reject(error);
        }
      }
      this._next();
    });
    child.stderr.on('data', (chunk) => {
      this.active?.onOutput?.(chunk.toString());
      this.onProgress({ type: 'stderr', message: chunk.toString() });
    });
    const failed = (error) => {
      if (this.child !== child) return;
      if (child.protocolFailure) error = child.protocolFailure;
      this.child = null;
      this.key = '';
      clearTimeout(this.startTimer);
      this.startTimer = null;
      if (this.starting) {
        error.code = child.protocolFailure ? 'TOOLHOST_PROTOCOL' : 'TOOLHOST_EXIT';
        readyReject(error);
        this.starting = null;
        this.startReject = null;
      }
      const jobs = [this.active, ...this.jobs].filter(Boolean);
      this.active = null;
      this.jobs = [];
      for (const job of jobs) {
        clearTimeout(job.timer);
        job.cancelSubscription?.dispose();
        if (!job.settled) {
          job.settled = true;
          const failure = job.timeoutError || new Error(job.kind === 'write'
            ? `ToolHost 已退出，写入结果未知；请先重新读取状态。${error.message}`
            : `ToolHost 已退出：${error.message}`);
          failure.code = child.protocolFailure ? 'TOOLHOST_PROTOCOL' : 'TOOLHOST_EXIT';
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
        this.child?.kill('SIGKILL');
      }
    }, job.timeoutMs);
    this.child.stdin.write(`${JSON.stringify(job.request)}\n`);
  }

  async request(tool, command, args = [], workspaceKey = '', input = undefined, options = {}) {
    if (this.disposed) throw new Error('ToolHost 客户端已关闭');
    const kind = requestKind(command, args);
    if (kind === 'read' && this.allowReadLane && this.active?.kind === 'write'
        && this.active.timeoutMs > 120000) {
      this.readClient ||= new ToolProcessClient(this.readClientOptions);
      return this.readClient.request(tool, command, args, workspaceKey, input, options);
    }
    for (let attempt = 0; attempt <= (kind === 'read' ? 1 : 0); attempt += 1) {
      try {
        await this._start(tool);
        const id = `req-${++this.sequence}`;
        return await new Promise((resolve, reject) => {
          const job = {
            id, kind, resolve, reject, settled: false,
            timeoutMs: options.timeoutMs || requestTimeoutMs(command, args),
            onOutput: options.onOutput,
            request: { id, command, args, workspaceKey, input, requestKind: kind },
          };
          const cancel = () => {
            if (job.settled) return;
            if (this.active !== job) {
              this.jobs = this.jobs.filter(item => item !== job);
              job.settled = true;
              job.cancelSubscription?.dispose();
              const error = new Error('已取消尚未执行的请求'); error.code = 'OPERATION_CANCELLED';
              reject(error);
            } else if (this.capabilities.has('cancel-index-v1')) {
              if (!job.cancelSent) {
                job.cancelSent = true;
                try {this.child.stdin.write(`${JSON.stringify({type:'cancel',id:job.id})}\n`);} catch {
                  job.onOutput?.('取消控制消息未发送成功，等待原任务最终结果。\n');
                }
              }
            } else job.onOutput?.('当前 ToolHost 版本不支持协作式取消，原任务继续。\n');
          };
          this.jobs.push(job);
          if (commandMetadata(command, args)?.cancellable && options.token) {
            job.cancelSubscription = options.token.onCancellationRequested(cancel);
            if (options.token.isCancellationRequested) cancel();
            if (job.settled) job.cancelSubscription?.dispose();
          }
          this._next();
        });
      } catch (error) {
        if (kind !== 'read' || attempt === 1 || error.code !== 'TOOLHOST_EXIT') throw error;
      }
    }
  }

  async stop() {
    const readClient = this.readClient;
    this.readClient = null;
    let readStopError;
    const readStop = readClient ? readClient.stop().catch((error) => { readStopError=error; }) : Promise.resolve();
    const child = this.child;
    if (!child) { await readStop; if(readStopError)throw readStopError; return; }
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
      job.cancelSubscription?.dispose();
      if (!job.settled) {
        job.settled = true;
        job.reject(new Error(job.kind === 'write'
          ? 'ToolHost 已停止，写入结果未知；请先重新读取状态。'
          : 'ToolHost 已停止'));
      }
    }
    let stopError;
    try {
      await new Promise((resolve, reject) => {
      const terminate = setTimeout(() => child.kill('SIGKILL'), 2000);
      const deadline = setTimeout(() => reject(new Error('ToolHost 停止超时')), 5000);
      child.once('close', () => {
        clearTimeout(terminate);
        clearTimeout(deadline);
        resolve();
      });
      try { child.stdin.end(); } catch { child.kill('SIGKILL'); }
      });
    } catch(error) { stopError=error; }
    await readStop;
    if(stopError || readStopError)throw stopError || readStopError;
  }

  dispose() {
    this.disposed = true;
    void this.stop().catch(this.onError);
  }
}

module.exports = { ToolProcessClient, requestKind, requestTimeoutMs, runtimeKey, ...require('./workspace-scheduler') };
