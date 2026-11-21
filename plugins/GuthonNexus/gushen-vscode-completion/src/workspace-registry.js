const { spawn } = require('node:child_process');
const { toolArguments } = require('./tool-runtime');

function workspaceSnapshot(payload) {
  if(payload?.ok!==true || !Array.isArray(payload.workspaces))throw new Error('缺少 ok=true 或 workspaces 数组');
  const configErrors=payload.configErrors ?? [];
  if(!Array.isArray(configErrors) || configErrors.some(item=>!item || typeof item.workspaceKey!=='string'
    || typeof item.code!=='string' || typeof item.message!=='string'))throw new Error('configErrors 必须为项目诊断数组');
  return {workspaces:payload.workspaces,configErrors};
}

function readWorkspaceRegistry(tool, spawnProcess = spawn) {
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
        resolve(workspaceSnapshot(JSON.parse(stdout)));
      } catch (error) {
        reject(new Error(`工作区列表无效：${error.message}`));
      }
    });
  });
}

// Preserve existing list consumers; the shared registry also retains diagnostics.
function readWorkspaces(tool, spawnProcess = spawn) {
  return readWorkspaceRegistry(tool, spawnProcess).then(result => result.workspaces);
}

class WorkspaceRegistry {
  constructor(read = readWorkspaceRegistry) {
    this.read = read;
    this.key = '';
    this.value = undefined;
    this.pending = undefined;
    this.generation = 0;
  }

  get(tool) {
    return this.getSnapshot(tool).then(result => result.workspaces);
  }

  getSnapshot(tool) {
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

module.exports = { readWorkspaces, readWorkspaceRegistry, workspaceSnapshot, WorkspaceRegistry };
