const test=require('node:test'),assert=require('node:assert/strict');
const {PlatformReferences,showPlatformReference}=require('../src/api/platform-reference');
const {sourceExportArgs}=require('../src/api/project-actions');
const {buildCatalogTree}=require('../src/api/source-ui');
test('reference cache stays within project and index generation; failed reads can retry',async()=>{
  let generation='a',count=0,fail=false;
  const api={editorState:{workspaces:new Map([['projects.A',{}]]),documentPath:(_key,_state,doc)=>doc.uri.fsPath==='/checkout/a.gss'},
    sourceTree:{indexGenerations:{get:()=>generation}},run:async(key,action)=>{count++;assert.equal(key,'projects.A');assert.equal(action,'reference');if(fail)throw Error('bad asset');return {items:[{apiPath:'$vs.util.safe'}]};}};
  const catalog=new PlatformReferences(api),doc={uri:{scheme:'file',fsPath:'/checkout/a.gss'}};
  assert.equal((await catalog.data(doc)).length,1);await catalog.data(doc);assert.equal(count,1);
  assert.deepEqual(await catalog.data({uri:{scheme:'file',fsPath:'/elsewhere/a.gss'}}),[]);
  generation='b';fail=true;await assert.rejects(catalog.data(doc),/bad asset/);fail=false;await catalog.data(doc);assert.equal(count,3);
});
test('source exports bind selected datasource and object, never unrelated readonly files',()=>{
  assert.deepEqual(sourceExportArgs('export-schema',{object:{path:'datasources/D/tables/T.json',sourceType:'table',sourceId:'T',dataSourceId:'D'}}),['--data-source-ids','D','--table-ids','T']);
  assert.deepEqual(sourceExportArgs('export-bill-type',{object:{path:'otherconfig/bill-type.md',sourceType:'bill-type',sourceId:'BT1',dataSourceId:'D'}}),['--data-source-ids','D','--bill-type-codes','BT1']);
  assert.deepEqual(sourceExportArgs('export-view',{category:'views',dataSourceId:'D'}),['--data-source-ids','D']);
  assert.throws(()=>sourceExportArgs('export-schema',{object:{path:'skills/a.md',sourceType:'skill'}}),/不匹配/);
});
test('configuration categories preserve file coordinates and bill datasource identity',()=>{
  const objects=[{path:'otherconfig/bill-type.md',sourceType:'bill-type',sourceId:'BT1',name:'采购',referenceId:'D:BT1',dataSourceId:'D',lineNumber:8,readonly:true},
    {path:'otherconfig/dropdown.md',sourceType:'dropdown',sourceId:'C1',name:'客商',referenceId:'C1',lineNumber:5,readonly:true},
    {path:'skills/platform-kit/apis/javascript/self.md',sourceType:'skill',name:'self.md',readonly:true}];
  const roots=buildCatalogTree('projects.A',{},objects,{dataSources:[{dataSourceId:'D',dataSourceName:'业务库'}]});
  assert.deepEqual(roots.slice(5).map(x=>x.label),['单据类型','下拉组件','开发参考']);
  const bill=roots[5].children[0];assert.equal(bill.dataSourceId,'D');assert.equal(bill.children[0].object.lineNumber,8);
});
test('reference picker opens original registered file without changing contents',async()=>{
  const opened=[];const vscode={window:{showQuickPick:async items=>items.find(x=>x.kind==='api') || items[0]}};
  const run=async()=>({items:[{signature:'safe():void',description:'安全方法',referencePath:'skills/platform-kit/apis/javascript/self.md',lineNumber:9}]});
  await showPlatformReference({vscode,run,key:'projects.A',ui:{open:async(...args)=>opened.push(args)}});
  assert.deepEqual(opened,[['projects.A','skills/platform-kit/apis/javascript/self.md',true,{raw:true,lineNumber:9}]]);
});

test('new export contexts retain system-script navigation without exposing config refresh writes',()=>{
  const menu=require('../package.json').contributes.menus['view/item/context'];
  for(const command of ['openApiSource','openApiOriginalSource','previewApiSource','refreshApiObject'])
    assert(menu.find(item=>item.command==='gushenCompletion.'+command).when.includes('system-script'));
  const refresh=menu.find(item=>item.command==='gushenCompletion.refreshApiObject').when;
  assert(!refresh.includes('bill-type'));assert(!refresh.includes('dropdown'));
});
