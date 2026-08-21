'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { collectPages, parsePageComponents } = require('./page-index');

const INDEX_DIRECTORY = path.join('docs', 'ai-index');
const INDEX_FILES = {
  manifest: 'manifest.json',
  objects: 'objects.jsonl',
  relations: 'relations.jsonl'
};
const SOURCE_CATEGORIES = ['procedures', 'system-script', 'tables', 'views'];
const IGNORED_NAMES = new Set(['.svn', '.git', 'node_modules', '.DS_Store', 'ai-index']);
const SQL_STOP_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS',
  'ON', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'INTO', 'UPDATE', 'DELETE', 'INSERT', 'MERGE',
  'VALUES', 'SET', 'GROUP', 'BY', 'ORDER', 'HAVING', 'UNION', 'ALL', 'WITH', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'OVER', 'PARTITION', 'LIMIT', 'OFFSET', 'FETCH', 'FOR', 'EXISTS'
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeSearchText(value) {
  return String(value || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function relativePath(root, filePath) {
  return normalizePath(path.relative(root, filePath) || '.');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function safeFileName(value) {
  return String(value || 'object')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'object';
}

function scalar(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  return text;
}

function projectDictionary(root, project) {
  const result = { dataSources: new Map(), systems: new Map() };
  const candidates = [];
  let current = path.resolve(root);
  for (let depth = 0; depth < 3; depth += 1) {
    for (const name of ['guthon-projects.yaml', '谷神项目配置.yaml', '谷神项目编码字典.yaml']) {
      candidates.push(path.join(current, name), path.join(current, 'docs', name));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const dictionaryPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!dictionaryPath) return result;
  let source = '';
  try { source = fs.readFileSync(dictionaryPath, 'utf8'); } catch { return result; }
  const projectId = String(project?.projectId || project?.id || '').trim();
  if (projectId) {
    const marker = new RegExp(`^\\s{2}${projectId}:\\s*$`, 'm');
    const match = marker.exec(source);
    if (match) {
      const start = match.index;
      const next = source.slice(start + match[0].length).search(/^\s{2}[A-Za-z0-9_-]+:\s*$/m);
      source = source.slice(start, next < 0 ? source.length : start + match[0].length + next);
    }
  }
  let dataSourceId = '';
  let systemId = '';
  for (const line of source.split(/\r?\n/)) {
    const data = line.match(/^\s*-\s+data_source_id:\s*(.+?)\s*$/);
    if (data) { dataSourceId = scalar(data[1]); systemId = ''; continue; }
    const dataName = line.match(/^\s+data_source_name:\s*(.+?)\s*$/);
    if (dataName && dataSourceId) result.dataSources.set(dataSourceId, scalar(dataName[1]));
    const system = line.match(/^\s*-\s+system_id:\s*(.+?)\s*$/);
    if (system) { systemId = scalar(system[1]); continue; }
    const systemName = line.match(/^\s+system_name:\s*(.+?)\s*$/);
    if (systemName && systemId) result.systems.set(systemId, scalar(systemName[1]));
  }
  return result;
}

async function walkFiles(directory, output = []) {
  let entries;
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(filePath, output);
    else output.push(filePath);
  }
  return output;
}

function sourceObjectId(category, filePath, content) {
  const fallback = path.basename(filePath, path.extname(filePath));
  if (category === 'procedures') {
    return content.match(/^\s*\*\s*@functionId\s+([^\r\n]*)$/m)?.[1]?.trim() || fallback;
  }
  if (category === 'tables' || category === 'views') {
    try {
      const json = JSON.parse(content);
      const idKey = category === 'tables' ? 'tableId' : 'viewId';
      return String(json[idKey] || fallback).trim();
    } catch { return fallback; }
  }
  if (category === 'system-script') {
    return content.match(/^\s*\*\s*@(?:serviceCompId|serviceComponentId|componentId|compId)\s+([^\r\n]*)$/mi)?.[1]?.trim() || fallback;
  }
  return fallback;
}

function sourceObjectName(category, filePath, content, objectId) {
  const fallback = path.basename(filePath, path.extname(filePath));
  if (category === 'procedures') {
    return content.match(/^\s*\*\s*@description\s*([^\r\n]*)$/m)?.[1]?.trim() || fallback;
  }
  if (category === 'tables' || category === 'views') {
    try {
      const json = JSON.parse(content);
      const nameKey = category === 'tables' ? 'tableName' : 'viewName';
      return String(json[nameKey] || json.name || json.label || objectId || fallback).trim();
    } catch { return fallback; }
  }
  if (category === 'system-script') {
    return content.match(/^\s*\*\s*@description\s*([^\r\n]*)$/m)?.[1]?.trim() || fallback;
  }
  return fallback;
}

function pageServiceComponentId(filePath, content) {
  return content.match(/^\s*\*\s*@pageAliasId\s+([^\r\n]*)$/mi)?.[1]?.trim()
    || path.basename(filePath, path.extname(filePath));
}

function pageServiceComponentName(filePath, content, objectId) {
  return content.match(/^\s*\*\s*@pageName\s+([^\r\n]*)$/mi)?.[1]?.trim()
    || content.match(/^\s*\*\s*@description\s+([^\r\n]*)$/mi)?.[1]?.trim()
    || objectId
    || path.basename(filePath, path.extname(filePath));
}

function scopeNames(category, scopeId, dictionary, systems) {
  return category === 'system-script'
    ? (systems.get(scopeId) || dictionary.systems.get(scopeId) || scopeId)
    : (dictionary.dataSources.get(scopeId) || scopeId);
}

function addAliases(record, values) {
  const aliases = new Set(record.aliases || []);
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && normalizeSearchText(text) !== normalizeSearchText(record.name)) aliases.add(text);
  }
  record.aliases = [...aliases];
}

function extractSqlReferences(text) {
  const references = [];
  const pattern = /\b(?:from|join|into|update|delete\s+from|merge\s+into)\s+([A-Za-z_][A-Za-z0-9_$#.]*)/gi;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const name = match[1].split('.').pop().replace(/[\]\["'`]/g, '');
    const upper = name.toUpperCase();
    if (!name || SQL_STOP_WORDS.has(upper) || references.some((item) => item.name === upper)) continue;
    references.push({ name: upper, evidence: match[0] });
  }
  return references;
}

function extractProcedureReferences(text) {
  const references = [];
  const pattern = /(?:proc\.(?:find|invoke)|\$vs\.proc\.(?:find|invoke)|(?:gUtil|gutil)\.request|invoke)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const name = match[1].trim();
    if (name && !references.some((item) => item.name === name)) references.push({ name, evidence: match[0] });
  }
  return references;
}

function genericPageDetails(source) {
  const scripts = [];
  const sqls = [];
  const components = [];
  function visit(value, pointer = '$', context = {}) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`, context));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const nextContext = {
      ...context,
      name: value.name || value.label || value.aliasName || value.fieldId || value.fdId || context.name || ''
    };
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${key}`;
      if (typeof child === 'string' && child.trim()) {
        if (key === 'sql' || key === 'SQL' || key === 'querySql') {
          sqls.push({ pointer: childPointer, component: nextContext.name, text: child });
        } else if (key === 'script' || /Script$/.test(key)) {
          scripts.push({ pointer: childPointer, event: key, component: nextContext.name, text: child });
        }
      }
      visit(child, childPointer, nextContext);
    }
  }
  let json;
  try { json = JSON.parse(source); } catch { return { scripts, sqls, components }; }
  visit(json);
  try {
    const tree = parsePageComponents(source);
    const collect = (nodes) => {
      for (const node of nodes || []) {
        if (node.kind !== 'event' && node.kind !== 'datasource' && node.label) components.push({ label: node.label, path: node.virtualPath || '' });
        collect(node.children);
      }
    };
    collect(tree);
  } catch {
    // The generic JSON walk above still provides scripts and SQL for a page
    // whose UI structure is not understood by the page component parser.
  }
  return {
    scripts,
    sqls,
    components: [...new Map(components.map((item) => [`${item.label}\n${item.path}`, item])).values()]
  };
}

