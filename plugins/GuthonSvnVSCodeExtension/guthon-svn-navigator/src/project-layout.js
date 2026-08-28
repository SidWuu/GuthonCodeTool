'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_NAMES = new Set(['.svn', '.git', 'node_modules', '.DS_Store']);

function directoryEntries(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_NAMES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  } catch {
    return [];
  }
}

function childDisplayName(root, fallback) {
  const marker = directoryEntries(root).find((entry) => entry.name.startsWith('$.'));
  return marker ? marker.name.slice(2).trim() : fallback;
}

function scopeEntries(root, pattern, childName, fallbackName) {
  return directoryEntries(root)
    .filter((entry) => !pattern || pattern.test(entry.name))
    .map((entry) => {
      const scopeRoot = path.join(root, entry.name);
      const sourceRoot = path.join(scopeRoot, childName);
      return {
        id: entry.name,
        name: childDisplayName(scopeRoot, fallbackName(entry.name)),
        root: sourceRoot,
        scopeRoot
      };
    });
}

function procedureIndexMetadata(proceduresRoot) {
  const result = new Map();
  const indexPath = path.join(proceduresRoot, 'index.md');
  let source;
  try { source = fs.readFileSync(indexPath, 'utf8'); } catch { return result; }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[(?:⚡\s*)?([^\]]+?)\]\(([^)]+)\)/);
    if (!match) continue;
    const parts = match[1].split(/\s+-\s+/, 2);
    const objectId = parts[0].trim();
    if (!objectId) continue;
    const target = match[2].split('#', 1)[0].split('?', 1)[0].trim();
    if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
    const filePath = path.resolve(path.dirname(indexPath), target);
    result.set(filePath, {
      objectId,
      name: parts[1]?.trim() || objectId,
      indexPath
    });
  }
  return result;
}

function discoverProjectLayout(projectRoot) {
  const root = path.resolve(projectRoot);
  const systemsRoot = path.join(root, 'systems');
  const dataSourcesRoot = path.join(root, 'datasources');
  const systems = scopeEntries(
    systemsRoot,
    /^SYS-/i,
    'pages',
    (id) => id
  ).map((entry) => ({
    ...entry,
    systemId: entry.id,
    name: childDisplayName(entry.scopeRoot, entry.id),
    pagesRoot: entry.root,
    systemScriptRoot: path.join(entry.scopeRoot, 'system-script')
  }));
  const dataSources = directoryEntries(dataSourcesRoot)
    .filter((entry) => /^\d+$/.test(entry.name))
    .map((entry) => {
      const scopeRoot = path.join(dataSourcesRoot, entry.name);
      return {
        id: entry.name,
        dataSourceId: entry.name,
        name: childDisplayName(scopeRoot, entry.name),
        scopeRoot,
        proceduresRoot: path.join(scopeRoot, 'procedures'),
        tablesRoot: path.join(scopeRoot, 'tables'),
        viewsRoot: path.join(scopeRoot, 'views')
      };
    });

  const pageRoots = systems.map((entry) => ({ id: entry.id, name: entry.name, root: entry.pagesRoot }));
  const systemScriptRoots = systems
    .filter((entry) => fs.existsSync(entry.systemScriptRoot))
    .map((entry) => ({ id: entry.id, name: entry.name, root: entry.systemScriptRoot }));
  const sourceRoots = {
    procedures: dataSources.map((entry) => ({ id: entry.id, name: entry.name, root: entry.proceduresRoot })),
    tables: dataSources.map((entry) => ({ id: entry.id, name: entry.name, root: entry.tablesRoot })),
    views: dataSources.map((entry) => ({ id: entry.id, name: entry.name, root: entry.viewsRoot })),
    'system-script': systemScriptRoots
  };
  return {
    kind: 'systems-datasources',
    root,
    systemsRoot,
    dataSourcesRoot,
    systems,
    dataSources,
    pageRoots,
    sourceRoots,
    systemNames: new Map(systems.map((entry) => [entry.id, entry.name])),
    dataSourceNames: new Map(dataSources.map((entry) => [entry.id, entry.name])),
    procedureIndexes: new Map(dataSources.map((entry) => [entry.id, procedureIndexMetadata(entry.proceduresRoot)]))
  };
}

function projectSourceRoot(layout, category, scopeId) {
  return layout?.sourceRoots?.[category]?.find((entry) => entry.id === scopeId)?.root || '';
}

module.exports = {
  discoverProjectLayout,
  projectSourceRoot,
  procedureIndexMetadata
};
