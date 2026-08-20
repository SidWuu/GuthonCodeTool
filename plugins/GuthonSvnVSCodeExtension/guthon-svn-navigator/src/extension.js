'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const {
  collectPages,
  extractPageSegment,
  findPageNode,
  formatReadablePageScripts,
  loadPageIndexes,
  parsePageComponents,
  pageSegmentFingerprint,
  readProductInfo,
  rewritePageSegment
} = require('./page-index');
const { parseSvnStatusXml } = require('./svn-status');
const { parseSvnLogXml } = require('./svn-log');
const {
  describeWorkspace,
  discoverWorkingCopyRoots,
  findLogicalWorkspaceRoot,
  isLogicalWorkspaceRoot,
  workingCopyForPath
} = require('./workspace-layout');

const VIEW_ID = 'guthonSvnNavigator.pageTree';
const CONFIG_SECTION = 'guthonSvnNavigator';
const VIRTUAL_DOCUMENT_SCHEME = 'guthon-page-segment';
const SVN_BASE_DOCUMENT_SCHEME = 'guthon-svn-base';
const READABLE_DIFF_DOCUMENT_SCHEME = 'guthon-svn-readable-diff';
const SCM_CHANGE_DOCUMENT_SCHEME = 'guthon-svn-change';
const VIRTUAL_NODE_KINDS = new Set([
  'component',
  'tab-item',
  'control-group',
  'control',
  'button',
  'event',
  'datasource'
]);

function svnArgs(args) {
  const trustServerCertificate = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get('trustServerCertificate', false);
  if (!trustServerCertificate) return args;
  return [
    '--non-interactive',
    '--trust-server-cert',
    '--trust-server-cert-failures=expired,cn-mismatch,unknown-ca,other',
    ...args
  ];
}

