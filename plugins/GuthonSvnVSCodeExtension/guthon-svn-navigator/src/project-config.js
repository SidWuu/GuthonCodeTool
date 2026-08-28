'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPathWithin, samePath } = require('./path-utils');

const PROJECT_CONFIG_NAMES = ['guthon-projects.yaml'];
const DEFAULT_PROJECT_CONFIG_TEMPLATE = `version: 2

# 所有项目共用一个 SVN 用户名；密码不写入配置。
username: "your-svn-user"

projects:
  # 新式分片 SVN：每个 checkout_paths 都是项目内的独立工作副本。
  gmeSvn:
    name: 期现产品
    path: gmeSvn
    repository_url: "https://source.example/project"
    checkout_paths:
      - skill
      - public
      - systems/SYS-XXXX
      - datasources/0000

  # 新式整项目 SVN：不填写 checkout_paths，整个项目根目录只 checkout 一次。
  # 根目录应直接包含 systems/、datasources/、public/ 和 skill/。
  newProject:
    name: 新项目
    path: newProject
    repository_url: "https://source.example/new-project"
`;

function stripComment(value) {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && quote) {
      index += 1;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char;
      continue;
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function scalar(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text === 'true') return true;
  if (text === 'false') return false;
  const inlineList = text.match(/^\[(.*)\]$/);
  if (inlineList) return inlineList[1].split(',').map(scalar).filter(Boolean);
  return text;
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

function addPath(project, value) {
  const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return;
  if (!project.checkoutPaths.includes(normalized)) project.checkoutPaths.push(normalized);
}

function newProject(id, defaults = {}) {
  return {
    id: String(id || '').trim(),
    name: '',
    path: '',
    repositoryUrl: '',
    checkoutRoot: '',
    username: String(defaults.username || '').trim(),
    checkoutPaths: [],
  };
}

function assignProjectValue(project, key, value) {
  const normalizedKey = String(key || '').trim().toLowerCase().replace(/-/g, '_');
  const parsed = scalar(value);
  const aliases = {
    project_id: 'id',
    project_name: 'name',
    name: 'name',
    directory: 'path',
    project_path: 'path',
    path: 'path',
    svn_url: 'repositoryUrl',
    repository_url: 'repositoryUrl',
    checkout_root: 'checkoutRoot',
  };
  if (aliases[normalizedKey]) {
    project[aliases[normalizedKey]] = String(parsed || '').trim();
    return;
  }
  if (normalizedKey === 'checkout_paths') {
    if (Array.isArray(parsed)) parsed.forEach((item) => addPath(project, item));
    return;
  }
}

function parseProjectConfig(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => stripComment(line));
  const projects = [];
  let inProjects = false;
  let projectsIndent = -1;
  let current = null;
  let currentIndent = -1;
  let listSection = '';
  let sharedUsername = '';

  const finishCurrent = () => {
    if (!current || !current.id) return;
    current.path = current.path || current.id;
    current.name = current.name || current.id;
    projects.push(current);
  };

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const indent = indentOf(rawLine);
    const line = rawLine.trim();
    const keyValue = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (indent === 0 && line === 'projects:') {
      finishCurrent();
      current = null;
      inProjects = true;
      projectsIndent = indent;
      continue;
    }
    if (indent === 0 && keyValue?.[1] === 'username' && keyValue[2]) {
      sharedUsername = String(scalar(keyValue[2]) || '').trim();
      if (current && !current.username) current.username = sharedUsername;
      continue;
    }

    if (inProjects && indent === projectsIndent + 2) {
      const mappingProject = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/);
      const listProject = line.match(/^-\s*(?:id|project_id):\s*(.+)$/);
      if (mappingProject || listProject) {
        finishCurrent();
        current = newProject(mappingProject ? mappingProject[1] : scalar(listProject[1]), {
          username: sharedUsername,
        });
        currentIndent = indent;
        listSection = '';
        if (listProject) currentIndent = indent;
        continue;
      }
    }
    if (!current) continue;
    if (inProjects && indent <= currentIndent && !line.startsWith('- ')) continue;
    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem && listSection) {
      addPath(current, scalar(listItem[1]));
      continue;
    }
    if (!keyValue) continue;
    const key = keyValue[1];
    const value = keyValue[2] || '';
    if (value) {
      const projectLevel = inProjects && indent === currentIndent + 2;
      if (projectLevel) assignProjectValue(current, key, value);
    }
    else if (key.replace(/-/g, '_') === 'checkout_paths') listSection = key;
    else listSection = '';
  }
  finishCurrent();
  return projects.filter((project, index, all) => all.findIndex((item) => item.id === project.id) === index);
}

function findProjectConfigPath(startRoot, options = {}) {
  let current = path.resolve(startRoot);
  const maxDepth = options.localOnly ? 1 : 3;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

async function ensureProjectConfig(workspaceRoot, options = {}) {
  const root = path.resolve(workspaceRoot);
  const existing = options.localOnly
    ? PROJECT_CONFIG_NAMES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate))
    : findProjectConfigPath(root);
  if (existing) return { configPath: existing, created: false };
  const configPath = path.join(root, PROJECT_CONFIG_NAMES[0]);
  await fs.promises.mkdir(root, { recursive: true });
  try {
    await fs.promises.writeFile(configPath, DEFAULT_PROJECT_CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    return { configPath, created: true };
  } catch (error) {
    if (error.code === 'EEXIST') return { configPath, created: false };
    throw error;
  }
}

function readProjectConfigurations(startRoot, options = {}) {
  const configPath = findProjectConfigPath(startRoot, options);
  if (!configPath) return { configPath: '', workspaceRoot: path.resolve(startRoot), projects: [] };
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { configPath, workspaceRoot: path.dirname(configPath), projects: [] };
  }
  return {
    configPath,
    workspaceRoot: path.dirname(configPath),
    projects: parseProjectConfig(text),
  };
}

function resolveProjectRoot(workspaceRoot, project) {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, project.path || project.id);
  if (!isPathWithin(root, candidate)) return '';
  return candidate;
}

function projectCheckoutMode(project) {
  return Array.isArray(project?.checkoutPaths) && project.checkoutPaths.length
    ? 'composite'
    : 'monolithic';
}

function configuredProjectRootsForPath(startRoot, options = {}) {
  const start = path.resolve(startRoot);
  const configured = readProjectConfigurations(start, options);
  return configured.projects
    .map((project) => resolveProjectRoot(configured.workspaceRoot, project))
    .filter((projectRoot) => projectRoot && (
      samePath(projectRoot, start)
      || isPathWithin(start, projectRoot)
      || isPathWithin(projectRoot, start)
    ));
}

module.exports = {
  DEFAULT_PROJECT_CONFIG_TEMPLATE,
  PROJECT_CONFIG_NAMES,
  configuredProjectRootsForPath,
  ensureProjectConfig,
  findProjectConfigPath,
  parseProjectConfig,
  projectCheckoutMode,
  readProjectConfigurations,
  resolveProjectRoot,
};
