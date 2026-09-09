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
const { prepareWorkspaceSetup, promptWorkspaceCreation, workspaceActions } = require('./tool-workspace');
const { createBridgeProcess, resolveBridgeScript } = require('./bridge-process');
const { resolveDevelopmentRuntime, toolArguments, writeRuntimeDescriptor } = require('./tool-runtime');
const {
  filterWorkspacesBySourceMode,
  selectWorkspaceSourceMode,
  sourceModeLabel,
} = require('./source-mode');
const { readWorkspaces } = require('./workspace-registry');
const { activateSvn } = require('./svn/activate');
const { clearLegacyCredentials, promptForPassword } = require('./svn/credentials');
const { workspaceKeyFromSourceControlId } = require('./svn/scm-manager');

const SUPPORTED_LANGUAGES = ['java', 'guthon-gss', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled', 'guthon-svn-edit'];
const TOOL_COMMANDS = {
  setup: 'setup',
  workspaceCreate: 'workspace-create',
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
  svn: 'SVN 检出/更新',
  'source-mode': '设置项目源码来源',
  'workspace-create': '添加产品或项目',
};
let toolQueue = Promise.resolve();
const activeToolRuns = new Set();

function toolRunKey(command, workspaceKey) {
  return `${command}::${workspaceKey || ''}`;
}

function reportToolAlreadyRunning(command, workspaceKey, labelOverride = '') {
  const message = `已有${labelOverride || TOOL_LABELS[command] || command}正在执行：${workspaceKey || '当前工作区'}，本次点击已忽略。`;
  const output = vscode.window.createOutputChannel('GuthonCodeTool');
  output.show(true);
  output.appendLine(message);
  vscode.window.showInformationMessage(message);
}

function claimToolRun(command, workspaceKey, labelOverride = '') {
  const runKey = toolRunKey(command, workspaceKey);
  if (activeToolRuns.has(runKey)) {
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

async function runTool(
  command,
  extraArgs = [],
  askForConfirmation = true,
  workspaceKey = '',
  claimedRunRelease = null,
  stdinPayload = undefined
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
  const tool = await configuredTool();
  if (!tool) {
    release();
    return false;
  }
  const output = vscode.window.createOutputChannel('GuthonCodeTool');
  output.show(true);
  const execute = () => new Promise((resolve) => {
    output.appendLine(`运行：${command}${workspaceKey ? ` · ${workspaceKey}` : ''}（${tool.mode === 'development' ? '调试模式' : '发行模式'}）`);
    const child = spawn(tool.toolPath, toolArguments(tool, command, extraArgs, workspaceKey), {
      shell: false,
      env: process.env,
    });
    child.stdout.on('data', (data) => output.append(data.toString()));
    child.stderr.on('data', (data) => output.append(data.toString()));
    child.stdin.end(stdinPayload === undefined ? '' : JSON.stringify(stdinPayload));
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
  return pending.finally(release);
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
      ready && toolItem(
        '添加产品或项目',
        'gushenCompletion.addWorkspace',
        'add',
        '后续开发可随时新增'
      ),
      configFiles,
      toolItem('打开本地数据目录', 'gushenCompletion.openToolHome', 'folder-opened'),
    ].filter(Boolean);
    const projects = new vscode.TreeItem('项目', vscode.TreeItemCollapsibleState.Expanded);
    projects.iconPath = new vscode.ThemeIcon('folder-library');
    const tool = configuredToolFromSettings();
    try {
      const statusLabels = { UNINITIALIZED: '未初始化', PARTIAL: '部分同步', SYNCED: '已同步', FAILED: '同步失败' };
      const workspaces = tool ? await readWorkspaces(tool) : [];
      projects.children = [toolItem(
        '添加产品或项目',
        'gushenCompletion.addWorkspace',
        'add',
        '创建本地配置并选择源码来源'
      ), ...workspaces.map((item) => {
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
            '设置工作区 SVN 登录',
            'gushenCompletion.setSvnCredentials',
            'key',
            '当前本地数据工作区内所有产品和项目共用',
            [item.workspaceKey],
          ),
          syncItem,
          item.sourceMode === 'svn' && item.scopeConfigPath && toolItem(
            '编辑 SVN 范围配置',
            'gushenCompletion.editSvnScope',
            'edit',
            item.scopeConfigReady ? item.scopeConfigPath : '在现有 products/projects.yaml 增加 svn.scope',
            [item.workspaceKey]
          ),
          toolItem('打开工作区目录', 'gushenCompletion.openWorkspace', 'folder-opened', undefined, [item.root]),
          source,
          actions.metadata.length && metadata,
          actions.diagnose && toolItem('执行源码逻辑排查', 'gushenCompletion.runDiagnosis', 'search', undefined, [item.workspaceKey]),
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
  const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
  void clearLegacyCredentials(context.secrets, toolHome).catch(() => {});
  const svnServices = activateSvn({
    vscode,
    context,
    getTool: async () => configuredToolFromSettings(),
    listSvnWorkspaces,
    onToolTreeChanged: () => toolView.refresh(),
    claimOperation: (workspaceKey, label) => claimToolRun(TOOL_COMMANDS.svn, workspaceKey, label),
  });
  const toolCommands = [
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
      const password = await promptForPassword(vscode.window);
      if (!password) return;
      try {
        await svnServices.backend.cacheAuthentication(selectedWorkspaceKey, password);
      } catch (error) {
        return vscode.window.showErrorMessage(`SVN 登录保存失败：${error.message}`);
      }
      return vscode.window.showInformationMessage(
        '已由 SVN 系统保存公共密码；用户名读取自 sync.yaml'
      );
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
        const scriptPath = path.join(workspaceRoot, 'context', 'svnCheckoutHere.sh');
        const batScriptPath = path.join(workspaceRoot, 'context', 'svnCheckoutHere.bat');
        if (!fs.existsSync(scriptPath) && !fs.existsSync(batScriptPath)) {
          return vscode.window.showWarningMessage(
            `已将 ${workspaceKey} 设为 SVN；请把谷神下载的 svnCheckoutHere.sh（macOS/Linux）或 svnCheckoutHere.bat（Windows）放入项目 context 目录。`
          );
        }
        const action = await vscode.window.showInformationMessage(
          `已将 ${workspaceKey} 设为 SVN。`,
          '从签出脚本检出/更新'
        );
        if (action === '从签出脚本检出/更新') {
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
      const completed = await runTool(TOOL_COMMANDS.setup, [], setupMode !== 'switch');
      if (!completed) return;
      if (setupMode === 'switch' && bridge.isRunning()) {
        const tool = await configuredTool();
        if (tool) await bridge.restart(tool);
      }
      toolView.refresh();
      await svnServices.refresh();
      if (setupMode === 'setup') {
        const next = await vscode.window.showInformationMessage(
          '本地数据目录已初始化，是否现在添加第一个产品或项目？',
          '立即添加',
          '稍后'
        );
        if (next === '立即添加') {
          return vscode.commands.executeCommand('gushenCompletion.addWorkspace');
        }
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.addWorkspace', async () => {
      const tool = await configuredTool();
      if (!tool) return false;
      let workspaces;
      try {
        workspaces = await readWorkspaces(tool);
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
      toolView.refresh();
      await svnServices.refresh();

      const configFile = definition.kind === 'product' ? 'products.yaml' : 'projects.yaml';
      const actions = definition.sourceMode === 'svn'
        ? ['立即调整配置', '继续导入 SVN 配置', '稍后']
        : ['立即调整配置', '稍后'];
      const next = await vscode.window.showInformationMessage(
        `${definition.name} 的配置已生成。系统别名、系统 ID、数据源 ID 仍需按实际谷神环境确认，是否现在调整？`,
        { modal: true },
        ...actions
      );
      if (next === '立即调整配置') {
        await vscode.commands.executeCommand('gushenCompletion.editConfig', configFile);
        return true;
      }
      if (next !== '继续导入 SVN 配置') return true;
      const workspaceKey = `${definition.kind === 'product' ? 'products' : 'projects'}.${definition.id}`;
      const imported = await vscode.commands.executeCommand('gushenCompletion.importSvnScope', workspaceKey);
      if (!imported) return true;
      const initialize = await vscode.window.showInformationMessage(
        'SVN 范围已导入，是否立即检出/更新并建立本地索引？',
        { modal: true },
        '立即执行',
        '稍后'
      );
      if (initialize === '立即执行') {
        await vscode.commands.executeCommand('gushenCompletion.initializeSvn', workspaceKey);
      }
      return true;
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
      let release = claimToolRun(TOOL_COMMANDS.svn, workspaceKey);
      if (!release) return false;
      try {
        const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
        if (!workspace) {
          void vscode.window.showErrorMessage(`未找到 SVN 项目：${workspaceKey}`);
          return false;
        }
        svnServices.log('SVN 检出/更新', '读取 SVN 范围配置预览');
        const hasScopeConfig = Boolean(workspace.scopeConfigReady);
        const hasCheckoutScript = Boolean(workspace.checkoutScriptReady);
        if (!hasScopeConfig && !hasCheckoutScript) {
          void vscode.window.showWarningMessage(
            `未找到 SVN 范围配置：${workspace.scopeConfigPath || 'config/products.yaml/projects.yaml'}。请先在对应文件的 svn.scope 中配置，或使用“导入 SVN checkout 配置”选择 .sh/.bat/粘贴内容。`
          );
          return false;
        }
        let preview;
        try {
          preview = await svnServices.backend.scopePreview(workspaceKey);
        } catch (error) {
          void vscode.window.showErrorMessage(`无法解析工作区 SVN 范围配置：${error.message}`);
          return false;
        }
        const changeSummary = `新增 ${preview.added}、移除 ${preview.removed}、变更 ${preview.modified}`;
        const scopeSummary = preview.excludedBySystemAliases
          ? `${preview.source === 'config' ? '范围配置' : '签出脚本'}共 ${preview.commands} 个地址，按 systems.include.mappings 保留 ${preview.entries} 个、排除 ${preview.excludedBySystemAliases} 个`
          : `${preview.source === 'config' ? '范围配置' : '签出脚本'}共 ${preview.commands} 个地址，保留 ${preview.entries} 个`;
        const confirmed = await vscode.window.showWarningMessage(
          `将使用当前工程的 SVN ${preview.source === 'config' ? '范围配置（products.yaml/projects.yaml 的 svn.scope）' : '签出脚本（可复制到现有配置的 svn.scope）'}：${scopeSummary}（${changeSummary}），随后使用同一次认证检出或更新筛选后的 working copy。配置只保存 URL 和相对目录，不保存凭据。`,
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
          await svnServices.refresh();
          toolView.refresh();
        }
        return completed;
      } finally {
        if (release) release();
      }
    }),
    vscode.commands.registerCommand('gushenCompletion.importSvnScope', async (workspaceKey) => {
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
      if (!workspace) return vscode.window.showErrorMessage(`未找到 SVN 项目：${workspaceKey}`);
      const choice = await vscode.window.showQuickPick([
        { label: '选择 svnCheckoutHere.sh/.bat', value: 'file' },
        { label: '粘贴 checkout 命令或地址', value: 'paste' },
      ], { title: '导入 SVN 范围到 products/projects.yaml 的 svn.scope' });
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
          const document = await vscode.workspace.openTextDocument({
            language: 'shellscript',
            content: '# 请在此粘贴 svn checkout 命令或 <url> <localSubdir>，然后点击“解析当前内容”。\n',
          });
          await vscode.window.showTextDocument(document, { preview: false });
          const confirmed = await vscode.window.showInformationMessage(
            '请把 checkout 命令粘贴到临时编辑器，完成后继续。',
            { modal: true },
            '解析当前内容'
          );
          if (confirmed !== '解析当前内容') return;
          result = await svnServices.backend.scopeImport(workspaceKey, document.getText(), 'script');
        }
      } catch (error) {
        return vscode.window.showErrorMessage(`导入 SVN 范围失败：${error.message}`);
      }
      const message = result.added
        ? `已向 ${result.output} 添加 ${result.added} 个 SVN 范围条目，重复 ${result.duplicatesSkipped || 0} 个。请检查配置后执行“从 SVN 范围配置检出/更新”。`
        : `没有新增 SVN 范围条目（重复 ${result.duplicatesSkipped || 0} 个）。`;
      vscode.window.showInformationMessage(message);
      await svnServices.refresh();
      toolView.refresh();
      return result;
    }),
    vscode.commands.registerCommand('gushenCompletion.editSvnScope', async (workspaceKey) => {
      const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
      if (!workspace?.scopeConfigPath) return vscode.window.showErrorMessage('无法解析 SVN 范围配置路径');
      const file = workspace.scopeConfigPath;
      if (!fs.existsSync(file)) {
        if (['products.yaml', 'projects.yaml'].includes(path.basename(file))) {
          return vscode.window.showErrorMessage(`缺少工作区配置文件：${file}，请先执行设置工作空间`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          '# 请在当前产品/项目的 svn.scope 下维护 SVN 范围。\n',
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
            await svnServices.refresh();
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
          await svnServices.refresh();
          toolView.refresh();
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
