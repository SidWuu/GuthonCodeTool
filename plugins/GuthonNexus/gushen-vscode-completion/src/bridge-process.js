const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function resolveBridgeScript(extensionPath) {
  return [
    path.join(extensionPath, 'bridge', 'server.js'),
    path.resolve(extensionPath, '..', '..', 'GuthonBridge', 'bridge', 'server.js'),
  ].find((candidate) => fs.existsSync(candidate));
}

function createBridgeProcess(options) {
  const spawnProcess = options.spawnProcess || spawn;
  let child;
  let currentPort = options.port || 17361;

  let sharedInstance;
  function isRunning() {
    if(sharedInstance?.pid) {
      try { process.kill(sharedInstance.pid,0); } catch(error) { if(error.code==='ESRCH')sharedInstance=undefined; }
    }
    return Boolean(sharedInstance || child && child.exitCode === null && !child.killed);
  }

  function start(tool) {
    if (isRunning()) return false;
    if (!options.scriptPath) throw new Error('VSIX 中缺少 Guthon Bridge 服务文件，请重新安装扩展');

    currentPort = Number(options.getPort?.() || options.port || 17361);
    if (!Number.isInteger(currentPort) || currentPort < 1 || currentPort > 65535) throw new Error('Bridge 端口无效');
    const started = spawnProcess(options.executable || process.execPath, [options.scriptPath], {
      env: {
        ...process.env,
        ...(tool.env || {}),
        ELECTRON_RUN_AS_NODE: '1',
        GUTHON_TOOL_PATH: tool.toolPath,
        GUTHON_TOOL_ENTRY: tool.toolEntry || '',
        GUTHON_TOOL_MODE: tool.mode || 'packaged',
        GUTHON_TOOL_HOME: tool.toolHome,
        GUTHON_BRIDGE_PORT: String(currentPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = started;
    let startupOutput = '';
    started.stdout?.on('data', (data) => {
      startupOutput += data.toString();
      const match = startupOutput.match(/BRIDGE_REUSE (\{[^\n]+\})/);
      if (match) {
        try { sharedInstance=JSON.parse(match[1]); } catch { /* Health validation below remains mandatory. */ }
      }
      options.onOutput?.(data.toString());
    });
    started.stderr?.on('data', (data) => options.onOutput?.(data.toString()));
    started.once('error', (error) => options.onError?.(error));
    started.once('exit', (code, signal) => {
      if (child === started) child = undefined;
      if(!sharedInstance || code!==0)options.onExit?.(code, signal);
      options.onStateChange?.();
    });
    options.onStateChange?.();
    return true;
  }

  function stop() {
    if (sharedInstance) { sharedInstance=undefined; options.onStateChange?.(); return Promise.resolve(false); }
    if (!isRunning()) return Promise.resolve(false);
    const running = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.kill('SIGKILL');
        reject(new Error('Bridge 停止超时，已强制结束进程'));
      }, options.stopTimeoutMs || 6000);
      running.once('exit', () => { clearTimeout(timer); resolve(true); });
      running.kill();
      options.onStateChange?.();
    });
  }

  async function restart(tool) {
    await stop();
    return start(tool);
  }

  function dispose() {
    void stop().catch((error) => options.onError?.(error));
  }

  function pairingToken(toolHome) {
    const token = fs.readFileSync(path.join(toolHome, 'var', 'nexus', 'bridge', 'token'), 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Bridge 配对令牌无效，请重新启动服务');
    return token;
  }

  async function waitForReady(toolHome, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isRunning()) throw new Error('Bridge 进程未运行，请查看输出面板');
      try {
        const response = await fetch(`http://127.0.0.1:${currentPort}/status`, {
          headers: { Authorization: `Bearer ${pairingToken(toolHome)}` },
          signal: AbortSignal.timeout(500),
        });
        const status = await response.json();
        if (response.ok && status.ok && (!sharedInstance || status.instanceId===sharedInstance.instanceId)) return status;
      } catch { /* Startup may still be creating its token or opening its listener. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if(sharedInstance){sharedInstance=undefined;options.onStateChange?.();}
    throw new Error('Bridge 启动健康检查超时，请查看输出面板');
  }

  async function request(toolHome, route, payload) {
    if (!isRunning()) throw new Error('Bridge 未运行，请先启动 Guthon Bridge');
    if (!/^\/(pageContext|navigate|navigationResult|components|updateGuard)(\?|$)/.test(route)) throw new Error('不支持的 Bridge 接口');
    const response = await fetch(`http://127.0.0.1:${currentPort}${route}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${pairingToken(toolHome)}`, 'Content-Type': 'application/json'},
      ...(payload === undefined ? {} : {body: JSON.stringify(payload)}), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.message || '浏览器定位请求失败');
    return result;
  }

  return { dispose, isRunning, isShared: () => Boolean(sharedInstance), pairingToken, request, restart, start, stop, waitForReady };
}

module.exports = { createBridgeProcess, resolveBridgeScript };
