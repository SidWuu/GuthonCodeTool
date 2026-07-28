const fs = require('node:fs');
const path = require('node:path');

function resolveDevelopmentRuntime(root, platform = process.platform) {
  if (!root) throw new Error('尚未选择 GuthonCodeTool 源码仓库根目录');
  const toolEntry = path.join(root, 'scripts', 'guthon_tool.py');
  const toolPath = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  const missing = [toolPath, toolEntry].filter((candidate) => !fs.existsSync(candidate));
  if (missing.length) throw new Error(`调试目录缺少：${missing.join('、')}`);
  return { mode: 'development', toolEntry, toolPath };
}

function toolArguments(tool, command, extraArgs = []) {
  return [
    ...(tool.toolEntry ? [tool.toolEntry] : []),
    command,
    '--home',
    tool.toolHome,
    ...(extraArgs.length ? ['--', ...extraArgs] : []),
  ];
}

module.exports = { resolveDevelopmentRuntime, toolArguments };
