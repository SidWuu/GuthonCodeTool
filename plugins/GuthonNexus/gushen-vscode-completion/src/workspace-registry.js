const { spawn } = require('node:child_process');
const { toolArguments } = require('./tool-runtime');

function readWorkspaces(tool, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(tool.toolPath, toolArguments(tool, 'workspaces'), { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code) return reject(new Error((stderr || stdout || `退出码 ${code}`).trim()));
      try {
        const payload = JSON.parse(stdout);
        if (payload?.ok !== true || !Array.isArray(payload.workspaces)) {
          throw new Error('缺少 ok=true 或 workspaces 数组');
        }
        resolve(payload.workspaces);
      } catch (error) {
        reject(new Error(`工作区列表无效：${error.message}`));
      }
    });
  });
}

class WorkspaceRegistry {
  constructor(read = readWorkspaces) {
    this.read = read;
    this.key = '';
    this.value = undefined;
    this.pending = undefined;
    this.generation = 0;
  }

  get(tool) {
    const key = JSON.stringify([tool.toolPath, tool.toolEntry || '', tool.toolHome]);
    if (this.key !== key) {
      this.invalidate();
      this.key = key;
    }
    if (this.value) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = Promise.resolve().then(() => this.read(tool));
    this.pending = pending;
    pending.then(
      (value) => {
        if (this.generation === generation) this.value = value;
      },
      () => {}
    ).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }

  invalidate() {
    this.generation += 1;
    this.value = undefined;
    this.pending = undefined;
  }
}

module.exports = { readWorkspaces, WorkspaceRegistry };
