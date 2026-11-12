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
const { prepareWorkspaceSetup, promptWorkspaceCreation, workspaceActions } = require('./tool-workspace');
const { promptDatabaseDiagnosis } = require('./database-config');
const { ToolJsonClient } = require('./tool-json-client');
const { workspaceCockpit } = require('./workspace-assistant');
const { createBridgeProcess, resolveBridgeScript } = require('./bridge-process');
const {
  normalizeExecutionMode, resolveDevelopmentRuntime, resolvePackagedTool, resolveScriptRuntime,
  writeRuntimeDescriptor, runtimeConfigurationTarget, installedToolEnvironment,
} = require('./tool-runtime');
const { ToolProcessClient } = require('./tool-process-client');
const { probeScriptRuntime } = require('./script-runtime');
const { createUpdateCenter } = require('./update-center');
const { createOnboarding } = require('./onboarding');
const {
  UPDATE_SOURCES,
  detectCurrentVersion,
  verifyExecutable,
  readUpdateState,
  writeUpdateState,
  withUpdateLock,
} = require('./tool-updater');
const { WorkspaceRegistry } = require('./workspace-registry');
const {isWorkspaceKey} = require('./workspace-identity');

const SUPPORTED_LANGUAGES = ['java', 'guthon-gss', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled', 'guthon-api-edit'];
const TOOL_COMMANDS = {
  setup: 'setup',
  workspaceCreate: 'workspace-create',
  workspaceDelete: 'workspace-delete',
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
const CONFIG_FILES = ['datasource.yaml', 'products.yaml', 'projects.yaml', 'sync.yaml', 'database-testing.yaml'];
const TOOL_LABELS = {
  setup: '设置工作空间',
  reindex: '重建索引',
  'export-markdown': '导出源码索引文档',
  'export-schema': '导出表结构',
  'export-bill-type': '导出单据类型',
  'export-system-script': '导出系统脚本',
  'export-view': '导出视图源码',
  doctor: '检查本地环境',
  diagnose: '执行源码逻辑排查',
  'workspace-create': '添加产品或项目',
  'workspace-delete': '删除产品或项目',
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
  const value = require('./api-completion').enrichCompletionData(mergeCompletionData(readJson(indexPath), manualData), readJson(officialDataPath));
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

function createProvider(context) {
  return {
    provideCompletionItems(document, position) {
      const lineText = document.lineAt(position.line).text;
      const currentWord = getCurrentWord(lineText, position.character);
      if (!shouldProvideApiCompletions(currentWord)) {
        return [];
      }
      const rules = loadRules(context);
      const languageId = document.languageId === 'guthon-gss' ? 'java' : document.languageId;
      const route = resolveRoute(rules, languageId, currentWord);
      const items = filterItems(loadData(context), route, currentWord);
      const range = completionRange(document, position, currentWord);

      return items.map((item) => toCompletionItem(item, range, route, currentWord));
    },
  };
}

function createDefinitionProvider(resolveDefinition = async()=>undefined) {
  return {provideDefinition:(document,position)=>resolveDefinition(document,position)};
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
    }
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
    if (config.get('developmentRoot', '') !== developmentRoot) {
      await config.update('developmentRoot', developmentRoot, runtimeConfigurationTarget(config, 'developmentRoot', vscode.ConfigurationTarget));
    }
    return runtime;
  } else if (mode === 'script') {
    let pythonPath = config.get('scriptPythonPath', '');
    let scriptPath = config.get('scriptToolPath', '');
    async function selectScriptFiles() {
      const python = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        title: '选择本地 Python 可执行文件',
      });
      if (!python) return false;
      pythonPath = python[0].fsPath;
      const script = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { 'GuthonCodeTool 调试脚本': ['pyz'] },
        title: '选择 GuthonCodeTool-python.pyz',
      });
      if (!script) return false;
      scriptPath = script[0].fsPath;
      return true;
    }
    if (options.selectScript && !await selectScriptFiles()) return undefined;
    try {
      runtime = resolveScriptRuntime(pythonPath, scriptPath);
    } catch (error) {
      if (options.selectScript) {
        vscode.window.showErrorMessage(error.message);
        return undefined;
      }
      if (!await selectScriptFiles()) return undefined;
      try {
        runtime = resolveScriptRuntime(pythonPath, scriptPath);
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return undefined;
      }
    }
    if (options.probeScript) {
      let probe;
      try {
        probe = await probeScriptRuntime(runtime);
      } catch (error) {
        const choice = await vscode.window.showErrorMessage(
          `调试环境不可用：${error.message}`, '重新选择 Python 和脚本'
        );
        if (choice === '重新选择 Python 和脚本' && !options.selectScript) {
          return configuredRuntime(config, mode, { ...options, selectScript: true });
        }
        return undefined;
      }
      if (probe.missingProviders.length) {
        const chosen = await vscode.window.showWarningMessage(
          `调试脚本 ${probe.version} 的核心功能可用，但部分功能依赖缺失：${probe.missingProviders.join('；')}`,
          { modal: true }, '继续使用核心功能'
        );
        if (chosen !== '继续使用核心功能') return undefined;
      }
    }
    if (config.get('scriptPythonPath', '') !== pythonPath) {
      await config.update('scriptPythonPath', pythonPath, runtimeConfigurationTarget(config, 'scriptPythonPath', vscode.ConfigurationTarget));
    }
    if (config.get('scriptToolPath', '') !== scriptPath) {
      await config.update('scriptToolPath', scriptPath, runtimeConfigurationTarget(config, 'scriptToolPath', vscode.ConfigurationTarget));
    }
    return runtime;
  } else {
    let toolPath = resolvePackagedTool(config.get('toolPath', ''));
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
          : '选择 GuthonCodeTool 可执行文件（应用目录内的 GuthonCodeTool）',
      });
      if (!selected) return undefined;
      const candidate = resolvePackagedTool(selected[0].fsPath);
      if (!candidate) {
        vscode.window.showErrorMessage('请选择 GuthonCodeTool 可执行文件：Windows 选择 EXE，macOS 选择应用目录内的 GuthonCodeTool 启动文件');
        return undefined;
      }
      toolPath = candidate;
      try {
        await verifyExecutable(toolPath);
      } catch (error) {
        vscode.window.showErrorMessage(`所选发行应用不可用：${error.message}`);
        return undefined;
      }
      await config.update('toolPath', toolPath, runtimeConfigurationTarget(config, 'toolPath', vscode.ConfigurationTarget));
    }
    return { mode: 'packaged', toolPath };
  }
}

