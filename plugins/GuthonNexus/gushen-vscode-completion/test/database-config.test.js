const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDiagnosisDatabaseUrl, parseAllowedTables, promptDatabaseDiagnosis } = require('../src/database-config');

function createWindow({ answers = {}, quickValues = ['test', 'full', false], cancelAt, confirmation = '更新此目标' } = {}) {
  const defaults = {
    '目标标识': 'risk-test',
    '准确业务系统 ID': 'SYS',
    '准确数据源 ID': 'DS',
    '租户/组织范围字段': 'ORG_ID',
    '租户字段核验证据引用': 'tenant-check-42',
    '数据库身份核验证据引用': 'identity-check-42',
    '数据库连接地址': 'oracle://db.invalid/pdb',
    '只读数据库用户名': 'readonly',
    '数据库密码': 'synthetic-test-only',
    'Oracle 业务 Schema': 'RISK',
  };
  const calls = [];
  const picks = [...quickValues];
  const record = (kind, options) => {
    calls.push({ kind, ...options });
    return calls.length === cancelAt;
  };
  const window = {
    showQuickPick: async (items, options) => {
      if (record('quick', options)) return undefined;
      const value = picks.shift();
      const choice = items.find((item) => item.value === value);
      assert.ok(choice, `Unexpected quick choice: ${value}`);
      return choice;
    },
    showInputBox: async (options) => {
      if (record('input', options)) return undefined;
      const value = Object.hasOwn(answers, options.title) ? answers[options.title] : defaults[options.title];
      assert.notEqual(value, undefined, `Unexpected prompt: ${options.title}`);
      const error = options.validateInput && options.validateInput(value);
      if (error) throw new Error(error);
      return value;
    },
    showWarningMessage: async (message, options, action) => {
      if (record('warning', { message, ...options, action })) return undefined;
      return confirmation;
    },
  };
  return { window, calls };
}

test('parses MySQL, PostgreSQL and Oracle diagnosis URLs', () => {
  assert.deepEqual(parseDiagnosisDatabaseUrl('mysql://readonly@db.invalid/risk'), {
    engine: 'mysql', host: 'db.invalid', port: 3306, database: 'risk', username: 'readonly', password: '',
  });
  assert.equal(parseDiagnosisDatabaseUrl('postgresql://db.invalid/trade').port, 5432);
  assert.deepEqual(parseDiagnosisDatabaseUrl('jdbc:oracle:thin:@//db.invalid:1521/pdb'), {
    engine: 'oracle', host: 'db.invalid', port: 1521, database: 'pdb', username: '', password: '',
  });
});

test('formal validation collects required evidence without a table list', async () => {
  const { window, calls } = createWindow();
  const seen = [];
  const value = await promptDatabaseDiagnosis(window, 'projects.risk', {
    listTargets: async (targetId) => { seen.push(targetId); return [{ id: 'other', environment: 'dev' }]; },
  });
  assert.deepEqual(seen, ['risk-test']);
  assert.equal(value.validationScope, 'full');
  assert.equal(value.systemId, 'SYS');
  assert.equal(value.dataSourceId, 'DS');
  assert.equal(Object.hasOwn(value, 'allowedTables'), false);
  assert.equal(calls.some((call) => /表名单|允许查询的表/.test(call.title || '')), false);
  assert.deepEqual(value.tenantScope, { field: 'ORG_ID', evidenceRef: 'tenant-check-42' });
  assert.equal(value.evidenceRef, 'identity-check-42');
  assert.equal(value.schema, 'RISK');
  assert.equal(value.makeDefault, false);
  assert.equal(calls.find((call) => call.title === '数据库密码').password, true);
});

test('quick diagnosis retains credentials, schema and explicit default selection', async () => {
  const { window, calls } = createWindow({ quickValues: ['test', 'diagnosis-only', true] });
  const value = await promptDatabaseDiagnosis(window, 'products.risk');
  assert.equal(value.validationScope, 'diagnosis-only');
  assert.equal(value.makeDefault, true);
  assert.equal(value.engine, 'oracle');
  assert.equal(value.schema, 'RISK');
  for (const field of ['allowedTables', 'systemId', 'dataSourceId', 'tenantScope', 'evidenceRef']) {
    assert.equal(Object.hasOwn(value, field), false);
  }
  assert.equal(calls.some((call) => call.title === '准确业务系统 ID'), false);
});

