const { spawn } = require('node:child_process');
const { toolArguments } = require('./tool-runtime');
const { StringDecoder } = require('node:string_decoder');
const { requestTimeoutMs, requestKind } = require('./tool-process-client');

function payloadError(payload) {
  const error=new Error(payload?.errors?.map(item=>item.error).join('; ') || payload?.error?.message || payload?.message || '后端返回 ok=false');
  const code=payload?.error?.code || payload?.errorCode || payload?.code;
  if(typeof code==='string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code))error.code=code;
  return error;
}

class ToolJsonClient {
  constructor({ getTool, spawnProcess = spawn, processClient, errorMessage, outputLabel = 'GuthonCodeTool' }) {
    this.getTool = getTool;
    this.spawnProcess = spawnProcess;
    this.processClient = processClient;
    this.errorMessage = errorMessage || ((stderr, stdout, code) => (stderr || stdout || `退出码 ${code}`).trim());
    this.outputLabel = outputLabel;
  }

  async run(workspaceKey, command, args = [], input, { onOutput, timeoutMs = requestTimeoutMs(command, args) } = {}) {
    const tool = await this.getTool();
    if (!tool) throw new Error('请先配置 GuthonCodeTool 运行模式和本地数据目录');
    if (this.processClient) {
      const payload = await this.processClient.request(tool, command, args, workspaceKey, input, {onOutput});
      if (payload?.ok !== true) throw payloadError(payload);
      return payload;
    }
    const serializedInput = input === undefined ? undefined : JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        tool.toolPath,
        toolArguments(tool, command, args, workspaceKey),
        { shell: false, env: { ...process.env, ...(tool.env || {}) } }
      );
      const stdout = [];
      const stderr = [];
      const decoder = new StringDecoder('utf8');
      let settled = false, outputBytes = 0, killTimer;
      const finish = (error, payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(payload);
      };
      const terminate = error => {
        child.kill?.('SIGTERM');
        killTimer = setTimeout(() => child.kill?.('SIGKILL'), 500);
        killTimer.unref?.();
        finish(error);
      };
      const timer = setTimeout(() => terminate(new Error(`${this.outputLabel} 请求超时${requestKind(command,args) === 'write' ? '；写入结果未知，请先核验工作区' : ''}`)), timeoutMs);
      const collect = (chunks, value, progress = false) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) return terminate(new Error(`${this.outputLabel} 输出超过 4 MiB；请使用有界查询并核验操作状态`));
        chunks.push(chunk);
        if (progress) onOutput?.(decoder.write(chunk));
      };
      child.stdout.on('data', value => collect(stdout, value));
      child.stderr.on('data', value => collect(stderr, value, true));
      child.on('error', error => finish(error));
      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        onOutput?.(decoder.end());
        const output = Buffer.concat(stdout).toString('utf8');
        const errorOutput = Buffer.concat(stderr).toString('utf8');
        if (code) {
          try {
            const payload=JSON.parse(output);
            if(payload?.ok===false)return finish(payloadError(payload));
          } catch {}
          const error=new Error(this.errorMessage(errorOutput, output, code));
          const semantic=/^([A-Z][A-Z0-9_]{2,63}):/.exec(error.message);
          if(semantic)error.code=semantic[1];
          return finish(error);
        }
        try {
          const payload = JSON.parse(output);
          if (payload?.ok !== true) return finish(payloadError(payload));
          finish(null, payload);
        } catch (error) {
          finish(new Error(`${this.outputLabel} 输出无效：${error.message}`));
        }
      });
      child.stdin.on?.('error', error => terminate(error));
      child.stdin.end(serializedInput);
    });
  }
}

module.exports = { ToolJsonClient };