function expandHome(value) {
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function isRepositoryRoot(candidate) {
  return isLogicalWorkspaceRoot(candidate);
}

function findRepositoryRoot(startPath) {
  return findLogicalWorkspaceRoot(startPath);
}

function discoverRepositoryRoots() {
  const roots = new Set();
  const configured = expandHome(vscode.workspace.getConfiguration(CONFIG_SECTION).get('repositoryRoot', '').trim());
  if (isRepositoryRoot(configured)) roots.add(configured);

  for (const folder of vscode.workspace.workspaceFolders || []) {
    const root = findRepositoryRoot(folder.uri.fsPath);
    if (root) roots.add(root);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function countPages(node) {
  if (node.kind === 'page') return 1;
  return (node.children || []).reduce((total, child) => total + countPages(child), 0);
}

function svnTargets(repository) {
  const targets = repository?.workingCopies?.length
    ? repository.workingCopies
    : discoverWorkingCopyRoots(repository.root);
  return targets.length ? targets : [repository.root];
}

function yamlScalar(value) {
  return String(value || '').trim().replace(/^['\"]|['\"]$/g, '');
}

function readProjectCodeDictionary(root) {
  const dictionary = {
    dataSources: new Map(),
    systems: new Map()
  };
  const dictionaryPath = path.join(root, 'docs', '谷神项目编码字典.yaml');
  let source = '';
  try {
    source = fs.readFileSync(dictionaryPath, 'utf8');
  } catch {
    return dictionary;
  }

  let currentDataSource = null;
  for (const line of source.split(/\r?\n/)) {
    const dataSourceMatch = line.match(/^\s{2}-\s+data_source_id:\s*(.+?)\s*$/);
    if (dataSourceMatch) {
      currentDataSource = yamlScalar(dataSourceMatch[1]);
      continue;
    }
    const dataSourceNameMatch = line.match(/^\s{4}data_source_name:\s*(.+?)\s*$/);
    if (dataSourceNameMatch && currentDataSource) {
      dictionary.dataSources.set(currentDataSource, yamlScalar(dataSourceNameMatch[1]));
      continue;
    }
    const systemIdMatch = line.match(/^\s{6}-\s+system_id:\s*(.+?)\s*$/);
    if (systemIdMatch) {
      dictionary.currentSystemId = yamlScalar(systemIdMatch[1]);
      continue;
    }
    const systemNameMatch = line.match(/^\s{8}system_name:\s*(.+?)\s*$/);
    if (systemNameMatch && dictionary.currentSystemId) {
      dictionary.systems.set(dictionary.currentSystemId, yamlScalar(systemNameMatch[1]));
    }
  }
  delete dictionary.currentSystemId;
  return dictionary;
}

function workingCopyDescriptor(logicalRepository, workingCopy, dictionary) {
  const relative = path.relative(logicalRepository.root, workingCopy);
  const [category, id] = relative.split(path.sep);
  const pageSystems = new Map((logicalRepository.children || [])
    .map((system) => [system.systemId, system.label]));
  const systemName = pageSystems.get(id) || dictionary.systems.get(id) || id;
  const dataSourceName = dictionary.dataSources.get(id) || id;
  const categories = {
    pages: '页面',
    procedures: '过程函数',
    'system-script': '系统脚本',
    tables: '数据表',
    views: '视图'
  };
  if (category === 'pages' || category === 'system-script') {
    return { category, id, label: `${systemName} · ${categories[category]}` };
  }
  if (categories[category]) {
    return { category, id, label: `${dataSourceName} · ${categories[category]}` };
  }
  if (category === 'public') return { category, id: '', label: '公共资源' };
  if (category === 'skill') return { category, id: '', label: '技能资源' };
  return { category, id, label: path.basename(workingCopy) };
}

function sourceControlRepositories(repositories) {
  return repositories.flatMap((logicalRepository) => {
    const dictionary = readProjectCodeDictionary(logicalRepository.root);
    const pages = new Map(collectPages(logicalRepository.children || [])
      .filter((page) => page.filePath)
      .map((page) => [path.resolve(page.filePath), page]));
    return (logicalRepository.workingCopies || []).map((workingCopy) => {
      const descriptor = workingCopyDescriptor(logicalRepository, workingCopy, dictionary);
      return {
        ...logicalRepository,
        root: workingCopy,
        logicalRoot: logicalRepository.root,
        workingCopies: [workingCopy],
        label: descriptor.label,
        sourceCategory: descriptor.category,
        sourceId: descriptor.id,
        pageByFilePath: pages
      };
    });
  });
}

function readableChangeName(repository, entry) {
  const filePath = path.resolve(entry.filePath);
  const extension = path.extname(filePath);
  if (repository.sourceCategory === 'pages') {
    const page = repository.pageByFilePath?.get(filePath);
    if (page) return `${page.label}（${path.basename(filePath, extension)}）${extension}`;
    if (path.basename(filePath).toLowerCase() === 'index.md') return '页面索引（index.md）';
  }
  const relative = entry.relativePath || path.relative(repository.root, filePath);
  const kind = {
    procedures: '过程函数',
    'system-script': '系统脚本',
    tables: '数据表',
    views: '视图'
  }[repository.sourceCategory];
  if (kind) return `${kind} · ${relative}`;
  return relative;
}

function scmChangeUri(repository, entry, displayName) {
  const extension = path.extname(displayName) || path.extname(entry.filePath);
  const baseName = extension && displayName.endsWith(extension)
    ? displayName.slice(0, -extension.length)
    : displayName;
  const query = new URLSearchParams({ source: entry.filePath }).toString();
  return vscode.Uri.from({
    scheme: SCM_CHANGE_DOCUMENT_SCHEME,
    authority: Buffer.from(repository.root).toString('hex').slice(0, 12),
    path: `/${safeVirtualName(baseName)}${extension}`,
    query
  });
}

function removeMissingPages(nodes) {
  return (nodes || []).flatMap((node) => {
    if (node.kind === 'page') {
      return node.filePath && fs.existsSync(node.filePath) ? [node] : [];
    }
    node.children = removeMissingPages(node.children);
    return node.kind === 'system' || node.children.length ? [node] : [];
  });
}

function iconForPageType(pageType) {
  const icons = {
    主页面: 'layout',
    子页面: 'file-code',
    弹窗: 'browser',
    选窗: 'search',
    服务组件: 'symbol-method',
    元组件: 'symbol-structure',
    侧边框: 'layout-sidebar-left'
  };
  return icons[pageType] || 'file';
}

function isJsonPage(element) {
  return element?.kind === 'page'
    && element.filePath
    && path.extname(element.filePath).toLowerCase() === '.json';
}

function isPageJsonPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.json'
    && filePath.split(path.sep).includes('pages');
}

function readableDiffPath(filePath) {
  const name = safeVirtualName(path.basename(filePath, path.extname(filePath)));
  return isPageJsonPath(filePath) ? `/${name}.event-scripts.txt` : `/${name}.json`;
}

function iconForVirtualNode(element) {
  if (element.kind === 'control-group') return 'list-tree';
  if (element.kind === 'control') return element.description?.includes('隐藏') ? 'eye-closed' : 'symbol-field';
  if (element.kind === 'button') return 'symbol-event';
  if (element.kind === 'event') return element.description === 'serviceEvents' ? 'server-process' : 'symbol-event';
  if (element.kind === 'datasource') return 'database';
  if (element.kind === 'tab-item') return 'folder-library';
  if (element.componentType === 'search-box') return 'filter';
  if (element.componentType === 'table-main' || element.componentType === 'table-item') return 'table';
  if (element.componentType === 'input-box') return 'edit';
  if (element.componentType === 'tab-page') return 'layout-panel';
  return 'symbol-structure';
}

function safeVirtualName(value) {
  return String(value || 'segment')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'segment';
}

function virtualDocumentType(element) {
  if (element.kind === 'datasource') return { extension: 'sql', language: 'sql' };
  if (element.kind === 'event') {
    return element.description === 'serviceEvents'
      ? { extension: 'gss', language: 'guthon-gss' }
      : { extension: 'js', language: 'javascript' };
  }
  return { extension: 'json', language: 'json' };
}

async function atomicWriteUtf8(filePath, content) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.guthon-tmp`
  );
  try {
    await fs.promises.writeFile(temporaryPath, content, 'utf8');
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

class PageSegmentFileSystemProvider {
  constructor() {
    this._onDidChangeFile = new vscode.EventEmitter();
    this.onDidChangeFile = this._onDidChangeFile.event;
    this.baselines = new Map();
    this.locks = new Map();
  }

  dispose() {
    this._onDidChangeFile.dispose();
    this.baselines.clear();
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  readDirectory(uri) {
    if (uri.path === '/' || !uri.path) return [];
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(uri) {
    throw vscode.FileSystemError.NoPermissions(`虚拟页面片段不支持创建目录：${uri.path}`);
  }

  delete(uri) {
    throw vscode.FileSystemError.NoPermissions(`虚拟页面片段不支持删除：${uri.path}`);
  }

  rename(oldUri, _newUri, _options) {
    throw vscode.FileSystemError.NoPermissions(`虚拟页面片段不支持重命名：${oldUri.path}`);
  }

  _query(uri) {
    const query = new URLSearchParams(uri.query);
    return {
      filePath: query.get('source') || '',
      virtualPath: query.get('path') || '',
      baseline: query.get('baseline') || ''
    };
  }

  _resolve(uri) {
    const { filePath, virtualPath } = this._query(uri);
    if (!filePath || !fs.existsSync(filePath)) throw vscode.FileSystemError.FileNotFound(uri);
    const source = fs.readFileSync(filePath, 'utf8');
    const node = findPageNode(parsePageComponents(source, filePath), virtualPath);
    if (!node) throw vscode.FileSystemError.Unavailable(`原 JSON 中找不到虚拟节点：${virtualPath}`);
    return { filePath, virtualPath, source, node };
  }

  readFile(uri) {
    try {
      const resolved = this._resolve(uri);
      const key = uri.toString();
      if (!this.baselines.has(key)) this.baselines.set(key, pageSegmentFingerprint(resolved.source, resolved.node));
      return Buffer.from(extractPageSegment(resolved.source, resolved.node), 'utf8');
    } catch (error) {
      if (error instanceof vscode.FileSystemError) throw error;
      throw vscode.FileSystemError.Unavailable(`读取页面片段失败：${error.message}`);
    }
  }

  stat(uri) {
    const resolved = this._resolve(uri);
    const fileStat = fs.statSync(resolved.filePath);
    const size = this.readFile(uri).byteLength;
    return {
      type: vscode.FileType.File,
      ctime: fileStat.birthtimeMs || fileStat.ctimeMs,
      mtime: fileStat.mtimeMs,
      size,
      permissions: 0
    };
  }

  async _withLock(filePath, operation) {
    const previous = this.locks.get(filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(filePath, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(filePath) === current) this.locks.delete(filePath);
    }
  }

  async writeFile(uri, content) {
    let resolved;
    try {
      resolved = this._resolve(uri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError) throw error;
      throw vscode.FileSystemError.Unavailable(`读取页面片段失败：${error.message}`);
    }
    const isFieldCollection = resolved.node.kind === 'control-group'
      && resolved.node.virtualPath.endsWith('/fields');
    if (!['event', 'datasource'].includes(resolved.node.kind) && !isFieldCollection) {
      throw vscode.FileSystemError.NoPermissions('组件和按钮整体片段暂不支持直接回写，请在原始 JSON 中修改。');
    }
    const key = uri.toString();
    const baseline = this.baselines.get(key) || this._query(uri).baseline;
    if (baseline && pageSegmentFingerprint(resolved.source, resolved.node) !== baseline) {
      throw vscode.FileSystemError.Unavailable('原 JSON 已在其他位置发生变化，请关闭虚拟文件后重新打开。');
    }
    const edited = Buffer.from(content).toString('utf8');
    return this._withLock(resolved.filePath, async () => {
      const latest = this._resolve(uri);
      const latestBaseline = this.baselines.get(key) || baseline;
      if (latestBaseline && pageSegmentFingerprint(latest.source, latest.node) !== latestBaseline) {
        throw vscode.FileSystemError.Unavailable('原 JSON 已在其他位置发生变化，请关闭虚拟文件后重新打开。');
      }
      let result;
      try {
        result = rewritePageSegment(latest.source, latest.virtualPath, edited, latest.filePath);
      } catch (error) {
        throw vscode.FileSystemError.Unavailable(error.message);
      }
      await atomicWriteUtf8(latest.filePath, result.source);
      const updatedSource = fs.readFileSync(latest.filePath, 'utf8');
      const updatedNode = findPageNode(parsePageComponents(updatedSource, latest.filePath), latest.virtualPath);
      if (updatedNode) this.baselines.set(key, pageSegmentFingerprint(updatedSource, updatedNode));
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    });
  }

  refreshSource(filePath) {
    for (const key of this.baselines.keys()) {
      try {
        const uri = vscode.Uri.parse(key);
        if (this._query(uri).filePath === filePath) {
          this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        }
      } catch {
        // Ignore stale virtual URI keys.
      }
    }
  }
}

class GuthonSvnTreeProvider {
  constructor(onRepositoriesChanged = null) {
    this.repositories = [];
    this.pages = [];
    this.watchers = [];
    this.pageStructureCache = new Map();
    this.onPageFileChange = null;
    this.onRepositoriesChanged = onRepositoriesChanged;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.refresh();
  }

  dispose() {
    this._disposeWatchers();
    this._onDidChangeTreeData.dispose();
  }

  _disposeWatchers() {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  _watchRepositories() {
    this._disposeWatchers();
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get('autoRefresh', true)) return;
    for (const repository of this.repositories) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(repository.root, 'pages/*/index.md')
      );
      const refresh = () => this.refresh(false);
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.watchers.push(watcher);

      const pageWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(repository.root, 'pages/**/*.json')
      );
      const refreshPage = (uri) => {
        this.pageStructureCache.delete(uri.fsPath);
        this.onPageFileChange?.(uri.fsPath);
        this._onDidChangeTreeData.fire(undefined);
      };
      pageWatcher.onDidCreate(refreshPage);
      pageWatcher.onDidChange(refreshPage);
      pageWatcher.onDidDelete(refreshPage);
      this.watchers.push(pageWatcher);
    }
  }

  refresh(rebuildWatchers = true) {
    this.pageStructureCache.clear();
    const roots = discoverRepositoryRoots();
    this.repositories = roots.map((root) => {
      const { productId, infoPath } = readProductInfo(root);
      const layout = describeWorkspace(root);
      let systems = loadPageIndexes(path.join(root, 'pages'));
      if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get('showMissingPages', false)) {
        systems = removeMissingPages(systems);
      }
      const repository = {
        kind: 'repository',
        label: productId ? `谷神产品 ${productId}` : path.basename(root),
        root,
        infoPath,
        productId,
        layout: layout.kind,
        workingCopies: layout.workingCopies,
        children: systems
      };
      for (const system of systems) system.repositoryRoot = root;
      return repository;
    });
    this.pages = this.repositories.flatMap((repository) => collectPages(repository.children)
      .map((page) => ({ ...page, repositoryRoot: repository.root, productId: repository.productId })));
    if (rebuildWatchers) this._watchRepositories();
    vscode.commands.executeCommand('setContext', 'guthonSvnNavigator.hasRepository', this.repositories.length > 0);
    this.onRepositoriesChanged?.(this.repositories);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      item.command = { command: 'guthonSvnNavigator.selectRepository', title: '选择 SVN 工作副本' };
      item.tooltip = '点击选择旧式单工作副本，或包含多个独立 checkout 的谷神项目目录';
      return item;
    }

    const hasVirtualChildren = isJsonPage(element)
      || (VIRTUAL_NODE_KINDS.has(element.kind) && element.children?.length > 0);
    const collapsible = element.kind === 'page'
      ? (hasVirtualChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
      : element.kind === 'repository'
        ? vscode.TreeItemCollapsibleState.Expanded
        : hasVirtualChildren || ['system', 'directory', 'menu'].includes(element.kind)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.id = this.nodeId(element);
    item.contextValue = `guthonSvn.${element.kind}`;

    if (element.kind === 'repository') {
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = element.layout === 'composite'
        ? `${element.children.length} 个系统 · ${element.workingCopies.length} 个工作副本`
        : `${element.children.length} 个系统`;
      item.tooltip = `${element.root}\n产品 ID：${element.productId || '-'}\n工作区模式：${element.layout === 'composite' ? '分片 checkout' : '完整工作副本'}`;
    } else if (element.kind === 'system') {
      item.iconPath = new vscode.ThemeIcon('server');
      item.description = vscode.workspace.getConfiguration(CONFIG_SECTION).get('showIds', false)
        ? element.systemId
        : `${countPages(element)} 个页面对象`;
      item.tooltip = `${element.label} (${element.systemId})\n${element.indexPath}`;
    } else if (element.kind === 'directory') {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = `${countPages(element)} 项`;
    } else if (element.kind === 'menu') {
      item.iconPath = new vscode.ThemeIcon('list-tree');
      item.description = `${countPages(element)} 项`;
    } else if (element.kind === 'page') {
      const missing = !element.filePath || !fs.existsSync(element.filePath);
      item.iconPath = new vscode.ThemeIcon(missing ? 'warning' : iconForPageType(element.pageType));
      item.description = missing ? `缺失 · ${element.pageType}` : element.pageType;
      item.resourceUri = element.filePath ? vscode.Uri.file(element.filePath) : undefined;
      item.tooltip = `${missing ? '索引目标文件缺失\n' : ''}${element.pageType}：${element.label}\n${element.filePath || element.linkTarget}`;
      if (!isJsonPage(element)) {
        item.command = {
          command: 'guthonSvnNavigator.openPage',
          title: '打开页面文件',
          arguments: [element]
        };
      }
    } else if ([...VIRTUAL_NODE_KINDS, 'page-empty', 'page-error'].includes(element.kind)) {
      item.iconPath = new vscode.ThemeIcon(
        element.kind === 'page-error' ? 'error' : element.kind === 'page-empty' ? 'info' : iconForVirtualNode(element)
      );
      item.description = element.description;
      item.tooltip = element.tooltip || `${element.label}${element.description ? `\n${element.description}` : ''}\n${element.filePath}`;
      if (!hasVirtualChildren) {
        item.command = {
          command: VIRTUAL_NODE_KINDS.has(element.kind)
            ? 'guthonSvnNavigator.openSegment'
            : 'guthonSvnNavigator.openPage',
          title: VIRTUAL_NODE_KINDS.has(element.kind) ? '只查看当前段' : '打开原文件',
          arguments: [element]
        };
      }
    }
    return item;
  }

  getChildren(element) {
    if (!element) {
      return this.repositories.length
        ? this.repositories
        : [{ kind: 'empty', label: '未找到谷神 SVN 工作副本', children: [] }];
    }
    if (isJsonPage(element)) return this._pageChildren(element);
    return element.children || [];
  }

  _pageChildren(element) {
    try {
      const stat = fs.statSync(element.filePath);
      const cached = this.pageStructureCache.get(element.filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.children;
      const children = parsePageComponents(fs.readFileSync(element.filePath, 'utf8'), element.filePath);
      const result = children.length ? children : [{
        kind: 'page-empty',
        label: '未识别到页面控件，点击打开原文件',
        filePath: element.filePath,
        children: []
      }];
      this.pageStructureCache.set(element.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, children: result });
      return result;
    } catch (error) {
      return [{
        kind: 'page-error',
        label: '页面 JSON 解析失败，点击查看原文件',
        description: error.message,
        tooltip: `${error.message}\n${element.filePath}`,
        filePath: element.filePath,
        children: []
      }];
    }
  }

  nodeId(element) {
    if (element.kind === 'repository') return `repository:${element.root}`;
    if (element.kind === 'page') return `page:${element.filePath || element.linkTarget}`;
    if (element.virtualPath) return `virtual:${element.filePath}:${element.virtualPath}`;
    if (element.filePath) return `${element.kind}:${element.filePath}:${element.offset || 0}`;
    return `${element.kind}:${element.indexPath || ''}:${element.systemId || ''}:${element.label}`;
  }
}

async function openPage(element) {
  if (!element?.filePath || !fs.existsSync(element.filePath)) {
    vscode.window.showErrorMessage(`页面文件不存在：${element?.filePath || element?.linkTarget || '未知路径'}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(element.filePath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  if (Number.isInteger(element.offset)) {
    const position = document.positionAt(Math.min(element.offset, document.getText().length));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }
}

async function openSegment(element) {
  if (!element?.filePath || !element?.virtualPath || !fs.existsSync(element.filePath)) {
    vscode.window.showErrorMessage('无法打开页面片段：原始文件或节点路径不存在。');
    return;
  }
  const type = virtualDocumentType(element);
  const pageName = path.basename(element.filePath, path.extname(element.filePath));
  const segmentName = safeVirtualName(`${element.label}-${element.description || ''}`);
  const source = fs.readFileSync(element.filePath, 'utf8');
  const mtime = fs.statSync(element.filePath).mtimeMs;
  const query = new URLSearchParams({
    source: element.filePath,
    path: element.virtualPath,
    version: String(mtime),
    baseline: pageSegmentFingerprint(source, element)
  }).toString();
  const uri = vscode.Uri.from({
    scheme: VIRTUAL_DOCUMENT_SCHEME,
    path: `/${safeVirtualName(pageName)}/${segmentName}.${type.extension}`,
    query
  });
  let document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId !== type.language) {
    document = await vscode.languages.setTextDocumentLanguage(document, type.language);
  }
  await vscode.window.showTextDocument(document, { preview: false });
}

async function selectRepository(provider) {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择谷神 SVN 项目目录',
    title: '请选择完整工作副本根目录，或包含 pages/procedures 等分片 checkout 的目录'
  });
  if (!selected?.length) return;
  const root = findRepositoryRoot(selected[0].fsPath);
  if (!root) {
    vscode.window.showErrorMessage('未识别到谷神 SVN 项目：需要旧式根工作副本，或 pages/* 等目录下的独立 SVN 工作副本。');
    return;
  }
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(
    'repositoryRoot',
    root,
    vscode.ConfigurationTarget.Workspace
  );
  provider.refresh();
}

async function chooseRepository(provider, placeHolder) {
  if (!provider.repositories.length) {
    vscode.window.showWarningMessage('尚未识别到谷神 SVN 工作副本。');
    return null;
  }
  if (provider.repositories.length === 1) return provider.repositories[0];
  const picked = await vscode.window.showQuickPick(
    provider.repositories.map((repository) => ({
      label: repository.label,
      description: repository.root,
      repository
    })),
    { placeHolder }
  );
  return picked?.repository || null;
}

async function searchPages(provider) {
  if (!provider.pages.length) {
    vscode.window.showWarningMessage('当前 SVN 工作副本没有可搜索的页面索引。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    provider.pages.map((page) => ({
      label: `${page.pageIcon || '📄'} ${page.label}`,
      description: `${page.pageType} · ${page.systemId}`,
      detail: page.breadcrumb,
      page
    })),
    {
      placeHolder: '输入中文页面名、系统名或页面类型',
      matchOnDescription: true,
      matchOnDetail: true
    }
  );
  if (picked) await openPage(picked.page);
}

