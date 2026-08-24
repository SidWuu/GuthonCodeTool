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

module.exports = { readWorkspaces };