function pageRecord(repository, page, dictionary) {
  const pagePath = page.filePath ? relativePath(repository.root, page.filePath) : '';
  const systemName = dictionary.systems.get(page.systemId) || page.systemId || '';
  const record = {
    projectId: repository.projectId,
    projectName: repository.label,
    kind: 'page',
    objectId: page.filePath ? `page:${pagePath}` : `page:${page.label}`,
    name: page.label,
    aliases: [],
    systemId: page.systemId || '',
    systemName,
    pageType: page.pageType || '页面对象',
    path: pagePath,
    indexPath: page.indexPath ? relativePath(repository.root, page.indexPath) : '',
    breadcrumb: page.breadcrumb || page.label,
    sourceExists: Boolean(page.filePath && fs.existsSync(page.filePath))
  };
  addAliases(record, [page.systemId, systemName, page.pageType, page.breadcrumb, page.linkTarget]);
  return record;
}

function makeRelation(source, targetKind, targetId, relation, evidence, extra = {}) {
  return {
    projectId: source.projectId,
    from: `${source.kind}:${source.objectId}`,
    to: `${targetKind}:${targetId}`,
    relation,
    evidence: String(evidence || '').slice(0, 240),
    ...extra
  };
}

async function buildProjectAiIndex(repository) {
  const root = path.resolve(repository.root);
  const dictionary = projectDictionary(root, repository);
  const systems = new Map((repository.systems || []).map((system) => [system.systemId, system.label]));
  const objects = [];
  const relations = [];
  const pageDetails = new Map();
  const sourceContents = new Map();
  const indexedServiceComponentPaths = new Set();

  const addServiceComponent = async (filePath, systemId = '', parentPage = null) => {
    const normalizedFilePath = path.resolve(filePath);
    if (indexedServiceComponentPaths.has(normalizedFilePath)) return;
    indexedServiceComponentPaths.add(normalizedFilePath);
    let componentSource = '';
    try { componentSource = await fs.promises.readFile(normalizedFilePath, 'utf8'); } catch { return; }
    const objectId = pageServiceComponentId(normalizedFilePath, componentSource);
    const headerPageId = componentSource.match(/^\s*\*\s*@pageId\s+([^\r\n]*)$/mi)?.[1]?.trim() || '';
    const componentRecord = {
      projectId: repository.projectId,
      projectName: repository.label,
      kind: 'service-component',
      objectId,
      name: pageServiceComponentName(normalizedFilePath, componentSource, objectId),
      aliases: [],
      systemId,
      systemName: systems.get(systemId) || dictionary.systems.get(systemId) || '',
      pageId: parentPage?.objectId || headerPageId,
      pageName: parentPage?.name || '',
      path: relativePath(root, normalizedFilePath),
      readOnly: false
    };
    addAliases(componentRecord, [objectId, path.basename(normalizedFilePath), componentRecord.pageName, systemId]);
    objects.push(componentRecord);
    sourceContents.set(`${componentRecord.kind}:${componentRecord.objectId}:${componentRecord.path}`, {
      record: componentRecord,
      source: componentSource
    });
    for (const componentReference of extractProcedureReferences(componentSource)) {
      relations.push(makeRelation(componentRecord, 'procedure', componentReference.name, 'calls', componentReference.evidence, { unresolved: true }));
    }
    for (const componentReference of extractSqlReferences(componentSource)) {
      relations.push(makeRelation(componentRecord, 'table-or-view', componentReference.name, 'uses', componentReference.evidence, { unresolved: true }));
    }
  };

  for (const page of collectPages(repository.systems || [])) {
    const record = pageRecord(repository, page, dictionary);
    objects.push(record);
    if (!page.filePath || !fs.existsSync(page.filePath)) continue;
    let source = '';
    try { source = await fs.promises.readFile(page.filePath, 'utf8'); } catch { continue; }
    const details = genericPageDetails(source);
    pageDetails.set(record.objectId, details);
    sourceContents.set(record.objectId, { record, source });
    for (const reference of extractProcedureReferences(source)) {
      relations.push(makeRelation(record, 'procedure', reference.name, 'calls', reference.evidence, { unresolved: true }));
    }
    for (const reference of extractSqlReferences(source)) {
      relations.push(makeRelation(record, 'table-or-view', reference.name, 'uses', reference.evidence, { unresolved: true }));
    }

    // 页面目录下的独立 .gss 文件就是页面服务组件。它们不属于
    // system-script/，但页面中的 runServiceComp 会直接调用这些对象。
    let siblings = [];
    try {
      siblings = await fs.promises.readdir(path.dirname(page.filePath), { withFileTypes: true });
    } catch {
      siblings = [];
    }
    for (const sibling of siblings.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.gss')) {
      await addServiceComponent(path.join(path.dirname(page.filePath), sibling.name), page.systemId || '', record);
    }
  }

  // 服务组件可能与页面 JSON 不在同一个分片目录，统一扫描 pages 下的所有 .gss。
  for (const filePath of await walkFiles(path.join(root, 'pages'))) {
    if (path.extname(filePath).toLowerCase() !== '.gss') continue;
    const relative = relativePath(root, filePath);
    const systemId = relative.match(/^pages\/([^/]+)\//)?.[1] || '';
    await addServiceComponent(filePath, systemId);
  }

  for (const category of SOURCE_CATEGORIES) {
    const categoryRoot = path.join(root, category);
    if (!fs.existsSync(categoryRoot)) continue;
    const scopes = (await fs.promises.readdir(categoryRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !IGNORED_NAMES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const scope of scopes) {
      const scopeId = scope.name;
      const scopeName = scopeNames(category, scopeId, dictionary, systems);
      for (const filePath of await walkFiles(path.join(categoryRoot, scopeId))) {
        const extension = path.extname(filePath).toLowerCase();
        if (!['.gss', '.vm', '.js', '.json', '.sql', '.txt'].includes(extension)) continue;
        let source = '';
        try { source = await fs.promises.readFile(filePath, 'utf8'); } catch { continue; }
        const objectId = sourceObjectId(category, filePath, source);
        const name = sourceObjectName(category, filePath, source, objectId);
        const objectKind = category === 'procedures' ? 'procedure'
          : category === 'system-script' ? 'system-script'
            : category === 'tables' ? 'table' : 'view';
        const record = {
          projectId: repository.projectId,
          projectName: repository.label,
          kind: objectKind,
          objectId,
          name,
          aliases: [],
          scopeId,
          scopeName,
          path: relativePath(root, filePath),
          readOnly: category === 'tables' || category === 'views'
        };
        addAliases(record, [objectId, path.basename(filePath), scopeId, scopeName]);
        objects.push(record);
        sourceContents.set(`${record.kind}:${record.objectId}:${record.path}`, { record, source });
        if (category === 'procedures' || category === 'system-script') {
          for (const reference of extractProcedureReferences(source)) {
            relations.push(makeRelation(record, 'procedure', reference.name, 'calls', reference.evidence, { unresolved: true }));
          }
        }
        for (const reference of extractSqlReferences(source)) {
          relations.push(makeRelation(record, 'table-or-view', reference.name, 'uses', reference.evidence, { unresolved: true }));
        }
      }
    }
  }

  const byProcedure = new Map();
  const byTableView = new Map();
  for (const object of objects) {
    if (object.kind === 'procedure') byProcedure.set(normalizeSearchText(object.objectId), object);
    if (object.kind === 'table' || object.kind === 'view') {
      byTableView.set(normalizeSearchText(object.objectId), object);
      byTableView.set(normalizeSearchText(object.name), object);
    }
  }
  for (const relation of relations) {
    const targetName = relation.to.split(':').slice(1).join(':');
    const lookup = relation.to.startsWith('procedure:') ? byProcedure.get(normalizeSearchText(targetName)) : byTableView.get(normalizeSearchText(targetName));
    if (lookup) {
      relation.to = `${lookup.kind}:${lookup.objectId}`;
      relation.unresolved = false;
    }
  }

  const pages = objects.filter((object) => object.kind === 'page');
  const pageMarkdown = [];
  for (const page of pages) {
    const details = pageDetails.get(page.objectId) || { scripts: [], sqls: [], components: [] };
    const pageRelations = relations.filter((relation) => relation.from === `page:${page.objectId}`);
    const lines = [
      `# 页面：${page.name}`,
      '',
      `- 项目：${page.projectName}（${page.projectId}）`,
      `- 系统：${page.systemName || '-'}（${page.systemId || '-'}）`,
      `- 页面类型：${page.pageType}`,
      `- 源文件：${page.path || '缺失'}`,
      `- 页面索引：${page.indexPath || '缺失'}`,
      '',
      '## 页面结构',
      ...(details.components.length ? details.components.map((component) => `- ${component.label}${component.path ? ` · ${component.path}` : ''}`) : ['- 未提取到组件名称']),
      '',
      '## 事件脚本',
      ...(details.scripts.length ? details.scripts.map((script) => `- ${script.event} · ${script.component || '页面'} · ${script.pointer}`) : ['- 无']),
      '',
      '## 数据源 SQL',
      ...(details.sqls.length ? details.sqls.map((sql) => `- ${sql.component || '数据源'} · \`${sql.pointer}\``) : ['- 无']),
      '',
      '## 依赖关系',
      ...(pageRelations.length ? pageRelations.map((relation) => `- ${relation.relation} → ${relation.to}${relation.unresolved ? '（待确认）' : ''}`) : ['- 未提取到']),
      ''
    ];
    const fileName = `${safeFileName(page.name)}-${sha1(page.path || page.objectId)}.md`;
    pageMarkdown.push({ fileName, content: lines.join('\n') });
    page.aiMarkdown = normalizePath(path.join(INDEX_DIRECTORY, 'pages', fileName));
  }

  const generatedAt = new Date().toISOString();
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt,
      projectId: repository.projectId,
      projectName: repository.label,
      root: '.',
      indexDirectory: INDEX_DIRECTORY,
      files: INDEX_FILES,
      pagesDirectory: normalizePath(path.join(INDEX_DIRECTORY, 'pages')),
      counts: { objects: objects.length, relations: relations.length, pages: pages.length },
      objectKinds: [...new Set(objects.map((object) => object.kind))].sort()
    },
    objects,
    relations,
    pageMarkdown
  };
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, 'utf8');
  try { await fs.promises.rename(temporaryPath, filePath); } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function writeProjectAiIndex(repository, index) {
  const root = path.resolve(repository.root);
  const indexRoot = path.join(root, INDEX_DIRECTORY);
  const pagesRoot = path.join(indexRoot, 'pages');
  await fs.promises.mkdir(pagesRoot, { recursive: true });
  await atomicWrite(path.join(indexRoot, INDEX_FILES.manifest), `${JSON.stringify(index.manifest, null, 2)}\n`);
  await atomicWrite(path.join(indexRoot, INDEX_FILES.objects), `${index.objects.map((object) => JSON.stringify(object)).join('\n')}\n`);
  await atomicWrite(path.join(indexRoot, INDEX_FILES.relations), `${index.relations.map((relation) => JSON.stringify(relation)).join('\n')}\n`);
  for (const page of index.pageMarkdown) await atomicWrite(path.join(pagesRoot, page.fileName), page.content);
  return indexRoot;
}