function runSvn(args, repositoryRoot, output, token) {
  return new Promise((resolve, reject) => {
    output.appendLine(`\n$ svn ${args.join(' ')}`);
    const child = spawn('svn', args, { cwd: repositoryRoot, shell: false });
    token?.onCancellationRequested(() => child.kill());
    let stderr = '';
    child.stdout.on('data', (chunk) => output.append(chunk.toString()));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      output.append(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error('SVN 命令已取消'));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `svn 退出码 ${code}`));
    });
  });
}

async function runSvnCommit(message, filePaths, repositoryRoot, output, token) {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'guthon-svn-commit-'));
  const messagePath = path.join(temporaryDirectory, 'message.txt');
  try {
    // SVN 服务端对 -m 参数的默认编码不一致；统一通过 UTF-8 文件传递提交说明。
    await fs.promises.writeFile(messagePath, message, 'utf8');
    return await runSvn(
      svnArgs(['commit', '-F', messagePath, '--encoding', 'UTF-8', '--depth', 'empty', '--', ...filePaths]),
      repositoryRoot,
      output,
      token
    );
  } finally {
    await fs.promises.unlink(messagePath).catch(() => {});
    await fs.promises.rmdir(temporaryDirectory).catch(() => {});
  }
}

function runSvnCapture(args, repositoryRoot, output, token) {
  return new Promise((resolve, reject) => {
    output?.appendLine(`\n$ svn ${args.join(' ')}`);
    const child = spawn('svn', args, { cwd: repositoryRoot, shell: false });
    token?.onCancellationRequested(() => child.kill());
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      output?.append(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      output?.append(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error('SVN 命令已取消'));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `svn 退出码 ${code}`));
    });
  });
}

