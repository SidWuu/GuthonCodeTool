const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDiagnosisDatabaseUrl, promptDatabaseDiagnosis } = require('../src/database-config');

test('parses MySQL, PostgreSQL and Oracle diagnosis URLs', () => {
  assert.deepEqual(parseDiagnosisDatabaseUrl('mysql://readonly@db.local/risk'), {
    engine: 'mysql', host: 'db.local', port: 3306, database: 'risk', username: 'readonly', password: '',
  });
  assert.equal(parseDiagnosisDatabaseUrl('postgresql://db.local/trade').port, 5432);
  assert.deepEqual(parseDiagnosisDatabaseUrl('jdbc:oracle:thin:@//ora.local:1521/pdb'), {
    engine: 'oracle', host: 'ora.local', port: 1521, database: 'pdb', username: '', password: '',
  });
});

test('prompts for a credential-safe Oracle diagnosis target', async () => {
  const quick = [{ label: '测试库', value: 'test' }];
  const inputs = ['risk-test', 'oracle://ora.local:1521/pdb', 'readonly', 'secret', 'GDRM'];
  const window = {
    showQuickPick: async () => quick.shift(),
    showInputBox: async () => inputs.shift(),
  };

  const value = await promptDatabaseDiagnosis(window, 'products.risk');

  assert.deepEqual(value, {
    targetId: 'risk-test', environment: 'test', engine: 'oracle', host: 'ora.local',
    port: 1521, database: 'pdb', schema: 'GDRM', username: 'readonly', password: 'secret',
    makeDefault: true,
  });
});
