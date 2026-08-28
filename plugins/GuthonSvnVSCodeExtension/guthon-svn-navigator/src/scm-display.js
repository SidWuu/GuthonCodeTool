'use strict';

const path = require('node:path');

const { pathKey } = require('./path-utils');

const OBJECT_KIND_PRIORITY = {
  page: 20,
  'service-component': 10
};

function objectIdForDisplay(object, filePath) {
  const fallback = path.basename(filePath, path.extname(filePath));
  const objectId = String(object?.objectId || '').trim();
  if (!objectId || objectId.startsWith('page:')) return fallback;
  return objectId;
}

function indexedObjectDisplayName(object, filePath) {
  if (!object) return '';
  const extension = path.extname(filePath);
  const name = String(object.name || '').trim();
  const objectId = objectIdForDisplay(object, filePath);
  if (!name || /^\$\{.*\}$/.test(name)) return '';
  if (name === objectId) return `${name}${extension}`;
  return `${name}（${objectId}）${extension}`;
}

function buildAiObjectByFilePath(root, index) {
  const result = new Map();
  for (const object of index?.objects || []) {
    if (!object?.path) continue;
    const key = pathKey(path.resolve(root, object.path));
    const current = result.get(key);
    const currentPriority = OBJECT_KIND_PRIORITY[current?.kind] || 0;
    const nextPriority = OBJECT_KIND_PRIORITY[object.kind] || 0;
    if (!current || nextPriority > currentPriority) result.set(key, object);
  }
  return result;
}

function appendExtension(label, filePath) {
  const extension = path.extname(filePath);
  if (!label || !extension || label.endsWith(extension)) return label;
  return `${label}${extension}`;
}

function pageDisplayName(page) {
  const label = String(page?.label || '').trim();
  // index.md records the menu path in breadcrumb.  A main page is usually
  // named only “主页面”, so include its owning module to distinguish pages
  // with the same generic name in the SCM change list.
  if (page?.pageType === '主页面' && page?.breadcrumb) {
    const breadcrumb = String(page.breadcrumb).trim();
    if (breadcrumb) return breadcrumb.replace(/\s*\/\s*/g, ' · ');
  }
  return label;
}

function readableChangeName(repository, entry) {
  const filePath = path.resolve(entry.filePath);
  const extension = path.extname(filePath);
  const relative = (entry.relativePath || path.relative(repository.logicalRoot || repository.root, filePath))
    .replace(/\\/g, '/');
  // SCM controls for the new layout are rooted at systems/<systemId>, so the
  // status entry is relative to that child checkout as pages/... rather than
  // to the logical project as systems/<systemId>/pages/....
  const isPagePath = repository.sourceCategory === 'pages'
    || /^systems\/[^/]+\/pages\//i.test(relative)
    || (repository.sourceCategory === 'systems' && /^pages\//i.test(relative));
  if (isPagePath) {
    const page = repository.pageByFilePath?.get(pathKey(filePath));
    if (page) return `${pageDisplayName(page)}（${path.basename(filePath, extension)}）${extension}`;
    if (path.basename(filePath).toLowerCase() === 'index.md') return '页面索引（index.md）';
  }
  const indexedName = indexedObjectDisplayName(
    repository.aiObjectByFilePath?.get(pathKey(filePath)),
    filePath
  );
  if (indexedName) return indexedName;
  if (entry.sourceIdentity?.label) return appendExtension(entry.sourceIdentity.label, filePath);
  const kind = {
    procedures: '过程函数',
    'system-script': '系统脚本',
    tables: '数据表',
    views: '视图'
  }[repository.sourceCategory];
  if (kind) return `${kind} · ${relative}`;
  return relative;
}

function isDeletedOrMissingChange(entry, fileExists = true) {
  return ['deleted', 'missing'].includes(entry?.item) || !fileExists;
}

module.exports = {
  buildAiObjectByFilePath,
  indexedObjectDisplayName,
  isDeletedOrMissingChange,
  readableChangeName
};