const SVN_STATUS_META = {
  modified: { label: '已修改', icon: 'diff-modified' },
  added: { label: '新增', icon: 'diff-added' },
  deleted: { label: '删除', icon: 'diff-removed' },
  replaced: { label: '替换', icon: 'diff-renamed' },
  conflicted: { label: '冲突', icon: 'warning' },
  missing: { label: '缺失', icon: 'warning' },
  obstructed: { label: '阻塞', icon: 'error' },
  unversioned: { label: '未纳入版本控制', icon: 'circle-filled' },
  incomplete: { label: '不完整', icon: 'warning' }
};

function scmIdForRoot(root) {
  return `guthonSvn-${Buffer.from(root).toString('hex').slice(0, 12)}`;
}

class SvnSourceControl {
  constructor(repository, output) {
    this.repository = repository;
    this.output = output;
    this.sourceControl = vscode.scm.createSourceControl(
      scmIdForRoot(repository.root),
      repository.label,
      vscode.Uri.file(repository.root)
    );
    this.sourceControl.inputBox.placeholder = '输入提交说明，然后点击提交';
    this.sourceControl.acceptInputCommand = {
      command: 'guthonSvnNavigator.commitChanges',
      title: '提交 SVN 更改',
      arguments: [repository]
    };
    this.sourceControl.statusBarCommands = [
      {
        command: 'guthonSvnNavigator.refreshSourceControl',
        title: '$(refresh) 刷新',
        arguments: [repository]
      },
      {
        command: 'guthonSvnNavigator.updateRepository',
        title: '$(cloud-download) 更新',
        arguments: [repository]
      },
      {
        command: 'guthonSvnNavigator.commitChanges',
        title: '$(check) 提交',
        arguments: [repository]
      }
    ];
    this.changes = this.sourceControl.createResourceGroup('changes', '工作副本更改');
    this.conflicts = this.sourceControl.createResourceGroup('conflicts', '冲突');
    this.unversioned = this.sourceControl.createResourceGroup('unversioned', '未纳入版本控制');
    this.conflicts.hideWhenEmpty = true;
    this.unversioned.hideWhenEmpty = true;
    this.entries = [];
  }

