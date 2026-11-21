const test = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('./refresh-target');

test('current PAGE and procedure keep their full identities', () => {
  assert.deepEqual(build({mode:'page-source', pageId:'PG-1', systemId:'S'}),
    {sourceType:'page', pageId:'PG-1', sourceId:'PG-1', systemId:'S', dataSourceId:''});
  assert.deepEqual(build({mode:'procedure', procedureId:'PR-1', procedureKeyword:'demo.pkg', funId:'save', dataSourceId:'DS'}),
    {sourceType:'procedure', sourceId:'PR-1', procedureId:'PR-1', alias:'demo.pkg', funId:'save', dataSourceId:'DS', systemId:''});
  assert.throws(() => build({mode:'page-source', procedureKeyword:'alias'}), /PAGE ID/);
  assert.throws(() => build({mode:'procedure', procedureId:'PR-1'}), /函数/);
});

test('table, view and script require one selected object and its owning identity', () => {
  for (const [mode, field, sourceType] of [['table-schema','tableIds','table'], ['views','viewIds','view'], ['system-scripts','scriptTypes','system-script']]) {
    const base = {mode, dataSourceId:'DS', systemId:'S'};
    assert.throws(() => build({...base,[field]:[]}), /选择一个/);
    assert.throws(() => build({...base,[field]:['a','b']}), /选择一个/);
    const target = build({...base,[field]:['a']});
    assert.equal(target.sourceType, sourceType);
    assert.equal(target.sourceId, 'a');
  }
  assert.throws(() => build({mode:'views',viewIds:['v']}), /身份/);
  assert.throws(() => build({mode:'billtype',billTypeCodes:['x']}), /不支持/);
});
