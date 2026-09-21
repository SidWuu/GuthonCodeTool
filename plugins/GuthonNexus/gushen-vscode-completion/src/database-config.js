const DATABASE_SCHEMES = {
  mysql: { engine: 'mysql', port: 3306 },
  mariadb: { engine: 'mysql', port: 3306 },
  postgres: { engine: 'postgresql', port: 5432 },
  postgresql: { engine: 'postgresql', port: 5432 },
  oracle: { engine: 'oracle', port: 1521 },
};

function decode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function parseDiagnosisDatabaseUrl(value) {
  let source = String(value || '').trim().replace(/^jdbc:/i, '');
  source = source.replace(/^oracle:thin:@\/\//i, 'oracle://');
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error('请输入完整连接地址，例如 mysql://服务器:3306/数据库');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const dialect = DATABASE_SCHEMES[scheme];
  if (!dialect) throw new Error('只支持 mysql、postgresql、oracle 连接地址');
  const host = parsed.hostname.trim();
  const database = decode(parsed.pathname.replace(/^\/+/, '')).trim()
    || parsed.searchParams.get('database')
    || parsed.searchParams.get('dbname')
    || parsed.searchParams.get('service')
    || '';
  const port = parsed.port ? Number(parsed.port) : dialect.port;
  if (!host || !database) throw new Error('连接地址必须包含服务器和数据库/服务名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('数据库端口须为 1-65535');
  return {
    engine: dialect.engine,
    host,
    port,
    database,
    username: decode(parsed.username).trim(),
    password: decode(parsed.password),
    ...(parsed.searchParams.get('schema') ? { schema: parsed.searchParams.get('schema').trim() } : {}),
  };
}

async function promptDatabaseDiagnosis(window, workspaceKey) {
  const environment = await window.showQuickPick([
    { label: '开发库', value: 'dev', description: '未明确环境时可作为工作区默认排查库' },
    { label: '测试库', value: 'test', description: '仅在明确要求测试环境时自动选择' },
  ], { title: `配置数据库排查 · ${workspaceKey}` });
  if (!environment) return undefined;
  const targetId = await window.showInputBox({
    title: '目标标识',
    prompt: '同一工作区内唯一，例如 trade-dev',
    value: environment.value,
    validateInput: (text) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? undefined : '仅允许字母、数字、点、下划线和连字符',
  });
  if (!targetId) return undefined;
  const url = await window.showInputBox({
    title: '数据库连接地址',
    prompt: '支持 mysql://、postgresql://、oracle://；可包含用户名，不建议包含密码',
    placeHolder: 'oracle://db.example:1521/pdb',
    validateInput: (text) => {
      try { parseDiagnosisDatabaseUrl(text); return undefined; } catch (error) { return error.message; }
    },
  });
  if (!url) return undefined;
  const connection = parseDiagnosisDatabaseUrl(url);
  const username = connection.username || await window.showInputBox({
    title: '只读数据库用户名',
    prompt: '建议使用专用只读账号',
    ignoreFocusOut: true,
  });
  if (!username) return undefined;
  const password = connection.password || await window.showInputBox({
    title: '数据库密码',
    prompt: '仅写入操作系统凭据库，不写入配置文件或命令参数',
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return undefined;
  let schema = connection.schema || '';
  if (connection.engine === 'oracle' && !schema) {
    schema = await window.showInputBox({
      title: 'Oracle 业务 Schema',
      prompt: '填写业务对象所属 schema，不一定等于登录用户名',
      validateInput: (text) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(text) ? undefined : '请输入有效 schema',
    });
    if (!schema) return undefined;
  }
  return {
    targetId,
    environment: environment.value,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    ...(schema ? { schema } : {}),
    username,
    password,
    makeDefault: true,
  };
}

module.exports = { parseDiagnosisDatabaseUrl, promptDatabaseDiagnosis };