  async refresh() {
    try {
      const targets = svnTargets(this.repository);
      const result = await runSvnCapture(
        svnArgs(['status', '--xml', '--ignore-externals', '--', ...targets]),
        this.repository.root,
        this.output
      );
      this.entries = parseSvnStatusXml(result.stdout, this.repository.root);
      const statesFor = (entries) => entries.map((entry) => {
        const meta = SVN_STATUS_META[entry.item] || { label: entry.item, icon: 'circle-filled' };
        const displayName = readableChangeName(this.repository, entry);
        return {
          resourceUri: scmChangeUri(this.repository, entry, displayName),
          decorations: {
            iconPath: new vscode.ThemeIcon(meta.icon),
            tooltip: `${meta.label} · ${displayName}\n${path.relative(this.repository.logicalRoot || this.repository.root, entry.filePath)}`
          },
          command: {
            command: 'guthonSvnNavigator.openReadableChange',
            title: '查看脚本/SQL 可读差异',
            arguments: [entry]
          },
          contextValue: `guthonSvn.${entry.item}`
        };
      });
      this.changes.resourceStates = statesFor(this.entries.filter((entry) => (
        entry.item !== 'unversioned' && entry.item !== 'conflicted'
      )));
      this.conflicts.resourceStates = statesFor(this.entries.filter((entry) => entry.item === 'conflicted'));
      this.unversioned.resourceStates = statesFor(this.entries.filter((entry) => entry.item === 'unversioned'));
      this.sourceControl.count = this.entries.length;
    } catch (error) {
      this.entries = [];
      this.changes.resourceStates = [];
      this.conflicts.resourceStates = [];
      this.unversioned.resourceStates = [];
      this.sourceControl.count = 0;
      this.output.appendLine(`读取 SVN 变更失败：${error.message}`);
    }
  }

