const { timedOutput, operationTimer, indexResultSummary } = require('./output-logging');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const {
  filterItems,
  findHoverItems,
  getCurrentWord,
  itemBodyToSnippet,
  itemDocumentation,
  itemFilterText,
  itemLabel,
  itemSortText,
  mergeCompletionData,
  resolveRoute,
  shouldProvideApiCompletions,
} = require('./rules');
const { createDocumentSelector } = require('./selector');
const { enrichCompletionData, mergeApiCompletionItems } = require('./api-completion');
const { workspaceRoot } = require('./workspace-root');
const { prepareWorkspaceSetup, promptWorkspaceCreation, WindowWorkspaceSelection, windowToolHome, workspaceSetupCard, hasWorkspaceConfigFiles, pickWorkspaceSourceMode } = require('./tool-workspace');
const { promptDatabaseDiagnosis } = require('./database-config');
const { ToolJsonClient } = require('./tool-json-client');
const { createBridgeProcess, resolveBridgeScript } = require('./bridge-process');
const {
  normalizeExecutionMode, runtimeSelectionOptions, resolveDevelopmentRuntime, resolvePackagedTool, packagedToolInDirectory, resolveScriptRuntime, initializationRuntimeInDirectory,
  writeRuntimeDescriptor, runtimeConfigurationTarget, installedSetupReport, installedToolEnvironment, toolArguments,
} = require('./tool-runtime');
const { ToolProcessClient } = require('./tool-process-client');
const { prepareScriptRuntime } = require('./script-runtime');
const { createUpdateCenter } = require('./update-center');
const { createOnboarding } = require('./onboarding');
const { workspaceTeamSource, openTeamSyncTerminal } = require('./onboarding-team');
const {
  UPDATE_SOURCES,
  detectCurrentVersion,
  verifyExecutable,
  readUpdateState,
  writeUpdateState,
  withUpdateLock,
} = require('./tool-updater');
const { WorkspaceRegistry } = require('./workspace-registry');

