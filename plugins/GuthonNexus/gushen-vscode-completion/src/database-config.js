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

async function promptDatabaseDiagnosis(window, workspaceKey, { listTargets } = {}) {
  const environment = await window.showQuickPick([
    { label: '开发库', value: 'dev', description: '明确配置开发环境目标' },
    { label: '测试库', value: 'test', description: '明确配置测试环境目标' },
  ], { title: `配置数据库只读目标 · ${workspaceKey}` });
  if (!environment) return undefined;
  const targetId = await window.showInputBox({
    title: '目标标识',
    prompt: '同一工作区内唯一，例如 trade-dev',
    validateInput: (text) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? undefined : '仅允许字母、数字、点、下划线和连字符',
  });
  if (!targetId) return undefined;
  const targets = listTargets ? await listTargets(targetId) : [];
  const existing = targets.find((target) => target.id === targetId);
  if (existing && existing.environment !== environment.value) {
    throw new Error(`目标 ${targetId} 已属于 ${existing.environment} 环境，请使用其准确环境或新标识`);
  }
  const scope = await window.showQuickPick([
    { label: '快速只读排查', value: 'diagnosis-only', description: '用于有界排查，不可运行正式验证计划' },
    { label: '正式只读验证', value: 'full', description: '需明确系统、数据源、表范围、租户字段及身份核验证据' },
  ], { title: `选择验证范围 · ${targetId}` });
  if (!scope) return undefined;
  if (existing) {
    const confirmation = await window.showWarningMessage(
      `将更新准确目标 ${targetId}（${existing.environment} · ${existing.endpoint} · ${existing.database}）。验证范围：${existing.validationScope || 'full'} → ${scope.value}。`,
      { modal: true }, '更新此目标'
    );
    if (confirmation !== '更新此目标') return undefined;
  }
  const formal = scope.value === 'full' ? await promptFormalScope(window) : {};
  if (!formal) return undefined;
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
  const defaultChoice = await window.showQuickPick([
    { label: '仅保存此目标', value: false },
    { label: '设为工作区排查默认目标', value: true, description: '同时更新该环境的默认排查目标' },
  ], { title: `默认排查目标 · ${targetId}` });
  if (!defaultChoice) return undefined;
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
    validationScope: scope.value,
    ...formal,
    makeDefault: defaultChoice.value,
  };
}

const identifier = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const actualEvidence = (value) => !!String(value || '').trim()
  && !/[<>]/.test(value) && !/^replace-/i.test(value.trim()) && !/\.example/i.test(value);

function parseAllowedTables(value) {
  const tables = String(value || '').split(',').map((table) => table.trim());
  if (!tables.length || tables.some((table) => !identifier.test(table))) {
    throw new Error('请输入明确表名，以英文逗号分隔；不允许通配符或 schema 前缀');
  }
  if (new Set(tables.map((table) => table.toUpperCase())).size !== tables.length) throw new Error('表名不能重复');
  return tables;
}

async function promptFormalScope(window) {
  const fields = [
    ['systemId', '准确业务系统 ID', '使用已核验的业务系统 ID'],
    ['dataSourceId', '准确数据源 ID', '使用已核验的数据源 ID'],
    ['allowedTables', '允许查询的表', '明确表名，以英文逗号分隔'],
    ['tenantField', '租户/组织范围字段', '填写已核验的普通字段名'],
    ['tenantEvidence', '租户字段核验证据引用', '填写实际证据引用，例如核验记录文件路径或记录 ID'],
    ['evidenceRef', '数据库身份核验证据引用', '已核验 engine、endpoint、database、schema 的实际证据引用'],
  ];
  const values = {};
  for (const [field, title, prompt] of fields) {
    const validateInput = (text) => {
      if (field === 'allowedTables') {
        try { parseAllowedTables(text); return undefined; } catch (error) { return error.message; }
      }
      if (field === 'tenantField') return identifier.test(text) ? undefined : '请输入有效字段名';
      return actualEvidence(text) ? undefined : '必须填写实际值，不允许占位内容';
    };
    const value = await window.showInputBox({ title, prompt, validateInput, ignoreFocusOut: true });
    if (value === undefined) return undefined;
    const error = validateInput(value);
    if (error) throw new Error(error);
    values[field] = value.trim();
  }
  return {
    systemId: values.systemId, dataSourceId: values.dataSourceId,
    allowedTables: parseAllowedTables(values.allowedTables),
    tenantScope: { field: values.tenantField, evidenceRef: values.tenantEvidence },
    evidenceRef: values.evidenceRef,
  };
}

module.exports = { parseDiagnosisDatabaseUrl, parseAllowedTables, promptDatabaseDiagnosis };