async function readProjectAiIndex(root) {
  const indexRoot = path.join(path.resolve(root), INDEX_DIRECTORY);
  const readJsonLines = async (name) => {
    try {
      const text = await fs.promises.readFile(path.join(indexRoot, name), 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  };
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(indexRoot, INDEX_FILES.manifest), 'utf8'));
    return { manifest, objects: await readJsonLines(INDEX_FILES.objects), relations: await readJsonLines(INDEX_FILES.relations) };
  } catch { return null; }
}

function searchAiIndex(index, query, limit = 50) {
  const needle = normalizeSearchText(query);
  if (!index || !needle) return [];
  return index.objects.map((object) => {
    const values = [object.name, object.objectId, ...(object.aliases || []), object.path, object.systemName, object.scopeName, object.breadcrumb];
    const haystack = normalizeSearchText(values.join(' '));
    const exact = values.some((value) => normalizeSearchText(value) === needle);
    const starts = values.some((value) => normalizeSearchText(value).startsWith(needle));
    const score = exact ? 100 : starts ? 60 : haystack.includes(needle) ? 20 : 0;
    return { object, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.object.name.localeCompare(right.object.name, 'zh-CN')).slice(0, limit).map((item) => item.object);
}

function formatAiContext(index, object, root) {
  if (!index || !object) return '';
  const relations = index.relations.filter((relation) => relation.from === `${object.kind}:${object.objectId}` || relation.to === `${object.kind}:${object.objectId}`);
  return [
    `# AI 上下文：${object.name}`,
    '',
    `- 项目：${object.projectName}（${object.projectId}）`,
    `- 类型：${object.kind}`,
    `- 标识：${object.objectId}`,
    `- 路径：${root ? path.join(root, object.path) : object.path}`,
    object.systemName ? `- 系统：${object.systemName}（${object.systemId || '-'}）` : '',
    object.scopeName ? `- 数据源/归属：${object.scopeName}（${object.scopeId || '-'}）` : '',
    object.aiMarkdown ? `- 页面结构索引：${path.join(root || '.', object.aiMarkdown)}` : '',
    '',
    '## 关系',
    ...(relations.length ? relations.map((relation) => `- ${relation.relation}: ${relation.from} -> ${relation.to}${relation.unresolved ? '（待确认）' : ''}`) : ['- 无']),
    ''
  ].filter(Boolean).join('\n');
}

module.exports = {
  INDEX_DIRECTORY,
  buildProjectAiIndex,
  formatAiContext,
  normalizeSearchText,
  readProjectAiIndex,
  searchAiIndex,
  writeProjectAiIndex
};
