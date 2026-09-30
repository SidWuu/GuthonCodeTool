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

function isDirectory(dirPath) {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

const PACKAGED_ENTRY_NAMES = ['GuthonCodeTool', 'GuthonCodeTool.exe'];

function resolvePackagedTool(toolPath) {
  // macOS 发行包是 onedir 目录，可执行文件位于目录内；选中文件夹时自动定位入口。
  if (isDirectory(toolPath)) {
    for (const name of PACKAGED_ENTRY_NAMES) {
      const candidate = path.join(toolPath, name);
      if (isFile(candidate)) return candidate;
    }
    return '';
  }
  return isFile(toolPath) ? toolPath : '';
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
  const command = [tool.toolPath, ...(tool.toolEntry ? [tool.toolEntry] : [])];
  const content = `${JSON.stringify({
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
  }, null, 2)}\n`;
  // 每条工具命令都会写描述符；内容不变时跳过读写，避免热路径上的同步 IO。
  try {
    if (fs.readFileSync(descriptorPath, 'utf8') === content) return descriptorPath;
  } catch {
    // 描述符不存在或不可读时按需重建。
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(descriptorPath, content, 'utf8');
  return descriptorPath;
}

module.exports = {
  normalizeExecutionMode, resolveDevelopmentRuntime, resolveScriptRuntime,
  resolvePackagedTool, toolArguments, writeRuntimeDescriptor,
};
