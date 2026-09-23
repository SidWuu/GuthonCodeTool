const fs = require('node:fs');
const path = require('node:path');

function resolveDevelopmentRuntime(root, platform = process.platform) {
  if (!root) throw new Error('尚未选择 GuthonCodeTool 源码仓库根目录');
  const toolEntry = path.join(root, 'scripts', 'guthon_tool.py');
  const toolPath = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  const missing = [toolPath, toolEntry].filter((candidate) => !fs.existsSync(candidate));
  if (missing.length) throw new Error(`开发目录缺少：${missing.join('、')}`);
  return { mode: 'source-development', toolEntry, toolPath };
}

function normalizeExecutionMode(mode) {
  return mode === 'development' ? 'source-development' : mode;
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function resolveScriptRuntime(pythonPath, scriptPath) {
  if (!path.isAbsolute(pythonPath || '') || !isFile(pythonPath)) {
    throw new Error('调试模式需要有效的 Python 绝对路径');
  }
  if (!path.isAbsolute(scriptPath || '') || path.extname(scriptPath).toLowerCase() !== '.pyz' || !isFile(scriptPath)) {
    throw new Error('调试模式需要有效的 GuthonCodeTool .pyz 绝对路径');
  }
  return { mode: 'script', toolPath: pythonPath, toolEntry: scriptPath };
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
  const command = [tool.toolPath, ...(tool.toolEntry ? [tool.toolEntry] : [])];
  fs.writeFileSync(descriptorPath, `${JSON.stringify({
    mode: tool.mode,
    protocolVersion: 1,
    command,
    codeSource: tool.toolEntry || tool.toolPath,
    home: tool.toolHome,
    workspaceResolveCommand: [...command, 'workspace-resolve', '--home', tool.toolHome],
    databaseTargetResolveCommand: [...command, 'database-target-resolve', '--home', tool.toolHome],
    databaseProbeCommand: [...command, 'database-probe', '--home', tool.toolHome],
    databaseDescribeCommand: [...command, 'database-describe', '--home', tool.toolHome],
    databaseQueryCommand: [...command, 'database-query-readonly', '--home', tool.toolHome],
    linterCommand: [path.join(tool.toolHome, 'var', 'tools', 'guthon-lint')],
  }, null, 2)}\n`, 'utf8');
  return descriptorPath;
}

module.exports = {
  normalizeExecutionMode, resolveDevelopmentRuntime, resolveScriptRuntime,
  toolArguments, writeRuntimeDescriptor,
};
