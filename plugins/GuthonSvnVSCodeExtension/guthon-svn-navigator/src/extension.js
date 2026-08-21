'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const {
  collectPages,
  extractPageSegment,
  findPageNode,
  formatReadablePageScripts,
  jsonStringAtParts,
  loadPageIndexes,
  parsePageComponents,
  pageSegmentFingerprint,
  readProductInfo,
  rewritePageSegment,
  rewriteJsonStringAtParts
} = require('./page-index');
const { parseSvnRemoteStatusXml, parseSvnStatusXml } = require('./svn-status');
const { parseSvnLogXml } = require('./svn-log');
const { resolveSvnExecutable } = require('./svn-executable');
const {
  describeWorkspace,
  discoverWorkingCopyRoots,
  discoverProjectRoots,
  findLogicalWorkspaceRoot,
  isLogicalWorkspaceRoot,
  workingCopyForPath
} = require('./workspace-layout');
const { createGssLanguageProviders } = require('./gss-language');
const { isPathWithin, pathKey, samePath } = require('./path-utils');
const {
  configuredProjectRootsForPath,
  ensureProjectConfig,
  readProjectConfigurations,
  resolveProjectRoot
} = require('./project-config');

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
const SOURCE_NODE_KINDS = new Set([
  'source-category',
  'source-scope',
  'source-directory',
  'source-file'
]);

let cachedSvnExecutable = null;
let cachedSvnExecutableSetting = null;
let lastSvnExecutableNoticeAt = 0;
let lastSvnStatusNoticeAt = 0;
let extensionState = null;
const SVN_EXECUTABLE_STATE_KEY = 'guthonSvnNavigator.svnExecutable';

function resetSvnExecutableCache() {
  cachedSvnExecutable = null;
  cachedSvnExecutableSetting = null;
}

function svnExecutablePath() {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredPath = configuration.inspect('svnExecutable')
    ? String(configuration.get('svnExecutable', '') || '').trim()
    : '';
  const storedPath = String(extensionState?.globalState.get(SVN_EXECUTABLE_STATE_KEY, '') || '').trim();
  const selectedPath = configuredPath || storedPath;
  if (cachedSvnExecutable && cachedSvnExecutableSetting === selectedPath) return cachedSvnExecutable;
  cachedSvnExecutable = resolveSvnExecutable({ configuredPath: selectedPath });
  cachedSvnExecutableSetting = selectedPath;
  return cachedSvnExecutable;
}

function executableForLog(executable) {
  return /\s/.test(executable) ? `"${executable}"` : executable;
}

function notifyMissingSvn(error, output) {
  if (error?.code !== 'SVN_EXECUTABLE_NOT_FOUND') return;
  output?.appendLine(error.message);
  const now = Date.now();
  if (now - lastSvnExecutableNoticeAt < 5000) return;
  lastSvnExecutableNoticeAt = now;
  void vscode.window.showErrorMessage(
    `${error.message} SVN 变更列表暂时无法读取。`,
    '选择 SVN 程序',
    '打开设置',
    '查看输出'
  ).then((action) => {
    if (action === '选择 SVN 程序') {
      void vscode.commands.executeCommand('guthonSvnNavigator.configureSvnExecutable');
    } else if (action === '打开设置') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'guthonSvnNavigator.svnExecutable');
    } else if (action === '查看输出') {
      output?.show(true);
    }
  });
}

function notifySvnStatusFailure(error, output) {
  if (error?.code === 'SVN_EXECUTABLE_NOT_FOUND') {
    notifyMissingSvn(error, output);
    return;
  }
  const now = Date.now();
  if (now - lastSvnStatusNoticeAt < 5000) return;
  lastSvnStatusNoticeAt = now;
  const firstLine = String(error?.message || error).split(/\r?\n/)[0];
  void vscode.window.showWarningMessage(
    `读取 SVN 变更失败：${firstLine}`,
    '查看输出'
  ).then((action) => {
    if (action === '查看输出') output?.show(true);
  });
}

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
  const addRootsForPath = (startPath) => {
    if (!startPath) return;

    // 项目配置也是中文源码树的项目来源。SVN SCM 必须优先复用同一批
    // path 映射，避免目录树已显示 gmeSvn、变更检测却仍指向其父目录。
    const configuredRoots = configuredProjectRootsForPath(startPath).filter(isRepositoryRoot);
    if (configuredRoots.length) {
      configuredRoots.forEach((root) => roots.add(root));
      return;
    }

    // 先检查当前目录及其直接子项目，再向上寻找所属项目。这样打开
    // codes/gme 之类共同父目录时，不会被外层残留 SVN 结构截获。
    const discovered = discoverProjectRoots(startPath);
    if (discovered.length) {
      discovered.forEach((root) => roots.add(root));
      return;
    }
    const ancestor = findRepositoryRoot(startPath);
    if (ancestor) roots.add(ancestor);
  };

  const configured = expandHome(vscode.workspace.getConfiguration(CONFIG_SECTION).get('repositoryRoot', '').trim());
  addRootsForPath(configured);

  for (const folder of vscode.workspace.workspaceFolders || []) {
    addRootsForPath(folder.uri.fsPath);
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

function selectProjectDictionaryBlock(source, projectId) {
  const lines = source.split(/\r?\n/);
  const projectsIndex = lines.findIndex((line) => line.trim() === 'projects:');
  if (projectsIndex === -1) return source;
  const expected = String(projectId || '').trim();
  let start = -1;
  let headerIndent = -1;
  for (let index = projectsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const mapping = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/);
    const list = line.trim().match(/^-\s*(?:id|project_id):\s*(.+)$/);
    const id = mapping ? mapping[1] : list ? yamlScalar(list[1]) : '';
    if (indent <= 0) break;
    if (id === expected) {
      start = index;
      headerIndent = indent;
      break;
    }
  }
  if (start === -1) return source;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const isSibling = indent === headerIndent && (
      /^([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/.test(line.trim())
      || /^-\s*(?:id|project_id):\s*/.test(line.trim())
    );
    if (isSibling) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function readProjectCodeDictionary(root, projectId = path.basename(path.resolve(root))) {
  const dictionary = {
    dataSources: new Map(),
    systems: new Map(),
    systemOrder: new Map()
  };
  let source = '';
  let current = path.resolve(root);
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const candidates = [
      path.join(current, 'docs', 'guthon-projects.yaml'),
      path.join(current, 'docs', '谷神项目配置.yaml'),
      path.join(current, 'docs', '谷神项目编码字典.yaml'),
      path.join(current, 'guthon-projects.yaml'),
      path.join(current, '谷神项目配置.yaml'),
      path.join(current, '谷神项目编码字典.yaml')
    ];
    const dictionaryPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (dictionaryPath) {
      try {
        source = fs.readFileSync(dictionaryPath, 'utf8');
      } catch {
        source = '';
      }
      if (source) break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!source) return dictionary;
  source = selectProjectDictionaryBlock(source, projectId);

  let currentDataSource = null;
  let dataSourceOrder = -1;
  let systemOrder = 0;
  for (const line of source.split(/\r?\n/)) {
    const dataSourceMatch = line.match(/^\s*-\s+data_source_id:\s*(.+?)\s*$/);
    if (dataSourceMatch) {
      currentDataSource = yamlScalar(dataSourceMatch[1]);
      dataSourceOrder += 1;
      systemOrder = 0;
      continue;
    }
    const dataSourceNameMatch = line.match(/^\s*data_source_name:\s*(.+?)\s*$/);
    if (dataSourceNameMatch && currentDataSource) {
      dictionary.dataSources.set(currentDataSource, yamlScalar(dataSourceNameMatch[1]));
      continue;
    }
    const systemIdMatch = line.match(/^\s*-\s+system_id:\s*(.+?)\s*$/);
    if (systemIdMatch) {
      dictionary.currentSystemId = yamlScalar(systemIdMatch[1]);
      dictionary.systemOrder.set(dictionary.currentSystemId, `${String(dataSourceOrder).padStart(4, '0')}:${String(systemOrder).padStart(4, '0')}`);
      systemOrder += 1;
      continue;
    }
    const systemNameMatch = line.match(/^\s*system_name:\s*(.+?)\s*$/);
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
    const dictionary = readProjectCodeDictionary(logicalRepository.root, logicalRepository.projectId);
    const pages = new Map(collectPages(logicalRepository.children || [])
      .filter((page) => page.filePath)
      .map((page) => [pathKey(page.filePath), page]));
    return (logicalRepository.workingCopies || []).map((workingCopy) => {
      const descriptor = workingCopyDescriptor(logicalRepository, workingCopy, dictionary);
      return {
        ...logicalRepository,
        root: workingCopy,
        logicalRoot: logicalRepository.root,
        workingCopies: [workingCopy],
        // Include a provider marker so stale/other SCM providers cannot be
        // mistaken for Guthon repositories in VS Code's Source Control view.
        label: `${logicalRepository.label} · ${descriptor.label}`,
        sourceCategory: descriptor.category,
        sourceId: descriptor.id,
        pageByFilePath: pages
      };
    });
  });
}

const SOURCE_OBJECT_META = {
  procedures: { label: '过程函数', scopeLabel: '数据源', icon: 'symbol-method' },
  tables: { label: '表', scopeLabel: '数据源', icon: 'table' },
  views: { label: '视图', scopeLabel: '数据源', icon: 'eye' },
  'system-script': { label: '系统脚本', scopeLabel: '系统', icon: 'file-code' }
};

class SourceMetadataCache {
  constructor(storageRoot) {
    this.storageRoot = storageRoot;
    this.cachePath = path.join(storageRoot, 'source-object-metadata.json');
    this.entries = new Map();
    this.loaded = false;
    this.loading = null;
    this.dirty = false;
  }

  async load() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const source = await fs.promises.readFile(this.cachePath, 'utf8');
        const data = JSON.parse(source);
        for (const [filePath, entry] of Object.entries(data.entries || {})) {
          if (entry && typeof entry === 'object') this.entries.set(filePath, entry);
        }
      } catch {
        // 首次运行或缓存损坏时，按源码重新建立缓存。
      }
      this.loaded = true;
      this.loading = null;
    })();
    return this.loading;
  }

  async read(filePath, sourceCategory, fallbackName) {
    if (!['procedures', 'tables', 'views'].includes(sourceCategory)) {
      return readSourceObjectIdentity(filePath, sourceCategory, fallbackName);
    }
    await this.load();
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return { label: fallbackName, objectId: path.basename(fallbackName, path.extname(fallbackName)) };
    }
    const cached = this.entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { label: cached.label, objectId: cached.objectId };
    }
    const identity = await readSourceObjectIdentity(filePath, sourceCategory, fallbackName);
    this.entries.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      label: identity.label,
      objectId: identity.objectId
    });
    this.dirty = true;
    return identity;
  }

  async save() {
    if (!this.dirty) return;
    const entries = Object.fromEntries(this.entries);
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.storageRoot, { recursive: true });
      await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: 1, entries }), 'utf8');
      await fs.promises.rename(temporaryPath, this.cachePath);
      this.dirty = false;
    } catch {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  }
}

