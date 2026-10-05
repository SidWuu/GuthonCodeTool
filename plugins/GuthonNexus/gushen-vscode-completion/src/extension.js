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
const { procedureTargetAt, selectDefinitionPaths } = require('./definition');
const { prepareWorkspaceSetup, promptWorkspaceCreation, workspaceActions } = require('./tool-workspace');
const { promptDatabaseDiagnosis } = require('./database-config');
const { exportAiContext, validateContextResult } = require('./ai-context-export');
const { ToolJsonClient } = require('./tool-json-client');
const { searchPickItems, workspaceCockpit } = require('./workspace-assistant');
const { createBridgeProcess, resolveBridgeScript } = require('./bridge-process');
const {
  normalizeExecutionMode, resolveDevelopmentRuntime, resolvePackagedTool, resolveScriptRuntime,
  writeRuntimeDescriptor,
} = require('./tool-runtime');
const { ToolProcessClient } = require('./tool-process-client');
const { probeScriptRuntime } = require('./script-runtime');
const { createUpdateCenter } = require('./update-center');
const {
  UPDATE_SOURCES,
  detectCurrentVersion,
  verifyExecutable,
  readUpdateState,
  writeUpdateState,
  withUpdateLock,
} = require('./tool-updater');
const {
  filterWorkspacesBySourceMode,
  selectWorkspaceSourceMode,
  sourceModeLabel,
} = require('./source-mode');
const { WorkspaceRegistry } = require('./workspace-registry');
const { activateSvn, selectEditableIdentity, sourceModuleElement } = require('./svn/activate');
const { clearLegacyCredentials, promptForPassword } = require('./svn/credentials');
const {isWorkspaceKey} = require('./workspace-identity');
const { workspaceKeyFromSourceControlId } = require('./svn/scm-manager');
const {
  createSvnScopeInputFile,
  hasSvnScopeInput,
  removeSvnScopeInputFile,
  waitForEditorTabClose,
} = require('./svn/scope-input');

