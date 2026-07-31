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

function toolArguments(tool, command, extraArgs = [], workspaceKey = '') {
  return [
    ...(tool.toolEntry ? [tool.toolEntry] : []),
    command,
    '--home',
    tool.toolHome,
    ...(workspaceKey ? ['--workspace', workspaceKey] : []),
    ...(extraArgs.length ? ['--', ...extraArgs] : []),
  ];
}

function writeRuntimeDescriptor(tool) {
  const runtimeDir = path.join(tool.toolHome, 'var', 'nexus');
  const descriptorPath = path.join(runtimeDir, 'tool-runtime.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(descriptorPath, `${JSON.stringify({
    mode: tool.mode,
    command: [tool.toolPath, ...(tool.toolEntry ? [tool.toolEntry] : [])],
    home: tool.toolHome,
  }, null, 2)}\n`, 'utf8');
  return descriptorPath;
}

module.exports = { resolveDevelopmentRuntime, toolArguments, writeRuntimeDescriptor };