async function configuredTool(options = {}) {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const mode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
  const runtime = await configuredRuntime(config, mode);
  if (!runtime) return undefined;
  let toolHome = options.toolHome || config.get('toolHome', '');
  if (!toolHome) {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 GuthonCodeTool 本地数据目录' });
    if (!selected) return undefined;
    toolHome = selected[0].fsPath;
    if (options.persistToolHome !== false) {
      await config.update('toolHome', toolHome, runtimeConfigurationTarget(config, 'toolHome', vscode.ConfigurationTarget));
    }
  }
  const tool = { ...runtime, toolHome, env: installedToolEnvironment(toolHome) };
  if (options.writeDescriptor !== false) writeRuntimeDescriptor(tool);
  return tool;
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
  const label = TOOL_LABELS[command] || command;
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
  const execute = async (token) => {
    const elapsed = operationTimer();
    output.appendLine(`运行：${command}${workspaceKey ? ` · ${workspaceKey}` : ''}（${modeLabel}）`);
    try {
      const result = await processClient.request(tool, command, extraArgs, workspaceKey, stdinPayload, {
        onOutput: (value) => output.append(value),
        token,
      });
      const summary = indexResultSummary(command, result);
      if (summary !== undefined) output.appendLine(summary);
      else if (result?.stdout) output.append(result.stdout);
      else output.appendLine(JSON.stringify(result, null, 2));
      output.appendLine(`GuthonCodeTool 完成：${command}`);
      vscode.window.showInformationMessage(`GuthonCodeTool 完成：${command}`);
      return true;
    } catch (error) {
      const target = workspaceKey ? ` · ${workspaceKey}` : '';
      output.show(true);
      output.appendLine(`${label}${error.code === 'OPERATION_CANCELLED' ? '已取消' : '失败'}${target}（${modeLabel}）：${error.message}`);
      if (error.code === 'OPERATION_CANCELLED') vscode.window.showInformationMessage(`${label}已取消${target}。详情见“输出 → GuthonCodeTool”`);
      else vscode.window.showErrorMessage(`${label}失败${target}（${modeLabel}）：${error.message}。详情见“输出 → GuthonCodeTool”`);
      return false;
    } finally {
      output.appendLine(`本次命令完整耗时：${elapsed()}`);
    }
  };
  const progressExecute = () => command === 'reindex'
    ? vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`${label}${workspaceKey ? ' · '+workspaceKey : ''}`,cancellable:true}, (_progress, token) => execute(token))
    : execute();
  const pending = toolQueue.then(progressExecute, progressExecute);
  toolQueue = pending.catch(() => false);
  return pending.finally(release);
}

