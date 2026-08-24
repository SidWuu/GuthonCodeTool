const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
const { prepareWorkspaceSetup, workspaceActions } = require('./tool-workspace');
const { createBridgeProcess, resolveBridgeScript } = require('./bridge-process');
const { resolveDevelopmentRuntime, toolArguments, writeRuntimeDescriptor } = require('./tool-runtime');
const {
  filterWorkspacesBySourceMode,
  selectWorkspaceSourceMode,
  sourceModeLabel,
} = require('./source-mode');
const { readWorkspaces } = require('./workspace-registry');
const { activateSvn } = require('./svn/activate');
const {
  credentialEnvironment,
  promptAndStoreCredentials,
  requireCredentials,
} = require('./svn/credentials');

const SUPPORTED_LANGUAGES = ['java', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled', 'guthon-svn-edit'];
const TOOL_COMMANDS = {
  setup: 'setup',
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
};
const CONFIG_FILES = ['datasource.yaml', 'products.yaml', 'projects.yaml', 'source-tables.yaml', 'sync.yaml'];
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
  svn: '管理 SVN 授权源码',
  'source-mode': '设置项目源码来源',
};
let toolQueue = Promise.resolve();

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

function loadData(context) {
  const generatedData = readJson(path.join(context.extensionPath, 'data', 'index.json'));
  const manualDataPath = path.join(context.extensionPath, 'data', 'manual.json');
  const manualData = fs.existsSync(manualDataPath) ? readJson(manualDataPath) : {};
  return mergeCompletionData(generatedData, manualData);
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
      const route = resolveRoute(rules, document.languageId, currentWord);
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

      const items = findHoverItems(data, document.languageId, document.getText(range));
      if (!items.length) return undefined;

      const documentation = [...new Set(items.map(itemDocumentation))].join('\n\n---\n\n');
      return new vscode.Hover(new vscode.MarkdownString(documentation), range);
    },
  };
}

async function configuredRuntime(config, mode) {
  let runtime;
  if (mode === 'development') {
    let developmentRoot = config.get('developmentRoot', '');
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
      await config.update('developmentRoot', developmentRoot, vscode.ConfigurationTarget.Global);
    }
    return runtime;
  } else {
    let toolPath = config.get('toolPath', '');
    if (!toolPath || !fs.existsSync(toolPath)) {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: '选择 GuthonCodeTool 可执行程序' });
      if (!selected) return undefined;
      toolPath = selected[0].fsPath;
      await config.update('toolPath', toolPath, vscode.ConfigurationTarget.Global);
    }
    return { mode: 'packaged', toolPath };
  }
}

async function configuredTool() {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const mode = config.get('executionMode', 'packaged');
  const runtime = await configuredRuntime(config, mode);
  if (!runtime) return undefined;
  let toolHome = config.get('toolHome', '');
  if (!toolHome) {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 GuthonCodeTool 本地数据目录' });
    if (!selected) return undefined;
    toolHome = selected[0].fsPath;
    await config.update('toolHome', toolHome, vscode.ConfigurationTarget.Global);
  }
  const tool = { ...runtime, toolHome };
  writeRuntimeDescriptor(tool);
  return tool;
}

