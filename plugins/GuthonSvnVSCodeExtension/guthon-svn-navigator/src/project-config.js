'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPathWithin, samePath } = require('./path-utils');

const PROJECT_CONFIG_NAMES = ['guthon-projects.yaml', '谷神项目配置.yaml', '谷神项目编码字典.yaml'];
const PROJECT_PATH_KEYS = new Set(['pages', 'procedures', 'system-script', 'system_script', 'tables', 'views', 'skill', 'public']);
const DEFAULT_PROJECT_CONFIG_TEMPLATE = `version: 2

# 使用英文配置字段；data_source_name 和 system_name 保留平台业务显示名称。
# username 只填写 SVN 用户名，不要填写密码或手机号。
projects:
  gmeSvn:
    name: 期现产品
    path: gmeSvn
    repository_url: "https://source.steel56.com.cn/gss/product/1305773397847855104/SYS-A7EE-D0E8-BE614B80"
    username: "your-svn-user"
    checkout_paths:
      - skill
      - public
      - pages/SYS-A7EE-D0E8-BE614B80
      - pages/SYS-6DB9-0A85-52DE4A3D
      - pages/SYS-BBD8-26A8-B8194BC7
      - pages/SYS-DD01-06B1-6B6C4E52
      - procedures/0000
      - procedures/0008
      - procedures/0015
      - system-script/SYS-A7EE-D0E8-BE614B80
      - system-script/SYS-6DB9-0A85-52DE4A3D
      - system-script/SYS-BBD8-26A8-B8194BC7
      - system-script/SYS-DD01-06B1-6B6C4E52
      - tables/0000
      - tables/0008
      - tables/0015
      - views/0000
      - views/0008
      - views/0015
    data_sources:
      - data_source_id: "0000"
        data_source_name: "主数据源"
        source_paths:
          procedures: "procedures/0000"
          tables: "tables/0000"
          views: "views/0000"
        systems:
          - system_id: "SYS-A7EE-D0E8-BE614B80"
            system_name: "主数据"
            system_alias_id: "com.golden.basic"
            source_paths:
              pages: "pages/SYS-A7EE-D0E8-BE614B80"
              page_index: "pages/SYS-A7EE-D0E8-BE614B80/index.md"
              system_script: "system-script/SYS-A7EE-D0E8-BE614B80"
      - data_source_id: "0008"
        data_source_name: "贸易系统"
        source_paths:
          procedures: "procedures/0008"
          tables: "tables/0008"
          views: "views/0008"
        systems:
          - system_id: "SYS-6DB9-0A85-52DE4A3D"
            system_name: "国际贸易"
            system_alias_id: "com.golden.bdp.itsdp"
            source_paths:
              pages: "pages/SYS-6DB9-0A85-52DE4A3D"
              page_index: "pages/SYS-6DB9-0A85-52DE4A3D/index.md"
              system_script: "system-script/SYS-6DB9-0A85-52DE4A3D"
          - system_id: "SYS-BBD8-26A8-B8194BC7"
            system_name: "国内贸易"
            system_alias_id: "com.golden.bdp.sdp"
            source_paths:
              pages: "pages/SYS-BBD8-26A8-B8194BC7"
              page_index: "pages/SYS-BBD8-26A8-B8194BC7/index.md"
              system_script: "system-script/SYS-BBD8-26A8-B8194BC7"
      - data_source_id: "0015"
        data_source_name: "风险管理"
        source_paths:
          procedures: "procedures/0015"
          tables: "tables/0015"
          views: "views/0015"
        systems:
          - system_id: "SYS-DD01-06B1-6B6C4E52"
            system_name: "风险管理"
            system_alias_id: "com.golden.bdp.gdrm"
            source_paths:
              pages: "pages/SYS-DD01-06B1-6B6C4E52"
              page_index: "pages/SYS-DD01-06B1-6B6C4E52/index.md"
              system_script: "system-script/SYS-DD01-06B1-6B6C4E52"

  # 新项目请复制下面的配置，并填写真实 SVN 地址和 checkout 路径。
  # scsjSvn:
  #   name: scsjSvn
  #   path: scsjSvn
  #   repository_url: "https://source.example/svn/project"
  #   username: "your-svn-user"
  #   checkout_paths:
  #     - pages/SYS-EXAMPLE
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

function newProject(id) {
  return {
    id: String(id || '').trim(),
    name: '',
    path: '',
    repositoryUrl: '',
    checkoutRoot: '',
    username: '',
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
    username: 'username',
  };
  if (aliases[normalizedKey]) {
    project[aliases[normalizedKey]] = String(parsed || '').trim();
    return;
  }
  if (normalizedKey === 'checkout_paths' || normalizedKey === 'paths' || normalizedKey === 'include') {
    if (Array.isArray(parsed)) parsed.forEach((item) => addPath(project, item));
    return;
  }
  if (PROJECT_PATH_KEYS.has(normalizedKey) && typeof parsed === 'string') addPath(project, parsed);
}

function parseProjectConfig(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => stripComment(line));
  const projects = [];
  let inProjects = false;
  let projectsIndent = -1;
  let current = null;
  let currentIndent = -1;
  let listSection = '';
  let legacyProject = null;

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
    if (indent === 0 && keyValue?.[1] === 'project' && keyValue[2]) {
      finishCurrent();
      legacyProject = newProject(scalar(keyValue[2]));
      current = legacyProject;
      currentIndent = -1;
      inProjects = false;
      continue;
    }

    if (inProjects && indent === projectsIndent + 2) {
      const mappingProject = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/);
      const listProject = line.match(/^-\s*(?:id|project_id):\s*(.+)$/);
      if (mappingProject || listProject) {
        finishCurrent();
        current = newProject(mappingProject ? mappingProject[1] : scalar(listProject[1]));
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
    if (value) assignProjectValue(current, key, value);
    else if (['checkout_paths', 'paths', 'include'].includes(key.replace(/-/g, '_'))) listSection = key;
    else listSection = '';
  }
  finishCurrent();
  if (legacyProject && !projects.includes(legacyProject)) {
    legacyProject.path = legacyProject.path || legacyProject.id;
    legacyProject.name = legacyProject.name || legacyProject.id;
    projects.push(legacyProject);
  }
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
  readProjectConfigurations,
  resolveProjectRoot,
};
