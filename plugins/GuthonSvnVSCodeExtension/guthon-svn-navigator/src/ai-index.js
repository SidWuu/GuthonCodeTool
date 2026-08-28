'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { collectPages, parsePageComponents } = require('./page-index');
const {
  inheritCalls,
  inheritanceParentPath,
  inspectInheritance,
  isInheritanceParent,
  materializeInheritance
} = require('./gss-inheritance');
const { discoverProjectLayout } = require('./project-layout');

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
  const dataSourceScripts = [];
  const components = [];
  const dataSourceMode = (value) => String(value?.dsType ?? '').trim() === '1' ? 'script' : 'sql';
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
      if (key === 'datasource' && child && typeof child === 'object' && !Array.isArray(child)) {
        const mode = dataSourceMode(child);
        const sourceKey = mode === 'script' ? 'script' : 'sql';
        if (typeof child[sourceKey] === 'string' && child[sourceKey].trim()) {
          const entry = {
            pointer: `${childPointer}/${sourceKey}`,
            component: nextContext.name,
            text: child[sourceKey],
            dataSourceType: child.dsType ?? '',
            mode
          };
          if (mode === 'script') dataSourceScripts.push(entry);
          else sqls.push(entry);
        }
        continue;
      }
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
  try { json = JSON.parse(source); } catch { return { scripts, sqls, dataSourceScripts, components }; }
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
    dataSourceScripts,
    components: [...new Map(components.map((item) => [`${item.label}\n${item.path}`, item])).values()]
  };
}