const SUPPORTED_LANGUAGES = ['java', 'guthon-gss', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled', 'guthon-api-edit'];
const TOOL_COMMANDS = {
  setup: 'setup',
  workspaceCreate: 'workspace-create',
  workspaceDelete: 'workspace-delete',
  workspaceSourceMode: 'workspace-source-mode',
  reindex: 'reindex',
  exportMarkdown: 'export-markdown',
  exportSchema: 'export-schema',
  exportBillTypes: 'export-bill-type',
  exportSystemScripts: 'export-system-script',
  exportViews: 'export-view',
  doctor: 'doctor',
  diagnose: 'diagnose',
  pullLog: 'pull-log',
  databaseTargetConfigure: 'database-target-configure',
};
const TOOL_LABELS = {
  setup: '设置工作空间',
  reindex: '重建索引',
  'sync-all': '更新 DATABASE 源码',
  'export-markdown': '导出源码索引文档',
  'export-schema': '导出表结构',
  'export-bill-type': '导出单据类型',
  'export-system-script': '导出系统脚本',
  'export-view': '导出视图源码',
  doctor: '检查本地环境',
  diagnose: '执行源码逻辑排查',
  'workspace-create': '添加工作区',
  'workspace-delete': '删除工作区',
  search: '搜索工作区完整索引',
  'context-pack': '生成 AI 上下文',
  'database-target-configure': '配置数据库排查',
};
let toolQueue = Promise.resolve();
const activeToolRuns = new Set();
let applicationUpdateRunning = false;
let toolOutputChannel = null;

// 复用同一个输出通道：每条命令都新建通道会持续泄漏，并反复把焦点抢到输出面板。
function toolOutput() {
  if (!toolOutputChannel) {
    toolOutputChannel = timedOutput(vscode.window.createOutputChannel('GuthonCodeTool'));
  }
  return toolOutputChannel;
}

function toolRunKey(command, workspaceKey) {
  return `${command}::${workspaceKey || ''}`;
}

function reportToolAlreadyRunning(command, workspaceKey, labelOverride = '') {
  const message = `已有${labelOverride || TOOL_LABELS[command] || command}正在执行：${workspaceKey || '当前工作区'}，本次点击已忽略。`;
  toolOutput().appendLine(message);
  vscode.window.showInformationMessage(message);
}

function claimToolRun(command, workspaceKey, labelOverride = '') {
  if (applicationUpdateRunning) {
    reportToolAlreadyRunning('tool-update', '', 'GuthonCodeTool 更新或回退');
    return null;
  }
  const runKey = toolRunKey(command, workspaceKey);
  const sourceCommands = new Set(['api','reindex','workspace-delete','export-schema','export-view','export-bill-type','export-system-script']);
  const selectedScope = workspaceKey || '__all__';
  const scopeBusy = sourceCommands.has(command) && [...activeToolRuns].some((key) => {
    const [otherCommand, otherScope] = key.split('::');
    return sourceCommands.has(otherCommand) && (selectedScope==='__all__' || !otherScope || otherScope==='__all__' || otherScope===selectedScope);
  });
  if (activeToolRuns.has(runKey) || scopeBusy) {
    reportToolAlreadyRunning(command, workspaceKey, labelOverride);
    return null;
  }
  activeToolRuns.add(runKey);
  return () => activeToolRuns.delete(runKey);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadRules(context) {
  const configuredPath = vscode.workspace
    .getConfiguration('gushenCompletion')
    .get('rulesPath', '');
  const rulesPath = configuredPath || path.join(context.extensionPath, 'rules.json');
  return readJson(rulesPath);
}

let completionDataCache = null;
let activeApiServices;

function loadData(context) {
  const dataDir = path.join(context.extensionPath, 'data');
  const indexPath = path.join(dataDir, 'index.json');
  const manualDataPath = path.join(dataDir, 'manual.json');
  const bundledOfficialDataPath = path.join(dataDir, 'official-api.json');
  const officialDataPath = context.globalStorageUri ? require('./official-update').getOfficialCatalogPath(context,bundledOfficialDataPath) : bundledOfficialDataPath;
  // 补全与悬停都会读取这份数据；按文件签名缓存，避免每次请求同步解析数百 KB JSON。
  const signature = [indexPath, manualDataPath, officialDataPath]
    .map((file) => {
      try {
        const stats = fs.statSync(file);
        return `${file}:${stats.size}:${stats.mtimeMs}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
  if (completionDataCache?.signature === signature) return completionDataCache.value;
  const manualData = fs.existsSync(manualDataPath) ? readJson(manualDataPath) : {};
  const value = enrichCompletionData(mergeCompletionData(readJson(indexPath), manualData), readJson(officialDataPath));
  completionDataCache = { signature, value };
  return value;
}

function completionRange(document, position, currentWord) {
  return new vscode.Range(
    position.line,
    position.character - currentWord.length,
    position.line,
    position.character
  );
}

function toCompletionItem(item, range, route, currentWord) {
  const kind = item.completionKind === 'function' ? vscode.CompletionItemKind.Function : item.completionKind === 'module' ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Snippet;
  const completion = new vscode.CompletionItem(itemLabel(item), kind);
  completion.detail = item.apiPath || `${item.language}/${item.group}`;
  completion.documentation = new vscode.MarkdownString(itemDocumentation(item));
  completion.insertText = new vscode.SnippetString(itemBodyToSnippet(item.body));
  completion.range = range;
  completion.sortText = itemSortText(item, route, currentWord);
  completion.filterText = itemFilterText(item, currentWord);
  return completion;
}

function createProvider(context, loadReferences = async () => []) {
  return {
    async provideCompletionItems(document, position, token) {
      const lineText = document.lineAt(position.line).text;
      const currentWord = getCurrentWord(lineText, position.character);
      if (!shouldProvideApiCompletions(currentWord)) {
        return [];
      }
      const rules = loadRules(context);
      const languageId = document.languageId === 'guthon-gss' ? 'java' : document.languageId;
      const route = resolveRoute(rules, languageId, currentWord);
      const version = document.version;
      const base = loadData(context)[route.source] || [];
      let references = [];
      try {
        references = await loadReferences(document);
      } catch (error) {
        toolOutput().appendLine(`项目 API 补全参考读取失败：${error.message}`);
      }
      if (token?.isCancellationRequested || document.version !== version) return [];
      const data = {[route.source]: mergeApiCompletionItems(base,
        references.filter(item => item.language === route.source))};
      const items = filterItems(data, route, currentWord);
      const range = completionRange(document, position, currentWord);

      return items.map((item) => toCompletionItem(item, range, route, currentWord));
    },
  };
}

function createHoverProvider(context) {

  return {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(
        position,
        /[$A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)+/
      );
      if (!range) return undefined;

      const languageId = document.languageId === 'guthon-gss' ? 'java' : document.languageId;
      const items = findHoverItems(loadData(context), languageId, document.getText(range));
      if (!items.length) return undefined;

      const documentation = [...new Set(items.map(itemDocumentation))].join('\n\n---\n\n');
      return new vscode.Hover(new vscode.MarkdownString(documentation), range);
    },
  };
}

async function configuredRuntime(config, mode, options = {}) {
  let runtime;
  mode = normalizeExecutionMode(mode);
  if (mode === 'source-development') {
    let developmentRoot = config.get('developmentRoot', '');
    if (options.selectDevelopment) {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 GuthonCodeTool 源码仓库根目录' });
      if (!selected) return undefined;
      developmentRoot = selected[0].fsPath;
      try {
        runtime = resolveDevelopmentRuntime(developmentRoot);
      } catch (error) {
        vscode.window.showErrorMessage(`所选源码目录不可用：${error.message}`);
        return undefined;
      }
    } else {
      try {
        runtime = resolveDevelopmentRuntime(developmentRoot);
      } catch {
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 GuthonCodeTool 源码仓库根目录' });
        if (!selected) return undefined;
        developmentRoot = selected[0].fsPath;
        try {
          runtime = resolveDevelopmentRuntime(developmentRoot);
        } catch (error) {
          vscode.window.showErrorMessage(error.message);
          return undefined;
        }
      }
    }
    return { runtime, configuration: { developmentRoot } };
  } else if (mode === 'script') {
    const pythonPath = config.get('scriptPythonPath', '');
    let scriptPath = config.get('scriptToolPath', '');
    if (!options.prepareScript) {
      try {
        return { runtime: resolveScriptRuntime(pythonPath, scriptPath), configuration: {} };
      } catch (error) {
        vscode.window.showErrorMessage(`调试环境不可用：${error.message}。请通过“选择运行方式”重新选择调试脚本。`);
        return undefined;
      }
    }
    if (options.selectScript || !scriptPath || !fs.existsSync(scriptPath)) {
      const script = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { 'GuthonCodeTool 调试脚本': ['pyz'] },
        title: '选择 GuthonCodeTool-python.pyz',
      });
      if (!script?.length) return undefined;
      scriptPath = script[0].fsPath;
    }
    try {
      const { runtime } = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: '准备 GuthonCodeTool 调试环境',
      }, progress => prepareScriptRuntime(scriptPath, {
        storageRoot: options.scriptStorageRoot, pythonPath, onProgress: message => progress.report({ message }),
      }));
      return { runtime, configuration: { scriptPythonPath: runtime.toolPath, scriptToolPath: runtime.toolEntry } };
    } catch (error) {
      vscode.window.showErrorMessage(`无法准备调试环境：${error.message}`);
      return undefined;
    }
  } else {
    let toolPath = resolvePackagedTool(options.packagedPath || config.get('toolPath', ''));
    let selectPackaged = options.selectPackaged || !toolPath;
    if (!selectPackaged && options.probePackaged) {
      try {
        await verifyExecutable(toolPath);
      } catch (error) {
        vscode.window.showWarningMessage(`当前发行应用不可用：${error.message}。请重新选择。`);
        selectPackaged = true;
      }
    }
    if (selectPackaged) {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: process.platform === 'win32' ? { '可执行文件': ['exe'] } : undefined,
        title: process.platform === 'win32'
          ? '选择 GuthonCodeTool EXE 可执行文件'
          : '选择 macOS 可执行文件 GuthonCodeTool',
      });
      if (!selected) return undefined;
      const candidate = resolvePackagedTool(selected[0].fsPath);
      if (!candidate) {
        vscode.window.showErrorMessage(`所选路径下没有可用的 GuthonCodeTool 可执行文件：${selected[0].fsPath}。Windows 请选择 EXE，macOS 请选择解压后的 GuthonCodeTool。`);
        return undefined;
      }
      toolPath = candidate;
      try {
        await verifyExecutable(toolPath);
      } catch (error) {
        vscode.window.showErrorMessage(`所选发行应用不可用：${error.message}`);
        return undefined;
      }
    }
    return { runtime: { mode: 'packaged', toolPath }, configuration: { toolPath } };
  }
}

async function pickExecutionMode(currentMode, entryOnly = false) {
  const modes = [
    { label: '发行模式', description: '调用打包的 GuthonCodeTool 应用', value: 'packaged' },
    { label: '开发模式', description: '使用源码和仓库的 .venv', value: 'source-development' },
    { label: '调试模式', description: '选择 Release 的 pyz，自动准备隔离的 Python 运行环境', value: 'script' },
  ];
  return entryOnly
    ? modes.find(item => item.value === currentMode)
    : vscode.window.showQuickPick(modes, { title: '选择 Guthon Nexus 运行模式' });
}

async function initializationRuntime(config, directory, scriptStorageRoot, reuseSelection) {
  const preferredMode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
  const selection = reuseSelection ? undefined : initializationRuntimeInDirectory(directory, preferredMode);
  if (!selection) {
    const mode = reuseSelection ? preferredMode : (await pickExecutionMode(preferredMode))?.value;
    if (!mode) return undefined;
    const selected = await configuredRuntime(config, mode, {
      selectPackaged: !reuseSelection, selectDevelopment: !reuseSelection, selectScript: !reuseSelection,
      probePackaged: true, prepareScript: true, scriptStorageRoot,
    });
    return selected && { ...selected, configuration: { ...selected.configuration, executionMode: mode } };
  }
  const { runtime } = selection;
  if (runtime.mode === 'packaged') {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '正在检查 GuthonCodeTool' },
        () => verifyExecutable(runtime.toolPath));
    } catch (error) {
      await vscode.window.showErrorMessage(`发行应用无法启动：${runtime.toolPath}。原因：${error.message}`);
      return undefined;
    }
  }
  return selection;
}

async function applyRuntimeSelection(config, selection, scope) {
  for (const [key, value] of Object.entries(selection.configuration)) {
    const targets = vscode.ConfigurationTarget;
    const configuredScope = runtimeConfigurationTarget(config, key, targets);
    const target = scope === targets.Workspace && configuredScope === targets.WorkspaceFolder
      ? configuredScope : scope ?? configuredScope;
    const current = target === targets.Workspace ? config.inspect?.(key)?.workspaceValue : config.get(key, '');
    if (current !== value) {
      await config.update(key, value, target);
    }
  }
}

function localWorkspaceFolders() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.every(item => item.uri.scheme === 'file') ? folders.map(item => item.uri.fsPath) : null;
}

async function configuredTool(options = {}) {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const toolHome = options.toolHome || windowToolHome(config, localWorkspaceFolders());
  if (!toolHome) {
    vscode.window.showInformationMessage('请在 Nexus 侧栏初始化或连接这个工作区');
    return undefined;
  }
  const mode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
  const selected = await configuredRuntime(config, mode);
  if (!selected) return undefined;
  await applyRuntimeSelection(config, selected);
  const runtime = selected.runtime;
  const tool = { ...runtime, toolHome, env: installedToolEnvironment(toolHome) };
  if (options.writeDescriptor !== false) writeRuntimeDescriptor(tool);
  return tool;
}

async function syncWorkspaceTeamRules(tool, { runTool, state, extraArgs = [], confirm = false }) {
  const home = path.resolve(tool.toolHome);
  const key = 'guthon.teamSource.' + (process.platform === 'win32' ? home.toLowerCase() : home);
  const saved = state.get(key);
  let source;
  try {
    source = await workspaceTeamSource(vscode.window,
      saved || process.env.GUTHON_TEAM_MARKETPLACE_URL || installedSetupReport(tool.toolHome)?.marketplaceUrl);
  } catch (error) {
    await vscode.window.showErrorMessage(`团队仓库地址无效：${error.message}`);
    return false;
  }
  let completed = false;
  let terminalStarted = false;
  while (source) {
    const args = [...extraArgs, '--team-source', source];
    try {
      completed = await runTool(TOOL_COMMANDS.setup, args, confirm, '', null, undefined, tool);
      break;
    } catch (error) {
      if (error.code !== 'TEAM_GIT_AUTH_REQUIRED') throw error;
      const action = await vscode.window.showErrorMessage(
        '团队仓库需要 Git 认证或读取权限。可在终端完成认证和同步，也可更换仓库地址。',
        '在终端认证并同步', '更换仓库地址');
      if (action === '在终端认证并同步') {
        openTeamSyncTerminal(vscode.window, tool, args);
        terminalStarted = true;
        break;
      }
      if (action !== '更换仓库地址') return false;
      source = await workspaceTeamSource(vscode.window, source, true);
      confirm = false;
    }
  }
  if ((completed || terminalStarted) && source !== saved) {
    try {
      await state.update(key, source);
    } catch (error) {
      await vscode.window.showWarningMessage(`保存团队仓库地址失败：${error.message}`);
    }
  }
  return completed;
}

async function runToolCommand(
  processClient,
  command,
  extraArgs = [],
  askForConfirmation = true,
  workspaceKey = '',
  claimedRunRelease = null,
  stdinPayload = undefined,
  configuredToolOverride = undefined
) {
  const teamSync = command === TOOL_COMMANDS.setup && extraArgs.includes('--team-source');
  const databaseSync = command === 'sync-all';
  const label = teamSync && !askForConfirmation ? '团队规则同步' : TOOL_LABELS[command] || command;
  const release = claimedRunRelease || claimToolRun(command, workspaceKey);
  if (!release) return false;
  if (askForConfirmation) {
    const confirmed = await vscode.window.showWarningMessage(`确认${label}？`, { modal: true }, '执行');
    if (confirmed !== '执行') {
      release();
      return false;
    }
  }
  const tool = configuredToolOverride || await configuredTool();
  if (!tool) {
    release();
    return false;
  }
  const output = toolOutput();
  const modeLabel = {
    'source-development': '开发模式', script: '调试模式', packaged: '发行模式',
  }[tool.mode] || tool.mode;
  const execute = async (token, progress) => {
    const elapsed = operationTimer();
    if (databaseSync) output.show(true);
    output.appendLine(`运行：${command}${workspaceKey ? ` · ${workspaceKey}` : ''}（${modeLabel}）`);
    let pendingProgress = '';
    try {
      const result = await processClient.request(tool, command, extraArgs, workspaceKey, stdinPayload, {
        onOutput: (value) => {
          output.append(value);
          if (!databaseSync || !progress) return;
          const lines = (pendingProgress + value).split(/\r?\n/);
          pendingProgress = lines.pop();
          const latest = lines.map(line => /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[DATABASE\] (.+)$/.exec(line)?.[1])
            .filter(Boolean).at(-1);
          if (latest) progress.report({message:latest});
        },
        token,
      });
      if (teamSync && result.governance !== 'ready') {
        throw new Error('后端未确认团队规范同步完成，请更新 GuthonCodeTool 运行入口');
      }
      const summary = indexResultSummary(command, result);
      if (summary !== undefined) output.appendLine(summary);
      else if (result?.stdout) output.append(result.stdout);
      else output.appendLine(JSON.stringify(result, null, 2));
      output.appendLine(`GuthonCodeTool 完成：${command}`);
      if (teamSync && !askForConfirmation) vscode.window.showInformationMessage('团队规则和开发门禁已同步');
      else vscode.window.showInformationMessage(`GuthonCodeTool 完成：${command}`);
      return true;
    } catch (error) {
      const target = workspaceKey ? ` · ${workspaceKey}` : '';
      output.show(true);
      output.appendLine(`${label}${error.code === 'OPERATION_CANCELLED' ? '已取消' : '失败'}${target}（${modeLabel}）：${error.message}`);
      if (teamSync && error.code === 'TEAM_GIT_AUTH_REQUIRED') throw error;
      if (error.code === 'OPERATION_CANCELLED') vscode.window.showInformationMessage(`${label}已取消${target}。详情见“输出 → GuthonCodeTool”`);
      else vscode.window.showErrorMessage(`${label}失败${target}（${modeLabel}）：${error.message}。详情见“输出 → GuthonCodeTool”`);
      return false;
    } finally {
      output.appendLine(`本次命令完整耗时：${elapsed()}`);
    }
  };
  const progressExecute = () => command === 'reindex' || teamSync || databaseSync
    ? vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`${label}${workspaceKey ? ' · '+workspaceKey : ''}`,cancellable:command === 'reindex'}, (progress, token) => execute(token, progress))
    : execute();
  const pending = toolQueue.then(progressExecute, progressExecute);
  toolQueue = pending.catch(() => false);
  return pending.finally(release);
}

function configuredToolFromSettings() {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const toolHome = windowToolHome(config, localWorkspaceFolders());
  if (!hasWorkspaceConfigFiles(toolHome)) return undefined;
  try {
    const mode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
    const runtime = mode === 'source-development'
      ? resolveDevelopmentRuntime(config.get('developmentRoot', ''))
      : mode === 'script'
        ? resolveScriptRuntime(config.get('scriptPythonPath', ''), config.get('scriptToolPath', ''))
        : { mode: 'packaged', toolPath: resolvePackagedTool(config.get('toolPath', '')) };
    if (!runtime.toolPath || !fs.existsSync(runtime.toolPath)) return undefined;
    return { ...runtime, toolHome, env: installedToolEnvironment(toolHome) };
  } catch {
    return undefined;
  }
}


function activate(context) {
  const nexusBuild = require('./extension-build').registerExtensionBuild(vscode,context);
  const processClient = new ToolProcessClient();
  const runTool = (...args) => runToolCommand(processClient, ...args);
  const initialConfig = vscode.workspace.getConfiguration('gushenCompletion');
  if (initialConfig.get('executionMode', 'packaged') === 'development') {
    void initialConfig.update('executionMode', 'source-development', vscode.ConfigurationTarget.Global);
  }
  let referenceCatalog;
  const provider = createProvider(context, document => referenceCatalog?.data(document) || []);
  const selector = createDocumentSelector(SUPPORTED_LANGUAGES, SUPPORTED_SCHEMES);
  const disposable = vscode.languages.registerCompletionItemProvider(
    selector,
    provider,
    '.'
  );
  const hoverDisposable = vscode.languages.registerHoverProvider(
    selector,
    createHoverProvider(context)
  );
  const bridgeOutput = vscode.window.createOutputChannel('Guthon Bridge');
  toolOutput().appendLine(`已加载 Nexus ${nexusBuild.version} · ${nexusBuild.buildId}`);
  const workspaceRegistry = new WorkspaceRegistry(async (tool) => {
    const result = await processClient.request(tool, 'workspaces');
    return require('./workspace-registry').workspaceSnapshot(result);
  });
  const projectOverview=require('./project-overview').registerProjectOverview({vscode,context});
  let projectCard;
  const bridge = createBridgeProcess({
    scriptPath: resolveBridgeScript(context.extensionPath),
    getPort: () => vscode.workspace.getConfiguration('gushenCompletion').get('bridgePort', 17361),
    onOutput: (text) => bridgeOutput.append(text),
    onError: (error) => vscode.window.showErrorMessage(`Guthon Bridge 启动失败：${error.message}`),
    onExit: (code) => {
      if (code) vscode.window.showErrorMessage(`Guthon Bridge 已退出（退出码 ${code}），请查看输出面板`);
    },
    onStateChange: () => {void vscode.commands.executeCommand('setContext','gushenCompletion.bridgeRunning',bridge.isRunning());projectCard?.refresh();},
  });
  void vscode.commands.executeCommand('setContext','gushenCompletion.bridgeRunning',bridge.isRunning());
  const refreshToolData = () => {workspaceRegistry.invalidate();projectCard?.refresh();};
  const apiServices = activeApiServices = require('./api/activate').activateApi({vscode,context,getTool:async()=>configuredToolFromSettings(),processClient,
    getOutput:toolOutput,onUpdated:()=>projectCard?.refresh(),onStatus:(key,status)=>projectOverview.provider.updateSummary(key,status)});
  const allWorkspaces = async () => {
    const tool=configuredToolFromSettings();if(!tool)return [];
    return (await workspaceRegistry.getSnapshot(tool)).workspaces;
  };
  let refreshGeneration=0;
  const selection=new WindowWorkspaceSelection({getWorkspaces:allWorkspaces,state:context.workspaceState,
    getScope:()=>configuredToolFromSettings()?.toolHome || '',
    getFolders:()=> (vscode.workspace.workspaceFolders || []).map(item=>item.uri.fsPath),window:vscode.window,
    onChange:()=>{projectCard?.invalidate();void refreshApiWorkspaces();}});
  const scopedWorkspaces=async()=>{const selected=await selection.current();return selected?[selected]:[];};
  let legacyProjects;
  const loadLegacyProjects = () => legacyProjects ||= require('./legacy-project').registerLegacyProjects({
    vscode, context, getTool: configuredToolFromSettings, processClient, sourceTree: apiServices.sourceTree,
    getWorkspaces: allWorkspaces, getSelected: () => selection.current(), runTool, getOutput: toolOutput,
    databaseBridgeRequest: (home, route, payload) => bridge.request(home, route, payload),
    databasePublicationRequest: (home, route, payload) => bridge.request(home, route, payload),
    databasePublicationMode: async home => {
      if (!home || !bridge.isRunning()) return 'bridge-stopped';
      try { return (await bridge.request(home, '/databaseProcedureCapabilities')).mode === 'manual' ? 'manual' : 'closed'; }
      catch { return 'bridge-unreachable'; }
    },
    refreshProjects: async () => { workspaceRegistry.invalidate(); await refreshApiWorkspaces(); },
    onStatus: (key, status, workspace) => {
      projectOverview.provider.updateSummary(key, status);
      projectCard?.updateLegacyStatus(workspace,status);
    },
  });
  projectCard=require('./api/project-card').registerProjectCard({vscode,context,api:apiServices,getWorkspaces:scopedWorkspaces,
    onLegacyAction:(workspace,action)=>loadLegacyProjects().action(workspace,action),
    onLegacyLogin:(workspace,credentials)=>loadLegacyProjects().login(workspace,credentials),
    getDiagnostic:()=>projectOverview.provider.diagnostic(),getSetup:()=>projectOverview.provider.setup,onSummary:(key,status)=>projectOverview.provider.updateSummary(key,status)});
  function setSourceMenuContexts(workspace) {
    const mode=workspace?.sourceMode || (workspace?'api':'');
    const managed=workspace?.executionReady===true && workspace.configuration?.schemaVersion===3;
    const svnManifest=mode==='svn' && workspace.checkoutLayout==='manifest-working-copies'
      && workspace.executionReady===true;
    return Promise.all(Object.entries({
      currentSourceIsApi:mode==='api',
      currentProjectHasManagedSourceSettings:managed,
      currentProjectCanChooseSourceScope:mode==='api' || (managed && (mode==='database' || svnManifest)),
      currentSvnUsesManifest:svnManifest,
      currentSvnHasWorkingCopies:svnManifest && !!workspace.workingCopies?.length,
    }).map(([name,value])=>vscode.commands.executeCommand('setContext',`gushenCompletion.${name}`,value)));
  }
  const refreshApiWorkspaces = async()=>{
    const generation=++refreshGeneration;
    let snapshot,selected,tool;
    try {
      tool=configuredToolFromSettings();
      snapshot=tool?await workspaceRegistry.getSnapshot(tool):{workspaces:[],configErrors:[]};
      selected=await selection.current();
      if(generation!==refreshGeneration)return;
      const apiWorkspaces=snapshot.workspaces.filter(item=>!item.sourceMode || item.sourceMode==='api');
      const selectedApi=selected && (!selected.sourceMode || selected.sourceMode==='api');
      const folders = localWorkspaceFolders();
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const setup = tool ? undefined : workspaceSetupCard(folders, windowToolHome(config, folders));
      projectOverview.provider.setSnapshot(snapshot,selected?.workspaceKey || '',selection.diagnosticKey,setup);
      if (snapshot.workspaces.some(item => item.sourceMode === 'svn' && item.executionReady === true) ||
          (selected?.sourceMode === 'database' && selected.executionReady === true)) loadLegacyProjects();
      const legacyUpdate = legacyProjects?.sync(selected, snapshot.workspaces);
      apiServices.sourceTree.setProjectPresentation(selected,projectOverview.provider.diagnostic(),legacyProjects);
      await Promise.all([
        legacyUpdate,
        apiServices.syncWorkspaces(apiWorkspaces,selectedApi?selected.workspaceKey:''),
        vscode.commands.executeCommand('setContext','gushenCompletion.needsWorkspaceSetup',!!setup),
        vscode.commands.executeCommand('setContext','gushenCompletion.hasCurrentProject',!!selected),
        setSourceMenuContexts(selected),
      ]);
      if(generation!==refreshGeneration)return;
      await projectCard.refresh();
    } catch(error) {
      if(generation!==refreshGeneration)return;
      const key=error.workspaceKey || selected?.workspaceKey;
      if(snapshot && key)projectOverview.provider.setProjectError(key,error);
      else projectOverview.provider.setError(error, tool?.toolHome);
      apiServices.sourceTree.setSelectedWorkspace('');
      apiServices.sourceTree.setProjectPresentation(undefined,projectOverview.provider.diagnostic());
      await Promise.all([
        legacyProjects?.sync(undefined, []),
        vscode.commands.executeCommand('setContext','gushenCompletion.needsWorkspaceSetup',false),
        vscode.commands.executeCommand('setContext','gushenCompletion.hasCurrentProject',false),
        setSourceMenuContexts(undefined),
      ]);
      if(generation!==refreshGeneration)return;
      projectCard.invalidate();await projectCard.refresh();
    }
  };
  const refreshDeletedWorkspace = async (key,scope)=>{
    if(selection.syncScope()!==scope)return;
    refreshGeneration++;
    workspaceRegistry.invalidate();
    apiServices.editorState.workspaces.delete(key);
    const saved=selection.forgetDeleted(key);
    if(saved) {
      projectCard.clearSelection();
      apiServices.sourceTree.setSelectedWorkspace('');
      apiServices.sourceTree.setProjectPresentation(undefined,undefined,legacyProjects);
    }
    await Promise.all([saved,refreshApiWorkspaces()]);
  };
  const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders?.(() => { void refreshApiWorkspaces(); });
  if (foldersChanged) context.subscriptions.push(foldersChanged);
  // 排序方式变化时重建源码树，避免继续使用按旧顺序缓存的目录。
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration?.((event) => {
    if (!event.affectsConfiguration('gushenCompletion.sourceTreeOrder')) return;
    apiServices.sourceTree.invalidate();
    apiServices.sourceTree.refresh();
  }) || { dispose() {} });
  const updateCenter = createUpdateCenter({ vscode, context, bridge, processClient,
    getTool: configuredToolFromSettings, loadedVersion: nexusBuild.version, loadedBuildId: nexusBuild.buildId,
    isBusy: () => activeToolRuns.size > 0,
    setBusy: value => { applicationUpdateRunning = value; },
    refresh: () => projectCard?.refresh(),
    log: message => toolOutput().appendLine(message) });

  const refreshLocalWorkspaceViews = async () => {refreshToolData();apiServices.sourceTree.refresh();await refreshApiWorkspaces();projectCard.refresh();};
  const assistantClient = new ToolJsonClient({getTool:async()=>configuredToolFromSettings(),processClient});
  const selectWorkspace = (workspaceKey,options) => selection.select(workspaceKey || '',options);
  const {workspaceKeyFrom,projectMenuHandler,projectToolHandler,projectDiagnosisHandler}=require('./api/project-actions');
  const {assertWorkspaceSaved,deleteWorkspace}=require('./workspace-delete');
  const selectedToolCommand = command => projectToolHandler({vscode,selectWorkspace,runTool,command});
  const projectMenu = command => projectMenuHandler({vscode,selectWorkspace,command});
  const projectAction=require('./api/project-actions');
  const sourceMenuAction = (legacyAction,apiCommand) => async value=>{
    try {
      const workspace=await selectWorkspace(workspaceKeyFrom(value));
      if(!workspace)return;
      if(!workspace.sourceMode || workspace.sourceMode==='api') {
        if(apiCommand)return await vscode.commands.executeCommand(`gushenCompletion.${apiCommand}`,workspace.workspaceKey);
        return;
      }
      return await loadLegacyProjects().action(workspace,legacyAction);
    } catch(error) {return vscode.window.showErrorMessage(`项目操作失败：${error.message}`);}
  };
  context.subscriptions.push(
    ...['showProjectChecks','showProjectHistory','showProjectIndex'].map(command=>vscode.commands.registerCommand(`gushenCompletion.${command}`,async value=>{
      const workspace=await selectWorkspace(workspaceKeyFrom(value));
      if(!workspace)return;
      if(command==='showProjectChecks')return vscode.commands.executeCommand('gushenCompletion.runDoctor',workspace.workspaceKey);
      if(command==='showProjectIndex') {
        try {return await projectAction.showProjectIndex({vscode,workspace,client:assistantClient});}
        catch(error) {return vscode.window.showErrorMessage(`索引管理失败：${error.message}`);}
      }
      if(workspace.sourceMode && workspace.sourceMode!=='api')return loadLegacyProjects().action(workspace,'history');
      return projectAction.showProjectHistory({vscode,workspace});
    }))
  );
  referenceCatalog=new (require('./api/platform-reference').PlatformReferences)(apiServices);
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector,{
    async provideHover(document,position,token) {
      const range=document.getWordRangeAtPosition(position,/[$A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)+/);if(!range)return;
      const word=document.getText(range),version=document.version,language=document.languageId==='guthon-gss'?'java':document.languageId;
      const items=(await referenceCatalog.data(document)).filter(item=>item.apiPath===word&&item.language===language);
      if(!items.length || token?.isCancellationRequested || document.version!==version)return;
      return new vscode.Hover(new vscode.MarkdownString(items.map(item=>'**'+item.signature+'**\n\n'+item.officialDocumentation).join('\n\n---\n\n')),range);
    }
  }));
  apiServices.setSelectWorkspace(selectWorkspace);
  require('./api/navigation').createApiNavigation({vscode,context,api:apiServices,selectWorkspace,getWorkspaces:allWorkspaces,getTool:configuredToolFromSettings,bridge,
    locateLegacy:(workspace,identity)=>loadLegacyProjects().locate(workspace,identity),
    legacyDefinitions:(workspace,target,document)=>loadLegacyProjects().procedureDefinitionUris(workspace,target,document),
    legacyAction:(workspace,action)=>loadLegacyProjects().action(workspace,action)});
  void refreshApiWorkspaces().catch(error=>vscode.window.showErrorMessage(`API 工作区初始化失败：${error.message}`));
  function svnAction(action) {
    return async (value, explicitPath, remote) => {
      try {
        const uri = value?.resourceUri || value;
        const key = workspaceKeyFrom(value) || uri?.authority;
        const workspace = await selectWorkspace(key);
        const params = new URLSearchParams(uri?.query);
        const sourcePath = explicitPath || params.get('path');
        if (workspace?.sourceMode === 'svn') return await action(loadLegacyProjects(), workspace, sourcePath, remote, params, value);
      } catch (error) { return vscode.window.showErrorMessage(error.message); }
    };
  }
  const reviewSvnFile = action => svnAction((service, workspace, sourcePath, _remote, params) => {
    if (!sourcePath) return;
    const workingCopyId = params.get('workingCopyId');
    return service.review(workspace, action, { sourcePath, workingCopyIds: workingCopyId ? [workingCopyId] : undefined });
  });
  const reviewSvnChanges = action => svnAction((service, workspace, _path, _remote, _params, value) => {
    if (action === 'platform-save' && value?.guthonWorkingCopyIds === undefined) return service.action(workspace, 'upload');
    return service.review(workspace, action, { workingCopyIds: value?.guthonWorkingCopyIds, scopeLabel: value?.guthonLabel });
  });
  const toolCommands = [
    vscode.commands.registerCommand('gushenCompletion.openSvnDocument', async target => {
      try {
        const workspace = await selectWorkspace(target.workspaceKey);
        if (workspace?.sourceMode !== 'svn') throw new Error('请选择 SVN 项目');
        return await loadLegacyProjects().virtualFs.open(target);
      } catch (error) { return vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('gushenCompletion.openLocalPageEditor', async target => {
      try {
        const workspace=await selectWorkspace(target.workspaceKey);
        if(workspace?.sourceMode!=='svn')throw new Error('请选择 SVN 项目');
        return await loadLegacyProjects().editSvnPage(workspace,target.object);
      } catch(error) {return vscode.window.showErrorMessage(error.message);}
    }),
    vscode.commands.registerCommand('gushenCompletion.syncLegacySourceNode',async item=>{
      try {
        const workspace=await selection.current();
        if(!workspace || !['svn','database'].includes(workspace.sourceMode))throw new Error('请选择当前项目的源码节点');
        return await loadLegacyProjects().updateNode(workspace,item);
      } catch(error){return vscode.window.showErrorMessage(error.message);}
    }),
    vscode.commands.registerCommand('gushenCompletion.showSvnSourceInheritance',async item=>{
      try {return await loadLegacyProjects().showInheritance(item);}
      catch(error){return vscode.window.showErrorMessage(error.message);}
    }),
    vscode.commands.registerCommand('gushenCompletion.openDatabaseWorkcopy', async item => {
      try { return await loadLegacyProjects().openWorkcopy(item); }
      catch (error) { return vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('gushenCompletion.showDatabaseWorkcopyDiff', async item => {
      try { return await loadLegacyProjects().openWorkcopy(item,true); }
      catch (error) { return vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('gushenCompletion.showDatabaseProcedureCallers', async item => {
      try { return await loadLegacyProjects().databaseCallers(item); }
      catch (error) { return vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('gushenCompletion.openLegacyDocument', async item => {
      try { return await loadLegacyProjects().openLocal(item); }
      catch (error) { return vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('gushenCompletion.saveSvnToGuthon', reviewSvnChanges('platform-save')),
    vscode.commands.registerCommand('gushenCompletion.revertSvnChanges', reviewSvnChanges('revert')),
    vscode.commands.registerCommand('gushenCompletion.showSvnDiff', svnAction((service, workspace, sourcePath, remote) => service.diff(workspace, sourcePath, { remote }))),
    vscode.commands.registerCommand('gushenCompletion.openSvnConflictMerge', svnAction((service, workspace, sourcePath) => service.conflict(workspace, sourcePath))),
    vscode.commands.registerCommand('gushenCompletion.openSvnChangeInNexus', svnAction((service, w, path, _remote, params) => service.openSvnChange(w,path,params))),
    vscode.commands.registerCommand('gushenCompletion.revertSingleSvnChange', reviewSvnFile('revert')),
    vscode.commands.registerCommand('gushenCompletion.saveSelectedSvnNexusChanges', reviewSvnFile('platform-save')),
    vscode.commands.registerCommand('gushenCompletion.markSvnConflictResolved', svnAction((service, w, path) => path && service.resolveConflict(w,path))),
    vscode.commands.registerCommand('gushenCompletion.updateAllSvnChanges', svnAction((service, workspace, _path, _remote, params, value) => {
      const workingCopyId = params.get('workingCopyId');
      return service.updateRemote(workspace, '', value?.guthonWorkingCopyIds ?? (workingCopyId ? [workingCopyId] : undefined));
    })),
    vscode.commands.registerCommand('gushenCompletion.updateSingleSvnChange',svnAction((service,w,path,_remote,params)=>
      path && service.updateRemote(w,path,[params.get('workingCopyId')].filter(Boolean)))),
    vscode.commands.registerCommand('gushenCompletion.showSvnHistory', svnAction((service, w, path) => path && service.history(w,path))),
    vscode.commands.registerCommand('gushenCompletion.showSvnRawDiff', svnAction((service, w, path) => path && service.diff(w,path,{raw:true}))),
    vscode.commands.registerCommand('gushenCompletion.searchProjects',()=>projectOverview.provider.search()),
    vscode.commands.registerCommand('gushenCompletion.refreshProjects',async()=>{workspaceRegistry.invalidate();await refreshApiWorkspaces();}),
    vscode.commands.registerCommand('gushenCompletion.openProjectConfiguration',async(value='')=>{
      const tool=configuredToolFromSettings();if(!tool)return vscode.window.showErrorMessage('请先设置本地数据目录');
      const key=workspaceKeyFrom(value);
      const names=['guthon.json','products.yaml','projects.yaml','sync.yaml','datasource.yaml','source-tables.yaml','database-testing.yaml'];
      const files=names.map(name=>({label:name,file:path.join(tool.toolHome,'config',name)})).filter(item=>fs.existsSync(item.file));
      if(!files.length)return vscode.window.showErrorMessage('当前数据目录没有可检查的配置文件');
      const preferred=key.startsWith('products.')?'products.yaml':key.startsWith('projects.')?'projects.yaml':'';
      files.sort((a,b)=>Number(b.label===preferred)-Number(a.label===preferred));
      const selected=files.length===1?files[0]:await vscode.window.showQuickPick(files,{title:'检查当前工作空间配置',placeHolder:'修复后点击项目总览的刷新按钮'});
      if(selected)await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(selected.file)),{preview:false});
    }),
    vscode.commands.registerCommand('gushenCompletion.switchWorkspace',async(value='')=>{
      try {
        const key=typeof value==='string'?value:value?.workspaceKey || '';
        const diagnostic=key && projectOverview.provider.snapshot.configErrors.find(item=>item.workspaceKey===key);
        if(diagnostic)return await selection.inspectDiagnostic(key);
        return await selection.select(key,{switchWindow:true});
      }
      catch(error) {return vscode.window.showErrorMessage(`工作区切换失败：${error.message}`);}
    }),
    vscode.commands.registerCommand('gushenCompletion.projectMenuOpenCheckout',projectMenu('openApiCheckout')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSourceConnection',sourceMenuAction('connection','configureApiSource')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSourceScope',sourceMenuAction('scope','selectApiSystems')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuConfigureDatabaseDiagnosis',projectMenu('configureDatabaseDiagnosis')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuReferenceSettings',projectMenu('configureReferenceAssets')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuCheckSystemMenu',projectMenu('showApiSystemMenu')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSyncModuleParameters',projectMenu('syncModuleParameters')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSyncPlatformReferences',projectMenu('syncPlatformReferences')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuLogout',projectMenu('logoutApiSource')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSvnScope',sourceMenuAction('svn-scope')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSvnRemote',sourceMenuAction('svn-remote')),
    vscode.commands.registerCommand('gushenCompletion.projectMenuSvnLoginCache',sourceMenuAction('svn-login-cache')),
    vscode.commands.registerCommand('gushenCompletion.configureProject', async value => {
      try {
        const workspace=await selectWorkspace(workspaceKeyFrom(value));
        if(!workspace)return;
        if(workspace.sourceMode && workspace.sourceMode!=='api') {
          if(workspace.configuration?.format==='unified') {
            const document=await vscode.workspace.openTextDocument(vscode.Uri.file(workspace.configuration.path));
            return await vscode.window.showTextDocument(document,{preview:true});
          }
          return await vscode.commands.executeCommand('gushenCompletion.openProjectConfiguration',workspace.workspaceKey);
        }
        return await projectAction.showConfiguration({vscode,client:assistantClient,workspace});
      } catch(error) {return vscode.window.showErrorMessage(`项目设置失败：${error.message}`);}
    }),
    vscode.commands.registerCommand('gushenCompletion.showProjectActions', async () => {
      try {return await require('./api/project-actions').showProjectActions({vscode,getWorkspaces:scopedWorkspaces,bridge});}
      catch(error) {return vscode.window.showErrorMessage(`项目操作失败：${error.message}`);}
    }),
    vscode.commands.registerCommand('gushenCompletion.openOnboarding', () => onboarding.open()),
    vscode.commands.registerCommand('gushenCompletion.showDiagnosisHistory', async (workspaceValue = '') => {
      try {
        const key = workspaceKeyFrom(workspaceValue);
        const selected = await selectWorkspace(key);
        if (!selected) return;
        const {showDiagnosisHistory} = require('./diagnosis-history-view');
        return await showDiagnosisHistory({vscode, client: assistantClient, workspaceKey: selected.workspaceKey});
      } catch (error) {return vscode.window.showErrorMessage(`诊断历史读取失败：${error.message}`);}
    }),
    vscode.commands.registerCommand('gushenCompletion.showPullHistory', async (workspaceKey = '') => {
      try {
        const selected = await selectWorkspace(typeof workspaceKey === 'string' ? workspaceKey : workspaceKey?.guthonWorkspaceKey || workspaceKey?.workspaceKey || '');
        if (!selected) return;
        const {showPullHistory} = require('./pull-history-view');
        return await showPullHistory({vscode,client:assistantClient,workspaceKey:selected.workspaceKey,workspaceRoot:selected.root});
      } catch (error) {return vscode.window.showErrorMessage(`拉取历史读取失败：${error.message}`);}
    }),
    ...['archive', 'restore'].map((action) => vscode.commands.registerCommand(
      `gushenCompletion.${action}PullHistory`, async (workspaceValue = '') => {
        try {
          const key = typeof workspaceValue === 'string' ? workspaceValue : workspaceValue?.guthonWorkspaceKey || workspaceValue?.workspaceKey || '';
          const selected = await selectWorkspace(key);
          if (!selected) return;
          const {maintainPullHistory} = require('./pull-history-view');
          return await maintainPullHistory({vscode,client:assistantClient,workspaceKey:selected.workspaceKey,action});
        } catch (error) {return vscode.window.showErrorMessage(`拉取历史维护失败：${error.message}`);}
      }
    )),
    vscode.commands.registerCommand('gushenCompletion.selectExecutionMode', async (value = false) => {
      const selectEntry=value===true;
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const currentMode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
      const selected = await pickExecutionMode(currentMode, selectEntry);
      if (!selected) return;
      const folders = localWorkspaceFolders();
      const toolHome = windowToolHome(config, folders);
      const selectingPackagedForWindow = !selectEntry && selected.value === 'packaged' && (!toolHome || currentMode !== 'packaged');
      const directory = selectingPackagedForWindow ? toolHome || workspaceSetupCard(folders, toolHome).directory : '';
      const packagedPath = directory && packagedToolInDirectory(directory);
      const selection = await configuredRuntime(config, selected.value, {
        ...runtimeSelectionOptions(selected.value, selectEntry),
        ...(selectingPackagedForWindow ? { packagedPath, selectPackaged: !packagedPath } : {}),
        prepareScript: true, scriptStorageRoot: context.globalStorageUri.fsPath,
      });
      if (!selection) return;
      const runtime = selection.runtime;
      if (!selectEntry) selection.configuration.executionMode = runtime.mode;
      await applyRuntimeSelection(config, selection, folders?.length ? vscode.ConfigurationTarget.Workspace : undefined);
      await processClient.stop();
      if (toolHome) writeRuntimeDescriptor({ ...runtime, toolHome });
      if (toolHome && bridge.isRunning()) await bridge.restart({ ...runtime, toolHome });
      refreshToolData();
      apiServices.sourceTree.refresh();
      await refreshApiWorkspaces();
      return vscode.window.showInformationMessage(selectEntry ? '已更新当前入口' : `已切换为${selected.label}`);
    }),
    vscode.commands.registerCommand('gushenCompletion.restartDevelopmentToolHost', async () => {
      const mode = normalizeExecutionMode(vscode.workspace.getConfiguration('gushenCompletion').get('executionMode', 'packaged'));
      if (mode !== 'source-development') {
        return vscode.window.showInformationMessage('此命令仅用于开发模式');
      }
      await processClient.stop();
      if (bridge.isRunning()) {
        const currentTool = configuredToolFromSettings();
        if (currentTool) await bridge.restart(currentTool);
      }
      refreshToolData();
      await refreshApiWorkspaces();
      return vscode.window.showInformationMessage('开发 ToolHost 已切换到当前源码');
    }),
    vscode.commands.registerCommand('gushenCompletion.selectUpdateSource', async () => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      if (normalizeExecutionMode(config.get('executionMode', 'packaged')) === 'source-development') {
        return vscode.window.showInformationMessage('开发模式从当前 developmentRoot 本地源码构建插件；发行和调试模式可选择 GitHub/Gitee。');
      }
      const current = config.get('updateSource', 'gitee');
      const selected = await vscode.window.showQuickPick(
        Object.entries(UPDATE_SOURCES).map(([value, provider]) => ({
          label: provider.label,
          description: value === current ? '当前更新源' : '',
          value,
        })),
        { title: '选择 GuthonCodeTool 更新源' }
      );
      if (!selected || selected.value === current) return;
      await config.update('updateSource', selected.value, vscode.ConfigurationTarget.Global);
      refreshToolData();
      return vscode.window.showInformationMessage(`GuthonCodeTool 更新源已切换为 ${selected.label}`);
    }),
    vscode.commands.registerCommand('gushenCompletion.checkToolUpdate', () => updateCenter.open()),
    vscode.commands.registerCommand('gushenCompletion.rollbackToolUpdate', async () => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      if (activeToolRuns.size) {
        return vscode.window.showWarningMessage('当前有 GuthonCodeTool 或源码操作正在执行，请完成后再回退');
      }
      if (applicationUpdateRunning) {
        return vscode.window.showInformationMessage('GuthonCodeTool 更新或回退正在执行，本次点击已忽略');
      }
      const storageRoot = context.globalStorageUri.fsPath;
      const state = readUpdateState(storageRoot);
      const rollbackPath = resolvePackagedTool(state.previousPath || '');
      if (!rollbackPath || !state.previousVersion) {
        return vscode.window.showInformationMessage('暂无可回退的 GuthonCodeTool 版本');
      }
      const confirmed = await vscode.window.showWarningMessage(
        `确认回退到 GuthonCodeTool ${state.previousVersion}？`,
        { modal: true },
        '回退'
      );
      if (confirmed !== '回退') return false;
      applicationUpdateRunning = true;
      const bridgeWasRunning = bridge.isRunning();
      try {
        return await withUpdateLock(storageRoot, async () => {
          const currentState = readUpdateState(storageRoot);
          if (JSON.stringify(currentState) !== JSON.stringify(state)) throw new Error('确认期间更新状态已变化，请重新发起回退');
          await verifyExecutable(rollbackPath, state.previousVersion);
          if (bridgeWasRunning) await bridge.stop();
          await processClient.stop();
          const currentPath = resolvePackagedTool(config.get('toolPath', '')) || config.get('toolPath', '');
          const currentApplicationVersion = await detectCurrentVersion(context.extensionPath, storageRoot, currentPath);
          const previousState = state;
          writeUpdateState(storageRoot, {
            activeVersion: state.previousVersion,
            activePath: rollbackPath,
            previousVersion: currentApplicationVersion,
            previousPath: currentPath,
            source: state.source,
            updatedAt: new Date().toISOString(),
        });
        try {
          await config.update('toolPath', rollbackPath, runtimeConfigurationTarget(config, 'toolPath', vscode.ConfigurationTarget));
        } catch (error) {
          writeUpdateState(storageRoot, previousState);
          throw error;
        }
        const toolHome = windowToolHome(config, localWorkspaceFolders());
        const tool = { mode: 'packaged', toolPath: rollbackPath, toolHome };
        refreshToolData();
        try {
          apiServices.sourceTree.refresh();
          if (toolHome) writeRuntimeDescriptor(tool);
          if (bridgeWasRunning) bridge.start(tool);
          await refreshApiWorkspaces();
        } catch (error) {
          await vscode.window.showWarningMessage(`应用已回退，但运行状态刷新失败：${error.message}`);
        }
        return vscode.window.showInformationMessage(`GuthonCodeTool 已回退到 ${state.previousVersion}`);
        });
      } catch (error) {
        if (bridgeWasRunning && !bridge.isRunning()) {
          const currentTool = configuredToolFromSettings();
          if (currentTool) bridge.start(currentTool);
        }
        return vscode.window.showErrorMessage(`GuthonCodeTool 回退失败：${error.message}`);
      } finally {
        applicationUpdateRunning = false;
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.syncTeamRules', async () => {
      if (!vscode.workspace.isTrusted) return vscode.window.showErrorMessage('请先信任当前工作区，再同步团队规则');
      const tool = configuredToolFromSettings();
      if (!tool) return vscode.window.showInformationMessage('请先在 Nexus 初始化或连接当前工作空间');
      try {
        const config = await processClient.request(tool, 'configuration-info');
        if (config?.ok !== true || config.initialized !== true || config.mode !== 'unified') {
          throw new Error('当前数据目录需要可用的统一工作空间配置');
        }
        return await syncWorkspaceTeamRules(tool, { runTool, state: context.globalState });
      } catch (error) {
        return vscode.window.showErrorMessage(`团队规则同步失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.setupTool', async (action) => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const previousToolHome = config.get('toolHome', '');
      const folders = localWorkspaceFolders();
      const toolHome = windowToolHome(config, folders);
      let setup;
      try {
        const target = action !== 'browse' && (action === 'current' || !hasWorkspaceConfigFiles(toolHome))
          ? workspaceSetupCard(folders, toolHome) : undefined;
        setup = await prepareWorkspaceSetup(config, vscode.window, {
          toolHome, directory: target?.directory, workspaceDirectory: target?.workspaceDirectory,
          browse: action === 'browse',
        });
      } catch (error) {
        return vscode.window.showErrorMessage(error.message);
      }
      if (!setup) return;
      if (setup.mode === 'refresh') return refreshLocalWorkspaceViews();
      const binding = config.inspect?.('executionMode');
      const reuseSelection = setup.workspaceDirectory &&
        (binding?.workspaceFolderValue !== undefined || binding?.workspaceValue !== undefined);
      const selected = await initializationRuntime(config, setup.toolHome, context.globalStorageUri?.fsPath, reuseSelection);
      if (!selected) return;
      const tool = { ...selected.runtime, toolHome: setup.toolHome, env: installedToolEnvironment(setup.toolHome) };
      let workspaces;
      if (setup.mode === 'switch') {
        try {
          const result = await processClient.request(tool, 'workspaces');
          if (result?.ok !== true || !Array.isArray(result.workspaces)) {
            throw new Error('工作区列表无效：缺少 ok=true 或 workspaces 数组');
          }
          workspaces = result.workspaces;
        } catch (error) {
          return vscode.window.showErrorMessage(`读取已有工作空间失败：${error.message}`);
        }
      } else {
        if (!vscode.workspace.isTrusted) {
          return vscode.window.showErrorMessage('请先信任当前工作区，再初始化团队规则和开发门禁。');
        }
        const args = [];
        if (setup.workspaceDirectory && setup.workspaceDirectory !== 'var') {
          try {
            const capabilities = await processClient.request(tool, 'configuration-info');
            if (!path.isAbsolute(capabilities?.workspaceRoot || '')) {
              throw new Error('所选 GuthonCodeTool 后端版本不支持自定义开发目录');
            }
          } catch (error) {
            await vscode.window.showErrorMessage(`无法初始化当前开发目录：${error.message}`);
            return;
          }
          args.push('--workspace-directory', setup.workspaceDirectory);
        }
        const completed = await syncWorkspaceTeamRules(tool, { runTool, state: context.globalState, extraArgs: args, confirm: true });
        if (!completed) return;
      }
      try {
        if (previousToolHome !== tool.toolHome) {selection.clear();refreshGeneration++;projectCard?.invalidate();await apiServices.reset();await processClient.stop();}
        const localBinding = folders?.length && (setup.workspaceDirectory || !windowToolHome({get: () => tool.toolHome}, folders));
        const scope = localBinding ? vscode.ConfigurationTarget.Workspace : undefined;
        await applyRuntimeSelection(config, selected, scope);
        writeRuntimeDescriptor(tool);
        await config.update('toolHome', tool.toolHome, scope ?? runtimeConfigurationTarget(config, 'toolHome', vscode.ConfigurationTarget));
      } catch (error) {
        return vscode.window.showErrorMessage(`Nexus 保存工作空间配置失败：${error.message}`);
      }
      if (bridge.isRunning() && previousToolHome !== tool.toolHome) await bridge.restart(tool);
      await refreshLocalWorkspaceViews();
      if (!vscode.workspace.workspaceFolders?.length) {
        const next = await vscode.window.showInformationMessage(
          '数据目录已就绪。打开开发目录后即可添加或选择项目。', '打开开发目录'
        );
        if (next === '打开开发目录') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceRoot(tool.toolHome)), { forceReuseWindow: true });
        }
        return;
      }
      if (setup.mode === 'setup') {
        const next = await vscode.window.showInformationMessage(
          '工作区已初始化，团队规则和开发门禁已同步。是否现在添加第一个项目？',
          '立即添加',
          '稍后'
        );
        if (next === '立即添加') {
          return vscode.commands.executeCommand('gushenCompletion.addWorkspace');
        }
      }
      if (setup.mode === 'switch') {
        return vscode.window.showInformationMessage(`已读取 ${workspaces.length} 个工作区及其现有索引状态`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.addWorkspace', async () => {
      const tool = await configuredTool();
      if (!tool) return false;
      let definition;
      try {
        const configuration = await processClient.request(tool, 'configuration-info');
        definition = await promptWorkspaceCreation(vscode.window, configuration);
      } catch (error) {
        await vscode.window.showErrorMessage(`添加项目失败：${error.message}`);
        return false;
      }
      if (!definition) return false;
      const created = await runTool(
        TOOL_COMMANDS.workspaceCreate,
        [],
        false,
        '',
        null,
        definition,
        tool
      );
      if (!created) return false;
      refreshToolData();
      await refreshApiWorkspaces();

      const nextStep = {
        api: '请选择新项目，配置平台地址并登录。',
        svn: '请选择新项目，在当前项目卡片填写 SVN 地址并登录，再选择同步范围。',
        database: '请选择新项目，在当前项目卡片填写主数据连接并登录，再选择同步范围。',
      }[definition.sourceMode];
      vscode.window.showInformationMessage(`已添加「${definition.name}」 · ${definition.sourceMode.toUpperCase()}。${nextStep}`);
      return true;
    }),
    vscode.commands.registerCommand('gushenCompletion.openProjectDirectory', async value => {
      try {
        const workspace = await selectWorkspace(workspaceKeyFrom(value));
        if (workspace) await vscode.commands.executeCommand('gushenCompletion.openWorkspace', workspace.root);
      } catch (error) {
        await vscode.window.showErrorMessage(`无法打开项目目录：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.migrateProjectDocs', async () => {
      try {
        const { migrateProjectDocs } = require('./project-docs-migration');
        return await migrateProjectDocs({ vscode, getTool: configuredToolFromSettings,
          getCurrentWorkspace: () => selection.current(), workspace: await selection.current() });
      } catch (error) {
        return vscode.window.showErrorMessage(`项目文档迁移未完成：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.changeWorkspaceSourceMode', async value => {
      const tool = configuredToolFromSettings();
      if (!tool) return;
      const client = new ToolJsonClient({getTool:()=>tool,processClient});
      const {changeWorkspaceSourceMode,upgradeLegacyConfiguration}=require('./workspace-source-mode');
      let workspace,sourceMode;
      try {
        workspace=await selectWorkspace(workspaceKeyFrom(value));
        if(!workspace)return;
        const config=await client.run('','configuration-info');
        const currentMode=workspace.sourceMode || 'api';
        const legacyConfig=config.mode==='legacy' && ['svn','database'].includes(currentMode);
        const allowed=legacyConfig?['api']:config.workspaceSourceModes;
        if(!Array.isArray(allowed) || !allowed.some(mode=>mode!==currentMode)) {
          return vscode.window.showInformationMessage('请先将配置升级到支持三种同步方式的版本');
        }
        sourceMode=await pickWorkspaceSourceMode(vscode.window,allowed,currentMode);
        if(!sourceMode)return;
        const assertReady=async()=>{
          if(configuredToolFromSettings()?.toolHome!==tool.toolHome)throw new Error('数据目录已切换，请重新选择项目');
          if(activeToolRuns.size || applicationUpdateRunning)throw new Error('请等待当前工具操作完成后再切换');
          assertWorkspaceSaved(vscode,workspace,apiServices.editorState,legacyProjects);
          if(apiServices.editorState.workspaces.has(workspace.workspaceKey))await apiServices.editorState.flush(workspace.workspaceKey);
        };
        if(legacyConfig) {
          const offlineClient=new ToolJsonClient({getTool:()=>tool});
          if(!await upgradeLegacyConfiguration({vscode,client:offlineClient,workspace,assertReady}))return;
          workspaceRegistry.invalidate();
          workspace=await selectWorkspace(workspace.workspaceKey);
          if(!workspace)return;
        }
        const result=await changeWorkspaceSourceMode({vscode,workspace,sourceMode,assertReady,
          request:payload=>client.run('',TOOL_COMMANDS.workspaceSourceMode,[],payload)});
        if(!result?.changed) {
          if(legacyConfig)await refreshLocalWorkspaceViews();
          return;
        }
        apiServices.editorState.workspaces.delete(workspace.workspaceKey);
        await refreshLocalWorkspaceViews();
        if(result.retained?.length) {
          return vscode.window.showWarningMessage(`已切换到 API。以下旧文件未能移入废纸篓，可在确认后手动清理：\n${result.retained.join('\n')}`,{modal:true});
        }
        return vscode.window.showInformationMessage(`「${workspace.name}」的同步方式已改为 ${sourceMode.toUpperCase()}${result.trashPaths ? '。请重新登录、选择范围，再点击“更新源码”。' : ''}`);
      } catch(error) {
        if (['WORKSPACE_MODE_MIGRATION_REQUIRED','WORKSPACE_API_RESET_PATH_INVALID'].includes(error.code)
            && workspace?.sourceMode === 'svn' && sourceMode === 'api') {
          const action = '复制迁移预检命令';
          const chosen = await vscode.window.showWarningMessage(error.message, action);
          if (chosen === action) {
            const powershell = process.platform === 'win32';
            const quote = value => powershell ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
            const args = toolArguments(tool, 'svn-api-migration', ['preflight'], workspace.workspaceKey);
            await vscode.env.clipboard.writeText((powershell ? '& ' : '') + [tool.toolPath, ...args].map(quote).join(' '));
          }
        } else {
          await vscode.window.showErrorMessage(`修改同步方式失败：${error.message}`);
        }
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.deleteWorkspace', async (workspaceValue) => {
      const tool=configuredToolFromSettings();
      if(!tool)return;
      const scope=selection.syncScope();
      let workspace;
      try {workspace=await selectWorkspace(workspaceKeyFrom(workspaceValue));}
      catch(error) {return vscode.window.showErrorMessage(`无法选择项目：${error.message}`);}
      if(!workspace)return;
      const client=new ToolJsonClient({getTool:()=>tool,processClient});
      return deleteWorkspace({vscode,workspace,
        request:payload=>client.run('',TOOL_COMMANDS.workspaceDelete,[],payload),
        assertSaved:()=>assertWorkspaceSaved(vscode,workspace,apiServices.editorState,legacyProjects),
        assertTool:()=>{
          if(configuredToolFromSettings()?.toolHome!==tool.toolHome)throw new Error('数据目录已切换，请重新预览删除范围');
        },
        refresh:()=>refreshDeletedWorkspace(workspace.workspaceKey,scope)});
    }),
    vscode.commands.registerCommand('gushenCompletion.configureDatabaseDiagnosis', async (workspaceKey) => {
      if (typeof workspaceKey !== 'string' || !workspaceKey) {
        return vscode.window.showErrorMessage('请选择具体工作区后配置数据库排查');
      }
      let definition;
      try {
        definition = await promptDatabaseDiagnosis(vscode.window, workspaceKey, {
          listTargets: async (targetId) => {
            const result = await assistantClient.run(workspaceKey, 'database-target-list', ['--target-id', targetId]);
            if (result.workspaceKey !== workspaceKey || !Array.isArray(result.targets)) throw new Error('目标预检返回的工作区或目标列表无效');
            return result.targets;
          },
        });
      } catch (error) { return vscode.window.showErrorMessage(`数据库目标配置预检失败：${error.message}`); }
      if (!definition) return false;
      const completed = await runTool(
        TOOL_COMMANDS.databaseTargetConfigure,
        [],
        false,
        workspaceKey,
        null,
        definition
      );
      if (completed) refreshToolData();
      return completed;
    }),
    vscode.commands.registerCommand('gushenCompletion.startBridge', async () => {
      const tool = await configuredTool();
      if (!tool) return;
      try {
        bridge.start(tool);
        bridgeOutput.show(true);
        const status = await bridge.waitForReady(tool.toolHome);
        const action = await vscode.window.showInformationMessage(`Guthon Bridge 已启动：http://127.0.0.1:${status.port}`, '复制配对令牌');
        if (action === '复制配对令牌') await vscode.env.clipboard.writeText(bridge.pairingToken(tool.toolHome));
      } catch (error) {
        return vscode.window.showErrorMessage(`Guthon Bridge 启动失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.stopBridge', async () => {
      if (!await bridge.stop()) return vscode.window.showInformationMessage('Guthon Bridge 未运行');
      return vscode.window.showInformationMessage('Guthon Bridge 已停止');
    }),
    vscode.commands.registerCommand('gushenCompletion.exportMarkdown', selectedToolCommand(TOOL_COMMANDS.exportMarkdown)),
    vscode.commands.registerCommand('gushenCompletion.exportSchema', selectedToolCommand(TOOL_COMMANDS.exportSchema)),
    vscode.commands.registerCommand('gushenCompletion.exportBillTypes', selectedToolCommand(TOOL_COMMANDS.exportBillTypes)),
    vscode.commands.registerCommand('gushenCompletion.exportSystemScripts', selectedToolCommand(TOOL_COMMANDS.exportSystemScripts)),
    vscode.commands.registerCommand('gushenCompletion.exportViews', selectedToolCommand(TOOL_COMMANDS.exportViews)),
    vscode.commands.registerCommand('gushenCompletion.runDoctor', async (workspaceValue = '') => {
      const workspaceKey = typeof workspaceValue === 'string' ? workspaceValue : workspaceValue?.guthonWorkspaceKey || '';
      const release = claimToolRun(TOOL_COMMANDS.doctor, workspaceKey);
      if (!release) return;
      try {
        const tool = await configuredTool({writeDescriptor: false});
        if (!tool) return;
        const signature = () => {
          const settings = vscode.workspace.getConfiguration('gushenCompletion');
          return JSON.stringify(['executionMode', 'toolHome', 'toolPath', 'developmentRoot', 'scriptPythonPath', 'scriptToolPath']
            .map(key => settings.get(key, '')));
        };
        const runtime = signature(), {showEnvironmentCheck} = require('./environment-check');
        return await showEnvironmentCheck({vscode, workspaceKey,
          client: new ToolJsonClient({getTool: async () => tool, processClient}),
          isCurrent: () => signature() === runtime});
      } catch (error) { return vscode.window.showErrorMessage(`环境检查未完成：${error.message}`); }
      finally { release(); }
    }),
    vscode.commands.registerCommand('gushenCompletion.runDiagnosis', projectDiagnosisHandler({vscode,selectWorkspace,runTool,command:TOOL_COMMANDS.diagnose})),
    vscode.commands.registerCommand('gushenCompletion.expandProjectSource', async () => {
      return vscode.commands.executeCommand('gushenCompletion.sourceView.focus');
    }),
    vscode.commands.registerCommand('gushenCompletion.openWorkspace', (workspaceRoot) =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(workspaceRoot))),
    vscode.commands.registerCommand('gushenCompletion.refreshToolView', async () => {
      await refreshLocalWorkspaceViews();
    }),
    vscode.commands.registerCommand('gushenCompletion.editConfig', async (filename) => {
      const toolHome = windowToolHome(vscode.workspace.getConfiguration('gushenCompletion'), localWorkspaceFolders());
      if (!toolHome) return vscode.window.showErrorMessage('请先执行 “Guthon Nexus: 设置/切换工作空间”');
      const file = path.join(toolHome, 'config', filename);
      if (!fs.existsSync(file)) return vscode.window.showErrorMessage(`配置文件不存在：${file}。请先执行 “Guthon Nexus: 设置/切换工作空间”`);
      return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }),
    vscode.commands.registerCommand('gushenCompletion.openToolHome', () => {
      const toolHome = windowToolHome(vscode.workspace.getConfiguration('gushenCompletion'), localWorkspaceFolders());
      if (!toolHome) return vscode.window.showErrorMessage('请先执行 “Guthon Nexus: 设置/切换工作空间”');
      if (!fs.existsSync(toolHome)) {
        return vscode.window.showErrorMessage(`本地数据目录不存在：${toolHome}。请重新执行 “Guthon Nexus: 设置/切换工作空间” 选择现有目录`);
      }
      return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(toolHome));
    }),
  ];

  const onboarding = createOnboarding({ vscode, context, getTool: configuredToolFromSettings,
    client: assistantClient, bridge });
  const startEnvironmentBridge = async () => {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('gushenCompletion').get('autoStartBridge', false)) return;
    const tool = configuredToolFromSettings();
    if (!tool) return;
    writeRuntimeDescriptor(tool);
    bridge.start(tool);
    await bridge.waitForReady(tool.toolHome);
  };
  const initializeInstalledEnvironment = async () => {
    try { await startEnvironmentBridge(); }
    catch (error) { void vscode.window.showErrorMessage(`Guthon Bridge 自动启动失败：${error.message}`); }
    await onboarding.openIfNeeded();
  };
  const onboardingTrust = vscode.workspace.onDidGrantWorkspaceTrust?.(() => {
    void initializeInstalledEnvironment().catch(error => vscode.window.showErrorMessage(error.message));
  });
  context.subscriptions.push(
    disposable,
    hoverDisposable,
    projectCard,
    projectOverview,
    updateCenter,
    onboarding,
    ...(onboardingTrust ? [onboardingTrust] : []),
    bridgeOutput,
    bridge,
    processClient,
    { dispose: () => { toolOutputChannel?.dispose(); toolOutputChannel = null; } },
    ...toolCommands
  );
  void initializeInstalledEnvironment().catch(error => vscode.window.showErrorMessage(error.message));
}

async function deactivate() {const api=activeApiServices;activeApiServices=undefined;await api?.dispose();}

module.exports = {
  activate,
  createHoverProvider,
  createProvider,
  deactivate,
};
