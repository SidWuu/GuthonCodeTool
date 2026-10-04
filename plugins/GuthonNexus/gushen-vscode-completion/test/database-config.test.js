const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDiagnosisDatabaseUrl, parseAllowedTables, promptDatabaseDiagnosis } = require('../src/database-config');

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
  const quick = [{ label: '测试库', value: 'test' }, {value:'diagnosis-only'}, {value:true}];
  const inputs = ['risk-test', 'oracle://ora.local:1521/pdb', 'readonly', 'secret', 'GDRM'];
  const window = {
    showQuickPick: async () => quick.shift(),
    showInputBox: async () => inputs.shift(),
  };

  const value = await promptDatabaseDiagnosis(window, 'products.risk');

  assert.deepEqual(value, {
    targetId: 'risk-test', environment: 'test', engine: 'oracle', host: 'ora.local',
    port: 1521, database: 'pdb', schema: 'GDRM', username: 'readonly', password: 'secret',
    validationScope: 'diagnosis-only', makeDefault: true,
  });
});


test('formal validation collects explicit scope and prechecks exact target ID', async () => {
  const inputs = ['risk-test', 'SYS', 'DS', 'RM_A,RM_B', 'ORG_ID', 'tenant-check-42', 'identity-check-42',
    'postgresql://pg.local/risk?schema=public', 'readonly', 'secret'];
  const quick = [{value:'test'}, {value:'full'}, {value:false}];
  const seen = [];
  const value = await promptDatabaseDiagnosis({showInputBox:async()=>inputs.shift(), showQuickPick:async()=>quick.shift()}, 'projects.risk', {
    listTargets: async (targetId) => {seen.push(targetId);return [{id:'other',environment:'dev'}];},
  });
  assert.deepEqual(seen,['risk-test']);
  assert.equal(value.validationScope,'full');
  assert.equal(value.systemId,'SYS');
  assert.equal(value.dataSourceId,'DS');
  assert.deepEqual(value.allowedTables,['RM_A','RM_B']);
  assert.deepEqual(value.tenantScope,{field:'ORG_ID',evidenceRef:'tenant-check-42'});
  assert.equal(value.evidenceRef,'identity-check-42');
  assert.equal(value.makeDefault,false);
  assert.equal(value.password,'secret');
});

test('existing exact target requires explicit update and rejects wrong environment', async () => {
  let picks=[{value:'test'},{value:'full'}], confirmations=0;
  const window = {showInputBox:async()=> 'same',showQuickPick:async()=>picks.shift(),showWarningMessage:async()=>{confirmations++;return undefined;}};
  await assert.rejects(promptDatabaseDiagnosis(window,'projects.risk',{listTargets:async()=>[{id:'same',environment:'dev'}]}),/准确环境/);
  picks=[{value:'test'},{value:'full'}];
  assert.equal(await promptDatabaseDiagnosis(window,'projects.risk',{listTargets:async()=>[{id:'same',environment:'test',validationScope:'full'}]}),undefined);
  assert.equal(confirmations,1);
});

test('formal tables reject wildcard, qualification and duplicate names; cancellation writes nothing', async () => {
  for (const value of ['*','public.T','T,t','']) assert.throws(()=>parseAllowedTables(value));
  const quick=[{value:'dev'},{value:'full'}];
  const inputs=['fresh','SYS',undefined];
  assert.equal(await promptDatabaseDiagnosis({showInputBox:async()=>inputs.shift(),showQuickPick:async()=>quick.shift()},'projects.risk'),undefined);
});
