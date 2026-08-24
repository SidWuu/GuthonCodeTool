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

function readableChangeName(repository, entry) {
  const filePath = path.resolve(entry.filePath);
  const extension = path.extname(filePath);
  if (repository.sourceCategory === 'pages') {
    const page = repository.pageByFilePath?.get(pathKey(filePath));
    if (page) return `${page.label}（${path.basename(filePath, extension)}）${extension}`;
    if (path.basename(filePath).toLowerCase() === 'index.md') return '页面索引（index.md）';
  }
  const indexedName = indexedObjectDisplayName(
    repository.aiObjectByFilePath?.get(pathKey(filePath)),
    filePath
  );
  if (indexedName) return indexedName;
  if (entry.sourceIdentity?.label) return appendExtension(entry.sourceIdentity.label, filePath);
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

function isDeletedOrMissingChange(entry, fileExists = true) {
  return ['deleted', 'missing'].includes(entry?.item) || !fileExists;
}

module.exports = {
  buildAiObjectByFilePath,
  indexedObjectDisplayName,
  isDeletedOrMissingChange,
  readableChangeName
};