function configuredToolFromSettings() {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const toolHome = config.get('toolHome', '');
  if (!toolHome || !fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'))) return undefined;
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

function toolItem(label, command, icon, description, args = []) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = { command, title: label, arguments: args };
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = description;
  return item;
}

function staticItem(label, icon, description) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = description;
  return item;
}

class ToolTreeDataProvider {
  constructor(bridge = { isRunning: () => false }, context, workspaceRegistry = new WorkspaceRegistry()) {
    this.bridge = bridge;
    this.context = context;
    this.workspaceRegistry = workspaceRegistry;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(element) {
    if (element) return element.children || [];
    const config = vscode.workspace.getConfiguration('gushenCompletion');
    const toolHome = config.get('toolHome', '');
    const executionMode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
    const developmentRoot = config.get('developmentRoot', '');
    const scriptToolPath = config.get('scriptToolPath', '');
    const updateSource = config.get('updateSource', 'gitee');
    const storageRoot = this.context.globalStorageUri.fsPath;
    const configuredToolPath = resolvePackagedTool(config.get('toolPath', ''));
    // Show the selected backend's actual version; source mode never overwrites the checkout.
    const applicationVersion = executionMode === 'packaged'
      ? await detectCurrentVersion(this.context.extensionPath, storageRoot, configuredToolPath).catch(() => '无法探测')
      : this.updates?.snapshot.current?.toolVersion || '待探测';
    const updateState = readUpdateState(storageRoot);
    const ready = toolHome && fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'));
    const workspace = new vscode.TreeItem('工作区', vscode.TreeItemCollapsibleState.Expanded);
    workspace.iconPath = new vscode.ThemeIcon(ready ? 'pass-filled' : 'warning');
    workspace.description = ready ? '已配置' : '未配置';
    const configFiles = new vscode.TreeItem('配置文件', vscode.TreeItemCollapsibleState.Collapsed);
    configFiles.iconPath = new vscode.ThemeIcon('settings-gear');
    configFiles.children = CONFIG_FILES
      .filter((filename) => filename !== 'database-testing.yaml' || fs.existsSync(path.join(toolHome, 'config', filename)))
      .map((filename) => toolItem(filename, 'gushenCompletion.editConfig', 'edit', undefined, [filename]));
    const runtime = new vscode.TreeItem('运行模式', vscode.TreeItemCollapsibleState.Collapsed);
    const modeLabel = {
      'source-development': '开发模式', script: '调试模式', packaged: '发行模式',
    }[executionMode] || '发行模式';
    const entryPath = executionMode === 'source-development'
      ? (developmentRoot ? path.join(developmentRoot, 'scripts', 'guthon_tool.py') : '')
      : executionMode === 'script' ? scriptToolPath : configuredToolPath;
    const entryItem = staticItem('当前入口', 'file-code', entryPath ? path.basename(entryPath) : '未配置');
    entryItem.tooltip = entryPath || '尚未选择工具入口';
    entryItem.command = { command: 'gushenCompletion.selectExecutionMode', title: '切换工具入口', arguments: [true] };
    const homeItem = staticItem('本地数据目录', 'folder', toolHome ? path.basename(toolHome) : '未配置');
    homeItem.tooltip = toolHome || '尚未选择本地数据目录';
    homeItem.command = { command: 'gushenCompletion.setupTool', title: '切换工作空间' };
    runtime.iconPath = new vscode.ThemeIcon(executionMode === 'packaged' ? 'package' : 'beaker');
    runtime.description = modeLabel;
    const update = this.updates?.snapshot;
    const checkUpdate = toolItem('检查更新', 'gushenCompletion.checkToolUpdate', 'sync',
      update?.count ? update.count + '项可更新' : update?.pending ? '待生效' : update?.unavailable ? '更新源待新版发行' : '');
    checkUpdate.tooltip = update?.error || update?.info || '检查后端、Nexus 与 Chrome Bridge 的版本';
    checkUpdate.children = [
      ...(update?.rows || []).map(item => staticItem(item.label, item.update ? 'cloud-download' : 'versions',
        (item.current || '未确认/未托管') + (item.target ? ' → ' + item.target : '') + (item.status ? ' · ' + item.status : ''))),
      ...(update?.error ? [staticItem('检查未完成', 'warning', update.error)] : []),
      ...(update?.info ? [staticItem('发行信息', 'info', update.info)] : []),
    ];
    checkUpdate.collapsibleState = checkUpdate.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    runtime.children = [
      toolItem(
        `切换模式：${modeLabel}`,
        'gushenCompletion.selectExecutionMode',
        executionMode === 'packaged' ? 'package' : 'beaker',
        executionMode === 'source-development'
          ? (path.basename(developmentRoot) || '源码仓库')
          : executionMode === 'script'
            ? (path.basename(scriptToolPath) || 'Release 脚本')
            : '打包应用'
      ),
      staticItem(`当前版本：${applicationVersion}`, 'tag'),
      entryItem,
      homeItem,
      executionMode === 'source-development' ? staticItem('更新源：本地源码', 'repo', path.basename(developmentRoot) || '未配置') : toolItem(
        `更新源：${UPDATE_SOURCES[updateSource]?.label || 'Gitee'}`,
        'gushenCompletion.selectUpdateSource',
        'cloud'
      ),
      checkUpdate,
      toolItem('检查谷神官方能力更新','gushenCompletion.checkOfficialUpdate','cloud-download'),
      toolItem('回退官方补全资源','gushenCompletion.rollbackOfficialUpdate','history'),
      toolItem(
        '回退到上一版本',
        'gushenCompletion.rollbackToolUpdate',
        'history',
        updateState.previousVersion ? `可回退到 ${updateState.previousVersion}` : '暂无可回退版本'
      ),
    ];
    workspace.children = [
      runtime,
      toolItem(
        ready ? '切换工作空间' : '设置工作空间',
        'gushenCompletion.setupTool',
        'folder-library',
        ready ? (path.basename(toolHome) || '已配置') : '选择本地数据目录'
      ),
      configFiles,
      toolItem('打开本地数据目录', 'gushenCompletion.openToolHome', 'folder-opened'),
    ].filter(Boolean);
    const projects = new vscode.TreeItem('项目', vscode.TreeItemCollapsibleState.Expanded);
    projects.iconPath = new vscode.ThemeIcon('folder-library');
    const tool = configuredToolFromSettings();
    try {
      const workspaces = tool ? await (this.listWorkspaces ? this.listWorkspaces() : this.workspaceRegistry.get(tool)) : [];
      projects.children = [toolItem(
        '添加产品或项目',
        'gushenCompletion.addWorkspace',
        'add',
        '创建 API 项目'
      ), ...workspaces.map((item) => {
        const actions = workspaceActions(item);
        const cockpit = workspaceCockpit(item);
        const node = new vscode.TreeItem(item.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        node.command = {
          command: 'gushenCompletion.expandProjectSource',
          title: '展开源码与索引',
        };
        node.description = `${item.id} · API · ${cockpit.description}`;
        node.iconPath = new vscode.ThemeIcon(cockpit.icon);
        node.contextValue = 'guthonWorkspace';
        node.guthonWorkspaceKey = item.workspaceKey;
        node.guthonDisplayName = item.displayName;
        const cockpitNode = new vscode.TreeItem(cockpit.label, vscode.TreeItemCollapsibleState.Expanded);
        cockpitNode.description = cockpit.description;
        cockpitNode.iconPath = new vscode.ThemeIcon(cockpit.icon);
        cockpitNode.children = cockpit.rows.map((row) => row.command
          ? toolItem(row.label, row.command, row.icon, row.description, [item.workspaceKey])
          : staticItem(row.label, row.icon, row.description));
        const source = new vscode.TreeItem('源码与索引', vscode.TreeItemCollapsibleState.Expanded);
        source.iconPath = new vscode.ThemeIcon('code');
        source.children = actions.source.map(([label, command, icon]) =>
          toolItem(label, command, icon, undefined, [item.workspaceKey]));
        const metadata = new vscode.TreeItem('配置资料', vscode.TreeItemCollapsibleState.Collapsed);
        metadata.iconPath = new vscode.ThemeIcon('server');
        metadata.children = actions.metadata.map(([label, command, icon]) =>
          toolItem(label, command, icon, undefined, [item.workspaceKey]));
        const syncItem = actions.syncAll
          ? toolItem(...actions.syncAll, undefined, [item.workspaceKey])
          : undefined;
        node.children = [
          cockpitNode,
          toolItem('检查此工作区环境', 'gushenCompletion.runDoctor', 'pulse', undefined, [item.workspaceKey]),
          syncItem,
          toolItem('打开工作区目录', 'gushenCompletion.openWorkspace', 'folder-opened', undefined, [item.root]),
          source,
          actions.metadata.length && metadata,
          actions.diagnose && toolItem('执行源码逻辑排查', 'gushenCompletion.runDiagnosis', 'search', undefined, [item.workspaceKey]),
          toolItem('查看最近诊断历史', 'gushenCompletion.showDiagnosisHistory', 'history', '只读元数据', [item.workspaceKey]),
        ].filter(Boolean);
        return node;
      })];
    } catch (error) {
      projects.children = [toolItem(`读取失败：${error.message}`, 'gushenCompletion.refreshToolView', 'error')];
    }
    const maintenance = new vscode.TreeItem('维护', vscode.TreeItemCollapsibleState.Expanded);
    maintenance.iconPath = new vscode.ThemeIcon('tools');
    maintenance.children = [
      toolItem('检查本地环境', 'gushenCompletion.runDoctor', 'pulse'),
    ];
    const bridge = new vscode.TreeItem('Guthon Bridge', vscode.TreeItemCollapsibleState.Expanded);
    const bridgeRunning = this.bridge.isRunning();
    bridge.iconPath = new vscode.ThemeIcon(bridgeRunning ? 'vm-running' : 'vm-outline');
    bridge.description = bridgeRunning ? '运行中 · 127.0.0.1:17361' : '未启动';
    bridge.children = [
      toolItem(
        bridgeRunning ? '停止 Guthon Bridge' : '启动 Guthon Bridge',
        bridgeRunning ? 'gushenCompletion.stopBridge' : 'gushenCompletion.startBridge',
        bridgeRunning ? 'debug-stop' : 'play'
      ),
    ];
    return [workspace, projects, bridge, maintenance];
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
  const provider = createProvider(context);
  const selector = createDocumentSelector(SUPPORTED_LANGUAGES, SUPPORTED_SCHEMES);
  const disposable = vscode.languages.registerCompletionItemProvider(
    selector,
    provider,
    '.'
  );
  let apiNavigation;
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    createDocumentSelector(['java','guthon-gss','javascript','sql'], ['file','untitled','guthon-api-edit']),
    createDefinitionProvider((document,position)=>apiNavigation?.definition(document,position))
  );
  const hoverDisposable = vscode.languages.registerHoverProvider(
    selector,
    createHoverProvider(context)
  );
  const bridgeOutput = vscode.window.createOutputChannel('Guthon Bridge');
  toolOutput().appendLine(`已加载 Nexus ${nexusBuild.version} · ${nexusBuild.buildId}`);
  const workspaceRegistry = new WorkspaceRegistry(async (tool) => {
    const result = await processClient.request(tool, 'workspaces');
    if (result?.ok !== true || !Array.isArray(result.workspaces)) {
      throw new Error('工作区列表无效：缺少 ok=true 或 workspaces 数组');
    }
    return result.workspaces;
  });
  let toolView;
  const bridge = createBridgeProcess({
    scriptPath: resolveBridgeScript(context.extensionPath),
    getPort: () => vscode.workspace.getConfiguration('gushenCompletion').get('bridgePort', 17361),
    onOutput: (text) => bridgeOutput.append(text),
    onError: (error) => vscode.window.showErrorMessage(`Guthon Bridge 启动失败：${error.message}`),
    onExit: (code) => {
      if (code) vscode.window.showErrorMessage(`Guthon Bridge 已退出（退出码 ${code}），请查看输出面板`);
    },
    onStateChange: () => toolView?.refresh(),
  });
  toolView = new ToolTreeDataProvider(bridge, context, workspaceRegistry);
  const toolViewDisposable = vscode.window.createTreeView('gushenCompletion.toolView', { treeDataProvider: toolView });
  let projectCard;
  const refreshToolData = () => {workspaceRegistry.invalidate();toolView.refresh();projectCard?.refresh();};
  const apiServices = activeApiServices = require('./api/activate').activateApi({vscode,context,getTool:async()=>configuredToolFromSettings(),processClient,
    onUpdated:()=>refreshToolData()});
  const scopedWorkspaces = async () => {
    const tool=configuredToolFromSettings();if(!tool) return [];
    const all=(await workspaceRegistry.get(tool)).filter(item=>item.sourceMode==='api');
    const folders=(vscode.workspace.workspaceFolders || []).map(item=>path.resolve(item.uri.fsPath));
    const matched=all.filter(item=>[item.root,item.checkoutPath].filter(Boolean).some(root=>folders.some(folder=>{
      const relative=path.relative(path.resolve(root),folder);
      return relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative));
    })));
    return matched.length ? matched : all;
  };
  toolView.listWorkspaces=scopedWorkspaces;
  projectCard=require('./api/project-card').registerProjectCard({vscode,context,api:apiServices,getWorkspaces:scopedWorkspaces});
  const refreshApiWorkspaces = async()=>apiServices.syncWorkspaces(await scopedWorkspaces());
  const updateCenter = createUpdateCenter({ vscode, context, bridge, processClient,
    getTool: configuredToolFromSettings, loadedVersion: nexusBuild.version, loadedBuildId: nexusBuild.buildId,
    isBusy: () => activeToolRuns.size > 0,
    setBusy: value => { applicationUpdateRunning = value; },
    refresh: () => toolView.refresh(), treeView: toolViewDisposable,
    log: message => toolOutput().appendLine(message) });
  toolView.updates = updateCenter;
  const refreshLocalWorkspaceViews = async () => {refreshToolData();apiServices.sourceTree.refresh();await refreshApiWorkspaces();projectCard.refresh();};
  const assistantClient = new ToolJsonClient({getTool:async()=>configuredToolFromSettings(),processClient});
  const selectWorkspace = async (workspaceKey = '') => {
    const workspaces=await scopedWorkspaces();
    if(workspaceKey) {const selected=workspaces.find(item=>item.workspaceKey===workspaceKey);if(!selected) throw new Error(`当前项目窗口找不到工作区：${workspaceKey}`);return selected;}
    const active=vscode.window.activeTextEditor?.document;
    if(active) for(const [key,state] of apiServices.editorState.workspaces) if(apiServices.editorState.documentPath(key,state,active)) {
      const selected=workspaces.find(item=>item.workspaceKey===key);if(selected) return selected;
    }
    if(workspaces.length===1) return workspaces[0];
    return (await vscode.window.showQuickPick(workspaces.map(item=>({label:item.displayName,description:item.workspaceKey,workspace:item})),{title:'选择当前项目'}))?.workspace;
  };
  apiServices.setSelectWorkspace(selectWorkspace);
  apiNavigation=require('./api/navigation').createApiNavigation({vscode,context,api:apiServices,selectWorkspace,getTool:configuredToolFromSettings,bridge});
  void refreshApiWorkspaces().catch(error=>vscode.window.showErrorMessage(`API 工作区初始化失败：${error.message}`));
  const toolCommands = [
    vscode.commands.registerCommand('gushenCompletion.openOnboarding', () => onboarding.open()),
    vscode.commands.registerCommand('gushenCompletion.showDiagnosisHistory', async (workspaceValue = '') => {
      try {
        const key = typeof workspaceValue === 'string' ? workspaceValue : workspaceValue?.guthonWorkspaceKey || workspaceValue?.workspaceKey || '';
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
    vscode.commands.registerCommand('gushenCompletion.selectExecutionMode', async (selectEntry = false) => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const currentMode = normalizeExecutionMode(config.get('executionMode', 'packaged'));
      const modes = [
        { label: '发行模式', description: '调用打包的 GuthonCodeTool 应用', value: 'packaged' },
        { label: '开发模式', description: '使用 clone 仓库中的 .venv 和源码', value: 'source-development' },
        { label: '调试模式', description: '使用本地 Python 和 Release 单文件 .pyz', value: 'script' },
      ];
      const selected = selectEntry
        ? modes.find((item) => item.value === currentMode)
        : await vscode.window.showQuickPick(modes, { title: '选择 Guthon Nexus 运行模式' });
      if (!selected) return;
      const runtime = await configuredRuntime(config, selected.value, {
        probeScript: true,
        probePackaged: true,
        selectScript: selectEntry,
        selectPackaged: selectEntry,
        selectDevelopment: selectEntry,
      });
      if (!runtime) return;
      await processClient.stop();
      if (!selectEntry) {
        await config.update('executionMode', selected.value, runtimeConfigurationTarget(config, 'executionMode', vscode.ConfigurationTarget));
      }
      const toolHome = config.get('toolHome', '');
      if (toolHome) writeRuntimeDescriptor({ ...runtime, toolHome });
      if (bridge.isRunning()) await bridge.restart({ ...runtime, toolHome });
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
        const toolHome = config.get('toolHome', '');
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
    vscode.commands.registerCommand('gushenCompletion.setupTool', async () => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const previousToolHome = config.get('toolHome', '');
      let setup;
      try {
        setup = await prepareWorkspaceSetup(config, vscode.window);
      } catch (error) {
        return vscode.window.showErrorMessage(error.message);
      }
      if (!setup) return;
      if (setup.mode === 'refresh') return refreshLocalWorkspaceViews();
      const tool = await configuredTool({
        toolHome: setup.toolHome,
        persistToolHome: false,
        writeDescriptor: false,
      });
      if (!tool) return;
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
        const completed = await runTool(TOOL_COMMANDS.setup, [], true, '', null, undefined, tool);
        if (!completed) return;
      }
      try {
        if (previousToolHome !== tool.toolHome) {await apiServices.reset();await processClient.stop();}
        writeRuntimeDescriptor(tool);
        await config.update('toolHome', tool.toolHome, runtimeConfigurationTarget(config, 'toolHome', vscode.ConfigurationTarget));
      } catch (error) {
        return vscode.window.showErrorMessage(`Nexus 保存工作空间配置失败：${error.message}`);
      }
      if (bridge.isRunning() && previousToolHome !== tool.toolHome) await bridge.restart(tool);
      await refreshLocalWorkspaceViews();
      if (setup.mode === 'setup') {
        const next = await vscode.window.showInformationMessage(
          '本地数据目录已初始化，是否现在添加第一个产品或项目？',
          '立即添加',
          '稍后'
        );
        if (next === '立即添加') {
          return vscode.commands.executeCommand('gushenCompletion.addWorkspace');
        }
      }
      if (setup.mode === 'switch') {
        return vscode.window.showInformationMessage(`已读取 ${workspaces.length} 个产品或项目及其现有索引状态`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.addWorkspace', async () => {
      const tool = await configuredTool();
      if (!tool) return false;
      let workspaces;
      try {
        workspaces = await workspaceRegistry.get(tool);
      } catch (error) {
        return vscode.window.showErrorMessage(`读取现有产品/项目失败：${error.message}`);
      }
      const definition = await promptWorkspaceCreation(vscode.window, workspaces, tool.toolHome);
      if (!definition) return false;
      const created = await runTool(
        TOOL_COMMANDS.workspaceCreate,
        [],
        false,
        '',
        null,
        definition
      );
      if (!created) return false;
      refreshToolData();
      await refreshApiWorkspaces();

      const nextStep = '请展开该 Nexus，配置项目地址、登录并选择子系统。';
      vscode.window.showInformationMessage(`${definition.name} Nexus 已创建。${nextStep}`);
      return true;
    }),
    vscode.commands.registerCommand('gushenCompletion.deleteWorkspace', async (workspaceValue) => {
      const workspaceKey = typeof workspaceValue === 'string'
        ? workspaceValue
        : workspaceValue?.guthonWorkspaceKey;
      if (!isWorkspaceKey(workspaceKey)) return vscode.window.showErrorMessage('请在具体产品或项目节点上执行删除');
      let plan;
      try {
        const state=await apiServices.sourceTree.status(workspaceKey);
        await apiServices.editorState.flush(workspaceKey);
        const registered=apiServices.editorState.workspaces.get(workspaceKey);
        if(apiServices.editorState.documents(workspaceKey,registered).some(item=>item.dirty)) throw new Error('该项目有未保存的编辑器或页面草稿，请先处理');
        plan=await assistantClient.run('',TOOL_COMMANDS.workspaceDelete,[],{checkOnly:true,workspaceKey});
        if(plan.workspaceKey!==workspaceKey || !Array.isArray(plan.paths) || plan.paths.some(p=>typeof p!=='string' || !path.isAbsolute(p))) throw new Error('删除预览身份或路径无效');
      } catch(error) {return vscode.window.showErrorMessage(`无法读取删除范围：${error.message}`);}
      const confirmed=await vscode.window.showWarningMessage(
        `确认删除 ${plan.displayName}（${workspaceKey}）？\n\n${plan.paths.join('\n')}\n\n目录将移入系统废纸篓，本地源码修改也会一并移走。`,{modal:true},'确认删除');
      if(confirmed!=='确认删除') return false;
      try {
        await apiServices.editorState.flush(workspaceKey);
        const registered=apiServices.editorState.workspaces.get(workspaceKey);
        if(apiServices.editorState.documents(workspaceKey,registered).some(item=>item.dirty)) throw new Error('确认后出现未保存的编辑器或页面草稿');
        for(const target of plan.paths) if(fs.existsSync(target)) await vscode.workspace.fs.delete(vscode.Uri.file(target),{recursive:true,useTrash:true});
      } catch(error) {return vscode.window.showErrorMessage(`删除已停止：${error.message}。配置尚未删除，已移入废纸篓的目录可恢复。`);}
      try {await assistantClient.run('',TOOL_COMMANDS.workspaceDelete,[],{checkOnly:false,workspaceKey});}
      catch(error) {return vscode.window.showErrorMessage(`目录已移入废纸篓，但配置删除失败：${error.message}。`);}
      refreshToolData();
      await refreshApiWorkspaces();
      return vscode.window.showInformationMessage(`已删除 ${plan.displayName}，相关目录可从系统废纸篓恢复。`);
    }),
    vscode.commands.registerCommand('gushenCompletion.configureDatabaseDiagnosis', async (workspaceKey) => {
      if (typeof workspaceKey !== 'string' || !workspaceKey) {
        return vscode.window.showErrorMessage('请从具体产品或项目下配置数据库排查');
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
    vscode.commands.registerCommand('gushenCompletion.exportMarkdown', (workspaceKey) => runTool(TOOL_COMMANDS.exportMarkdown, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportSchema', (workspaceKey) => runTool(TOOL_COMMANDS.exportSchema, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportBillTypes', (workspaceKey) => runTool(TOOL_COMMANDS.exportBillTypes, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportSystemScripts', (workspaceKey) => runTool(TOOL_COMMANDS.exportSystemScripts, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportViews', (workspaceKey) => runTool(TOOL_COMMANDS.exportViews, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.runDoctor', async (workspaceValue = '') => {
      const workspaceKey = typeof workspaceValue === 'string' ? workspaceValue : workspaceValue?.guthonWorkspaceKey || '';
      const release = claimToolRun(TOOL_COMMANDS.doctor, workspaceKey);
      if (!release) return;
      try {
        const tool = await configuredTool({writeDescriptor: false});
        if (!tool) return;
        const signature = () => {
          const settings = vscode.workspace.getConfiguration('gushenCompletion');
          return JSON.stringify(['executionMode', 'toolHome', 'toolPath', 'developmentRoot', 'scriptPythonPath', 'scriptToolPath', 'bridgePort']
            .map(key => settings.get(key, '')));
        };
        const runtime = signature(), {showEnvironmentCheck} = require('./environment-check');
        return await showEnvironmentCheck({vscode, workspaceKey,
          bridgePort: vscode.workspace.getConfiguration('gushenCompletion').get('bridgePort', 17361),
          client: new ToolJsonClient({getTool: async () => tool, processClient}),
          isCurrent: () => signature() === runtime});
      } catch (error) { return vscode.window.showErrorMessage(`环境检查未完成：${error.message}`); }
      finally { release(); }
    }),
    vscode.commands.registerCommand('gushenCompletion.runDiagnosis', async (workspaceKey) => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, title: '选择排查定义 JSON' });
      if (selected) return runTool(TOOL_COMMANDS.diagnose, [selected[0].fsPath], true, workspaceKey);
    }),
    vscode.commands.registerCommand('gushenCompletion.expandProjectSource', async () => {
      await vscode.commands.executeCommand('gushenCompletion.toolView.focus');
      return vscode.commands.executeCommand('list.expand');
    }),
    vscode.commands.registerCommand('gushenCompletion.openWorkspace', (workspaceRoot) =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(workspaceRoot))),
    vscode.commands.registerCommand('gushenCompletion.refreshToolView', async () => {
      await refreshLocalWorkspaceViews();
    }),
    vscode.commands.registerCommand('gushenCompletion.editConfig', async (filename) => {
      const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
      if (!toolHome) return vscode.window.showErrorMessage('请先执行 “Guthon Nexus: 设置/切换工作空间”');
      const file = path.join(toolHome, 'config', filename);
      if (!fs.existsSync(file)) return vscode.window.showErrorMessage(`配置文件不存在：${file}。请先执行 “Guthon Nexus: 设置/切换工作空间”`);
      return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }),
    vscode.commands.registerCommand('gushenCompletion.openToolHome', () => {
      const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
      return toolHome ? vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(toolHome)) : vscode.window.showErrorMessage('请先执行 “Guthon Nexus: 设置/切换工作空间”');
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
    definitionDisposable,
    hoverDisposable,
    toolViewDisposable,
    projectCard,
    updateCenter,
    onboarding,
    ...(onboardingTrust ? [onboardingTrust] : []),
    toolView.changed,
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
  createDefinitionProvider,
  createHoverProvider,
  createProvider,
  ToolTreeDataProvider,
  deactivate,
};