const SUPPORTED_LANGUAGES = ['java', 'guthon-gss', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled', 'guthon-svn-edit'];
const TOOL_COMMANDS = {
  setup: 'setup',
  workspaceCreate: 'workspace-create',
  workspaceDelete: 'workspace-delete',
  svnLoginConfigure: 'svn-login-configure',
  syncSourceAll: 'sync-source-all',
  syncSource: 'sync-source',
  syncAll: 'sync-all',
  reindex: 'reindex',
  exportMarkdown: 'export-markdown',
  exportSchema: 'export-schema',
  exportBillTypes: 'export-bill-type',
  exportSystemScripts: 'export-system-script',
  exportViews: 'export-view',
  doctor: 'doctor',
  diagnose: 'diagnose',
  workcopy: 'workcopy',
  svn: 'svn',
  sourceMode: 'source-mode',
  search: 'search',
  contextPack: 'context-pack',
  pullLog: 'pull-log',
  databaseTargetConfigure: 'database-target-configure',
};
const CONFIG_FILES = ['datasource.yaml', 'products.yaml', 'projects.yaml', 'source-tables.yaml', 'sync.yaml', 'database-testing.yaml'];
const TOOL_LABELS = {
  setup: '设置工作空间',
  'sync-source-all': '拉取源码重建索引',
  'sync-source': '拉取源码',
  'sync-all': '同步工作区全部资料',
  reindex: '重建索引',
  'export-markdown': '导出源码索引文档',
  'export-schema': '导出表结构',
  'export-bill-type': '导出单据类型',
  'export-system-script': '导出系统脚本',
  'export-view': '导出视图源码',
  doctor: '检查本地环境',
  diagnose: '执行源码逻辑排查',
  workcopy: '执行 Workcopy 操作',
  svn: 'SVN 检出/更新',
  'source-mode': '设置项目源码来源',
  'workspace-create': '添加产品或项目',
  'workspace-delete': '删除产品或项目',
  'svn-login-configure': '设置工作区 SVN 用户名',
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
    toolOutputChannel = vscode.window.createOutputChannel('GuthonCodeTool');
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
  const sourceCommands = new Set(['svn','init','reindex','sync-all','sync-source','sync-source-all','pull','source-mode','workspace-delete','export-schema','export-view','export-bill-type','export-system-script']);
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

function loadData(context) {
  const dataDir = path.join(context.extensionPath, 'data');
  const indexPath = path.join(dataDir, 'index.json');
  const manualDataPath = path.join(dataDir, 'manual.json');
  // 补全与悬停都会读取这份数据；按文件签名缓存，避免每次请求同步解析数百 KB JSON。
  const signature = [indexPath, manualDataPath]
    .map((file) => {
      try {
        const stats = fs.statSync(file);
        return `${stats.size}:${stats.mtimeMs}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
  if (completionDataCache?.signature === signature) return completionDataCache.value;
  const manualData = fs.existsSync(manualDataPath) ? readJson(manualDataPath) : {};
  const value = mergeCompletionData(readJson(indexPath), manualData);
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
  const completion = new vscode.CompletionItem(itemLabel(item), vscode.CompletionItemKind.Snippet);
  completion.detail = `${item.language}/${item.group}`;
  completion.documentation = new vscode.MarkdownString(itemDocumentation(item));
  completion.insertText = new vscode.SnippetString(itemBodyToSnippet(item.body));
  completion.range = range;
  completion.sortText = itemSortText(item, route, currentWord);
  completion.filterText = itemFilterText(item, currentWord);
  return completion;
}

function createProvider(context) {
  const data = loadData(context);

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
      const items = filterItems(data, route, currentWord);
      const range = completionRange(document, position, currentWord);

      return items.map((item) => toCompletionItem(item, range, route, currentWord));
    },
  };
}

function createDefinitionProvider() {
  return {
    async provideDefinition(document, position) {
      const target = procedureTargetAt(document.getText(), document.offsetAt(position));
      if (!target) return undefined;
      const pattern = `**/procedure/${target.alias}/${target.fun}/source.vm`;
      const uris = await vscode.workspace.findFiles(pattern, '**/.guthon-baseline/**');
      const selected = new Set(selectDefinitionPaths(uris.map((uri) => uri.fsPath), document.uri.fsPath));
      return uris.filter((uri) => selected.has(uri.fsPath))
        .map((uri) => new vscode.Location(uri, new vscode.Position(0, 0)));
    },
  };
}

function createHoverProvider(context) {
  const data = loadData(context);

  return {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(
        position,
        /[$A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)+/
      );
      if (!range) return undefined;

      const languageId = document.languageId === 'guthon-gss' ? 'java' : document.languageId;
      const items = findHoverItems(data, languageId, document.getText(range));
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
      await config.update('developmentRoot', developmentRoot, vscode.ConfigurationTarget.Global);
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
      await config.update('scriptPythonPath', pythonPath, vscode.ConfigurationTarget.Global);
    }
    if (config.get('scriptToolPath', '') !== scriptPath) {
      await config.update('scriptToolPath', scriptPath, vscode.ConfigurationTarget.Global);
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
        canSelectFiles: true, canSelectFolders: true, canSelectMany: false,
        title: '选择 GuthonCodeTool 应用（macOS 可选中解压出的 GuthonCodeTool 文件夹）',
      });
      if (!selected) return undefined;
      const candidate = resolvePackagedTool(selected[0].fsPath);
      if (!candidate) {
        vscode.window.showErrorMessage('所选路径不是 GuthonCodeTool 应用：请选择可执行文件，或包含它的 GuthonCodeTool 文件夹');
        return undefined;
      }
      toolPath = candidate;
      try {
        await verifyExecutable(toolPath);
      } catch (error) {
        vscode.window.showErrorMessage(`所选发行应用不可用：${error.message}`);
        return undefined;
      }
      await config.update('toolPath', toolPath, vscode.ConfigurationTarget.Global);
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
      await config.update('toolHome', toolHome, vscode.ConfigurationTarget.Global);
    }
  }
  const tool = { ...runtime, toolHome };
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
    output.appendLine(`运行：${command}${workspaceKey ? ` · ${workspaceKey}` : ''}（${modeLabel}）`);
    try {
      const result = await processClient.request(tool, command, extraArgs, workspaceKey, stdinPayload, {
        onOutput: (value) => output.append(value),
        token,
      });
      if (result?.stdout) output.append(result.stdout);
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
    return { ...runtime, toolHome };
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
      const workspaces = tool ? await this.workspaceRegistry.get(tool) : [];
      projects.children = [toolItem(
        '添加产品或项目',
        'gushenCompletion.addWorkspace',
        'add',
        '创建本地配置并选择源码来源'
      ), ...workspaces.map((item) => {
        const actions = workspaceActions(item);
        const cockpit = workspaceCockpit(item);
        const node = new vscode.TreeItem(item.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        node.command = {
          command: 'gushenCompletion.expandProjectSource',
          title: '展开源码与索引',
        };
        node.description = `${item.id} · ${item.sourceMode === 'svn' ? 'SVN' : '数据库'} · ${cockpit.description}`;
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
          toolItem(
            `源码来源：${sourceModeLabel(item.sourceMode)}`,
            'gushenCompletion.selectWorkspaceSourceMode',
            item.sourceMode === 'svn' ? 'repo' : 'database',
            '当前项目',
            [item.workspaceKey, item.sourceMode, item.root]
          ),
          item.sourceMode === 'svn' && toolItem(
            '设置工作区 SVN 登录',
            'gushenCompletion.setSvnCredentials',
            'key',
            '全工作区共用',
            [item.workspaceKey],
          ),
          item.sourceMode === 'svn' && item.capabilities?.['svn.initialize'] && toolItem(
            '导入/粘贴 SVN checkout 配置',
            'gushenCompletion.importSvnScope',
            'file-add',
            '支持多行粘贴',
            [item.workspaceKey],
          ),
          syncItem,
          item.sourceMode === 'svn' && item.scopeConfigPath && toolItem(
            '编辑 SVN 地址配置',
            'gushenCompletion.editSvnScope',
            'edit',
            item.scopeConfigReady ? '已配置' : '待配置',
            [item.workspaceKey]
          ),
          toolItem('打开工作区目录', 'gushenCompletion.openWorkspace', 'folder-opened', undefined, [item.root]),
          source,
          actions.metadata.length && metadata,
          actions.diagnose && toolItem('执行源码逻辑排查', 'gushenCompletion.runDiagnosis', 'search', undefined, [item.workspaceKey]),
          toolItem('查看最近诊断历史', 'gushenCompletion.showDiagnosisHistory', 'history', '只读元数据', [item.workspaceKey]),
          ...actions.workcopy.map(([label, command, icon]) =>
            toolItem(label, command, icon, undefined, [item.workspaceKey])),
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
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    createDocumentSelector(['java', 'guthon-gss'], ['file', 'untitled']),
    createDefinitionProvider()
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
  const listSvnWorkspaces = async () => {
    const tool = configuredToolFromSettings();
    if (!tool) return [];
    return filterWorkspacesBySourceMode(await workspaceRegistry.get(tool), 'svn');
  };
  const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
  void clearLegacyCredentials(context.secrets, toolHome).catch(() => {});
  const svnServices = activateSvn({
    vscode,
    context,
    getTool: async () => configuredToolFromSettings(),
    listSvnWorkspaces,
    invalidateWorkspaces: () => workspaceRegistry.invalidate(),
    processClient,
    bridge,
    onToolTreeChanged: () => toolView.refresh(),
    claimOperation: (workspaceKey, label) => claimToolRun(TOOL_COMMANDS.svn, workspaceKey, label),
  });
  const refreshToolData = () => {
    workspaceRegistry.invalidate();
    toolView.refresh();
  };
  const updateCenter = createUpdateCenter({ vscode, context, bridge, processClient,
    getTool: configuredToolFromSettings, loadedVersion: nexusBuild.version, loadedBuildId: nexusBuild.buildId,
    isBusy: () => activeToolRuns.size > 0,
    setBusy: value => { applicationUpdateRunning = value; },
    refresh: () => toolView.refresh(), treeView: toolViewDisposable,
    log: message => toolOutput().appendLine(message) });
  toolView.updates = updateCenter;
  const refreshLocalWorkspaceViews = async () => {
    refreshToolData();
    svnServices.catalogTree.refresh();
    await svnServices.refreshWorkspaceList();
  };
  const assistantClient = new ToolJsonClient({
    getTool: async () => configuredToolFromSettings(),
    processClient,
  });

  const copyAiContext = async (workspaceKey, identity, detailed = false) => {
    if (!workspaceKey || !identity?.sourceId) throw new Error('所选结果没有可定位的源码对象');
    const args = ['--source-id', identity.sourceId];
    if (identity.funId) args.push('--fun-id', identity.funId);
    if (identity.sourceNamespace) args.push('--source-namespace', identity.sourceNamespace);
    if (detailed) args.push('--detailed', '--limit', '12');
    const result = await assistantClient.run(workspaceKey, TOOL_COMMANDS.contextPack, args);
    validateContextResult(result, workspaceKey, identity);
    await vscode.env.clipboard.writeText(result.markdown);
    vscode.window.showInformationMessage(`${detailed ? '详细' : '精简'} AI 上下文已复制：${identity.sourceId}`);
    return result;
  };

  const selectWorkspace = async (workspaceKey = '', sourceMode = '') => {
    const tool = configuredToolFromSettings();
    if (!tool) throw new Error('请先配置 GuthonCodeTool');
    const allWorkspaces = await workspaceRegistry.get(tool);
    const workspaces = sourceMode
      ? filterWorkspacesBySourceMode(allWorkspaces, sourceMode)
      : allWorkspaces;
    if (workspaceKey) {
      const selected = workspaces.find((item) => item.workspaceKey === workspaceKey);
      if (!selected) throw new Error(`找不到工作区：${workspaceKey}`);
      return selected;
    }
    if (workspaces.length===1) return workspaces[0];
    return vscode.window.showQuickPick(workspaces.map((item) => ({
      label: item.displayName,
      description: `${item.workspaceKey} · ${sourceModeLabel(item.sourceMode)}`,
      workspace: item,
    })), { title: '选择统一搜索的工作区' }).then((item) => item?.workspace);
  };

  const saveAiContext = async (workspace, identity) => {
    const choices = [
      { label: '索引摘要', value: 'metadata', description: '保留精确源码身份与有界调用/事实，不读取正文' },
    ];
    if (workspace.sourceMode === 'svn' && ['page', 'procedure'].includes(identity.sourceType)) {
      choices.push({ label: '摘要与影响预览', value: 'impact', description: '加入当前索引中的有界表访问、字段关系或调用证据' });
      if (identity.sourceNamespace && (identity.sourceType === 'procedure' || (identity.jsonPointer && ['gss', 'vm', 'js', 'sql'].includes(identity.fragmentType)))) {
        choices.push({ label: '摘要、影响与继承上下文', value: 'inheritance', description: '显式读取当前片段最多 8000 字继承正文；不复制整 PAGE' });
      }
    }
    const selected = await vscode.window.showQuickPick(choices, { title: '选择 AI 上下文文件内容' });
    if (!selected) return undefined;
    const tool = configuredToolFromSettings();
    if (!tool) throw new Error('请先配置明确的本地数据目录');
    const result = await exportAiContext({
      client: assistantClient, backend: svnServices.backend, toolHome: tool.toolHome, workspace, identity,
      includeImpact: ['impact', 'inheritance'].includes(selected.value),
      includeInheritance: selected.value === 'inheritance',
    });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(result.artifactPath));
    await vscode.window.showTextDocument(document, { preview: true });
    const action = await vscode.window.showInformationMessage(`AI 上下文已导出：${result.artifactPath}`, '复制文件路径');
    if (action === '复制文件路径') await vscode.env.clipboard.writeText(result.artifactPath);
    return result;
  };

  const searchWorkspace = async (workspaceValue, sourceMode = '', exportOnly = false) => {
    const requestedKey = typeof workspaceValue === 'string' ? workspaceValue : '';
    const workspace = await selectWorkspace(requestedKey, sourceMode);
    if (!workspace) return undefined;
    const query = await vscode.window.showInputBox({
      title: `统一搜索 · ${workspace.displayName}`,
      prompt: '搜索源码名称、ID、函数、条件、赋值、异常、表读写或调用关系',
      value: vscode.window.activeTextEditor?.selection && !vscode.window.activeTextEditor.selection.isEmpty
        ? vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection).trim().slice(0,100) : '',
      validateInput: (value) => String(value || '').trim() ? undefined : '请输入搜索关键词',
    });
    if (!query) return undefined;
    const result = await assistantClient.run(
      workspace.workspaceKey,
      TOOL_COMMANDS.search,
      ['--query', query, '--limit', '30']
    );
    if (!result.items?.length) {
      return vscode.window.showInformationMessage(`未找到与“${query}”相关的本地索引结果`);
    }
    const selected = await vscode.window.showQuickPick(searchPickItems(result), {
      title: `统一搜索 · ${result.items.length} 条结果`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) return undefined;
    if (exportOnly) return saveAiContext(workspace, selected.item.identity);
    const action = await vscode.window.showQuickPick([
      { label: '打开源码', value: 'open', description: selected.item.filePath || selected.item.identity?.sourcePath || '' },
      { label: '复制精简 AI 上下文', value: 'context', description: '定位、关键关系和最多 5 条高价值事实' },
      { label: '复制详细 AI 上下文', value: 'context-detailed', description: '用于需要更多调用关系和事实的深入分析' },
      { label: '导出 AI 上下文文件', value: 'context-file', description: '保存到当前私有工作区 context/ai，提供绝对路径' },
    ], { title: selected.label });
    if (!action) return undefined;
    if (action.value === 'context-file') return saveAiContext(workspace, selected.item.identity);
    if (action.value === 'context') {
      return copyAiContext(workspace.workspaceKey, selected.item.identity);
    }
    if (action.value === 'context-detailed') {
      return copyAiContext(workspace.workspaceKey, selected.item.identity, true);
    }
    if (workspace.sourceMode === 'svn' && selected.item.identity?.sourceType) {
      const identity = await selectEditableIdentity(vscode, svnServices.backend, {
        workspaceKey: workspace.workspaceKey,
        ...selected.item.identity,
      });
      return svnServices.virtualFs.open(
        identity,
        selected.item.line > 0 ? { lineNumber: selected.item.line } : {}
      );
    }
    if (!selected.item.filePath) throw new Error('该结果没有可打开的本地文件');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.item.filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    if (selected.item.line > 0) {
      const line = Math.min(selected.item.line - 1, Math.max(0, document.lineCount - 1));
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0));
    }
    return editor;
  };
  const toolCommands = [
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
    vscode.commands.registerCommand('gushenCompletion.searchWorkspace', async (workspaceKey) => {
      try {
        return await searchWorkspace(workspaceKey);
      } catch (error) {
        return vscode.window.showErrorMessage(`统一搜索失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.searchCurrentSvnWorkspace', async () => {
      try {
        return await searchWorkspace(svnServices.selectedWorkspaceKey(), 'svn');
      } catch (error) {
        return vscode.window.showErrorMessage(`统一搜索失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.exportAiContext', async (element) => {
      try {
        const source = sourceModuleElement(element);
        if (!source?.object) {
          return await searchWorkspace(typeof element === 'string' ? element : element?.guthonWorkspaceKey || element?.workspaceKey || '', '', true);
        }
        const workspace = await selectWorkspace(source.workspaceKey);
        if (!workspace) return;
        const identity = {
          ...source.object,
          workingCopyId: source.object.workingCopyId || source.object.scopeEntryId || '',
          ...(element?.fragment ? { jsonPointer: element.fragment.jsonPointer || '', fragmentType: element.fragment.scriptType || '' } : {}),
        };
        return await saveAiContext(workspace, identity);
      } catch (error) { return vscode.window.showErrorMessage(`AI 上下文导出失败：${error.message}`); }
    }),
    vscode.commands.registerCommand('gushenCompletion.copySvnAiContext', async (element) => {
      try {
        const sourceElement = sourceModuleElement(element);
        if (!sourceElement?.object) throw new Error('请选择一个 SVN 源码对象或其子节点');
        return await copyAiContext(sourceElement.workspaceKey, sourceElement.object);
      } catch (error) {
        return vscode.window.showErrorMessage(`生成 AI 上下文失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.setSvnCredentials', async (workspaceKey) => {
      let selectedWorkspaceKey = typeof workspaceKey === 'string' ? workspaceKey : '';
      if (!selectedWorkspaceKey) {
        const selected = await vscode.window.showQuickPick(
          (await listSvnWorkspaces()).map((item) => ({
            label: item.displayName,
            description: item.workspaceKey,
            workspaceKey: item.workspaceKey,
          })),
          { title: '选择用于保存公共 SVN 登录的工作区' }
        );
        if (!selected) return;
        selectedWorkspaceKey = selected.workspaceKey;
      }
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === selectedWorkspaceKey);
      if (!workspace) return vscode.window.showErrorMessage(`未找到 SVN 项目：${selectedWorkspaceKey}`);
      const username = await vscode.window.showInputBox({
        title: '设置当前本地数据工作区的 SVN 登录',
        prompt: '公共 SVN 用户名（全部产品和项目共用）',
        value: workspace.svnUsername || '',
        ignoreFocusOut: true,
        validateInput: (value) => String(value || '').trim() ? undefined : '用户名不能为空',
      });
      if (username === undefined) return;
      const usernameConfigured = await runTool(
        TOOL_COMMANDS.svnLoginConfigure,
        [],
        false,
        '',
        null,
        { username: username.trim() }
      );
      if (!usernameConfigured) return false;
      refreshToolData();
      await svnServices.refreshWorkspaceList();
      if (!workspace.scopeConfigReady && !workspace.checkoutScriptReady) {
        return vscode.window.showInformationMessage(
          '公共 SVN 用户名已保存。请先导入/粘贴 checkout 配置，再次点击此入口保存密码。'
        );
      }
      const password = await promptForPassword(vscode.window);
      if (!password) return;
      try {
        await svnServices.backend.cacheAuthentication(selectedWorkspaceKey, password);
      } catch (error) {
        return vscode.window.showErrorMessage(`SVN 登录保存失败：${error.message}`);
      }
      return vscode.window.showInformationMessage(
        '公共 SVN 用户名已更新，密码已由 SVN 系统保存。'
      );
    }),
    vscode.commands.registerCommand('gushenCompletion.quickOpenSvnSource', async (workspaceKey='') => {
      const {quickOpenSource}=require('./svn/quick-open');
      try {
        return await quickOpenSource({vscode,listWorkspaces:listSvnWorkspaces,workspaceKey,
          search:(key,keyword)=>assistantClient.run(key,TOOL_COMMANDS.search,['--query',keyword,'--limit','30']),
          open:async(identity)=>svnServices.virtualFs.open(await selectEditableIdentity(vscode,svnServices.backend,identity))});
      } catch(error){return vscode.window.showErrorMessage(error.message);}
    }),
    vscode.commands.registerCommand('gushenCompletion.selectWorkspaceSourceMode', async (
      workspaceKey,
      currentMode
    ) => {
      if (!isWorkspaceKey(workspaceKey)) return vscode.window.showErrorMessage('请在具有明确工作区键的产品或项目节点上切换源码模式');
      const selected = await selectWorkspaceSourceMode(vscode.window, currentMode, async (current, next) => {
        if (current !== 'svn' || next !== 'database') return true;
        const dirtyDocuments = vscode.workspace.textDocuments.filter(
          (document) => document.uri.scheme === 'guthon-svn-edit'
            && document.uri.authority === workspaceKey
            && document.isDirty
        );
        if (dirtyDocuments.length) {
          const confirmed = await vscode.window.showWarningMessage(
            `有 ${dirtyDocuments.length} 个 SVN 虚拟文档尚未保存到本地 checkout。`,
            { modal: true },
            '保存并切换'
          );
          if (confirmed !== '保存并切换') return false;
          for (const document of dirtyDocuments) {
            if (!await document.save()) return false;
          }
        }
        const workspace = (await listSvnWorkspaces()).find(
          (item) => item.workspaceKey === workspaceKey && item.workingCopies?.length
        );
        if (!workspace) return true;
        let status;
        try {
          status = await svnServices.scm.refresh(workspace);
        } catch (error) {
          await vscode.window.showWarningMessage(
            `无法确认 ${workspaceKey} 的 SVN 修改状态，可能有更新、保存或放弃操作正在执行。\n${error.message}`,
            { modal: true }
          );
          return false;
        }
        const count = status.changes?.length || 0;
        if (!count) return true;
        const confirmed = await vscode.window.showWarningMessage(
          `当前项目仍有 ${count} 个 SVN 本地变更。改为 DATABASE 后不会删除 checkout，但该项目将不再显示为 SVN SCM provider。`,
          { modal: true },
          '切换并保留修改'
        );
        return confirmed === '切换并保留修改';
      });
      if (!selected) return;
      if (!await runTool(TOOL_COMMANDS.sourceMode, ['set', '--mode', selected], false, workspaceKey)) return;
      refreshToolData();
      await svnServices.refreshWorkspaceList();
      return vscode.window.showInformationMessage(
        `已将 ${workspaceKey} 设为 ${selected === 'svn' ? 'SVN' : 'DATABASE'}。请在该 Nexus 节点中继续配置。`
      );
    }),
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
        await config.update('executionMode', selected.value, vscode.ConfigurationTarget.Global);
      }
      const toolHome = config.get('toolHome', '');
      if (toolHome) writeRuntimeDescriptor({ ...runtime, toolHome });
      if (bridge.isRunning()) await bridge.restart({ ...runtime, toolHome });
      refreshToolData();
      svnServices.catalogTree.refresh();
      await svnServices.refreshWorkspaceList();
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
      await svnServices.refreshWorkspaceList();
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
        return vscode.window.showWarningMessage('当前有 GuthonCodeTool 或 SVN 操作正在执行，请完成后再回退');
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
          await config.update('toolPath', rollbackPath, vscode.ConfigurationTarget.Global);
        } catch (error) {
          writeUpdateState(storageRoot, previousState);
          throw error;
        }
        const toolHome = config.get('toolHome', '');
        const tool = { mode: 'packaged', toolPath: rollbackPath, toolHome };
        refreshToolData();
        try {
          svnServices.catalogTree.refresh();
          if (toolHome) writeRuntimeDescriptor(tool);
          if (bridgeWasRunning) bridge.start(tool);
          await svnServices.refreshWorkspaceList();
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
        if (previousToolHome !== tool.toolHome) await processClient.stop();
        writeRuntimeDescriptor(tool);
        await config.update('toolHome', tool.toolHome, vscode.ConfigurationTarget.Global);
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
      await svnServices.refreshWorkspaceList();

      const nextStep = definition.sourceMode === 'svn'
        ? '请展开该 Nexus，再设置 SVN 登录、导入/粘贴 checkout 配置或编辑 SVN 地址。'
        : '请后续在配置文件中补充 datasource 后再拉取源码。';
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
        plan = await assistantClient.run('', TOOL_COMMANDS.workspaceDelete, [], {
          mode: 'preview',
          workspaceKey,
        });
      } catch (error) {
        return vscode.window.showErrorMessage(`无法读取删除范围：${error.message}`);
      }
      const existingDirectories = (plan.directories || []).filter((item) => item.exists);
      const details = [
        `配置：${plan.workspaceConfigPath}`,
        plan.datasourceIds?.length ? `独占数据源：${plan.datasourceIds.join('、')}` : '独占数据源：无',
        plan.databaseTestingConfigured ? '数据库排查配置：将删除当前工作区条目' : '数据库排查配置：无',
        ...existingDirectories.map((item) => `${item.label}：${item.path}`),
      ].join('\n');
      const docsWarning = plan.kind === 'projects' && plan.docsHasFiles
        ? '\n\n项目 docs 目录中存在文件，请检查是否需要备份。'
        : '';
      const confirmed = await vscode.window.showWarningMessage(
        `确认删除 ${plan.displayName}（${workspaceKey}）？\n\n${details}${docsWarning}\n\n目录将移入系统废纸篓；未提交的本地源码修改也会一并移走。其他产品、项目和共享配置不会删除。`,
        { modal: true },
        '确认删除'
      );
      if (confirmed !== '确认删除') return false;
      try {
        for (const item of existingDirectories) {
          await vscode.workspace.fs.delete(vscode.Uri.file(item.path), {
            recursive: true,
            useTrash: true,
          });
        }
      } catch (error) {
        return vscode.window.showErrorMessage(
          `删除已停止：无法把相关目录移入系统废纸篓（${error.message}）。配置尚未删除；已移入废纸篓的目录可恢复。`
        );
      }
      try {
        await assistantClient.run('', TOOL_COMMANDS.workspaceDelete, [], {
          mode: 'delete',
          workspaceKey,
          confirmation: workspaceKey,
        });
      } catch (error) {
        return vscode.window.showErrorMessage(
          `目录已移入系统废纸篓，但配置删除失败：${error.message}。配置仍保留，可直接重试删除；已移入废纸篓的目录无需先恢复。`
        );
      }
      refreshToolData();
      await svnServices.refreshWorkspaceList();
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
    vscode.commands.registerCommand('gushenCompletion.initSourceIndex', (workspaceKey) => runTool(TOOL_COMMANDS.syncSourceAll, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.syncWorkspaceSource', (workspaceKey) => runTool(TOOL_COMMANDS.syncSource, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.syncWorkspaceAll', (workspaceKey) => runTool(TOOL_COMMANDS.syncAll, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.reindexCalls', (workspaceKey) => runTool(TOOL_COMMANDS.reindex, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportMarkdown', (workspaceKey) => runTool(TOOL_COMMANDS.exportMarkdown, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportSchema', (workspaceKey) => runTool(TOOL_COMMANDS.exportSchema, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportBillTypes', (workspaceKey) => runTool(TOOL_COMMANDS.exportBillTypes, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportSystemScripts', (workspaceKey) => runTool(TOOL_COMMANDS.exportSystemScripts, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.exportViews', (workspaceKey) => runTool(TOOL_COMMANDS.exportViews, [], true, workspaceKey)),
    vscode.commands.registerCommand('gushenCompletion.runDoctor', () => runTool(TOOL_COMMANDS.doctor, ['--json'])),
    vscode.commands.registerCommand('gushenCompletion.runDiagnosis', async (workspaceKey) => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, title: '选择排查定义 JSON' });
      if (selected) return runTool(TOOL_COMMANDS.diagnose, [selected[0].fsPath], true, workspaceKey);
    }),
    vscode.commands.registerCommand('gushenCompletion.inspectWorkcopy', async (workspaceKey) => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 Workcopy 目录' });
      if (!selected) return;
      const action = await vscode.window.showQuickPick([
        { label: '查看状态', value: 'status' },
        { label: '生成差异报告', value: 'diff' },
        { label: '打包交付物', value: 'package' },
      ], { title: 'Workcopy 操作' });
      if (action) return runTool(TOOL_COMMANDS.workcopy, [action.value, selected[0].fsPath], true, workspaceKey);
    }),
    vscode.commands.registerCommand('gushenCompletion.initializeSvn', async (workspaceKey) => {
      let release = claimToolRun(TOOL_COMMANDS.svn, workspaceKey);
      if (!release) return false;
      try {
        const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
        if (!workspace) {
          void vscode.window.showErrorMessage(`未找到 SVN 项目：${workspaceKey}`);
          return false;
        }
        svnServices.log('SVN 检出/更新', '读取 SVN 地址配置预览');
        const hasScopeConfig = Boolean(workspace.scopeConfigReady);
        const hasCheckoutScript = Boolean(workspace.checkoutScriptReady);
        if (!hasScopeConfig && !hasCheckoutScript) {
          void vscode.window.showWarningMessage(
            `未找到 SVN 地址配置：${workspace.scopeConfigPath || 'config/products.yaml/projects.yaml'}。请先在对应文件中配置 svn.url，或使用“导入/粘贴 SVN checkout 配置”。`
          );
          return false;
        }
        let preview;
        try {
          preview = await svnServices.backend.scopePreview(workspaceKey);
        } catch (error) {
          void vscode.window.showErrorMessage(`无法解析工作区 SVN 地址配置：${error.message}`);
          return false;
        }
        const changeSummary = `新增 ${preview.added}、移除 ${preview.removed}、变更 ${preview.modified}`;
        const scopeSummary = `${preview.source === 'config' ? '地址配置' : '签出脚本'}包含 ${preview.entries} 个仓库地址`;
        const confirmed = await vscode.window.showWarningMessage(
          `将使用当前工程的 SVN ${preview.source === 'config' ? '地址配置（products.yaml/projects.yaml 的 svn.url）' : '签出脚本'}：${scopeSummary}（${changeSummary}），随后检出或更新完整 working copy。系统与数据源映射不限制 checkout 内容；配置不保存凭据。`,
          { modal: true },
          '检出/更新'
        );
        if (confirmed !== '检出/更新') return false;
        const completed = await runTool(
          TOOL_COMMANDS.svn,
          ['sync-from-config', '--accept-scope-change'],
          false,
          workspaceKey,
          release
        );
        release = null;
        if (completed) {
          refreshToolData();
          await svnServices.refresh(workspaceKey);
        }
        return completed;
      } finally {
        if (release) release();
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.importSvnScope', async (workspaceKey, preferredSource = '') => {
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
      if (!workspace) return vscode.window.showErrorMessage(`未找到 SVN 项目：${workspaceKey}`);
      const choice = preferredSource
        ? { value: preferredSource }
        : await vscode.window.showQuickPick([
          { label: '选择 svnCheckoutHere.sh/.bat', value: 'file' },
          { label: '粘贴一个或多个 SVN 地址/checkout 命令', value: 'paste' },
        ], { title: '导入/粘贴 SVN checkout 配置' });
      if (!choice) return;
      let result;
      try {
        if (choice.value === 'file') {
          const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'SVN checkout 文件': ['sh', 'bat'], '所有文件': ['*'] },
            title: '选择谷神 SVN checkout 文件',
          });
          if (!selected) return;
          result = await svnServices.backend.scopeImportFile(workspaceKey, selected[0].fsPath);
        } else {
          const input = createSvnScopeInputFile(context.globalStorageUri?.fsPath);
          try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(input.file));
            const closed = waitForEditorTabClose(vscode, document);
            await vscode.window.showTextDocument(document, { preview: false });
            await closed;
            const action = await vscode.window.showInformationMessage(
              'SVN 地址编辑器已关闭，请选择下一步。',
              { modal: true },
              '解析 SVN 地址',
              '编辑 SVN 地址配置'
            );
            if (action === '编辑 SVN 地址配置') {
              await vscode.commands.executeCommand('gushenCompletion.editSvnScope', workspaceKey);
              return { action: 'edit' };
            }
            if (action !== '解析 SVN 地址') return;
            const text = fs.readFileSync(input.file, 'utf8');
            if (!hasSvnScopeInput(text)) {
              const next = await vscode.window.showWarningMessage(
                '未检测到 SVN 地址或 checkout 命令，没有执行解析。',
                '编辑 SVN 地址配置'
              );
              if (next === '编辑 SVN 地址配置') {
                await vscode.commands.executeCommand('gushenCompletion.editSvnScope', workspaceKey);
                return { action: 'edit' };
              }
              return;
            }
            result = await svnServices.backend.scopeImport(workspaceKey, text, 'script');
          } finally {
            removeSvnScopeInputFile(input);
          }
        }
      } catch (error) {
        return vscode.window.showErrorMessage(`导入 SVN 地址失败：${error.message}`);
      }
      const message = result.url && Array.isArray(result.scope) && !result.scope.length
        ? `已解析 SVN 根地址并写入 svn.url：${result.url}。将完整检出该地址下当前账号可见的所有目录。`
        : result.url && Array.isArray(result.scope)
          ? `已解析旧版显式范围配置：1 个 SVN URL、${result.scope.length} 个 scope。请检查配置后执行检出/更新。`
        : result.added
          ? `已向 ${result.output} 添加 ${result.added} 个 SVN 地址。请检查配置后执行检出/更新。`
          : `SVN 地址配置没有变化。`;
      vscode.window.showInformationMessage(message);
      refreshToolData();
      await svnServices.refreshWorkspaceList();
      return result;
    }),
    vscode.commands.registerCommand('gushenCompletion.editSvnScope', async (workspaceKey) => {
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
      if (!workspace?.scopeConfigPath) return vscode.window.showErrorMessage('无法解析 SVN 地址配置路径');
      const file = workspace.scopeConfigPath;
      if (!fs.existsSync(file)) {
        if (['products.yaml', 'projects.yaml'].includes(path.basename(file))) {
          return vscode.window.showErrorMessage(`缺少工作区配置文件：${file}，请先执行设置工作空间`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          '# 请在当前产品/项目的 svn.url 中维护唯一 SVN 根地址。\n',
          'utf8'
        );
        return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
      }
      return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }),
    vscode.commands.registerCommand('gushenCompletion.refreshSvn', async (workspaceValue) => {
      const providerId = workspaceValue?.id || workspaceValue?.sourceControl?.id || '';
      const workspaceKey = typeof workspaceValue === 'string'
        ? workspaceValue
        : workspaceValue?.guthonWorkspaceKey
          || workspaceKeyFromSourceControlId(providerId);
      const requestedWorkingCopyIds = Array.isArray(workspaceValue?.guthonWorkingCopyIds)
        ? workspaceValue.guthonWorkingCopyIds.filter(Boolean)
        : [];
      if (!workspaceKey) return vscode.window.showErrorMessage('无法解析 SVN 项目');
      let release = claimToolRun(TOOL_COMMANDS.svn, workspaceKey);
      if (!release) return false;
      try {
        if (!await svnServices.saveDirtyDocuments(workspaceKey, '更新 SVN', '更新 SVN')) return false;
        const workspaces = await listSvnWorkspaces();
        const workspace = workspaces.find((item) => item.workspaceKey === workspaceKey);
        if (!workspace?.workingCopies?.length) {
          const completed = await runTool(
            TOOL_COMMANDS.svn,
            ['refresh'],
            true,
            workspaceKey,
            release
          );
          release = null;
          if (completed) {
            svnServices.scm.clearRemote(workspaceKey);
            refreshToolData();
            await svnServices.refresh(workspaceKey);
          }
          return completed;
        }
        svnServices.log('更新 SVN', '检查远程变更和本地修改');
        const current = await svnServices.backend.scmStatus(
          workspaceKey,
          true,
          svnServices.backendOutput
        );
        const currentById = new Map(current.workingCopies.map((item) => [item.id, item]));
        let selectedWorkingCopyIds = requestedWorkingCopyIds;
        if (!selectedWorkingCopyIds.length) {
          const sourceGroups = (workspace.sourceControlGroups || []).map((group) => {
            const items = (group.workingCopyIds || []).map((id) => currentById.get(id)).filter(Boolean);
            const remoteCount = items.filter((item) => item.outOfDate).length;
            const localCount = items.filter((item) => !item.clean).length;
            return {
              label: group.label,
              description: `${group.dataSourceId || '公共'} · ${items.length} 个 working copy`,
              detail: [
                remoteCount ? `远程更新 ${remoteCount}` : '',
                localCount ? `本地修改 ${localCount}` : '',
              ].filter(Boolean).join(' · ') || '当前干净',
              workingCopyIds: items.map((item) => item.id),
            };
          }).filter((group) => group.workingCopyIds.length);
          const selected = await vscode.window.showQuickPick(
            sourceGroups.length ? sourceGroups : current.workingCopies.map((item) => ({
              label: item.id,
              description: item.clean ? '干净' : '有本地修改',
              detail: item.outOfDate ? '远程存在更新' : undefined,
              workingCopyIds: [item.id],
            })),
            { title: '选择要更新的 SVN 子系统' }
          );
          if (!selected) return false;
          selectedWorkingCopyIds = selected.workingCopyIds;
        }
        const selectedItems = selectedWorkingCopyIds.map((id) => currentById.get(id)).filter(Boolean);
        if (!selectedItems.length) {
          void vscode.window.showErrorMessage('所选子系统没有可更新的 SVN working copy');
          return false;
        }
        const args = [
          'refresh',
          ...selectedItems.flatMap((item) => ['--working-copy', item.id]),
        ];
        svnServices.log('更新 SVN', `已选择 ${selectedItems.length} 个 working copy，准备执行 SVN update`);
        if (selectedItems.some((item) => !item.clean)) {
          const confirmed = await vscode.window.showWarningMessage(
            '所选子系统存在本地修改。更新将由 SVN 执行原生文本合并，Nexus 不会自动解决冲突。',
            { modal: true },
            '更新并合并'
          );
          if (confirmed !== '更新并合并') return false;
          args.push('--merge-local');
        }
        const completed = await runTool(
          TOOL_COMMANDS.svn,
          args,
          true,
          workspaceKey,
          release
        );
        release = null;
        if (completed) {
          svnServices.scm.clearRemote(workspaceKey);
          refreshToolData();
          await svnServices.refresh(workspaceKey);
        }
        return completed;
      } finally {
        if (release) release();
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.showSvnStatus', async (workspaceKey) => {
      await vscode.commands.executeCommand('gushenCompletion.refreshSvnScm', workspaceKey);
      return vscode.commands.executeCommand('workbench.view.scm');
    }),
    vscode.commands.registerCommand('gushenCompletion.focusSvnSource', async () =>
      vscode.commands.executeCommand('gushenCompletion.svnSourceView.focus')),
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

  context.subscriptions.push(
    disposable,
    definitionDisposable,
    hoverDisposable,
    toolViewDisposable,
    updateCenter,
    toolView.changed,
    bridgeOutput,
    bridge,
    processClient,
    { dispose: () => { toolOutputChannel?.dispose(); toolOutputChannel = null; } },
    ...toolCommands
  );
}

function deactivate() {}

module.exports = {
  activate,
  createDefinitionProvider,
  createHoverProvider,
  createProvider,
  ToolTreeDataProvider,
  deactivate,
};