  dispose() {
    this.sourceControl.dispose();
  }
}

class SvnSourceControlManager {
  constructor(output) {
    this.output = output;
    this.controls = new Map();
  }

  setRepositories(repositories) {
    const sourceRepositories = sourceControlRepositories(repositories);
    const roots = new Set(sourceRepositories.map((repository) => repository.root));
    for (const [root, control] of this.controls) {
      if (!roots.has(root)) {
        control.dispose();
        this.controls.delete(root);
      }
    }
    for (const repository of sourceRepositories) {
      if (!this.controls.has(repository.root)) {
        this.controls.set(repository.root, new SvnSourceControl(repository, this.output));
      }
    }
    void this.refreshAll();
  }

  async refreshAll() {
    await Promise.all([...this.controls.values()].map((control) => control.refresh()));
  }

  async refreshForPath(filePath) {
    const control = [...this.controls.values()].find((candidate) => (
      filePath === candidate.repository.root
      || filePath.startsWith(`${candidate.repository.root}${path.sep}`)
    ));
    if (control) await control.refresh();
  }

  findByRoot(root) {
    return this.controls.get(root) || null;
  }

  controlsForLogicalRoot(root) {
    return [...this.controls.values()].filter((control) => (
      control.repository.logicalRoot === root || control.repository.root === root
    ));
  }

  dispose() {
    for (const control of this.controls.values()) control.dispose();
    this.controls.clear();
  }
}

class SvnBaseContentProvider {
  dispose() {}

  async provideTextDocumentContent(uri) {
    const query = new URLSearchParams(uri.query);
    const filePath = query.get('file') || '';
    const logicalRoot = query.get('root') || findRepositoryRoot(filePath) || path.dirname(filePath);
    const root = workingCopyForPath(logicalRoot, filePath) || logicalRoot;
    const revision = query.get('revision') || 'BASE';
    if (!filePath || !fs.existsSync(filePath)) return '';
    const result = await runSvnCapture(
      svnArgs(['cat', '-r', revision, '--', filePath]),
      root,
      null
    );
    return result.stdout;
  }
}

class ReadableDiffContentProvider {
  dispose() {}

  async provideTextDocumentContent(uri) {
    const query = new URLSearchParams(uri.query);
    const filePath = query.get('file') || '';
    const root = query.get('root') || findRepositoryRoot(filePath) || path.dirname(filePath);
    const revision = query.get('revision') || '';
    if (!filePath) return '';
    let source;
    if (revision) {
      const result = await runSvnCapture(
        svnArgs(['cat', '-r', revision, '--', filePath]),
        root,
        null
      );
      source = result.stdout;
    } else {
      if (!fs.existsSync(filePath)) return '';
      source = fs.readFileSync(filePath, 'utf8');
    }
    if (path.extname(filePath).toLowerCase() !== '.json') return source;
    try {
      if (isPageJsonPath(filePath)) return formatReadablePageScripts(source);
      return `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
    } catch {
      return source;
    }
  }
}

class ScmChangeContentProvider {
  dispose() {}

  async provideTextDocumentContent(uri) {
    const filePath = new URLSearchParams(uri.query).get('source') || '';
    if (!filePath) return '未找到对应的 SVN 源文件。';
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return `源文件已不存在：${filePath}`;
    }
  }
}

async function openChange(entry, readable = false) {
  if (entry instanceof vscode.Uri) entry = { resourceUri: entry };
  if (entry?.resourceUri && !entry.filePath) {
    const resourceUri = entry.resourceUri;
    const filePath = resourceUri.scheme === SCM_CHANGE_DOCUMENT_SCHEME
      ? new URLSearchParams(resourceUri.query).get('source') || ''
      : resourceUri.fsPath;
    const logicalRoot = findRepositoryRoot(filePath) || path.dirname(filePath);
    entry = {
      filePath,
      relativePath: path.relative(logicalRoot, filePath),
      item: 'modified'
    };
  }
  if (!entry?.filePath || !fs.existsSync(entry.filePath)) return;
  const logicalRoot = findRepositoryRoot(entry.filePath) || path.dirname(entry.filePath);
  const root = workingCopyForPath(logicalRoot, entry.filePath) || logicalRoot;
  const isJson = path.extname(entry.filePath).toLowerCase() === '.json';
  const isPageJson = isPageJsonPath(entry.filePath);
  const useReadableProjection = readable && isJson;
  const currentUri = useReadableProjection
    ? vscode.Uri.from({
      scheme: READABLE_DIFF_DOCUMENT_SCHEME,
      path: readableDiffPath(entry.filePath),
      query: new URLSearchParams({ file: entry.filePath, root }).toString()
    })
    : vscode.Uri.file(entry.filePath);
  if (['unversioned', 'added'].includes(entry.item)) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(currentUri), { preview: false });
    return;
  }
  try {
    const baseUri = vscode.Uri.from({
      scheme: useReadableProjection ? READABLE_DIFF_DOCUMENT_SCHEME : SVN_BASE_DOCUMENT_SCHEME,
      path: useReadableProjection ? readableDiffPath(entry.filePath) : `/${safeVirtualName(path.basename(entry.filePath))}`,
      query: new URLSearchParams({
        file: entry.filePath,
        root,
        revision: 'BASE'
      }).toString()
    });
    try {
      await runSvnCapture(
        svnArgs(['cat', '-r', 'BASE', '--', entry.filePath]),
        root,
        null
      );
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取 SVN 基线，未打开差异：${error.message}`);
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri,
      currentUri,
      `${entry.relativePath}${useReadableProjection ? isPageJson ? '（事件脚本与 SQL 可读差异）' : '（格式化可读差异）' : '（真实文件差异）'}（SVN 基线 ↔ 工作区）`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`打开 SVN 差异失败：${error.message}`);
  }
}

async function openReadableChange(entry) {
  await openChange(entry, true);
}

