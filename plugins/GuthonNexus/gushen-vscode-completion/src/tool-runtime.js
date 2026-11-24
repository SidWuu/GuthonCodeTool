const fs = require('node:fs');
const path = require('node:path');
const { workspaceRoot } = require('./workspace-root');

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

// 开发模式每次都让用户明确选择源码目录，避免沿用已失效或非当前分支的 developmentRoot。
function runtimeSelectionOptions(mode, reselectEntry = false) {
  return {
    probePackaged: true,
    selectScript: reselectEntry || normalizeExecutionMode(mode) === 'script',
    selectPackaged: reselectEntry,
    selectDevelopment: reselectEntry || normalizeExecutionMode(mode) === 'source-development',
  };
}

function runtimeConfigurationTarget(config, key, targets) {
  const scope = config.inspect?.(key);
  if (scope?.workspaceFolderValue !== undefined) return targets.WorkspaceFolder;
  if (scope?.workspaceValue !== undefined) return targets.Workspace;
  return targets.Global;
}

function installedSetupReport(home) {
  try {
    const file = path.join(workspaceRoot(home), 'nexus', 'setup-result.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return undefined;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    return report?.state === 'environment-ready' ? report : undefined;
  } catch { return undefined; }
}

function installedToolEnvironment(home, base = process.env) {
  const report = installedSetupReport(home);
  if (!report) return {};
  const env = {};
  if (base.LOCALAPPDATA && /^[a-f0-9]{20}$/.test(report.bundleId || '')) {
    const python = path.join(base.LOCALAPPDATA, 'Guthon', 'runtimes', report.bundleId, 'python.exe');
    if (isFile(python)) env.GUTHON_PYTHON = python;
  }
  const executable = report.programs?.git;
  if (typeof executable !== 'string' || !path.isAbsolute(executable)
      || path.basename(executable).toLowerCase() !== 'git.exe' || !isFile(executable)) return env;
  const directories = [path.dirname(executable)];
  const ssh = path.join(path.dirname(executable), '..', 'usr', 'bin');
  if (isDirectory(ssh)) directories.push(ssh);
  env.PATH = [...directories, base.PATH || base.Path || ''].join(path.delimiter);
  return env;
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function isDirectory(dirPath) {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

function resolvePackagedTool(toolPath) {
  return isFile(toolPath) ? toolPath : '';
}

function packagedToolInDirectory(directory, platform = process.platform) {
  const candidates = platform === 'win32'
    ? ['GuthonCodeTool-windows-x64.exe', 'GuthonCodeTool.exe']
    : ['GuthonCodeTool', path.join('GuthonCodeTool', 'GuthonCodeTool')];
  return candidates.map(name => path.join(directory, name)).find(isFile) || '';
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

function initializationRuntimeInDirectory(directory, preferredMode) {
  const application = packagedToolInDirectory(directory);
  if (application) {
    return { runtime: { mode: 'packaged', toolPath: application }, configuration: { executionMode: 'packaged', toolPath: application } };
  }

  if (preferredMode === 'source-development') {
    for (const developmentRoot of [directory, path.join(directory, 'GuthonCodeTool')]) {
      try {
        const runtime = resolveDevelopmentRuntime(developmentRoot);
        return { runtime, configuration: { executionMode: runtime.mode, developmentRoot } };
      } catch { /* Try the next supported layout. */ }
    }
  }
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
  const runtimeDir = path.join(workspaceRoot(tool.toolHome), 'nexus');
  const descriptorPath = path.join(runtimeDir, 'tool-runtime.json');
  const command = [tool.toolPath, ...(tool.toolEntry ? [tool.toolEntry] : [])];
  const content = `${JSON.stringify({
    mode: tool.mode,
    protocolVersion: 1,
    command,
    codeSource: tool.toolEntry || tool.toolPath,
    home: tool.toolHome,
    workspaceRoot: workspaceRoot(tool.toolHome),
    workspaceResolveCommand: [...command, 'workspace-resolve', '--home', tool.toolHome],
    databaseTargetResolveCommand: [...command, 'database-target-resolve', '--home', tool.toolHome],
    databaseProbeCommand: [...command, 'database-probe', '--home', tool.toolHome],
    databaseDescribeCommand: [...command, 'database-describe', '--home', tool.toolHome],
    databaseQueryCommand: [...command, 'database-query-readonly', '--home', tool.toolHome],
    linterCommand: [...command, 'lint', '--home', tool.toolHome],
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
  installedSetupReport,
  installedToolEnvironment,
  runtimeConfigurationTarget,
  normalizeExecutionMode, runtimeSelectionOptions, resolveDevelopmentRuntime, resolveScriptRuntime,
  resolvePackagedTool, packagedToolInDirectory, initializationRuntimeInDirectory, toolArguments, writeRuntimeDescriptor,
};
