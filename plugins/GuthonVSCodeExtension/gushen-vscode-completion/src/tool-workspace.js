const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATABASE_SCHEMES = {
  mysql: { type: 'mysql', port: 3306 },
  mariadb: { type: 'mysql', port: 3306 },
  postgres: { type: 'postgresql', port: 5432 },
  postgresql: { type: 'postgresql', port: 5432 },
};

function decodedUrlPart(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function parseDatabaseUrl(value) {
  const source = String(value || '')
    .trim()
    .replace(/^jdbc:/i, '')
    .replace(/\\([@_])/g, '$1');
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error('请输入完整连接地址，例如 postgresql://服务器:5432/数据库');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const dialect = DATABASE_SCHEMES[scheme];
  if (!dialect) throw new Error('当前仅支持 mysql、mariadb、postgresql 连接地址');
  const host = parsed.hostname.trim();
  const database = decodedUrlPart(parsed.pathname.replace(/^\/+/, '')).trim()
    || parsed.searchParams.get('database')
    || parsed.searchParams.get('dbname')
    || parsed.searchParams.get('service')
    || '';
  const port = parsed.port ? Number(parsed.port) : dialect.port;
  if (!host) throw new Error('连接地址缺少服务器');
  if (!database) throw new Error('连接地址缺少数据库或服务名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('数据库端口须为 1-65535');
  return {
    type: dialect.type,
    host,
    port,
    database,
    username: decodedUrlPart(parsed.username).trim(),
    password: decodedUrlPart(parsed.password),
  };
}

function parseDatabaseCredentials(value) {
  const source = String(value || '').trim();
  const labeled = source.match(
    /^(?:用户名|用户|账号|username|user)\s*[:：=\-－—]?\s*(.*?)\s*(?:[,，;；]\s*)?(?:密码|口令|password|pass|pwd)\s*[:：=\-－—]?\s*(.*)$/i
  );
  if (labeled) {
    const username = labeled[1].trim();
    if (username) return { username, password: labeled[2].trim() };
  }
  const separators = [/[，,]/, /[：:]/, /\s+[-－—]\s+/, /\s+/, /[－—]/, /-/];
  for (const separator of separators) {
    const match = separator.exec(source);
    if (!match) continue;
    const username = source.slice(0, match.index).trim();
    const password = source.slice(match.index + match[0].length).trim();
    if (username) return { username, password };
  }
  throw new Error('请同时输入用户名和密码，例如：用户名：postgres，密码：secret');
}

async function prepareWorkspaceSetup(config, window, configurationTarget) {
  const toolHome = config.get('toolHome', '');
  if (!toolHome || !fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'))) return 'setup';

  const confirmed = await window.showWarningMessage(
    `当前工作空间已设置：${toolHome}\n是否切换工作空间？`,
    { modal: true },
    '切换工作空间'
  );
  if (confirmed !== '切换工作空间') return undefined;

  const selected = await window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: '选择新的 GuthonCodeTool 本地数据工作空间',
  });
  if (!selected) return undefined;

  await config.update('toolHome', selected[0].fsPath, configurationTarget);
  return 'switch';
}

function workspaceActions(item) {
  const capability = (name) => Boolean(item.capabilities?.[name]);
  if (item.sourceMode === 'svn') {
    return {
      source: [
        ['搜索工作区完整索引', 'gushenCompletion.searchWorkspace', 'search'],
        capability('svn.initialize') && ['导入 SVN checkout 配置', 'gushenCompletion.importSvnScope', 'file-add'],
        capability('svn.initialize') && ['从 SVN 范围配置检出/更新', 'gushenCompletion.initializeSvn', 'repo-clone'],
        capability('svn.reindex') && ['扫描/重建本地 SVN 索引', 'gushenCompletion.reindexCalls', 'refresh'],
        capability('svn.browse') && ['查看谷神同步源码', 'gushenCompletion.focusSvnSource', 'list-tree'],
        capability('svn.status') && ['管理本地源码变更', 'gushenCompletion.manageSvnChanges', 'source-control'],
        ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
      ].filter(Boolean),
      workcopy: [],
      metadata: [['配置数据库排查', 'gushenCompletion.configureDatabaseDiagnosis', 'database']],
      diagnose: false,
      syncAll: undefined,
    };
  }
  return {
    source: [
      ['搜索工作区完整索引', 'gushenCompletion.searchWorkspace', 'search'],
      ['拉取源码重建索引', 'gushenCompletion.initSourceIndex', 'database'],
      ['拉取源码', 'gushenCompletion.syncWorkspaceSource', 'sync'],
      ['重建索引', 'gushenCompletion.reindexCalls', 'refresh'],
      ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
    ],
    workcopy: [['检查或打包 Workcopy', 'gushenCompletion.inspectWorkcopy', 'package']],
    metadata: [
      ['配置数据库排查', 'gushenCompletion.configureDatabaseDiagnosis', 'database'],
      ['导出表结构', 'gushenCompletion.exportSchema', 'table'],
      ['导出单据类型', 'gushenCompletion.exportBillTypes', 'list-tree'],
      ['导出系统脚本', 'gushenCompletion.exportSystemScripts', 'file-code'],
      ['导出视图源码', 'gushenCompletion.exportViews', 'eye'],
    ],
    diagnose: true,
    syncAll: ['同步工作区全部资料', 'gushenCompletion.syncWorkspaceAll', 'cloud-download'],
  };
}

function suggestedWorkspaceId(name, kind, now = new Date()) {
  const normalized = String(name || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase();
  if (normalized) return normalized;
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');
  return `${kind}-${stamp}`;
}

function configuredSvnUsername(toolHome) {
  const syncPath = path.join(toolHome, 'config', 'sync.yaml');
  if (!fs.existsSync(syncPath)) return '';
  const svn = fs.readFileSync(syncPath, 'utf8').match(/^svn:\s*\n((?:^\s+.*\n?)*)/m);
  const username = svn?.[1].match(/^\s+username:\s*["']?([^\s"']*)/m)?.[1];
  return username || '';
}

async function promptWorkspaceCreation(window, workspaces, toolHome, now = new Date()) {
  const kindChoice = await window.showQuickPick([
    { label: '产品', description: '创建 products.<id>', value: 'product' },
    { label: '项目', description: '创建独立的 projects.<id> 快照工作区', value: 'project' },
  ], { title: '添加谷神产品或项目' });
  if (!kindChoice) return undefined;

  const name = await window.showInputBox({
    title: `输入${kindChoice.label}名称`,
    prompt: '该名称用于 Nexus 显示和本地工作区目录',
    validateInput: (value) => String(value || '').trim() ? undefined : '名称不能为空',
  });
  if (name === undefined) return undefined;
  const ids = new Set((workspaces || []).map((item) => item.id));
  const id = await window.showInputBox({
    title: `确认${kindChoice.label}稳定 ID`,
    value: suggestedWorkspaceId(name, kindChoice.value, now),
    prompt: '创建后保持不变，用于 workspaceKey 和本地配置引用',
    validateInput: (value) => {
      const candidate = String(value || '').trim();
      if (!SAFE_ID.test(candidate) || candidate === '.' || candidate === '..') return '仅允许字母、数字、点、下划线和横线，且须以字母或数字开头';
      return ids.has(candidate) ? '该 ID 已存在' : undefined;
    },
  });
  if (id === undefined) return undefined;
  const source = await window.showQuickPick([
    { label: 'SVN', description: '导入谷神 checkout 配置后检出并建立索引', value: 'svn' },
    { label: 'DATABASE', description: '填写开发库连接后拉取源码与资料', value: 'database' },
  ], { title: '选择源码来源' });
  if (!source) return undefined;

  const result = {
    kind: kindChoice.value,
    id: id.trim(),
    name: name.trim(),
    sourceMode: source.value,
  };
  if (source.value === 'svn') {
    const existingUsername = configuredSvnUsername(toolHome);
    if (!existingUsername) {
      const svnUsername = await window.showInputBox({
        title: '输入公共 SVN 用户名',
        prompt: '仅首次需要，之后新增产品/项目自动复用；密码仍由 SVN 系统凭据保存',
        validateInput: (value) => String(value || '').trim() ? undefined : 'SVN 用户名不能为空',
      });
      if (svnUsername === undefined) return undefined;
      result.svnUsername = svnUsername.trim();
    }
    return result;
  }

  const connectionUrl = await window.showInputBox({
    title: '粘贴数据库连接地址',
    prompt: '支持 mysql、mariadb、postgresql；自动解析服务器、端口和数据库/服务名',
    placeHolder: 'postgresql://192.168.1.183:5432/nbkcqx_gdsdp',
    validateInput: (value) => {
      try {
        parseDatabaseUrl(value);
        return undefined;
      } catch (error) {
        return error.message;
      }
    },
  });
  if (connectionUrl === undefined) return undefined;
  const connection = parseDatabaseUrl(connectionUrl);
  const credentials = await window.showInputBox({
    title: '输入数据库用户名和密码',
    value: connection.username
      ? `用户名：${connection.username}，密码：${connection.password}`
      : '',
    prompt: '支持“用户名：user，密码：pass”、user:pass、user,pass、user - pass 或空格分隔',
    validateInput: (value) => {
      try {
        parseDatabaseCredentials(value);
        return undefined;
      } catch (error) {
        return error.message;
      }
    },
  });
  if (credentials === undefined) return undefined;
  const credential = parseDatabaseCredentials(credentials);
  result.datasource = {
    id: `${result.id}-dev`,
    type: connection.type,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: credential.username,
    password: credential.password,
    environment: 'dev',
  };
  return result;
}

module.exports = {
  configuredSvnUsername,
  parseDatabaseCredentials,
  parseDatabaseUrl,
  prepareWorkspaceSetup,
  promptWorkspaceCreation,
  suggestedWorkspaceId,
  workspaceActions,
};
