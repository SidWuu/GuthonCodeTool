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

  function isRunning() {
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  function start(tool) {
    if (isRunning()) return false;
    if (!options.scriptPath) throw new Error('VSIX 中缺少 Guthon Bridge 服务文件，请重新安装扩展');

    const started = spawnProcess(options.executable || process.execPath, [options.scriptPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        GUTHON_TOOL_PATH: tool.toolPath,
        GUTHON_TOOL_ENTRY: tool.toolEntry || '',
        GUTHON_TOOL_HOME: tool.toolHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = started;
    started.stdout?.on('data', (data) => options.onOutput?.(data.toString()));
    started.stderr?.on('data', (data) => options.onOutput?.(data.toString()));
    started.once('error', (error) => options.onError?.(error));
    started.once('exit', (code, signal) => {
      if (child === started) child = undefined;
      options.onExit?.(code, signal);
      options.onStateChange?.();
    });
    options.onStateChange?.();
    return true;
  }

  function stop() {
    if (!isRunning()) return Promise.resolve(false);
    const running = child;
    return new Promise((resolve) => {
      running.once('exit', () => resolve(true));
      running.kill();
      options.onStateChange?.();
    });
  }

  async function restart(tool) {
    await stop();
    return start(tool);
  }

  function dispose() {
    if (isRunning()) child.kill();
  }

  return { dispose, isRunning, restart, start, stop };
}

module.exports = { createBridgeProcess, resolveBridgeScript };
