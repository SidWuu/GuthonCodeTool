const { spawn } = require('node:child_process');
const { toolArguments } = require('./tool-runtime');

class ToolJsonClient {
  constructor({ getTool, spawnProcess = spawn, processClient }) {
    this.getTool = getTool;
    this.spawnProcess = spawnProcess;
    this.processClient = processClient;
  }

  async run(workspaceKey, command, args = [], input) {
    const tool = await this.getTool();
    if (!tool) throw new Error('请先配置 GuthonCodeTool 运行模式和本地数据目录');
    if (this.processClient) {
      const payload = await this.processClient.request(tool, command, args, workspaceKey, input);
      if (payload?.ok !== true) throw new Error('后端返回 ok=false');
      return payload;
    }
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        tool.toolPath,
        toolArguments(tool, command, args, workspaceKey),
        { shell: false, env: process.env }
      );
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (value) => stdout.push(Buffer.from(value)));
      child.stderr.on('data', (value) => stderr.push(Buffer.from(value)));
      child.on('error', reject);
      child.on('close', (code) => {
        const output = Buffer.concat(stdout).toString('utf8');
        const errorOutput = Buffer.concat(stderr).toString('utf8');
        if (code) return reject(new Error((errorOutput || output || `退出码 ${code}`).trim()));
        try {
          const payload = JSON.parse(output);
          if (payload?.ok !== true) throw new Error('后端返回 ok=false');
          resolve(payload);
        } catch (error) {
          reject(new Error(`GuthonCodeTool 输出无效：${error.message}`));
        }
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
}

module.exports = { ToolJsonClient };