function filePathFromCommandValue(value) {
  if (typeof value === 'string') return value;
  const resourceUri = value instanceof vscode.Uri ? value : value?.resourceUri;
  if (resourceUri?.scheme === SCM_CHANGE_DOCUMENT_SCHEME) {
    return new URLSearchParams(resourceUri.query).get('source') || '';
  }
  return resourceUri?.fsPath || value?.filePath || value?.fsPath || '';
}

function historyDate(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value || '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(time));
}

async function showFileHistory(value) {
  const filePath = filePathFromCommandValue(value);
  if (!filePath || !fs.existsSync(filePath)) return;
  const logicalRoot = findRepositoryRoot(filePath) || path.dirname(filePath);
  const root = workingCopyForPath(logicalRoot, filePath) || logicalRoot;
  try {
    const result = await runSvnCapture(svnArgs(['log', '--xml', '-l', '50', '--', filePath]), root, null);
    const entries = parseSvnLogXml(result.stdout);
    if (!entries.length) {
      vscode.window.showInformationMessage('该文件没有可显示的 SVN 历史版本。');
      return;
    }
    const picked = await vscode.window.showQuickPick(entries.map((entry) => ({
      label: `r${entry.revision} · ${entry.author} · ${historyDate(entry.date)}`,
      description: entry.message.split(/\r?\n/)[0] || '（无提交说明）',
      detail: entry.message || '（无提交说明）',
      entry
    })), {
      title: `SVN 文件历史 · ${path.basename(filePath)}`,
      placeHolder: '选择一个版本打开或比较'
    });
    if (!picked) return;
    const action = await vscode.window.showQuickPick([
      { label: '与当前文件比较', detail: `r${picked.entry.revision} ↔ 当前工作区`, action: 'diff-current' },
      { label: '打开该历史版本', detail: `只读打开 r${picked.entry.revision}`, action: 'open' }
    ], { title: `r${picked.entry.revision} · ${path.basename(filePath)}` });
    if (!action) return;
    const revisionUri = vscode.Uri.from({
      scheme: SVN_BASE_DOCUMENT_SCHEME,
      path: `/${safeVirtualName(path.basename(filePath))}`,
      query: new URLSearchParams({ file: filePath, root, revision: picked.entry.revision }).toString()
    });
    if (action.action === 'open') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(revisionUri), { preview: false });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      revisionUri,
      vscode.Uri.file(filePath),
      `${path.basename(filePath)}（r${picked.entry.revision} ↔ 当前文件）`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`读取 SVN 文件历史失败：${error.message}`);
  }
}

async function addUnversionedChange(sourceControlManager, value) {
  const resourceUri = value instanceof vscode.Uri ? value : value?.resourceUri;
  const filePath = resourceUri?.scheme === SCM_CHANGE_DOCUMENT_SCHEME
    ? new URLSearchParams(resourceUri.query).get('source') || ''
    : resourceUri?.fsPath || value?.filePath || '';
  const control = [...sourceControlManager.controls.values()].find((candidate) => (
    candidate.entries.some((entry) => entry.filePath === filePath && entry.item === 'unversioned')
  ));
  if (!control || !filePath) return;
  try {
    await runSvn(
      svnArgs(['add', '--', filePath]),
      control.repository.root,
      sourceControlManager.output
    );
    await control.refresh();
    vscode.window.showInformationMessage(`已加入 SVN：${path.basename(filePath)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`加入 SVN 失败：${error.message}`);
  }
}

async function updateRepository(provider, output, element) {
  const repository = element?.kind === 'repository'
    ? element
    : await chooseRepository(provider, '选择要更新的 SVN 工作副本');
  if (!repository) return;
  output.show(true);
  const targets = svnTargets(repository);
  const results = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在全量更新 ${repository.label}（${targets.length} 个工作副本）`,
    cancellable: true
  }, async (progress, token) => {
    for (let index = 0; index < targets.length; index += 1) {
      if (token.isCancellationRequested) break;
      const target = targets[index];
      progress.report({
        message: `${index + 1}/${targets.length} · ${path.relative(repository.root, target) || path.basename(target)}`,
        increment: 100 / targets.length
      });
      try {
        await runSvn(svnArgs(['update', '--', target]), target, output, token);
        results.push({ target, ok: true });
      } catch (error) {
        results.push({ target, ok: false, error });
      }
    }
  });
  provider.refresh();
  const failed = results.filter((result) => !result.ok);
  if (!failed.length && results.length === targets.length) {
    vscode.window.showInformationMessage(`SVN 全量更新完成：${results.length} 个工作副本。`);
  } else {
    const names = failed.map((result) => path.relative(repository.root, result.target) || path.basename(result.target));
    vscode.window.showWarningMessage(`SVN 全量更新未完全成功：${results.length - failed.length}/${targets.length} 成功。失败：${names.join('、') || '已取消'}；详情见 Guthon SVN 输出。`);
  }
}

async function updateAll(provider, output) {
  const repository = await chooseRepository(provider, '选择要全量更新的谷神项目');
  if (repository) await updateRepository(provider, output, repository);
}

async function showRepositoryStatus(provider, output, element) {
  const repository = element?.kind === 'repository'
    ? element
    : await chooseRepository(provider, '选择要查看状态的 SVN 工作副本');
  if (!repository) return;
  output.show(true);
  try {
    await runSvn(svnArgs(['status', '--', ...svnTargets(repository)]), repository.root, output);
  } catch (error) {
    vscode.window.showErrorMessage(`读取 SVN 状态失败：${error.message}`);
  }
}

function isCommittableEntry(entry) {
  return entry && entry.item !== 'unversioned' && entry.item !== 'conflicted';
}

async function chooseCommitControl(sourceControlManager, logicalRoot) {
  const controls = sourceControlManager.controlsForLogicalRoot(logicalRoot)
    .filter((control) => control.entries.some(isCommittableEntry));
  if (controls.length === 1) return controls[0];
  if (!controls.length) {
    vscode.window.showInformationMessage('当前没有可提交的已纳入 SVN 的更改；未纳入版本控制的文件请先使用通用 SVN 扩展执行“Add”。');
    return null;
  }
  const picked = await vscode.window.showQuickPick(controls.map((control) => ({
    label: control.repository.label,
    description: `${control.entries.filter(isCommittableEntry).length} 个可提交更改`,
    detail: path.relative(control.repository.logicalRoot, control.repository.root),
    control
  })), {
    title: '选择一个中文存储库提交',
    placeHolder: '独立 checkout 必须分别提交，不能合并为一条 SVN commit'
  });
  return picked?.control || null;
}

