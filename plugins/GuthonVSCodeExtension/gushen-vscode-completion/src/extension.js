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

const SUPPORTED_LANGUAGES = ['java', 'javascript', 'sql'];
const SUPPORTED_SCHEMES = ['file', 'untitled'];
const TOOL_COMMANDS = {
  setup: 'setup',
  init: 'init',
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
};
const CONFIG_FILES = ['datasource.yaml', 'products.yaml', 'projects.yaml', 'source-tables.yaml', 'sync.yaml'];
const TOOL_LABELS = {
  setup: '初始化工作区',
  init: '初始化源码索引',
  'sync-source': '同步当前 ACTIVE 源码',
  'sync-all': '同步当前 ACTIVE 全部资料',
  reindex: '重建本地调用索引',
  'export-markdown': '导出源码索引文档',
  'export-schema': '导出表结构',
  'export-bill-type': '导出单据类型',
  'export-system-script': '导出系统脚本',
  'export-view': '导出视图源码',
  doctor: '检查本地环境',
  diagnose: '执行源码逻辑排查',
  workcopy: '执行 Workcopy 操作',
};

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

async function configuredTool() {
  const config = vscode.workspace.getConfiguration('gushenCompletion');
  let toolPath = config.get('toolPath', '');
  let toolHome = config.get('toolHome', '');
  if (!toolPath) {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: '选择 GuthonCodeTool 可执行程序' });
    if (!selected) return undefined;
    toolPath = selected[0].fsPath;
    await config.update('toolPath', toolPath, vscode.ConfigurationTarget.Global);
  }
  if (!toolHome) {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 GuthonCodeTool 本地数据目录' });
    if (!selected) return undefined;
    toolHome = selected[0].fsPath;
    await config.update('toolHome', toolHome, vscode.ConfigurationTarget.Global);
  }
  return { toolPath, toolHome };
}

async function runTool(command, extraArgs = []) {
  const label = TOOL_LABELS[command] || command;
  const confirmed = await vscode.window.showWarningMessage(`确认${label}？`, { modal: true }, '执行');
  if (confirmed !== '执行') return false;
  const tool = await configuredTool();
  if (!tool) return false;
  const output = vscode.window.createOutputChannel('GuthonCodeTool');
  output.show(true);
  output.appendLine(`运行：${command}`);
  const child = spawn(tool.toolPath, [command, '--home', tool.toolHome, ...(extraArgs.length ? ['--', ...extraArgs] : [])], { shell: false });
  child.stdout.on('data', (data) => output.append(data.toString()));
  child.stderr.on('data', (data) => output.append(data.toString()));
  child.on('error', (error) => vscode.window.showErrorMessage(`GuthonCodeTool 启动失败：${error.message}`));
  child.on('close', (code) => {
    const message = code === 0 ? `GuthonCodeTool 完成：${command}` : `GuthonCodeTool 失败（退出码 ${code}）：${command}`;
    output.appendLine(message);
    (code === 0 ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(message);
  });
  return true;
}

function toolItem(label, command, icon, description, args = []) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = { command, title: label, arguments: args };
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = description;
  return item;
}

class ToolTreeDataProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  getChildren(element) {
    if (element) return element.children || [];
    const config = vscode.workspace.getConfiguration('gushenCompletion');
    const toolHome = config.get('toolHome', '');
    const ready = toolHome && fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'));
    const workspace = new vscode.TreeItem('工作区', vscode.TreeItemCollapsibleState.Expanded);
    workspace.iconPath = new vscode.ThemeIcon(ready ? 'pass-filled' : 'warning');
    workspace.description = ready ? '已配置' : '未配置';
    const configFiles = new vscode.TreeItem('配置文件', vscode.TreeItemCollapsibleState.Collapsed);
    configFiles.iconPath = new vscode.ThemeIcon('settings-gear');
    configFiles.children = CONFIG_FILES.map((filename) => toolItem(filename, 'gushenCompletion.editConfig', 'edit', undefined, [filename]));
    workspace.children = [
      toolItem('初始化工作区', 'gushenCompletion.setupTool', 'folder-library', ready ? toolHome : '选择程序和本地数据目录'),
      configFiles,
      toolItem('打开本地数据目录', 'gushenCompletion.openToolHome', 'folder-opened'),
    ];
    const source = new vscode.TreeItem('源码', vscode.TreeItemCollapsibleState.Expanded);
    source.iconPath = new vscode.ThemeIcon('code');
    source.children = [
      toolItem('初始化源码索引', 'gushenCompletion.initSourceIndex', 'database'),
      toolItem('同步当前 ACTIVE 源码', 'gushenCompletion.syncActiveSource', 'sync'),
      toolItem('重建本地调用索引', 'gushenCompletion.reindexCalls', 'refresh'),
      toolItem('导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'),
    ];
    const metadata = new vscode.TreeItem('配置数据', vscode.TreeItemCollapsibleState.Expanded);
    metadata.iconPath = new vscode.ThemeIcon('server');
    metadata.children = [
      toolItem('同步当前 ACTIVE 全部资料', 'gushenCompletion.syncActiveAll', 'cloud-download'),
      toolItem('导出表结构', 'gushenCompletion.exportSchema', 'table'),
      toolItem('导出单据类型', 'gushenCompletion.exportBillTypes', 'list-tree'),
      toolItem('导出系统脚本', 'gushenCompletion.exportSystemScripts', 'file-code'),
      toolItem('导出视图源码', 'gushenCompletion.exportViews', 'eye'),
    ];
    const maintenance = new vscode.TreeItem('维护', vscode.TreeItemCollapsibleState.Expanded);
    maintenance.iconPath = new vscode.ThemeIcon('tools');
    maintenance.children = [
      toolItem('检查本地环境', 'gushenCompletion.runDoctor', 'pulse'),
      toolItem('执行源码逻辑排查', 'gushenCompletion.runDiagnosis', 'search'),
      toolItem('检查或打包 Workcopy', 'gushenCompletion.inspectWorkcopy', 'package'),
    ];
    return [workspace, source, metadata, maintenance];
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
    createDocumentSelector(['java'], SUPPORTED_SCHEMES),
    createDefinitionProvider()
  );
  const hoverDisposable = vscode.languages.registerHoverProvider(
    selector,
    createHoverProvider(context)
  );
  const toolView = new ToolTreeDataProvider();
  const toolViewDisposable = vscode.window.registerTreeDataProvider('gushenCompletion.toolView', toolView);
  const toolCommands = [
    vscode.commands.registerCommand('gushenCompletion.setupTool', async () => { await runTool(TOOL_COMMANDS.setup); toolView.refresh(); }),
    vscode.commands.registerCommand('gushenCompletion.initSourceIndex', () => runTool(TOOL_COMMANDS.init)),
    vscode.commands.registerCommand('gushenCompletion.syncActiveSource', () => runTool(TOOL_COMMANDS.syncSource)),
    vscode.commands.registerCommand('gushenCompletion.syncActiveAll', () => runTool(TOOL_COMMANDS.syncAll)),
    vscode.commands.registerCommand('gushenCompletion.reindexCalls', () => runTool(TOOL_COMMANDS.reindex)),
    vscode.commands.registerCommand('gushenCompletion.exportMarkdown', () => runTool(TOOL_COMMANDS.exportMarkdown)),
    vscode.commands.registerCommand('gushenCompletion.exportSchema', () => runTool(TOOL_COMMANDS.exportSchema)),
    vscode.commands.registerCommand('gushenCompletion.exportBillTypes', () => runTool(TOOL_COMMANDS.exportBillTypes)),
    vscode.commands.registerCommand('gushenCompletion.exportSystemScripts', () => runTool(TOOL_COMMANDS.exportSystemScripts)),
    vscode.commands.registerCommand('gushenCompletion.exportViews', () => runTool(TOOL_COMMANDS.exportViews)),
    vscode.commands.registerCommand('gushenCompletion.runDoctor', () => runTool(TOOL_COMMANDS.doctor, ['--json'])),
    vscode.commands.registerCommand('gushenCompletion.runDiagnosis', async () => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, title: '选择排查定义 JSON' });
      if (selected) return runTool(TOOL_COMMANDS.diagnose, [selected[0].fsPath]);
    }),
    vscode.commands.registerCommand('gushenCompletion.inspectWorkcopy', async () => {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 Workcopy 目录' });
      if (!selected) return;
      const action = await vscode.window.showQuickPick([
        { label: '查看状态', value: 'status' },
        { label: '生成差异报告', value: 'diff' },
        { label: '打包交付物', value: 'package' },
      ], { title: 'Workcopy 操作' });
      if (action) return runTool(TOOL_COMMANDS.workcopy, [action.value, selected[0].fsPath]);
    }),
    vscode.commands.registerCommand('gushenCompletion.refreshToolView', () => toolView.refresh()),
    vscode.commands.registerCommand('gushenCompletion.editConfig', async (filename) => {
      const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
      if (!toolHome) return vscode.window.showErrorMessage('请先执行 “Guthon: 初始化工作区”');
      const file = path.join(toolHome, 'config', filename);
      if (!fs.existsSync(file)) return vscode.window.showErrorMessage(`配置文件不存在：${file}。请先执行 “Guthon: 初始化工作区”`);
      return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }),
    vscode.commands.registerCommand('gushenCompletion.openToolHome', () => {
      const toolHome = vscode.workspace.getConfiguration('gushenCompletion').get('toolHome', '');
      return toolHome ? vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(toolHome)) : vscode.window.showErrorMessage('请先执行 “Guthon: 初始化工作区”');
    }),
  ];

  context.subscriptions.push(disposable, definitionDisposable, hoverDisposable, toolViewDisposable, toolView.changed, ...toolCommands);
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
