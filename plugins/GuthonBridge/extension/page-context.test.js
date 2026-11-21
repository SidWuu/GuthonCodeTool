const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./page-bridge.js'),'utf8');
const code=source.slice(source.indexOf('  function inspectCurrentHubSource()'),source.indexOf('  function inspectPageContext()'));
function inspect(systems){
  const context={document:{querySelector:()=>null},location:{href:'https://platform.example/guthon/#/gdpaas/dev/modules'},
    getActivePageTabCode:()=> 'PG-CURRENT',getDataSourceId:()=> 'DS_1',
    getAllVueInstances:()=>systems.map(systemId=>({$store:{state:{modeDev:{systemId}}}}))};
  vm.runInNewContext(code,context);return context.inspectCurrentHubSource();
}
test('module page context publishes current native store system identity alongside datasource and PAGE',()=>{
  const x=inspect(['SYS-A','SYS-A']);assert.equal(x.systemId,'SYS-A');assert.deepEqual(Array.from(x.systemIds),['SYS-A']);
  assert.equal(x.pageId,'PG-CURRENT');assert.equal(x.dataSourceId,'DS_1');
});
test('missing or ambiguous current systems are not guessed from PAGE names or datasource',()=>{
  assert.equal(inspect([]).systemId,'');assert.equal(inspect(['SYS-A','SYS-B']).systemId,'');
  assert.deepEqual(Array.from(inspect([null,'invalid']).systemIds),[]);
});