test('existing exact target is confirmed while legacy fields are not rewritten', async () => {
  const existing = { id: 'risk-test', environment: 'test', validationScope: 'full', endpoint: 'db.invalid:1521', database: 'pdb', allowedTables: ['DEMO_ORDER'] };
  const before = structuredClone(existing);
  const { window, calls } = createWindow();
  const value = await promptDatabaseDiagnosis(window, 'projects.risk', { listTargets: async () => [existing] });
  assert.equal(value.targetId, existing.id);
  assert.equal(Object.hasOwn(value, 'allowedTables'), false);
  assert.equal(value.makeDefault, false);
  assert.deepEqual(existing, before);
  const warning = calls.find((call) => call.kind === 'warning');
  assert.equal(warning.modal, true);
  assert.match(warning.message, /risk-test/);
  assert.equal(warning.action, '更新此目标');
});

test('same ID in another environment is rejected before confirmation or credentials', async () => {
  const { window, calls } = createWindow();
  await assert.rejects(promptDatabaseDiagnosis(window, 'projects.risk', {
    listTargets: async () => [{ id: 'risk-test', environment: 'dev' }],
  }), /准确环境/);
  assert.equal(calls.some((call) => call.kind === 'warning' || call.title === '数据库密码'), false);
});

test('declining an existing target update returns no payload', async () => {
  const { window, calls } = createWindow({ confirmation: '取消' });
  const value = await promptDatabaseDiagnosis(window, 'projects.risk', {
    listTargets: async () => [{ id: 'risk-test', environment: 'test', validationScope: 'full' }],
  });
  assert.equal(value, undefined);
  assert.equal(calls.at(-1).kind, 'warning');
});

test('cancellation at every creation step returns no configuration payload', async () => {
  const complete = createWindow();
  await promptDatabaseDiagnosis(complete.window, 'projects.risk');
  for (let step = 1; step <= complete.calls.length; step += 1) {
    const { window, calls } = createWindow({ cancelAt: step });
    assert.equal(await promptDatabaseDiagnosis(window, 'projects.risk'), undefined, `step ${step}`);
    assert.equal(calls.length, step);
  }
});

test('cancellation at every update step returns no configuration payload', async () => {
  const options = { listTargets: async () => [{ id: 'risk-test', environment: 'test', validationScope: 'full' }] };
  const complete = createWindow();
  await promptDatabaseDiagnosis(complete.window, 'projects.risk', options);
  for (let step = 1; step <= complete.calls.length; step += 1) {
    const { window, calls } = createWindow({ cancelAt: step });
    assert.equal(await promptDatabaseDiagnosis(window, 'projects.risk', options), undefined, `step ${step}`);
    assert.equal(calls.length, step);
  }
});

test('invalid target ID is rejected by the existing input validator', async () => {
  const { window } = createWindow({ answers: { '目标标识': 'bad target' } });
  await assert.rejects(promptDatabaseDiagnosis(window, 'projects.risk'), /仅允许/);
});

test('formal identity and tenant evidence remain mandatory and validated', async () => {
  for (const answers of [
    { '准确业务系统 ID': '' }, { '准确数据源 ID': '<pending>' },
    { '租户/组织范围字段': 'ORG ID' }, { '租户字段核验证据引用': '' },
    { '租户字段核验证据引用': '<pending>' }, { '数据库身份核验证据引用': 'replace-evidence' },
  ]) {
    const { window } = createWindow({ answers });
    await assert.rejects(promptDatabaseDiagnosis(window, 'projects.risk'), /实际值|有效字段/);
  }
});

test('Oracle schema validation and connection parsing remain active', async () => {
  for (const answers of [{ 'Oracle 业务 Schema': 'bad schema' }, { '数据库连接地址': 'invalid' }]) {
    const { window } = createWindow({ answers });
    await assert.rejects(promptDatabaseDiagnosis(window, 'projects.risk'), /schema|完整连接地址/);
  }
});

test('legacy table parser export keeps its existing syntax contract', () => {
  assert.deepEqual(parseAllowedTables('DEMO_ORDER, DEMO_DETAIL'), ['DEMO_ORDER', 'DEMO_DETAIL']);
  for (const value of ['*', 'public.T', 'T,t', '']) assert.throws(() => parseAllowedTables(value));
});