function pageRecord(repository, page, layout) {
  const pagePath = page.filePath ? relativePath(repository.root, page.filePath) : '';
  const systemName = layout.systemNames.get(page.systemId) || page.systemId || '';
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

async function effectiveInheritedSource(root, filePath, source) {
  if (isInheritanceParent(filePath)) return { skip: true, source };
  const parentPath = inheritanceParentPath(filePath);
  const parentExists = Boolean(parentPath && fs.existsSync(parentPath));
  if (!parentExists && !inheritCalls(source).length) return { skip: false, source, inheritance: null };
  let parentSource = '';
  if (parentExists) {
    try { parentSource = await fs.promises.readFile(parentPath, 'utf8'); } catch { parentSource = ''; }
  }
  const inspected = inspectInheritance(filePath, source, parentSource, parentExists);
  if (!inspected) return { skip: false, source, inheritance: null };
  const parentRelativePath = relativePath(root, inspected.parentPath);
  const inheritance = {
    state: inspected.state,
    parentPath: parentRelativePath,
    parentReadOnly: true,
    resolvable: inspected.resolvable
  };
  if (inspected.reason) inheritance.reason = inspected.reason;
  let effectiveSource = source;
  if (inspected.state === 'active') {
    effectiveSource = materializeInheritance(filePath, source, parentSource).content;
  }
  return {
    skip: false,
    source: effectiveSource,
    inheritance,
    parentFileName: path.basename(inspected.parentPath),
    parentRelativePath,
    effectiveSourcePaths: inspected.state === 'active'
      ? [relativePath(root, filePath), parentRelativePath]
      : [relativePath(root, filePath)]
  };
}

async function buildProjectAiIndex(repository) {
  const root = path.resolve(repository.root);
  const layout = repository.layoutData || discoverProjectLayout(root);
  const systems = layout.systemNames;
  const objects = [];
  const relations = [];
  const pageDetails = new Map();
  const sourceContents = new Map();
  const indexedServiceComponentPaths = new Set();

  const addServiceComponent = async (filePath, systemId = '', parentPage = null) => {
    const normalizedFilePath = path.resolve(filePath);
    if (isInheritanceParent(normalizedFilePath)) return;
    if (indexedServiceComponentPaths.has(normalizedFilePath)) return;
    indexedServiceComponentPaths.add(normalizedFilePath);
    let componentSource = '';
    try { componentSource = await fs.promises.readFile(normalizedFilePath, 'utf8'); } catch { return; }
    const inherited = await effectiveInheritedSource(root, normalizedFilePath, componentSource);
    const effectiveSource = inherited.source;
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
      systemName: systems.get(systemId) || '',
      pageId: parentPage?.objectId || headerPageId,
      pageName: parentPage?.name || '',
      path: relativePath(root, normalizedFilePath),
      readOnly: false
    };
    if (inherited.inheritance) {
      componentRecord.inheritance = inherited.inheritance;
      componentRecord.effectiveSourcePaths = inherited.effectiveSourcePaths;
    }
    addAliases(componentRecord, [
      objectId,
      path.basename(normalizedFilePath),
      componentRecord.pageName,
      systemId,
      inherited.parentFileName,
      inherited.parentRelativePath
    ]);
    objects.push(componentRecord);
    sourceContents.set(`${componentRecord.kind}:${componentRecord.objectId}:${componentRecord.path}`, {
      record: componentRecord,
      source: effectiveSource
    });
    if (inherited.inheritance?.state === 'active') {
      relations.push(makeRelation(componentRecord, 'inherit-source', inherited.parentRelativePath, 'inherits', '@inherit()', { unresolved: false, readOnly: true }));
    } else if (['missing-parent', 'invalid-parent'].includes(inherited.inheritance?.state)) {
      relations.push(makeRelation(componentRecord, 'inherit-source', inherited.parentRelativePath, 'inherits', '@inherit()', { unresolved: true, readOnly: true }));
    }
    for (const componentReference of extractProcedureReferences(effectiveSource)) {
      relations.push(makeRelation(componentRecord, 'procedure', componentReference.name, 'calls', componentReference.evidence, { unresolved: true }));
    }
    for (const componentReference of extractSqlReferences(effectiveSource)) {
      relations.push(makeRelation(componentRecord, 'table-or-view', componentReference.name, 'uses', componentReference.evidence, { unresolved: true }));
    }
  };

  for (const page of collectPages(repository.systems || [])) {
    const record = pageRecord(repository, page, layout);
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
    // systems/*/pages 下的独立 .gss 文件就是页面服务组件。
    let siblings = [];
    try {
      siblings = await fs.promises.readdir(path.dirname(page.filePath), { withFileTypes: true });
    } catch {
      siblings = [];
    }
    for (const sibling of siblings.filter((entry) => entry.isFile()
      && path.extname(entry.name).toLowerCase() === '.gss'
      && !isInheritanceParent(entry.name))) {
      await addServiceComponent(path.join(path.dirname(page.filePath), sibling.name), page.systemId || '', record);
    }
  }

  // 服务组件可能与页面 JSON 不在同一个目录，统一扫描新式 systems/*/pages。
  for (const pageRoot of layout.pageRoots) {
    for (const filePath of await walkFiles(pageRoot.root)) {
      if (path.extname(filePath).toLowerCase() !== '.gss') continue;
      if (isInheritanceParent(filePath)) continue;
      await addServiceComponent(filePath, pageRoot.id);
    }
  }

  for (const category of SOURCE_CATEGORIES) {
    const scopes = layout.sourceRoots[category] || [];
    for (const scope of scopes) {
      if (!fs.existsSync(scope.root)) continue;
      const scopeId = scope.id;
      const scopeName = scope.name;
      for (const filePath of await walkFiles(scope.root)) {
        const extension = path.extname(filePath).toLowerCase();
        if (!['.gss', '.vm', '.js', '.json', '.sql', '.txt'].includes(extension)) continue;
        if (category === 'procedures' && isInheritanceParent(filePath)) continue;
        let source = '';
        try { source = await fs.promises.readFile(filePath, 'utf8'); } catch { continue; }
        const inherited = category === 'procedures'
          ? await effectiveInheritedSource(root, filePath, source)
          : { source, inheritance: null };
        const effectiveSource = inherited.source;
        const indexedIdentity = category === 'procedures'
          ? layout.procedureIndexes.get(scopeId)?.get(path.resolve(filePath))
          : null;
        const objectId = indexedIdentity?.objectId || sourceObjectId(category, filePath, source);
        const name = indexedIdentity?.name || sourceObjectName(category, filePath, source, objectId);
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
          ...(category === 'system-script' ? { systemId: scopeId } : { dataSourceId: scopeId }),
          path: relativePath(root, filePath),
          readOnly: category === 'tables' || category === 'views'
        };
        if (inherited.inheritance) {
          record.inheritance = inherited.inheritance;
          record.effectiveSourcePaths = inherited.effectiveSourcePaths;
        }
        addAliases(record, [
          objectId,
          path.basename(filePath),
          scopeId,
          scopeName,
          inherited.parentFileName,
          inherited.parentRelativePath
        ]);
        objects.push(record);
        sourceContents.set(`${record.kind}:${record.objectId}:${record.path}`, { record, source: effectiveSource });
        if (inherited.inheritance?.state === 'active') {
          relations.push(makeRelation(record, 'inherit-source', inherited.parentRelativePath, 'inherits', '@inherit()', { unresolved: false, readOnly: true }));
        } else if (['missing-parent', 'invalid-parent'].includes(inherited.inheritance?.state)) {
          relations.push(makeRelation(record, 'inherit-source', inherited.parentRelativePath, 'inherits', '@inherit()', { unresolved: true, readOnly: true }));
        }
        if (category === 'procedures' || category === 'system-script') {
          for (const reference of extractProcedureReferences(effectiveSource)) {
            relations.push(makeRelation(record, 'procedure', reference.name, 'calls', reference.evidence, { unresolved: true }));
          }
        }
        for (const reference of extractSqlReferences(effectiveSource)) {
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
    const details = pageDetails.get(page.objectId) || { scripts: [], sqls: [], dataSourceScripts: [], components: [] };
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
      '## 数据源脚本（GSS）',
      ...(details.dataSourceScripts.length ? details.dataSourceScripts.map((script) => `- ${script.component || '数据源'} · \`${script.pointer}\``) : ['- 无']),
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
  const inheritanceStates = objects.reduce((counts, object) => {
    const state = object.inheritance?.state;
    if (state) counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  return {
    manifest: {
      schemaVersion: 3,
      layout: 'systems-datasources',
      generatedAt,
      projectId: repository.projectId,
      projectName: repository.label,
      root: '.',
      indexDirectory: INDEX_DIRECTORY,
      files: INDEX_FILES,
      pagesDirectory: normalizePath(path.join(INDEX_DIRECTORY, 'pages')),
      counts: {
        objects: objects.length,
        relations: relations.length,
        pages: pages.length,
        inheritedObjects: inheritanceStates.active || 0,
        overriddenObjects: inheritanceStates.overridden || 0,
        inheritanceWarnings: (inheritanceStates['missing-parent'] || 0) + (inheritanceStates['invalid-parent'] || 0)
      },
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
    if (manifest.layout !== 'systems-datasources' || manifest.schemaVersion < 3) return null;
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
    object.inheritance ? `- 继承状态：${object.inheritance.state}` : '',
    object.inheritance?.parentPath ? `- 父级实现（只读）：${root ? path.join(root, object.inheritance.parentPath) : object.inheritance.parentPath}` : '',
    object.effectiveSourcePaths?.length ? `- 有效源码：${object.effectiveSourcePaths.map((sourcePath) => root ? path.join(root, sourcePath) : sourcePath).join('、')}` : '',
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