async function chooseCommitEntries(control) {
  const entries = control.entries.filter(isCommittableEntry);
  if (!entries.length) return [];
  const picked = await vscode.window.showQuickPick(entries.map((entry) => {
    const meta = SVN_STATUS_META[entry.item] || { label: entry.item };
    return {
      label: `${meta.label} · ${readableChangeName(control.repository, entry)}`,
      description: entry.relativePath,
      picked: true,
      entry
    };
  }), {
    canPickMany: true,
    title: `选择要提交的文件 · ${control.repository.label}`,
    placeHolder: '默认全选；取消勾选即可排除文件'
  });
  return picked?.map((item) => item.entry) || [];
}

async function commitChanges(provider, sourceControlManager, element) {
  let repository = element?.kind === 'repository' ? element : null;
  if (!repository && element?.repositoryRoot) {
    repository = provider.repositories.find((candidate) => candidate.root === element.repositoryRoot) || null;
  }
  if (!repository) repository = await chooseRepository(provider, '选择要提交的 SVN 工作副本');
  if (!repository) return;

  let control = sourceControlManager.findByRoot(repository.root);
  if (!control) control = await chooseCommitControl(sourceControlManager, repository.root);
  if (!control) return;

  const entries = await chooseCommitEntries(control);
  if (!entries.length) return;
  const inputMessage = control.sourceControl.inputBox.value?.trim() || '';
  const message = inputMessage || await vscode.window.showInputBox({
    prompt: `提交 ${control.repository.label} 的 ${entries.length} 个文件`,
    placeHolder: '请输入提交说明（必填）',
    validateInput: (value) => value.trim() ? undefined : '提交说明不能为空'
  });
  if (!message?.trim()) return;

  try {
    const filePaths = entries.map((entry) => entry.filePath);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `正在提交 ${control.repository.label}（${filePaths.length} 个文件）`,
      cancellable: true
    }, (_progress, token) => runSvnCommit(
      message.trim(),
      filePaths,
      control.repository.root,
      sourceControlManager.output,
      token
    ));
    control.sourceControl.inputBox.value = '';
    await sourceControlManager.refreshAll();
    provider.refresh();
    vscode.window.showInformationMessage('SVN 提交完成。');
  } catch (error) {
    vscode.window.showErrorMessage(`SVN 提交失败：${error.message}`);
  }
}

async function refreshSourceControl(sourceControlManager, element) {
  const root = element?.root;
  const control = root ? sourceControlManager.findByRoot(root) : null;
  if (control) await control.refresh();
  else await sourceControlManager.refreshAll();
}

function activate(context) {
  let sourceControlManager;
  const provider = new GuthonSvnTreeProvider((repositories) => sourceControlManager?.setRepositories(repositories));
  const segmentProvider = new PageSegmentFileSystemProvider();
  const baseContentProvider = new SvnBaseContentProvider();
  const readableDiffProvider = new ReadableDiffContentProvider();
  const scmChangeProvider = new ScmChangeContentProvider();
  provider.onPageFileChange = (filePath) => segmentProvider.refreshSource(filePath);
  const output = vscode.window.createOutputChannel('Guthon SVN');
  sourceControlManager = new SvnSourceControlManager(output);
  sourceControlManager.setRepositories(provider.repositories);
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  context.subscriptions.push(
    provider,
    segmentProvider,
    baseContentProvider,
    readableDiffProvider,
    scmChangeProvider,
    sourceControlManager,
    output,
    treeView,
    vscode.workspace.registerFileSystemProvider(VIRTUAL_DOCUMENT_SCHEME, segmentProvider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode.workspace.registerTextDocumentContentProvider(SVN_BASE_DOCUMENT_SCHEME, baseContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(READABLE_DIFF_DOCUMENT_SCHEME, readableDiffProvider),
    vscode.workspace.registerTextDocumentContentProvider(SCM_CHANGE_DOCUMENT_SCHEME, scmChangeProvider),
    vscode.commands.registerCommand('guthonSvnNavigator.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('guthonSvnNavigator.searchPages', () => searchPages(provider)),
    vscode.commands.registerCommand('guthonSvnNavigator.openPage', openPage),
    vscode.commands.registerCommand('guthonSvnNavigator.openSegment', openSegment),
    vscode.commands.registerCommand('guthonSvnNavigator.revealInSource', openPage),
    vscode.commands.registerCommand('guthonSvnNavigator.openIndex', (element) => openPage({ filePath: element?.indexPath })),
    vscode.commands.registerCommand('guthonSvnNavigator.selectRepository', () => selectRepository(provider)),
    vscode.commands.registerCommand('guthonSvnNavigator.updateRepository', (element) => updateRepository(provider, output, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.updateAll', () => updateAll(provider, output)),
    vscode.commands.registerCommand('guthonSvnNavigator.showStatus', (element) => showRepositoryStatus(provider, output, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.commitChanges', (element) => commitChanges(provider, sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.refreshSourceControl', (element) => refreshSourceControl(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.openChange', openChange),
    vscode.commands.registerCommand('guthonSvnNavigator.openReadableChange', openReadableChange),
    vscode.commands.registerCommand('guthonSvnNavigator.showFileHistory', showFileHistory),
    vscode.commands.registerCommand('guthonSvnNavigator.addUnversionedChange', (element) => addUnversionedChange(sourceControlManager, element)),
    vscode.workspace.onDidSaveTextDocument((document) => sourceControlManager.refreshForPath(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => sourceControlManager.refreshForPath(uri.fsPath))),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => sourceControlManager.refreshForPath(uri.fsPath))),
    vscode.workspace.onDidRenameFiles((event) => event.files.forEach((file) => {
      sourceControlManager.refreshForPath(file.oldUri.fsPath);
      sourceControlManager.refreshForPath(file.newUri.fsPath);
    })),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) provider.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );
}

function deactivate() {}

module.exports = { activate, deactivate, discoverRepositoryRoots, findRepositoryRoot, isRepositoryRoot };