async function runTool(command, extraArgs = [], askForConfirmation = true, workspaceKey = '', environment = {}) {
  const label = TOOL_LABELS[command] || command;
  if (askForConfirmation) {
    const confirmed = await vscode.window.showWarningMessage(`确认${label}？`, { modal: true }, '执行');
    if (confirmed !== '执行') return false;
  }
  const tool = await configuredTool();
  if (!tool) return false;
  const output = vscode.window.createOutputChannel('GuthonCodeTool');
  output.show(true);
  const execute = () => new Promise((resolve) => {
    output.appendLine(`运行：${command}${workspaceKey ? ` · ${workspaceKey}` : ''}（${tool.mode === 'development' ? '调试模式' : '发行模式'}）`);
    const child = spawn(tool.toolPath, toolArguments(tool, command, extraArgs, workspaceKey), {
      shell: false,
      env: { ...process.env, ...environment },
    });
    child.stdout.on('data', (data) => output.append(data.toString()));
    child.stderr.on('data', (data) => output.append(data.toString()));
    child.on('error', (error) => {
      vscode.window.showErrorMessage(`GuthonCodeTool 启动失败：${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      const message = code === 0 ? `GuthonCodeTool 完成：${command}` : `GuthonCodeTool 失败（退出码 ${code}）：${command}`;
      output.appendLine(message);
      (code === 0 ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(message);
      resolve(code === 0);
    });
  });
  const pending = toolQueue.then(execute, execute);
  toolQueue = pending.catch(() => false);
  return pending;
}

function configuredToolFromSettings() {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  const toolHome = config.get('toolHome', '');
  if (!toolHome || !fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'))) return undefined;
  try {
    const mode = config.get('executionMode', 'packaged');
    const runtime = mode === 'development'
      ? resolveDevelopmentRuntime(config.get('developmentRoot', ''))
      : { mode: 'packaged', toolPath: config.get('toolPath', '') };
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

class ToolTreeDataProvider {
  constructor(bridge = { isRunning: () => false }) {
    this.bridge = bridge;
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
    const executionMode = config.get('executionMode', 'packaged');
    const developmentRoot = config.get('developmentRoot', '');
    const ready = toolHome && fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'));
    const workspace = new vscode.TreeItem('工作区', vscode.TreeItemCollapsibleState.Expanded);
    workspace.iconPath = new vscode.ThemeIcon(ready ? 'pass-filled' : 'warning');
    workspace.description = ready ? '已配置' : '未配置';
    const configFiles = new vscode.TreeItem('配置文件', vscode.TreeItemCollapsibleState.Collapsed);
    configFiles.iconPath = new vscode.ThemeIcon('settings-gear');
    configFiles.children = CONFIG_FILES.map((filename) => toolItem(filename, 'gushenCompletion.editConfig', 'edit', undefined, [filename]));
    workspace.children = [
      toolItem(
        `运行模式：${executionMode === 'development' ? '调试模式' : '发行模式'}`,
        'gushenCompletion.selectExecutionMode',
        executionMode === 'development' ? 'beaker' : 'package',
        executionMode === 'development' ? developmentRoot : '打包应用'
      ),
      toolItem(
        ready ? '切换工作空间' : '设置工作空间',
        'gushenCompletion.setupTool',
        'folder-library',
        ready ? toolHome : '选择程序和本地数据目录'
      ),
      configFiles,
      toolItem('打开本地数据目录', 'gushenCompletion.openToolHome', 'folder-opened'),
    ];
    const projects = new vscode.TreeItem('项目', vscode.TreeItemCollapsibleState.Expanded);
    projects.iconPath = new vscode.ThemeIcon('folder-library');
    const tool = configuredToolFromSettings();
    try {
      const statusLabels = { UNINITIALIZED: '未初始化', PARTIAL: '部分同步', SYNCED: '已同步', FAILED: '同步失败' };
      const workspaces = tool ? await readWorkspaces(tool) : [];
      projects.children = workspaces.map((item) => {
        const actions = workspaceActions(item);
        const node = new vscode.TreeItem(item.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        node.command = {
          command: 'gushenCompletion.expandProjectSource',
          title: '展开源码与索引',
        };
        node.description = `${item.id} · ${item.sourceMode === 'svn' ? 'SVN' : '数据库'} · ${statusLabels[item.status] || item.status}`;
        node.iconPath = new vscode.ThemeIcon(item.status === 'SYNCED' ? 'pass-filled' : item.status === 'FAILED' ? 'error' : 'folder');
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
          toolItem(
            `源码来源：${sourceModeLabel(item.sourceMode)}`,
            'gushenCompletion.selectWorkspaceSourceMode',
            item.sourceMode === 'svn' ? 'repo' : 'database',
            '仅作用于当前项目',
            [item.workspaceKey, item.sourceMode, item.root]
          ),
          item.sourceMode === 'svn' && toolItem(
            '设置工作区 SVN 凭据',
            'gushenCompletion.setSvnCredentials',
            'key',
            '当前本地数据工作区内所有产品和项目共用',
          ),
          syncItem,
          toolItem('打开工作区目录', 'gushenCompletion.openWorkspace', 'folder-opened', undefined, [item.root]),
          source,
          actions.metadata.length && metadata,
          actions.diagnose && toolItem('执行源码逻辑排查', 'gushenCompletion.runDiagnosis', 'search', undefined, [item.workspaceKey]),
          ...actions.workcopy.map(([label, command, icon]) =>
            toolItem(label, command, icon, undefined, [item.workspaceKey])),
        ].filter(Boolean);
        return node;
      });
      if (!projects.children.length) {
        projects.children = [toolItem(
          '当前没有配置产品或项目',
          'gushenCompletion.editConfig',
          'warning',
          undefined,
          ['products.yaml']
        )];
      }
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
  const provider = createProvider(context);
  const selector = createDocumentSelector(SUPPORTED_LANGUAGES, SUPPORTED_SCHEMES);
  const disposable = vscode.languages.registerCompletionItemProvider(
    selector,
    provider,
    '.'
  );
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    createDocumentSelector(['java'], ['file', 'untitled']),
    createDefinitionProvider()
  );
  const hoverDisposable = vscode.languages.registerHoverProvider(
    selector,
    createHoverProvider(context)
  );
  const bridgeOutput = vscode.window.createOutputChannel('Guthon Bridge');
  let toolView;
  const bridge = createBridgeProcess({
    scriptPath: resolveBridgeScript(context.extensionPath),
    onOutput: (text) => bridgeOutput.append(text),
    onError: (error) => vscode.window.showErrorMessage(`Guthon Bridge 启动失败：${error.message}`),
    onExit: (code) => {
      if (code) vscode.window.showErrorMessage(`Guthon Bridge 已退出（退出码 ${code}），请查看输出面板`);
    },
    onStateChange: () => toolView?.refresh(),
  });
  toolView = new ToolTreeDataProvider(bridge);
  const toolViewDisposable = vscode.window.registerTreeDataProvider('gushenCompletion.toolView', toolView);
  const listSvnWorkspaces = async () => {
    const tool = configuredToolFromSettings();
    if (!tool) return [];
    return filterWorkspacesBySourceMode(await readWorkspaces(tool), 'svn');
  };
  const svnCredentialScope = () => vscode.workspace
    .getConfiguration('gushenCompletion')
    .get('toolHome', '');
  const svnEnvironment = () => credentialEnvironment(context.secrets, svnCredentialScope());
  const svnServices = activateSvn({
    vscode,
    context,
    getTool: async () => configuredToolFromSettings(),
    getEnvironment: svnEnvironment,
    listSvnWorkspaces,
    onToolTreeChanged: () => toolView.refresh(),
  });
  const toolCommands = [
    vscode.commands.registerCommand('gushenCompletion.setSvnCredentials', async () => {
      const environment = await promptAndStoreCredentials(
        vscode.window,
        context.secrets,
        svnCredentialScope()
      );
      if (!environment) return;
      await svnServices.refresh();
      return vscode.window.showInformationMessage('已安全保存当前本地数据工作区共用的 SVN 凭据');
    }),
    vscode.commands.registerCommand('gushenCompletion.selectWorkspaceSourceMode', async (
      workspaceKey,
      currentMode,
      workspaceRoot
    ) => {
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
      toolView.refresh();
      await svnServices.refresh();
      if (selected === 'svn') {
        const batPath = path.join(workspaceRoot, 'context', 'svnCheckoutHere.bat');
        if (!fs.existsSync(batPath)) {
          return vscode.window.showWarningMessage(
            `已将 ${workspaceKey} 设为 SVN；请先把谷神下载的 svnCheckoutHere.bat 放入项目 context 目录。`
          );
        }
        const action = await vscode.window.showInformationMessage(
          `已将 ${workspaceKey} 设为 SVN。`,
          '从 BAT 检出/更新'
        );
        if (action === '从 BAT 检出/更新') {
          return vscode.commands.executeCommand('gushenCompletion.initializeSvn', workspaceKey);
        }
        return undefined;
      }
      return vscode.window.showInformationMessage(`已将 ${workspaceKey} 设为 DATABASE`);
    }),
    vscode.commands.registerCommand('gushenCompletion.selectExecutionMode', async () => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const selected = await vscode.window.showQuickPick([
        { label: '发行模式', description: '调用打包的 GuthonCodeTool 应用', value: 'packaged' },
        { label: '调试模式', description: '直接调用源码仓库中的 Python 脚本', value: 'development' },
      ], { title: '选择 Guthon Nexus 运行模式' });
      if (!selected) return;
      const runtime = await configuredRuntime(config, selected.value);
      if (!runtime) return;
      await config.update('executionMode', selected.value, vscode.ConfigurationTarget.Global);
      const toolHome = config.get('toolHome', '');
      if (toolHome) writeRuntimeDescriptor({ ...runtime, toolHome });
      if (bridge.isRunning()) await bridge.restart({ ...runtime, toolHome });
      toolView.refresh();
      await svnServices.refresh();
      return vscode.window.showInformationMessage(`已切换为${selected.label}`);
    }),
    vscode.commands.registerCommand('gushenCompletion.setupTool', async () => {
      const config = vscode.workspace.getConfiguration('gushenCompletion');
      const setupMode = await prepareWorkspaceSetup(config, vscode.window, vscode.ConfigurationTarget.Global);
      if (!setupMode) return;
      await runTool(TOOL_COMMANDS.setup, [], setupMode !== 'switch');
      if (setupMode === 'switch' && bridge.isRunning()) {
        const tool = await configuredTool();
        if (tool) await bridge.restart(tool);
      }
      toolView.refresh();
      await svnServices.refresh();
    }),
    vscode.commands.registerCommand('gushenCompletion.startBridge', async () => {
      const tool = await configuredTool();
      if (!tool) return;
      try {
        if (!bridge.start(tool)) return vscode.window.showInformationMessage('Guthon Bridge 已在运行');
        bridgeOutput.show(true);
        return vscode.window.showInformationMessage('Guthon Bridge 已启动：http://127.0.0.1:17361');
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
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
      if (!workspace) return vscode.window.showErrorMessage(`未找到 SVN 项目：${workspaceKey}`);
      const environment = workspace.svnCredentialsRequired
        ? await requireCredentials(vscode.window, context.secrets, svnCredentialScope())
        : await svnEnvironment(workspaceKey);
      if (workspace.svnCredentialsRequired && !environment) return false;
      let preview;
      try {
        preview = await svnServices.backend.scopePreview(workspaceKey);
      } catch (error) {
        return vscode.window.showErrorMessage(`无法解析工作区 svnCheckoutHere.bat：${error.message}`);
      }
      const changeSummary = `新增 ${preview.added}、移除 ${preview.removed}、变更 ${preview.modified}`;
      const scopeSummary = preview.excludedBySystemAliases
        ? `BAT 共 ${preview.commands} 个地址，按 systems.include.system_aliases 保留 ${preview.entries} 个、排除 ${preview.excludedBySystemAliases} 个`
        : `BAT 共 ${preview.commands} 个地址，保留 ${preview.entries} 个`;
      const confirmed = await vscode.window.showWarningMessage(
        `将从当前工程 context/svnCheckoutHere.bat 生成检出范围：${scopeSummary}（${changeSummary}），随后检出或更新筛选后的 working copy。BAT 不会被执行，凭据不会写入授权清单。`,
        { modal: true },
        '检出/更新'
      );
      if (confirmed !== '检出/更新') return false;
      if (await runTool(
        TOOL_COMMANDS.svn,
        ['sync-from-bat', '--accept-scope-change'],
        false,
        workspaceKey,
        environment
      )) {
        await svnServices.refresh();
        toolView.refresh();
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.refreshSvn', async (workspaceValue) => {
      const providerId = workspaceValue?.id || workspaceValue?.sourceControl?.id || '';
      const workspaceKey = typeof workspaceValue === 'string'
        ? workspaceValue
        : providerId.startsWith('guthon-svn-')
          ? providerId.slice('guthon-svn-'.length)
          : '';
      if (!workspaceKey) return vscode.window.showErrorMessage('无法解析 SVN 项目');
      if (!await svnServices.saveDirtyDocuments(workspaceKey, '更新 SVN')) return;
      const workspaces = await listSvnWorkspaces();
      const workspace = workspaces.find((item) => item.workspaceKey === workspaceKey);
      if (!workspace?.workingCopies?.length) {
        if (await runTool(
          TOOL_COMMANDS.svn,
          ['refresh'],
          true,
          workspaceKey,
          await svnEnvironment(workspaceKey)
        )) await svnServices.refresh();
        return;
      }
      const current = await svnServices.backend.scmStatus(workspaceKey, true);
      const selected = await vscode.window.showQuickPick(
        current.workingCopies.map((item) => ({
          label: item.id,
          description: item.clean ? '干净' : '有本地修改',
          detail: item.outOfDate ? '远程存在更新' : undefined,
          item,
        })),
        { title: '选择要更新的 SVN working copy' }
      );
      if (!selected) return;
      const args = ['refresh', '--working-copy', selected.item.id];
      if (!selected.item.clean) {
        const confirmed = await vscode.window.showWarningMessage(
          '当前 working copy 有本地修改。更新将由 SVN 执行原生文本合并，Nexus 不会自动解决冲突。',
          { modal: true },
          '更新并合并'
        );
        if (confirmed !== '更新并合并') return;
        args.push('--merge-local');
      }
      if (await runTool(
        TOOL_COMMANDS.svn,
        args,
        true,
        workspaceKey,
        await svnEnvironment(workspaceKey)
      )) {
        await svnServices.refresh();
        toolView.refresh();
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
      toolView.refresh();
      await svnServices.refresh();
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
    toolView.changed,
    bridgeOutput,
    bridge,
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