async function sourceObjectFileEntries(directory, meta, metadataCache, parentPath = '') {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries
      .filter((entry) => entry.name !== '.DS_Store' && entry.name !== '.svn')
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.join(parentPath, entry.name);
      if (entry.isDirectory()) {
        result.push({
          kind: 'source-directory',
          label: entry.name,
          sourceCategory: meta.sourceCategory,
          sourceId: meta.sourceId,
          repositoryRoot: meta.repositoryRoot,
          sourceRoot: filePath,
          relativePath,
          children: await sourceObjectFileEntries(filePath, meta, metadataCache, relativePath)
        });
        continue;
      }
      const identity = await metadataCache?.read(filePath, meta.sourceCategory, entry.name)
        || await readSourceObjectIdentity(filePath, meta.sourceCategory, entry.name);
      result.push({
        kind: 'source-file',
        label: identity.label,
        filePath,
        repositoryRoot: meta.repositoryRoot,
        sourceCategory: meta.sourceCategory,
        sourceId: meta.sourceId,
        objectId: identity.objectId,
        fileName: entry.name,
        relativePath,
        children: []
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function readSourceObjectIdentity(filePath, sourceCategory, fallbackName) {
  const fallbackId = path.basename(fallbackName, path.extname(fallbackName));
  if (sourceCategory === 'procedures') {
    try {
      // 过程函数的中文说明位于源码头部的 @description 注释中。
      const source = (await fs.promises.readFile(filePath, 'utf8')).slice(0, 65536);
      const functionId = source.match(/^\s*\*\s*@functionId\s+([^\r\n]*)$/m)?.[1]?.trim() || fallbackId;
      const description = source.match(/^\s*\*\s*@description\s*([^\r\n]*)$/m)?.[1]?.trim() || '';
      return {
        label: description ? `${description}（${functionId}）` : fallbackName,
        objectId: functionId
      };
    } catch {
      return { label: fallbackName, objectId: fallbackId };
    }
  }
  if (sourceCategory !== 'tables' && sourceCategory !== 'views') {
    return { label: fallbackName, objectId: fallbackId };
  }
  try {
    const source = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    const nameKey = sourceCategory === 'tables' ? 'tableName' : 'viewName';
    const idKey = sourceCategory === 'tables' ? 'tableId' : 'viewId';
    const name = String(source[nameKey] || '').trim();
    const objectId = String(source[idKey] || fallbackId).trim();
    return {
      label: name ? `${name}（${objectId}）` : fallbackName,
      objectId
    };
  } catch {
    return { label: fallbackName, objectId: fallbackId };
  }
}

async function buildSourceObjectGroups(logicalRepository, systems, metadataCache) {
  const dictionary = readProjectCodeDictionary(logicalRepository.root, logicalRepository.projectId);
  const systemNames = new Map((systems || []).map((system) => [system.systemId, system.label]));
  const groups = [];
  for (const [sourceCategory, categoryMeta] of Object.entries(SOURCE_OBJECT_META)) {
    const root = path.join(logicalRepository.root, sourceCategory);
    const scopeIds = fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      : [];
    const scopes = [];
    for (const sourceId of scopeIds) {
      const scopeName = sourceCategory === 'system-script'
        ? (systemNames.get(sourceId) || dictionary.systems.get(sourceId) || sourceId)
        : (dictionary.dataSources.get(sourceId) || sourceId);
      const sourceRoot = path.join(root, sourceId);
      const meta = { sourceCategory, sourceId, repositoryRoot: logicalRepository.root };
      scopes.push({
        kind: 'source-scope',
        label: `${scopeName}（${sourceId}）`,
        description: categoryMeta.scopeLabel,
        icon: categoryMeta.icon,
        sourceCategory,
        sourceId,
        sourceRoot,
        children: await sourceObjectFileEntries(sourceRoot, meta, metadataCache)
      });
    }
    groups.push({
      kind: 'source-category',
      label: categoryMeta.label,
      description: `${scopes.length} 个${categoryMeta.scopeLabel}`,
      sourceCategory,
      repositoryRoot: logicalRepository.root,
      sourceRoot: root,
      children: scopes
    });
  }
  return groups.filter((category) => category.children.length > 0);
}

function countSourceFiles(node) {
  if (node.kind === 'source-file') return 1;
  return (node.children || []).reduce((total, child) => total + countSourceFiles(child), 0);
}

function collectSourceFiles(nodes, output = []) {
  for (const node of nodes || []) {
    if (node.kind === 'source-file') output.push(node);
    collectSourceFiles(node.children, output);
  }
  return output;
}

// 搜索结果必须引用树中的原始节点，TreeView.reveal 才能沿 parent 链展开目录。
function collectPageTreeNodes(nodes, ancestors = [], output = []) {
  for (const node of nodes || []) {
    const nextAncestors = node.kind === 'page' ? ancestors : [...ancestors, node.label];
    if (node.kind === 'page') {
      node.breadcrumb = [...ancestors, node.label].join(' / ');
      output.push(node);
    }
    collectPageTreeNodes(node.children, nextAncestors, output);
  }
  return output;
}

function iconForSourceCategory(sourceCategory) {
  return {
    procedures: 'symbol-method',
    tables: 'table',
    views: 'eye',
    'system-script': 'file-code'
  }[sourceCategory] || 'file';
}

function readableChangeName(repository, entry) {
  const filePath = path.resolve(entry.filePath);
  const extension = path.extname(filePath);
  if (repository.sourceCategory === 'pages') {
    const page = repository.pageByFilePath?.get(pathKey(filePath));
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
  constructor(onRepositoriesChanged = null, metadataCache = null, extensionContext = null) {
    this.repositories = [];
    this.pages = [];
    this.searchItems = [];
    this.parentByNode = new WeakMap();
    this.treeView = null;
    this.watchers = [];
    this.pageStructureCache = new Map();
    this.metadataCache = metadataCache;
    this.extensionContext = extensionContext;
    this.activeRepositoryRoot = extensionContext?.workspaceState.get('guthonSvnNavigator.selectedProjectRoot', '');
    this.projectConfigurations = [];
    this.workspaceRoot = '';
    this.refreshPromise = null;
    this.refreshRequested = false;
    this.pendingRebuildWatchers = false;
    this.refreshTimer = null;
    this.onPageFileChange = null;
    this.onWorkingCopyFileChange = null;
    this.onRepositoriesChanged = onRepositoriesChanged;
    this.nodeDecoration = null;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  dispose() {
    this._disposeWatchers();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this._onDidChangeTreeData.dispose();
  }

  setTreeView(treeView) {
    this.treeView = treeView;
  }

  setNodeDecorationProvider(provider) {
    this.nodeDecoration = provider;
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshDecorations() {
    this._onDidChangeTreeData.fire(undefined);
  }

  visibleRepositories() {
    const active = this.repositories.find((repository) => samePath(repository.root, this.activeRepositoryRoot));
    return active ? [active] : this.repositories.slice(0, 1);
  }

  async setActiveRepository(root) {
    const selected = this.repositories.find((repository) => samePath(repository.root, root));
    if (!selected) return false;
    this.activeRepositoryRoot = selected.root;
    await this.extensionContext?.workspaceState.update(
      'guthonSvnNavigator.selectedProjectRoot',
      selected.root
    );
    this._rebuildVisibleState();
    this.onRepositoriesChanged?.(this.visibleRepositories());
    this._onDidChangeTreeData.fire(undefined);
    return true;
  }

  _rebuildVisibleState() {
    const visible = this.visibleRepositories();
    this.pages = visible.flatMap((repository) => collectPageTreeNodes(repository.systems)
      .map((page) => {
        page.repositoryRoot = repository.root;
        page.productId = repository.productId;
        return page;
      }));
    this.searchItems = [
      ...this.pages,
      ...visible.flatMap((repository) => collectSourceFiles(repository.children))
    ];
    this.parentByNode = new WeakMap();
    for (const repository of visible) this._indexParents(repository, null);
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
      const refresh = () => this._scheduleRefresh(false);
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

      for (const workingCopy of repository.workingCopies || [repository.root]) {
        const statusWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workingCopy, '**/*')
        );
        const refreshStatus = (uri) => this.onWorkingCopyFileChange?.(uri.fsPath);
        statusWatcher.onDidCreate(refreshStatus);
        statusWatcher.onDidChange(refreshStatus);
        statusWatcher.onDidDelete(refreshStatus);
        this.watchers.push(statusWatcher);
      }
    }
  }

  refresh(rebuildWatchers = true) {
    this.refreshRequested = true;
    this.pendingRebuildWatchers = this.pendingRebuildWatchers || rebuildWatchers;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._runRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  _scheduleRefresh(rebuildWatchers = false) {
    this.pendingRebuildWatchers = this.pendingRebuildWatchers || rebuildWatchers;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh(false);
    }, 300);
  }

  async _runRefresh() {
    while (this.refreshRequested) {
      this.refreshRequested = false;
      const rebuildWatchers = this.pendingRebuildWatchers;
      this.pendingRebuildWatchers = false;
      await this._refreshOnce(rebuildWatchers);
    }
  }

  async _refreshOnce(rebuildWatchers) {
    const roots = discoverRepositoryRoots();
    const configured = readProjectConfigurations(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || roots[0] || path.dirname(roots[0] || '')
    );
    this.projectConfigurations = configured.projects;
    this.workspaceRoot = configured.workspaceRoot;
    const repositories = [];
    for (const root of roots) {
      const { productId, infoPath } = readProductInfo(root);
      const layout = describeWorkspace(root);
      const projectConfig = configured.projects.find((project) => (
        samePath(resolveProjectRoot(configured.workspaceRoot, project), root)
      ));
      let systems = loadPageIndexes(path.join(root, 'pages'));
      const dictionary = readProjectCodeDictionary(root, projectConfig?.id);
      systems.sort((left, right) => (
        (dictionary.systemOrder.get(left.systemId) || `9999:${left.systemId}`)
          .localeCompare(dictionary.systemOrder.get(right.systemId) || `9999:${right.systemId}`)
      ));
      if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get('showMissingPages', false)) {
        systems = removeMissingPages(systems);
      }
      const repository = {
        kind: 'repository',
        label: projectConfig?.name || (productId ? `谷神产品 ${productId}` : path.basename(root)),
        projectId: projectConfig?.id || path.basename(root),
        root,
        infoPath,
        productId,
        layout: layout.kind,
        workingCopies: layout.workingCopies,
        systems,
        children: [...systems, ...await buildSourceObjectGroups({ root }, systems, this.metadataCache)]
      };
      for (const system of systems) system.repositoryRoot = root;
      repositories.push(repository);
    }
    this.repositories = repositories;
    if (!this.repositories.some((repository) => samePath(repository.root, this.activeRepositoryRoot))) {
      this.activeRepositoryRoot = this.repositories[0]?.root || '';
      if (this.extensionContext) {
        void this.extensionContext.workspaceState.update(
          'guthonSvnNavigator.selectedProjectRoot',
          this.activeRepositoryRoot
        );
      }
    }
    this._rebuildVisibleState();
    await this.metadataCache?.save();
    if (rebuildWatchers) this._watchRepositories();
    vscode.commands.executeCommand('setContext', 'guthonSvnNavigator.hasRepository', this.visibleRepositories().length > 0);
    vscode.commands.executeCommand('setContext', 'guthonSvnNavigator.hasMultipleProjects', this.repositories.length > 1);
    this.onRepositoriesChanged?.(this.visibleRepositories());
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
        : hasVirtualChildren
          || (SOURCE_NODE_KINDS.has(element.kind) && element.kind !== 'source-file')
          || ['system', 'directory', 'menu'].includes(element.kind)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.id = this.nodeId(element);
    item.contextValue = `guthonSvn.${element.kind}`;

    if (element.kind === 'repository') {
      item.iconPath = new vscode.ThemeIcon('archive');
      item.resourceUri = vscode.Uri.file(element.root);
      item.description = element.layout === 'composite'
        ? `${element.systems.length} 个系统 · ${element.workingCopies.length} 个工作副本`
        : `${element.systems.length} 个系统`;
      item.tooltip = `${element.root}\n产品 ID：${element.productId || '-'}\n工作区模式：${element.layout === 'composite' ? '分片 checkout' : '完整工作副本'}`;
    } else if (element.kind === 'system') {
      item.iconPath = new vscode.ThemeIcon('server');
      item.resourceUri = element.sourceRoot ? vscode.Uri.file(element.sourceRoot) : undefined;
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
    } else if (element.kind === 'source-category') {
      item.iconPath = new vscode.ThemeIcon('folder-library');
      item.resourceUri = element.sourceRoot ? vscode.Uri.file(element.sourceRoot) : undefined;
      item.description = element.description;
    } else if (element.kind === 'source-scope') {
      item.iconPath = new vscode.ThemeIcon(element.icon || 'folder');
      item.resourceUri = element.sourceRoot ? vscode.Uri.file(element.sourceRoot) : undefined;
      item.description = `${element.description} · ${countSourceFiles(element)} 项`;
      item.tooltip = `${element.label}\n${element.sourceRoot}`;
    } else if (element.kind === 'source-directory') {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.resourceUri = element.sourceRoot ? vscode.Uri.file(element.sourceRoot) : undefined;
      item.description = `${countSourceFiles(element)} 项`;
    } else if (element.kind === 'source-file') {
      item.iconPath = new vscode.ThemeIcon(iconForSourceCategory(element.sourceCategory));
      item.resourceUri = vscode.Uri.file(element.filePath);
      item.description = element.sourceCategory === 'tables'
        ? '表结构 JSON（只读）'
        : element.sourceCategory === 'views'
          ? '视图定义 JSON（只读）'
          : element.sourceCategory === 'procedures'
            ? '过程函数'
            : '系统脚本';
      item.tooltip = `${element.filePath}\n${element.objectId || element.sourceId}`;
      item.command = {
        command: 'guthonSvnNavigator.openSourceFile',
        title: '打开源码对象',
        arguments: [element]
      };
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
    const decoration = this.nodeDecoration?.(element);
    if (decoration) {
      const iconId = item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : 'file';
      item.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(decoration.color));
    }
    return item;
  }

  getChildren(element) {
    if (!element) {
      return this.visibleRepositories().length
        ? this.visibleRepositories()
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

  _indexParents(element, parent) {
    if (parent) this.parentByNode.set(element, parent);
    for (const child of element.children || []) this._indexParents(child, element);
  }

  getParent(element) {
    return this.parentByNode.get(element);
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

async function openSourceFile(element) {
  if (!element?.filePath || !fs.existsSync(element.filePath)) {
    vscode.window.showErrorMessage(`源码对象不存在：${element?.filePath || '未知路径'}`);
    return;
  }
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(vscode.Uri.file(element.filePath)),
    { preview: false }
  );
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
  const configuredProjects = provider.projectConfigurations || [];
  if (configuredProjects.length) {
    const items = configuredProjects.map((project) => {
      const projectRoot = resolveProjectRoot(provider.workspaceRoot, project);
      const repository = provider.repositories.find((item) => samePath(item.root, projectRoot));
      return {
        label: configuredProjectLabel(project),
        description: repository ? '已初始化 · 点击切换' : '未初始化 · 点击后可初始化',
        detail: projectRoot || project.path || project.id,
        project,
        repository
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: '选择当前项目',
      placeHolder: '目录树、搜索和 SVN 变更都会切换到所选项目'
    });
    if (!picked) return;
    if (picked.repository) {
      await provider.setActiveRepository(picked.repository.root);
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `项目“${configuredProjectLabel(picked.project)}”还没有初始化。`,
      '初始化此项目'
    );
    if (action === '初始化此项目') {
      await initializeProject(provider, provider.output, picked.project.id);
    }
    return;
  }
  if (provider.repositories.length > 1) {
    const picked = await vscode.window.showQuickPick(
      provider.repositories.map((repository) => ({
        label: repository.label,
        description: repository.root,
        repository
      })),
      { title: '选择当前谷神项目', placeHolder: '树目录、搜索和 SVN 变更将切换到所选项目' }
    );
    if (picked) await provider.setActiveRepository(picked.repository.root);
    return;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择谷神 SVN 项目目录',
    title: '请选择完整工作副本根目录，或包含 pages/procedures 等分片 checkout 的目录'
  });
  if (!selected?.length) return;
  const selectedPath = selected[0].fsPath;
  const root = findRepositoryRoot(selectedPath);
  const projects = readProjectConfigurations(selectedPath).projects;
  if (!root && !discoverProjectRoots(selectedPath).length && !projects.length) {
    vscode.window.showErrorMessage('未识别到谷神 SVN 项目：需要已初始化的项目，或包含项目配置的工作区目录。');
    return;
  }
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(
    'repositoryRoot',
    root || selectedPath,
    vscode.ConfigurationTarget.Workspace
  );
  provider.refresh();
}

function configuredProjectLabel(project) {
  return project.name && project.name !== project.id
    ? `${project.name} (${project.id})`
    : project.name || project.id;
}

function svnUrlForPath(repositoryUrl, relativePath) {
  return `${String(repositoryUrl || '').replace(/\/+$/, '')}/${String(relativePath).replace(/^\/+/, '')}`;
}

async function ensureProjectReadme(projectRoot) {
  const readmePath = path.join(projectRoot, 'README.md');
  const content = await fs.promises.readFile(
    path.join(__dirname, '..', 'README.md'),
    'utf8'
  );
  try {
    const existing = await fs.promises.readFile(readmePath, 'utf8');
    if (!existing.includes('This directory is managed by Guthon SVN Navigator.')) return false;
    await fs.promises.writeFile(readmePath, content, 'utf8');
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.promises.writeFile(readmePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

async function initializeProject(provider, output, projectId = '') {
  let projects = provider.projectConfigurations || [];
  const workspaceFolderRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const hasEmptyCurrentWorkspace = workspaceFolderRoot
    && !provider.repositories.length
    && !isLogicalWorkspaceRoot(workspaceFolderRoot);
  if (hasEmptyCurrentWorkspace && path.resolve(provider.workspaceRoot || '') !== path.resolve(workspaceFolderRoot)) {
    try {
      const localConfig = await ensureProjectConfig(workspaceFolderRoot, { localOnly: true });
      if (localConfig.created) {
        const readmeCreated = await ensureProjectReadme(workspaceFolderRoot);
        await provider.refresh();
        vscode.window.showInformationMessage(
          `已在当前工作区生成 ${localConfig.configPath}${readmeCreated ? ' 和插件 README.md' : ''}。请填写 SVN 用户名和项目地址后，再执行初始化。`
        );
        return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`生成当前项目配置失败：${error.message}`);
      return;
    }
  }
  if (!projects.length) {
    const workspaceRoot = workspaceFolderRoot
      || provider.workspaceRoot
      || '';
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('未找到工作区目录，无法生成 guthon-projects.yaml。');
      return;
    }
    let configResult;
    try {
      configResult = await ensureProjectConfig(workspaceRoot);
    } catch (error) {
      vscode.window.showErrorMessage(`生成 guthon-projects.yaml 失败：${error.message}`);
      return;
    }
    if (configResult.created) {
      const readmeCreated = await ensureProjectReadme(workspaceRoot);
      await provider.refresh();
      vscode.window.showInformationMessage(
        `已生成 ${configResult.configPath}${readmeCreated ? ' 和插件 README.md' : ''}。请先填写 SVN 用户名和新项目地址，再重新执行初始化。`
      );
      return;
    }
    await provider.refresh();
    projects = provider.projectConfigurations || [];
    if (!projects.length) {
      vscode.window.showWarningMessage('guthon-projects.yaml 中没有可用项目配置。');
      return;
    }
  }
  let project;
  if (projectId) {
    project = projects.find((item) => item.id === projectId);
    if (!project) return;
  } else {
    const picked = await vscode.window.showQuickPick(
      projects.map((item) => ({
        label: configuredProjectLabel(item),
        description: item.repositoryUrl || '未配置 SVN 地址',
        detail: item.path || item.id,
        project: item
      })),
      { title: '初始化谷神项目', placeHolder: '按配置创建项目目录并拉取对应 SVN 源码' }
    );
    if (!picked) return;
    project = picked.project;
  }
  const projectRoot = resolveProjectRoot(provider.workspaceRoot, project);
  if (!projectRoot || !project.repositoryUrl) {
    vscode.window.showErrorMessage(`项目“${configuredProjectLabel(project)}”缺少有效的 path 或 repository_url 配置。`);
    return;
  }
  const checkoutPaths = [...new Set([
    ...project.checkoutPaths,
    ...(project.checkoutPaths.length ? [] : ['skill', 'public'])
  ])];
  if (!checkoutPaths.length) {
    vscode.window.showErrorMessage(`项目“${configuredProjectLabel(project)}”没有配置 checkout_paths 或源码路径。`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `确认初始化“${configuredProjectLabel(project)}”吗？\n目录：${projectRoot}\n将根据配置拉取 ${checkoutPaths.length} 个 SVN 工作副本。`,
    { modal: true },
    '开始初始化'
  );
  if (confirmed !== '开始初始化') return;
  await fs.promises.mkdir(projectRoot, { recursive: true });
  output.show(true);
  const failures = [];
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在初始化 ${configuredProjectLabel(project)}`,
    cancellable: true
  }, async (progress, token) => {
    for (let index = 0; index < checkoutPaths.length; index += 1) {
      if (token.isCancellationRequested) break;
      const relativePath = checkoutPaths[index].replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!relativePath) continue;
      const target = path.resolve(projectRoot, relativePath);
      if (!isPathWithin(projectRoot, target)) {
        failures.push({ relativePath, error: new Error('checkout 路径越过项目目录') });
        continue;
      }
      progress.report({
        message: `${index + 1}/${checkoutPaths.length} · ${relativePath}`,
        increment: 100 / checkoutPaths.length
      });
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const usernameArgs = project.username ? ['--username', project.username] : [];
        if (fs.existsSync(path.join(target, '.svn'))) {
          await runSvn(svnArgs(['update', ...usernameArgs, '--', target]), projectRoot, output, token);
        } else {
          await runSvn(
            svnArgs(['checkout', ...usernameArgs, svnUrlForPath(project.repositoryUrl, relativePath), target]),
            projectRoot,
            output,
            token
          );
        }
      } catch (error) {
        failures.push({ relativePath, error });
      }
    }
  });
  let readmeCreated = false;
  try {
    readmeCreated = await ensureProjectReadme(
      provider.workspaceRoot || workspaceFolderRoot || projectRoot
    );
  } catch (error) {
    output.appendLine(`生成 README.md 失败：${error.message}`);
  }
  await provider.refresh();
  const initialized = provider.repositories.find((repository) => samePath(repository.root, projectRoot));
  if (initialized) await provider.setActiveRepository(projectRoot);
  if (failures.length) {
    vscode.window.showWarningMessage(`项目初始化完成，但 ${failures.length}/${checkoutPaths.length} 个路径失败：${failures.map((item) => item.relativePath).join('、')}。${readmeCreated ? '插件 README.md 已生成。' : ''}详情见 Guthon SVN 输出。`);
  } else {
    vscode.window.showInformationMessage(`项目初始化完成：${configuredProjectLabel(project)}${readmeCreated ? '，插件 README.md 已生成' : ''}`);
  }
}

async function chooseRepository(provider, placeHolder) {
  const visible = provider.visibleRepositories();
  if (!visible.length) {
    vscode.window.showWarningMessage('尚未识别到谷神 SVN 工作副本。');
    return null;
  }
  return visible[0];
}

async function searchPages(provider) {
  if (!provider.searchItems.length) {
    vscode.window.showWarningMessage('当前 SVN 工作副本没有可搜索的源码对象。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    provider.searchItems.map((entry) => {
      if (entry.kind === 'page') {
        return {
          label: `${entry.pageIcon || '📄'} ${entry.label}`,
          description: `页面 · ${entry.pageType} · ${entry.systemId}`,
          detail: entry.breadcrumb,
          entry
        };
      }
      return {
        label: `${iconForSourceCategory(entry.sourceCategory)} ${entry.label}`,
        description: `${SOURCE_OBJECT_META[entry.sourceCategory]?.label || entry.sourceCategory} · ${entry.sourceId}`,
        detail: entry.relativePath,
        entry
      };
    }),
    {
      placeHolder: '搜索页面、过程函数、系统脚本、表或视图名称/路径/编码',
      matchOnDescription: true,
      matchOnDetail: true
    }
  );
  if (!picked) return;
  const entry = picked.entry;
  if (provider.treeView) {
    await provider.treeView.reveal(entry, { expand: true, select: true, focus: true });
  }
  if (entry.kind === 'page') await openPage(entry);
  else await openSourceFile(entry);
}

function runSvn(args, repositoryRoot, output, token) {
  let executable;
  try {
    executable = svnExecutablePath();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    output.appendLine(`\n$ ${executableForLog(executable)} ${args.join(' ')}`);
    const child = spawn(executable, args, { cwd: repositoryRoot, shell: false });
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
  let executable;
  try {
    executable = svnExecutablePath();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    output?.appendLine(`\n$ ${executableForLog(executable)} ${args.join(' ')}`);
    const child = spawn(executable, args, { cwd: repositoryRoot, shell: false });
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
  modified: { label: '已修改', icon: 'diff-modified', badge: 'M', color: 'gitDecoration.modifiedResourceForeground', rank: 40 },
  added: { label: '新增', icon: 'diff-added', badge: 'A', color: 'gitDecoration.addedResourceForeground', rank: 30 },
  deleted: { label: '删除', icon: 'diff-removed', badge: 'D', color: 'gitDecoration.deletedResourceForeground', rank: 60 },
  replaced: { label: '替换', icon: 'diff-renamed', badge: 'R', color: 'gitDecoration.renamedResourceForeground', rank: 50 },
  conflicted: { label: '冲突', icon: 'warning', badge: '!', color: 'gitDecoration.conflictingResourceForeground', rank: 100 },
  missing: { label: '缺失', icon: 'warning', badge: '!', color: 'gitDecoration.deletedResourceForeground', rank: 80 },
  obstructed: { label: '阻塞', icon: 'error', badge: '!', color: 'gitDecoration.conflictingResourceForeground', rank: 90 },
  unversioned: { label: '未纳入版本控制', icon: 'circle-filled', badge: 'U', color: 'gitDecoration.untrackedResourceForeground', rank: 20 },
  incomplete: { label: '不完整', icon: 'warning', badge: '!', color: 'gitDecoration.conflictingResourceForeground', rank: 70 }
};

function mergeSvnDecoration(current, next) {
  if (!next) return current;
  if (!current || (SVN_STATUS_META[next.item]?.rank || 0) > (SVN_STATUS_META[current.item]?.rank || 0)) {
    return next;
  }
  return current;
}

function nodeFilePaths(element, output = new Set()) {
  if (!element) return output;
  if (element.filePath) output.add(path.resolve(element.filePath));
  if (element.sourceRoot) output.add(path.resolve(element.sourceRoot));
  for (const child of element.children || []) nodeFilePaths(child, output);
  return output;
}

// JSON 页面仍保留原始文件作为 Quick Diff；打开 SCM 变更时另有“事件脚本与 SQL 可读差异”。
const QUICK_DIFF_EXTENSIONS = new Set(['.gss', '.vm', '.java', '.js', '.sql', '.json']);

function scmIdForRoot(root) {
  const digest = crypto.createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16);
  return `guthonSvn-${digest}`;
}

class SvnSourceControl {
  constructor(repository, output) {
    this.repository = repository;
    this.output = output;
    this.sourceControl = vscode.scm.createSourceControl(
      scmIdForRoot(repository.root),
      repository.label
    );
    this.sourceControl.inputBox.placeholder = '输入提交说明，然后点击提交';
    this.sourceControl.acceptInputCommand = {
      command: 'guthonSvnNavigator.commitChanges',
      title: '提交 SVN 更改',
      arguments: [repository]
    };
    this.sourceControl.quickDiffProvider = {
      label: 'SVN BASE',
      provideOriginalResource: (uri) => {
        if (uri.scheme !== 'file') return undefined;
        const filePath = path.resolve(uri.fsPath);
        if (!isPathWithin(this.repository.root, filePath)) return undefined;
        if (!QUICK_DIFF_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return undefined;
        const entry = this.entries.find((candidate) => samePath(candidate.filePath, filePath));
        if (entry && ['added', 'unversioned'].includes(entry.item)) return undefined;
        return vscode.Uri.from({
          scheme: SVN_BASE_DOCUMENT_SCHEME,
          path: `/${safeVirtualName(path.basename(filePath))}`,
          query: new URLSearchParams({
            file: filePath,
            root: this.repository.root,
            revision: 'BASE'
          }).toString()
        });
      }
    };
    this.sourceControl.statusBarCommands = [
      {
        command: 'guthonSvnNavigator.refreshSourceControl',
        title: '$(refresh) 刷新',
        arguments: [repository]
      },
      {
        command: 'guthonSvnNavigator.refreshRemoteChanges',
        title: '$(cloud) 远程',
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
    this.remoteChanges = this.sourceControl.createResourceGroup('remoteChanges', '远程变更');
    this.changelistGroups = new Map();
    this.conflicts.hideWhenEmpty = true;
    this.unversioned.hideWhenEmpty = true;
    this.remoteChanges.hideWhenEmpty = true;
    this.entries = [];
    this.remoteEntries = [];
    this.lastStatusResult = null;
  }

  statesFor(entries, remote = false) {
    return entries.map((entry) => {
      const item = remote ? entry.remoteItem : entry.item;
      const meta = SVN_STATUS_META[item] || { label: item, icon: 'circle-filled' };
      const displayName = readableChangeName(this.repository, entry);
      return {
        resourceUri: scmChangeUri(this.repository, entry, displayName),
        decorations: {
          iconPath: new vscode.ThemeIcon(meta.icon),
          tooltip: `${remote ? '远程' : meta.label} · ${displayName}\n${path.relative(this.repository.logicalRoot || this.repository.root, entry.filePath)}${entry.changelist ? `\n变更集：${entry.changelist}` : ''}`
        },
        command: {
          command: remote ? 'guthonSvnNavigator.openRemoteChange' : 'guthonSvnNavigator.openReadableChange',
          title: remote ? '查看远程版本差异' : '查看脚本/SQL 可读差异',
          arguments: [entry]
        },
        contextValue: remote ? `guthonSvn.remote.${item}` : `guthonSvn.${item}`
      };
    });
  }

  updateChangelistGroups(entries) {
    const byName = new Map();
    for (const entry of entries) {
      if (!entry.changelist) continue;
      if (!byName.has(entry.changelist)) byName.set(entry.changelist, []);
      byName.get(entry.changelist).push(entry);
    }
    for (const [name, groupEntries] of byName) {
      let group = this.changelistGroups.get(name);
      if (!group) {
        const id = `changelist-${Buffer.from(name).toString('hex').slice(0, 24)}`;
        group = this.sourceControl.createResourceGroup(id, `变更集 · ${name}`);
        group.hideWhenEmpty = true;
        this.changelistGroups.set(name, group);
      }
      group.resourceStates = this.statesFor(groupEntries);
    }
    for (const [name, group] of this.changelistGroups) {
      if (byName.has(name)) continue;
      group.dispose();
      this.changelistGroups.delete(name);
    }
  }

  async refresh() {
    const targets = svnTargets(this.repository);
    try {
      const result = await runSvnCapture(
        svnArgs(['status', '--xml', '--ignore-externals', '--', ...targets]),
        this.repository.root,
        this.output
      );
      this.entries = parseSvnStatusXml(result.stdout, this.repository.root);
      const regularEntries = this.entries.filter((entry) => (
        entry.item !== 'unversioned' && entry.item !== 'conflicted' && !entry.changelist
      ));
      this.changes.resourceStates = this.statesFor(regularEntries);
      this.conflicts.resourceStates = this.statesFor(this.entries.filter((entry) => entry.item === 'conflicted'));
      this.unversioned.resourceStates = this.statesFor(this.entries.filter((entry) => entry.item === 'unversioned'));
      this.updateChangelistGroups(this.entries.filter((entry) => (
        entry.item !== 'unversioned' && entry.item !== 'conflicted'
      )));
      this.sourceControl.count = this.entries.length;
      this.lastStatusResult = {
        ok: true,
        repositoryRoot: this.repository.root,
        targets,
        count: this.entries.length,
        error: null
      };
      return this.lastStatusResult;
    } catch (error) {
      // 保留上一次成功的变更列表，避免一次临时 PATH、权限或网关错误
      // 把用户已经看到的本地变更误清空。
      this.output.appendLine(`读取 SVN 变更失败，保留上次结果：${error.message}`);
      this.lastStatusResult = {
        ok: false,
        repositoryRoot: this.repository.root,
        targets,
        count: this.entries.length,
        error: error.message
      };
      notifySvnStatusFailure(error, this.output);
      return this.lastStatusResult;
    }
  }

  async refreshRemote() {
    try {
      const result = await runSvnCapture(
        svnArgs(['status', '--xml', '-u', '--ignore-externals', '--', this.repository.root]),
        this.repository.root,
        this.output
      );
      this.remoteEntries = parseSvnRemoteStatusXml(result.stdout, this.repository.root);
      this.remoteChanges.resourceStates = this.statesFor(this.remoteEntries, true);
      return this.remoteEntries;
    } catch (error) {
      this.remoteEntries = [];
      this.remoteChanges.resourceStates = [];
      this.output.appendLine(`读取 SVN 远程变更失败：${error.message}`);
      throw error;
    }
  }

  dispose() {
    for (const group of this.changelistGroups.values()) group.dispose();
    this.changelistGroups.clear();
    this.sourceControl.dispose();
  }
}

class SvnSourceControlManager {
  constructor(output) {
    this.output = output;
    this.controls = new Map();
    this.decorations = new Map();
    this.onDecorationsChanged = null;
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
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
      const existing = this.controls.get(repository.root);
      if (existing && existing.repository.label !== repository.label) {
        existing.dispose();
        this.controls.delete(repository.root);
      }
      if (!this.controls.has(repository.root)) {
        this.controls.set(repository.root, new SvnSourceControl(repository, this.output));
      }
    }
    void this.refreshAll();
  }

  async refreshAll() {
    const results = await Promise.all([...this.controls.values()].map((control) => control.refresh()));
    this.rebuildDecorations();
    return results;
  }

  async refreshForPath(filePath) {
    const control = [...this.controls.values()].find((candidate) => (
      isPathWithin(candidate.repository.root, filePath)
    ));
    if (control) {
      await control.refresh();
      this.rebuildDecorations();
    }
  }

  scheduleRefreshForPath(filePath) {
    const control = [...this.controls.values()].find((candidate) => (
      isPathWithin(candidate.repository.root, filePath)
    ));
    if (!control) return;
    if (!this.pendingPathRefreshes) this.pendingPathRefreshes = new Map();
    const existing = this.pendingPathRefreshes.get(control.repository.root);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingPathRefreshes.delete(control.repository.root);
      void control.refresh().then(() => this.rebuildDecorations());
    }, 300);
    this.pendingPathRefreshes.set(control.repository.root, timer);
  }

  findByRoot(root) {
    return this.controls.get(root)
      || [...this.controls.values()].find((control) => samePath(control.repository.root, root))
      || null;
  }

  controlsForLogicalRoot(root) {
    return [...this.controls.values()].filter((control) => (
      samePath(control.repository.logicalRoot, root) || samePath(control.repository.root, root)
    ));
  }

  rebuildDecorations() {
    const next = new Map();
    const add = (filePath, decoration) => {
      const key = pathKey(filePath);
      next.set(key, mergeSvnDecoration(next.get(key), decoration));
    };
    for (const control of this.controls.values()) {
      const logicalRoot = path.resolve(control.repository.logicalRoot || control.repository.root);
      for (const entry of control.entries) {
        const item = entry.item;
        if (!SVN_STATUS_META[item]) continue;
        const filePath = path.resolve(entry.filePath);
        add(filePath, { item, tooltip: `${SVN_STATUS_META[item].label} · ${readableChangeName(control.repository, entry)}` });
        let current = path.dirname(filePath);
        while (isPathWithin(logicalRoot, current)) {
          add(current, { item, tooltip: `${SVN_STATUS_META[item].label} · 下级存在变更` });
          if (current === logicalRoot) break;
          current = path.dirname(current);
        }
      }
    }
    const changed = new Set([...this.decorations.keys(), ...next.keys()]);
    this.decorations = next;
    this._onDidChangeFileDecorations.fire([...changed].map((filePath) => vscode.Uri.file(filePath)));
    this.onDecorationsChanged?.();
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file') return undefined;
    const decoration = this.decorations.get(pathKey(uri.fsPath));
    const meta = decoration && SVN_STATUS_META[decoration.item];
    if (!meta) return undefined;
    return {
      badge: meta.badge,
      color: new vscode.ThemeColor(meta.color),
      tooltip: decoration.tooltip,
      propagate: false
    };
  }

  decorationForElement(element) {
    let result;
    for (const filePath of nodeFilePaths(element)) {
      result = mergeSvnDecoration(result, this.decorations.get(pathKey(filePath)));
    }
    return result ? SVN_STATUS_META[result.item] && {
      item: result.item,
      color: SVN_STATUS_META[result.item].color,
      tooltip: result.tooltip
    } : undefined;
  }

  dispose() {
    for (const timer of this.pendingPathRefreshes?.values() || []) clearTimeout(timer);
    this.pendingPathRefreshes?.clear();
    for (const control of this.controls.values()) control.dispose();
    this.controls.clear();
    this.decorations.clear();
    this._onDidChangeFileDecorations.dispose();
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
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  dispose() {
    this._onDidChange.dispose();
  }

  refresh(uri) {
    this._onDidChange.fire(uri);
  }

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

function revisionDocumentUri(filePath, root, revision = '', readable = false) {
  if (!revision && !readable) return vscode.Uri.file(filePath);
  return vscode.Uri.from({
    scheme: readable ? READABLE_DIFF_DOCUMENT_SCHEME : SVN_BASE_DOCUMENT_SCHEME,
    path: readable ? readableDiffPath(filePath) : `/${safeVirtualName(path.basename(filePath))}`,
    query: new URLSearchParams({ file: filePath, root, revision }).toString()
  });
}

async function chooseHistoryDiffMode(filePath, title) {
  const choices = [];
  if (path.extname(filePath).toLowerCase() === '.json') {
    choices.push({
      label: '事件脚本与 SQL 可读差异',
      detail: '展开页面事件和数据源 SQL，不改变原始 JSON',
      readable: true
    });
  }
  choices.push({
    label: '原始源码差异',
    detail: '比较两个版本的完整原始文件',
    readable: false
  });
  if (choices.length === 1) return choices[0];
  return vscode.window.showQuickPick(choices, { title });
}

async function openRevisionDiff(filePath, root, leftRevision, rightRevision, title) {
  const mode = await chooseHistoryDiffMode(filePath, title);
  if (!mode) return;
  const leftUri = revisionDocumentUri(filePath, root, leftRevision, mode.readable);
  const rightUri = revisionDocumentUri(filePath, root, rightRevision, mode.readable);
  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `${path.basename(filePath)}（${leftRevision || '工作区'} ↔ ${rightRevision || '工作区'}${mode.readable ? ' · 事件脚本与 SQL' : ' · 原始源码'}）`
  );
}

async function openRemoteChange(entry) {
  const filePath = filePathFromCommandValue(entry);
  if (!filePath) return;
  const logicalRoot = findRepositoryRoot(filePath) || path.dirname(filePath);
  const root = workingCopyForPath(logicalRoot, filePath) || logicalRoot;
  try {
    await openRevisionDiff(filePath, root, 'BASE', 'HEAD', `查看远程差异 · ${path.basename(filePath)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`打开 SVN 远程差异失败：${error.message}`);
  }
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
      { label: '与 SVN BASE 比较', detail: `r${picked.entry.revision} ↔ BASE`, action: 'diff-base' },
      { label: '与另一个历史版本比较', detail: '选择第二个历史版本', action: 'diff-revision' },
      { label: '打开该历史版本', detail: `只读打开 r${picked.entry.revision}`, action: 'open' },
      { label: '复制版本号', detail: `r${picked.entry.revision}`, action: 'copy-revision' },
      { label: '复制提交说明', detail: picked.entry.message || '（无提交说明）', action: 'copy-message' }
    ], { title: `r${picked.entry.revision} · ${path.basename(filePath)}` });
    if (!action) return;
    if (action.action === 'copy-revision') {
      await vscode.env.clipboard.writeText(picked.entry.revision);
      return;
    }
    if (action.action === 'copy-message') {
      await vscode.env.clipboard.writeText(picked.entry.message || '');
      return;
    }
    const revisionUri = revisionDocumentUri(filePath, root, picked.entry.revision, false);
    if (action.action === 'open') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(revisionUri), { preview: false });
      return;
    }
    if (action.action === 'diff-current') {
      await openRevisionDiff(filePath, root, picked.entry.revision, '', `历史版本与当前文件 · ${path.basename(filePath)}`);
      return;
    }
    if (action.action === 'diff-base') {
      await openRevisionDiff(filePath, root, picked.entry.revision, 'BASE', `历史版本与 BASE · ${path.basename(filePath)}`);
      return;
    }
    const other = await vscode.window.showQuickPick(entries
      .filter((entry) => entry.revision !== picked.entry.revision)
      .map((entry) => ({
        label: `r${entry.revision} · ${entry.author} · ${historyDate(entry.date)}`,
        description: entry.message.split(/\r?\n/)[0] || '（无提交说明）',
        entry
      })), {
      title: `选择与 r${picked.entry.revision} 比较的版本`,
      placeHolder: '可搜索版本号、作者和提交说明'
    });
    if (other) {
      await openRevisionDiff(
        filePath,
        root,
        picked.entry.revision,
        other.entry.revision,
        `比较两个历史版本 · ${path.basename(filePath)}`
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(`读取 SVN 文件历史失败：${error.message}`);
  }
}

function readableDiffEditor() {
  const editors = [
    vscode.window.activeTextEditor,
    ...(vscode.window.visibleTextEditors || [])
  ].filter((editor, index, all) => editor && all.indexOf(editor) === index)
    .filter((editor) => editor.document.uri.scheme === READABLE_DIFF_DOCUMENT_SCHEME);
  const current = editors.find((editor) => {
    const revision = new URLSearchParams(editor.document.uri.query).get('revision') || '';
    return !revision;
  });
  return current || editors[0] || null;
}

function readableDiffBlockAtLine(document, line) {
  const lines = document.getText().split(/\r?\n/);
  for (let index = Math.min(line, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index].match(/^\/\/ ===== (.+) · (pageEvents|serviceEvents|SQL) =====$/);
    if (!match) continue;
    return {
      parts: match[1].split(' > '),
      label: match[1].split(' > ').at(-1) || match[1],
      runtime: match[2],
      headerLine: index
    };
  }
  return null;
}

function documentWithLineChanges(originalDocument, modifiedDocument, changes) {
  const parts = [];
  let originalLine = 0;
  for (const change of changes) {
    const originalIsEmpty = change.originalEndLineNumber === 0;
    const modifiedIsEmpty = change.modifiedEndLineNumber === 0;
    let originalStartLine = originalIsEmpty
      ? change.originalStartLineNumber
      : change.originalStartLineNumber - 1;
    let originalStartColumn = 0;
    if (modifiedIsEmpty && change.originalEndLineNumber === originalDocument.lineCount) {
      originalStartLine -= 1;
      originalStartColumn = originalDocument.lineAt(originalStartLine).range.end.character;
    }
    parts.push(originalDocument.getText(new vscode.Range(
      originalLine,
      0,
      originalStartLine,
      originalStartColumn
    )));
    if (!modifiedIsEmpty) {
      let modifiedStartLine = change.modifiedStartLineNumber - 1;
      let modifiedStartColumn = 0;
      if (originalIsEmpty && change.originalStartLineNumber === originalDocument.lineCount) {
        modifiedStartLine -= 1;
        modifiedStartColumn = modifiedDocument.lineAt(modifiedStartLine).range.end.character;
      }
      parts.push(modifiedDocument.getText(new vscode.Range(
        modifiedStartLine,
        modifiedStartColumn,
        change.modifiedEndLineNumber,
        0
      )));
    }
    originalLine = originalIsEmpty
      ? change.originalStartLineNumber
      : change.originalEndLineNumber;
  }
  parts.push(originalDocument.getText(new vscode.Range(
    originalLine,
    0,
    originalDocument.lineCount,
    0
  )));
  return parts.join('');
}

async function revertQuickDiffChange(provider, sourceControlManager, resourceUri, changes, changeIndex) {
  if (!(resourceUri instanceof vscode.Uri)
    || resourceUri.scheme !== 'file'
    || !Array.isArray(changes)
    || !Number.isInteger(changeIndex)
    || !changes[changeIndex]) {
    vscode.window.showWarningMessage('未取得当前 SVN 差异块，请重新点击左侧变更标记后再试。');
    return;
  }
  const filePath = resourceUri.fsPath;
  const logicalRoot = findRepositoryRoot(filePath) || path.dirname(filePath);
  const root = workingCopyForPath(logicalRoot, filePath) || logicalRoot;
  try {
    const editor = vscode.window.visibleTextEditors.find((candidate) => (
      candidate.document.uri.toString() === resourceUri.toString()
    ));
    if (!editor) {
      vscode.window.showWarningMessage('当前修改文件未在编辑器中打开，无法撤销这一处变更。');
      return;
    }
    const originalUri = vscode.Uri.from({
      scheme: SVN_BASE_DOCUMENT_SCHEME,
      path: `/${safeVirtualName(path.basename(filePath))}`,
      query: new URLSearchParams({ file: filePath, root, revision: 'BASE' }).toString()
    });
    const originalDocument = await vscode.workspace.openTextDocument(originalUri);
    const keptChanges = [
      ...changes.slice(0, changeIndex),
      ...changes.slice(changeIndex + 1)
    ];
    const updatedText = documentWithLineChanges(originalDocument, editor.document, keptChanges);
    const visibleRange = editor.visibleRanges[0];
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      resourceUri,
      new vscode.Range(
        new vscode.Position(0, 0),
        editor.document.lineAt(editor.document.lineCount - 1).range.end
      ),
      updatedText
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) throw new Error('VS Code 未能应用当前差异块的撤销编辑');
    if (!await editor.document.save()) throw new Error('撤销后保存文件失败');
    const targetLine = Math.max(0, Math.min(
      editor.document.lineCount - 1,
      changes[changeIndex].modifiedStartLineNumber - 1
    ));
    editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
    if (visibleRange) editor.revealRange(visibleRange);
    await sourceControlManager.refreshForPath(filePath);
    await provider.refresh(false);
  } catch (error) {
    vscode.window.showErrorMessage(`取消当前变更失败：${error.message}`);
  }
}

async function revertReadableDiffBlock(provider, sourceControlManager, readableDiffProvider) {
  const editor = readableDiffEditor();
  if (!editor) {
    vscode.window.showInformationMessage('请先打开“脚本/SQL可读差异”，再把光标放在要撤销的差异块中。');
    return;
  }
  const documentUri = editor.document.uri;
  const query = new URLSearchParams(documentUri.query);
  const filePath = query.get('file') || '';
  const logicalRoot = query.get('root') || findRepositoryRoot(filePath) || path.dirname(filePath);
  const revision = query.get('revision') || '';
  if (revision) {
    vscode.window.showInformationMessage('历史版本是只读的，请在工作区一侧的当前差异块中执行撤销。');
    return;
  }
  if (!filePath || path.extname(filePath).toLowerCase() !== '.json' || !isPageJsonPath(filePath)) {
    vscode.window.showInformationMessage('当前差异不是页面 JSON 的事件/SQL 可读差异，不能执行单块撤销。');
    return;
  }
  const block = readableDiffBlockAtLine(editor.document, editor.selection.active.line);
  if (!block) {
    vscode.window.showWarningMessage('请把光标放在事件或 SQL 差异块内，再执行“取消当前差异块”。');
    return;
  }
  const root = workingCopyForPath(logicalRoot, filePath) || logicalRoot;
  try {
    const [currentSource, baseResult] = await Promise.all([
      fs.promises.readFile(filePath, 'utf8'),
      runSvnCapture(svnArgs(['cat', '-r', 'BASE', '--', filePath]), root, null)
    ]);
    const currentBlock = jsonStringAtParts(currentSource, block.parts);
    const baseBlock = jsonStringAtParts(baseResult.stdout, block.parts);
    if (currentBlock === null || baseBlock === null) {
      vscode.window.showWarningMessage(`“${block.label}”在当前文件或 SVN 基线中不存在，暂不支持对新增/删除块自动撤销。`);
      return;
    }
    if (currentBlock === baseBlock) {
      vscode.window.showInformationMessage(`“${block.label}”当前没有本地修改。`);
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `确定只撤销“${block.label}”这个${block.runtime === 'SQL' ? 'SQL' : '事件脚本'}块吗？同一 JSON 文件中的其他修改不会变动。`,
      { modal: true },
      '取消当前块'
    );
    if (confirmed !== '取消当前块') return;
    const updatedSource = rewriteJsonStringAtParts(currentSource, block.parts, baseBlock);
    await atomicWriteUtf8(filePath, updatedSource);
    await sourceControlManager.refreshForPath(filePath);
    await provider.refresh(false);
    readableDiffProvider.refresh(documentUri);
    vscode.window.showInformationMessage(`已取消当前差异块：${block.label}。其他文件和 JSON 修改未变动。`);
  } catch (error) {
    vscode.window.showErrorMessage(`取消当前差异块失败：${error.message}`);
  }
}

async function addUnversionedChange(sourceControlManager, value) {
  const resourceUri = value instanceof vscode.Uri ? value : value?.resourceUri;
  const filePath = resourceUri?.scheme === SCM_CHANGE_DOCUMENT_SCHEME
    ? new URLSearchParams(resourceUri.query).get('source') || ''
    : resourceUri?.fsPath || value?.filePath || '';
  const control = [...sourceControlManager.controls.values()].find((candidate) => (
    candidate.entries.some((entry) => samePath(entry.filePath, filePath) && entry.item === 'unversioned')
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

async function revertChange(provider, sourceControlManager, value) {
  const filePath = filePathFromCommandValue(value);
  if (!filePath) return;
  const control = [...sourceControlManager.controls.values()].find((candidate) => (
    isPathWithin(candidate.repository.root, filePath)
  ));
  const entry = control?.entries.find((candidate) => samePath(candidate.filePath, filePath));
  if (!control || !entry) {
    vscode.window.showWarningMessage(`未找到文件对应的 SVN 工作副本：${filePath}`);
    return;
  }
  if (entry.item === 'unversioned') {
    vscode.window.showInformationMessage('未纳入 SVN 的文件不能执行取消更改；请先执行 Add 或直接删除文件。');
    return;
  }
  const displayName = readableChangeName(control.repository, entry);
  const confirmed = await vscode.window.showWarningMessage(
    `确定取消“${displayName}”的本地更改吗？文件将恢复到 SVN 基线，未提交内容无法通过插件恢复。`,
    { modal: true },
    '取消本地更改'
  );
  if (confirmed !== '取消本地更改') return;
  try {
    await runSvn(
      svnArgs(['revert', '--depth', 'empty', '--', filePath]),
      control.repository.root,
      sourceControlManager.output
    );
    await control.refresh();
    await provider.refresh();
    vscode.window.showInformationMessage(`已取消本地更改：${displayName}`);
  } catch (error) {
    vscode.window.showErrorMessage(`取消更改失败：${error.message}`);
  }
}

function safePathPart(value) {
  return String(value || '').replace(/[^A-Za-z0-9._\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'svn';
}

async function inspectUpdateTargets(repository, targets, output, token) {
  const inspections = [];
  for (const target of targets) {
    const result = await runSvnCapture(
      svnArgs(['status', '--xml', '--ignore-externals', '--', target]),
      target,
      output,
      token
    );
    inspections.push({ target, entries: parseSvnStatusXml(result.stdout, target) });
  }
  return inspections;
}

async function backupUpdatePatches(provider, repository, inspections, output, token) {
  const changed = inspections.filter((inspection) => (
    inspection.entries.some((entry) => !['unversioned', 'conflicted'].includes(entry.item))
  ));
  if (!changed.length) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDirectory = path.join(
    provider.extensionContext.globalStorageUri.fsPath,
    'svn-update-backups',
    safePathPart(repository.projectId || repository.label),
    stamp
  );
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  for (const inspection of changed) {
    const paths = inspection.entries
      .filter((entry) => !['unversioned', 'conflicted'].includes(entry.item))
      .map((entry) => entry.filePath);
    const result = await runSvnCapture(
      svnArgs(['diff', '--', ...paths]),
      inspection.target,
      output,
      token
    );
    const relative = path.relative(repository.logicalRoot || repository.root, inspection.target)
      || path.basename(inspection.target);
    const patchPath = path.join(backupDirectory, `${safePathPart(relative)}.patch`);
    await fs.promises.writeFile(patchPath, result.stdout, 'utf8');
  }
  return backupDirectory;
}

async function updateRepository(provider, output, element) {
  const repository = element?.kind === 'repository'
    ? element
    : await chooseRepository(provider, '选择要更新的 SVN 工作副本');
  if (!repository) return;
  output.show(true);
  const targets = svnTargets(repository);
  const results = [];
  let inspections;
  try {
    inspections = await inspectUpdateTargets(repository, targets, output);
  } catch (error) {
    vscode.window.showErrorMessage(`更新前检查失败，已取消更新：${error.message}`);
    return;
  }
  const conflicts = inspections.flatMap((inspection) => (
    inspection.entries.filter((entry) => entry.item === 'conflicted')
  ));
  if (conflicts.length) {
    vscode.window.showWarningMessage(`检测到 ${conflicts.length} 个未解决冲突，已阻止更新。请先处理冲突或执行 SVN Cleanup。`);
    return;
  }
  const localChanges = inspections.flatMap((inspection) => inspection.entries);
  if (localChanges.length) {
    const confirmed = await vscode.window.showWarningMessage(
      `更新前检测到 ${localChanges.length} 个本地变更。插件会先备份已纳入 SVN 的真实 Patch，再执行更新；未纳入版本控制的文件不会被修改。`,
      { modal: true },
      '备份并继续更新'
    );
    if (confirmed !== '备份并继续更新') return;
  }
  let backupDirectory = '';
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `正在全量更新 ${repository.label}（${targets.length} 个工作副本）`,
      cancellable: true
    }, async (progress, token) => {
      if (localChanges.length) {
        progress.report({ message: '正在备份本地 SVN Patch' });
        backupDirectory = await backupUpdatePatches(provider, repository, inspections, output, token);
      }
      for (let index = 0; index < targets.length; index += 1) {
        if (token.isCancellationRequested) break;
        const target = targets[index];
        progress.report({
          message: `${index + 1}/${targets.length} · ${path.relative(repository.root, target) || path.basename(target)}`,
          increment: 100 / targets.length
        });
        try {
          await runSvn(svnArgs(['update', '--ignore-externals', '--', target]), target, output, token);
          results.push({ target, ok: true });
        } catch (error) {
          results.push({ target, ok: false, error });
        }
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`SVN 更新前备份失败，已取消更新：${error.message}`);
    return;
  }
  await provider.refresh();
  const failed = results.filter((result) => !result.ok);
  if (!failed.length && results.length === targets.length) {
    vscode.window.showInformationMessage(`SVN 全量更新完成：${results.length} 个工作副本。${backupDirectory ? ` 更新前 Patch 已保存到 ${backupDirectory}` : ''}`);
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

async function checkSvnStatus(provider, sourceControlManager) {
  const output = sourceControlManager.output;
  output.show(true);
  let executable;
  try {
    executable = svnExecutablePath();
  } catch (error) {
    output.appendLine(`\n[SVN 状态检查失败] ${error.message}`);
    notifyMissingSvn(error, output);
    return;
  }

  const repositories = provider.visibleRepositories();
  const controls = repositories.flatMap((repository) => (
    sourceControlManager.controlsForLogicalRoot(repository.root)
  ));
  output.appendLine('\n========== Guthon SVN 状态检查 ==========');
  output.appendLine(`SVN 程序：${executable}`);
  output.appendLine(`当前项目：${repositories.map((repository) => repository.label).join('、') || '未选择'}`);
  if (!controls.length) {
    output.appendLine('未找到可检测的 SVN 工作副本。请确认项目路径下存在 .svn。');
    vscode.window.showWarningMessage('未找到可检测的 SVN 工作副本，请查看 Guthon SVN 输出。');
    return;
  }

  const results = await sourceControlManager.refreshAll();
  for (const control of controls) {
    const result = results.find((candidate) => candidate.repositoryRoot === control.repository.root)
      || control.lastStatusResult;
    output.appendLine(`项目：${control.repository.label}`);
    output.appendLine(`工作副本：${control.repository.root}`);
    output.appendLine(`结果：${result?.ok ? '正常' : `失败，已保留上次结果：${result?.error || '未知错误'}`}`);
    output.appendLine(`本地变更数量：${result?.count ?? control.entries.length}`);
  }
  output.appendLine('========== SVN 状态检查结束 ==========');
  const failed = results.filter((result) => !result.ok).length;
  if (failed) {
    vscode.window.showWarningMessage(`SVN 状态检查完成：${failed} 个工作副本失败，详情见 Guthon SVN 输出。`);
  } else {
    vscode.window.showInformationMessage(`SVN 状态检查完成：${results.length} 个工作副本正常。`);
  }
}

function isCommittableEntry(entry) {
  return entry && entry.item !== 'unversioned' && entry.item !== 'conflicted';
}

async function chooseCommitControl(sourceControlManager, logicalRoot) {
  const candidates = logicalRoot
    ? sourceControlManager.controlsForLogicalRoot(logicalRoot)
    : [...sourceControlManager.controls.values()];
  const controls = candidates
    .filter((control) => control.entries.some(isCommittableEntry));
  if (controls.length === 1) return controls[0];
  if (!controls.length) {
    vscode.window.showInformationMessage('当前没有可提交的已纳入 SVN 的更改；未纳入版本控制的文件请先右键执行“加入 SVN”。');
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
    repository = provider.repositories.find((candidate) => samePath(candidate.root, element.repositoryRoot)) || null;
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

  const preview = entries.slice(0, 8).map((entry) => (
    `${SVN_STATUS_META[entry.item]?.label || entry.item} · ${readableChangeName(control.repository, entry)}`
  ));
  if (entries.length > preview.length) preview.push(`……另有 ${entries.length - preview.length} 个文件`);
  const confirmed = await vscode.window.showInformationMessage(
    `确认提交 ${entries.length} 个文件到“${control.repository.label}”吗？\n\n${preview.join('\n')}\n\n提交说明：${message.trim()}`,
    { modal: true },
    '确认提交'
  );
  if (confirmed !== '确认提交') return;

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

function controlForCommandValue(sourceControlManager, value) {
  const root = value?.root || '';
  if (root && sourceControlManager.findByRoot(root)) return sourceControlManager.findByRoot(root);
  const filePath = filePathFromCommandValue(value);
  if (!filePath) return null;
  return [...sourceControlManager.controls.values()].find((candidate) => (
    isPathWithin(candidate.repository.root, filePath)
  )) || null;
}

async function refreshRemoteChanges(sourceControlManager, element) {
  let controls = [];
  const direct = controlForCommandValue(sourceControlManager, element);
  if (direct) controls = [direct];
  else if (element?.root) controls = sourceControlManager.controlsForLogicalRoot(element.root);
  else controls = [...sourceControlManager.controls.values()];
  if (!controls.length) return;
  sourceControlManager.output.show(true);
  let total = 0;
  let failed = 0;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在检查 SVN 远程变更（${controls.length} 个工作副本）`,
    cancellable: false
  }, async (progress) => {
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      progress.report({
        message: `${index + 1}/${controls.length} · ${control.repository.label}`,
        increment: 100 / controls.length
      });
      try {
        total += (await control.refreshRemote()).length;
      } catch {
        failed += 1;
      }
    }
  });
  const message = `SVN 远程检查完成：发现 ${total} 个远程变更${failed ? `，${failed} 个工作副本检查失败` : ''}。`;
  if (failed) vscode.window.showWarningMessage(`${message} 详情见 Guthon SVN 输出。`);
  else vscode.window.showInformationMessage(message);
}

async function cleanupRepository(sourceControlManager, element) {
  const direct = controlForCommandValue(sourceControlManager, element);
  const controls = direct ? [direct] : [...sourceControlManager.controls.values()];
  if (!controls.length) return;
  sourceControlManager.output.show(true);
  let failed = 0;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在清理 SVN 工作副本（${controls.length} 个）`,
    cancellable: false
  }, async (progress) => {
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      progress.report({ message: control.repository.label, increment: 100 / controls.length });
      try {
        await runSvn(
          svnArgs(['cleanup', '--', control.repository.root]),
          control.repository.root,
          sourceControlManager.output
        );
      } catch (error) {
        failed += 1;
        sourceControlManager.output.appendLine(`Cleanup 失败：${error.message}`);
      }
    }
  });
  await sourceControlManager.refreshAll();
  if (failed) vscode.window.showWarningMessage(`SVN Cleanup 完成，但 ${failed} 个工作副本失败。`);
  else vscode.window.showInformationMessage('SVN Cleanup 完成。');
}

async function resolveConflict(sourceControlManager, value) {
  const filePath = filePathFromCommandValue(value);
  const control = controlForCommandValue(sourceControlManager, value);
  if (!filePath || !control) return;
  const entry = control.entries.find((candidate) => samePath(candidate.filePath, filePath));
  if (!entry || entry.item !== 'conflicted') return;
  const action = await vscode.window.showQuickPick([
    { label: '查看冲突差异', detail: '比较 SVN BASE 与当前工作区内容', action: 'diff' },
    { label: '标记当前内容为已解决', detail: '保留当前文件内容并执行 svn resolve --accept working', action: 'resolve' }
  ], { title: `处理冲突 · ${readableChangeName(control.repository, entry)}` });
  if (!action) return;
  if (action.action === 'diff') {
    await openReadableChange(entry);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    '确认保留当前工作区文件内容，并将该冲突标记为已解决吗？',
    { modal: true },
    '标记已解决'
  );
  if (confirmed !== '标记已解决') return;
  try {
    await runSvn(
      svnArgs(['resolve', '--accept', 'working', '--', filePath]),
      control.repository.root,
      sourceControlManager.output
    );
    await control.refresh();
    vscode.window.showInformationMessage(`已标记冲突为解决：${path.basename(filePath)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`解决 SVN 冲突失败：${error.message}`);
  }
}

async function setChangelist(sourceControlManager, value) {
  const filePath = filePathFromCommandValue(value);
  const control = controlForCommandValue(sourceControlManager, value);
  if (!filePath || !control) return;
  const existing = [...new Set(control.entries.map((entry) => entry.changelist).filter(Boolean))];
  const picked = await vscode.window.showQuickPick([
    ...existing.map((name) => ({ label: name, name })),
    { label: '$(add) 新建变更集', create: true },
    { label: '$(remove) 移出当前变更集', remove: true }
  ], { title: `设置 SVN 变更集 · ${path.basename(filePath)}` });
  if (!picked) return;
  let name = picked.name || '';
  if (picked.create) {
    name = await vscode.window.showInputBox({
      prompt: '输入 SVN 变更集名称',
      validateInput: (value) => value.trim() ? undefined : '变更集名称不能为空'
    }) || '';
    name = name.trim();
    if (!name) return;
  }
  try {
    const args = picked.remove
      ? ['changelist', '--remove', '--', filePath]
      : ['changelist', name, '--', filePath];
    await runSvn(svnArgs(args), control.repository.root, sourceControlManager.output);
    await control.refresh();
  } catch (error) {
    vscode.window.showErrorMessage(`设置 SVN 变更集失败：${error.message}`);
  }
}

async function exportPatch(sourceControlManager, value) {
  let control = controlForCommandValue(sourceControlManager, value);
  if (!control) control = await chooseCommitControl(sourceControlManager, value?.root || '');
  if (!control) return;
  const directPath = filePathFromCommandValue(value);
  let entries = directPath
    ? control.entries.filter((entry) => entry.filePath === directPath && isCommittableEntry(entry))
    : await chooseCommitEntries(control);
  entries = entries.filter((entry) => entry.item !== 'conflicted');
  if (!entries.length) return;
  const defaultName = `${safePathPart(control.repository.projectId || 'guthon')}-${Date.now()}.patch`;
  const destination = await vscode.window.showSaveDialog({
    title: `导出真实 SVN Patch · ${control.repository.label}`,
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Desktop', defaultName)),
    filters: { 'SVN Patch': ['patch', 'diff'] }
  });
  if (!destination) return;
  try {
    const result = await runSvnCapture(
      svnArgs(['diff', '--', ...entries.map((entry) => entry.filePath)]),
      control.repository.root,
      sourceControlManager.output
    );
    await fs.promises.writeFile(destination.fsPath, result.stdout, 'utf8');
    vscode.window.showInformationMessage(`SVN Patch 已导出：${destination.fsPath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`导出 SVN Patch 失败：${error.message}`);
  }
}

async function showRepositoryHistory(sourceControlManager, element) {
  let control = controlForCommandValue(sourceControlManager, element);
  if (!control) {
    const controls = [...sourceControlManager.controls.values()];
    const pickedControl = await vscode.window.showQuickPick(controls.map((candidate) => ({
      label: candidate.repository.label,
      detail: candidate.repository.root,
      control: candidate
    })), { title: '选择要查看历史的 SVN 工作副本' });
    control = pickedControl?.control || null;
  }
  if (!control) return;
  try {
    const result = await runSvnCapture(
      svnArgs(['log', '--xml', '-l', '100', '--', control.repository.root]),
      control.repository.root,
      null
    );
    const entries = parseSvnLogXml(result.stdout);
    if (!entries.length) {
      vscode.window.showInformationMessage(`“${control.repository.label}”没有可显示的 SVN 提交历史。`);
      return;
    }
    const picked = await vscode.window.showQuickPick(entries.map((entry) => ({
      label: `r${entry.revision} · ${entry.author} · ${historyDate(entry.date)}`,
      description: entry.message.split(/\r?\n/)[0] || '（无提交说明）',
      detail: entry.message || '（无提交说明）',
      entry
    })), {
      title: `SVN 提交历史 · ${control.repository.label}`,
      placeHolder: '搜索版本号、作者或提交说明'
    });
    if (!picked) return;
    const action = await vscode.window.showQuickPick([
      { label: '复制版本号', value: picked.entry.revision },
      { label: '复制提交说明', value: picked.entry.message || '' }
    ], { title: `r${picked.entry.revision}` });
    if (action) await vscode.env.clipboard.writeText(action.value);
  } catch (error) {
    vscode.window.showErrorMessage(`读取 SVN 提交历史失败：${error.message}`);
  }
}

async function configureSvnExecutable(sourceControlManager) {
  const selected = await vscode.window.showOpenDialog({
    title: '选择 SVN 命令行程序',
    openLabel: '使用此 SVN 程序',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: process.platform === 'win32' ? { 'SVN 程序': ['exe'] } : undefined
  });
  if (!selected?.length) return;
  const executable = selected[0].fsPath;
  try {
    resolveSvnExecutable({ configuredPath: executable });
  } catch (error) {
    vscode.window.showErrorMessage(error.message);
    return;
  }
  await extensionState?.globalState.update(SVN_EXECUTABLE_STATE_KEY, executable);
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (configuration.inspect('svnExecutable')) {
    try {
      await configuration.update('svnExecutable', executable, vscode.ConfigurationTarget.Global);
    } catch (error) {
      sourceControlManager.output.appendLine(`写入 SVN 路径设置失败，已改用插件本机存储：${error.message}`);
    }
  }
  resetSvnExecutableCache();
  vscode.window.showInformationMessage(`已使用 SVN 程序：${executable}`);
  await sourceControlManager.refreshAll();
}

function activate(context) {
  extensionState = context;
  let sourceControlManager;
  const metadataCache = new SourceMetadataCache(context.globalStorageUri.fsPath);
  const provider = new GuthonSvnTreeProvider(
    (repositories) => sourceControlManager?.setRepositories(repositories),
    metadataCache,
    context
  );
  const segmentProvider = new PageSegmentFileSystemProvider();
  const baseContentProvider = new SvnBaseContentProvider();
  const readableDiffProvider = new ReadableDiffContentProvider();
  const scmChangeProvider = new ScmChangeContentProvider();
  provider.onPageFileChange = (filePath) => segmentProvider.refreshSource(filePath);
  const output = vscode.window.createOutputChannel('Guthon SVN');
  provider.output = output;
  const gssProviders = createGssLanguageProviders(context);
  sourceControlManager = new SvnSourceControlManager(output);
  provider.onWorkingCopyFileChange = (filePath) => sourceControlManager.scheduleRefreshForPath(filePath);
  sourceControlManager.setRepositories(provider.visibleRepositories());
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  provider.setTreeView(treeView);
  provider.setNodeDecorationProvider((element) => sourceControlManager.decorationForElement(element));
  sourceControlManager.onDecorationsChanged = () => provider.refreshDecorations();

  context.subscriptions.push(
    provider,
    segmentProvider,
    baseContentProvider,
    readableDiffProvider,
    scmChangeProvider,
    sourceControlManager,
    vscode.window.registerFileDecorationProvider(sourceControlManager),
    output,
    treeView,
    vscode.languages.registerCompletionItemProvider(
      { language: 'guthon-gss' },
      gssProviders.completion,
      '.', '#', '$'
    ),
    vscode.languages.registerHoverProvider(
      { language: 'guthon-gss' },
      gssProviders.hover
    ),
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
    vscode.commands.registerCommand('guthonSvnNavigator.openSourceFile', openSourceFile),
    vscode.commands.registerCommand('guthonSvnNavigator.openSegment', openSegment),
    vscode.commands.registerCommand('guthonSvnNavigator.revealInSource', openPage),
    vscode.commands.registerCommand('guthonSvnNavigator.openIndex', (element) => openPage({ filePath: element?.indexPath })),
    vscode.commands.registerCommand('guthonSvnNavigator.selectRepository', () => selectRepository(provider)),
    vscode.commands.registerCommand('guthonSvnNavigator.configureSvnExecutable', () => configureSvnExecutable(sourceControlManager)),
    vscode.commands.registerCommand('guthonSvnNavigator.initializeProject', () => initializeProject(provider, output)),
    vscode.commands.registerCommand('guthonSvnNavigator.updateRepository', (element) => updateRepository(provider, output, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.updateAll', () => updateAll(provider, output)),
    vscode.commands.registerCommand('guthonSvnNavigator.showStatus', (element) => showRepositoryStatus(provider, output, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.checkSvnStatus', () => checkSvnStatus(provider, sourceControlManager)),
    vscode.commands.registerCommand('guthonSvnNavigator.commitChanges', (element) => commitChanges(provider, sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.refreshSourceControl', (element) => refreshSourceControl(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.refreshRemoteChanges', (element) => refreshRemoteChanges(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.openRemoteChange', openRemoteChange),
    vscode.commands.registerCommand('guthonSvnNavigator.cleanupRepository', (element) => cleanupRepository(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.resolveConflict', (element) => resolveConflict(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.setChangelist', (element) => setChangelist(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.exportPatch', (element) => exportPatch(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.showRepositoryHistory', (element) => showRepositoryHistory(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.openChange', openChange),
    vscode.commands.registerCommand('guthonSvnNavigator.openReadableChange', openReadableChange),
    vscode.commands.registerCommand('guthonSvnNavigator.showFileHistory', showFileHistory),
    vscode.commands.registerCommand('guthonSvnNavigator.addUnversionedChange', (element) => addUnversionedChange(sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.revertChange', (element) => revertChange(provider, sourceControlManager, element)),
    vscode.commands.registerCommand('guthonSvnNavigator.revertQuickDiffChange', (resourceUri, changes, changeIndex) => revertQuickDiffChange(provider, sourceControlManager, resourceUri, changes, changeIndex)),
    vscode.commands.registerCommand('guthonSvnNavigator.revertReadableDiffBlock', () => revertReadableDiffBlock(provider, sourceControlManager, readableDiffProvider)),
    vscode.workspace.onDidSaveTextDocument((document) => sourceControlManager.scheduleRefreshForPath(document.uri.fsPath)),
    vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => sourceControlManager.scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidDeleteFiles((event) => event.files.forEach((uri) => sourceControlManager.scheduleRefreshForPath(uri.fsPath))),
    vscode.workspace.onDidRenameFiles((event) => event.files.forEach((file) => {
      sourceControlManager.scheduleRefreshForPath(file.oldUri.fsPath);
      sourceControlManager.scheduleRefreshForPath(file.newUri.fsPath);
    })),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.svnExecutable`)) {
        resetSvnExecutableCache();
        void sourceControlManager.refreshAll();
      }
      if (event.affectsConfiguration(CONFIG_SECTION)) provider.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );
  void provider.refresh().catch((error) => {
    vscode.window.showErrorMessage(`加载中文源码目录失败：${error.message}`);
  });
}

function deactivate() {}

module.exports = { activate, deactivate, discoverRepositoryRoots, findRepositoryRoot, isRepositoryRoot };
