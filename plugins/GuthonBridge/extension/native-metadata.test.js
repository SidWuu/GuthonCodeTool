const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function fixture(){
  const calls=[],field={pkid:'FIELD-1',tableId:'EXAMPLE',fieldId:'ROW_ID',fieldName:'明细ID',dataType:'BIGINT',isPrimary:1,isCanNull:0,isIncrement:0};
  const box={location:{origin:'http://platform.example',pathname:'/guthon/index.html'},URLSearchParams,AbortSignal,
    async fetch(url,options){const body=Object.fromEntries(options.body);calls.push({url,body,credentials:options.credentials});let data;
      if(url.endsWith('getTableFields.htm'))data={list:[{...field}]};
      else if(url.endsWith('tables/list.htm'))data={list:[{pkid:'TABLE-1',dataSourceId:'DS_1',tableId:'EXAMPLE'}]};
      else if(url.endsWith('saveTableField.htm')){field.isIncrement=Number(body.isIncrement);data={field:{...field}};}
      else throw Error('Unregistered native URL');
      return {ok:true,text:async()=>JSON.stringify({code:0,data})};}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./native-metadata'),'utf8'),box);
  const payload={dataSourceId:'DS_1',tableId:'EXAMPLE',fieldId:'ROW_ID',expectedOrigin:box.location.origin,dataSourceIds:['DS_1']};
  return {box,field,calls,run:p=>box.runNativeMetadata({...payload,...p})};
}

test('native inspection is read-only; GUID correction preserves fields and independently rereads',async()=>{
  const f=fixture(),inspected=await f.run({action:'inspect-guid'});
  assert.equal(inspected.state,'SUCCEEDED');assert.equal(inspected.field.isIncrement,0);
  assert.equal(f.calls.length,1);
  const result=await f.run({action:'set-guid',expectedSnapshot:inspected.snapshot});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.after.isIncrement,2);
  const writes=f.calls.filter(c=>c.url.endsWith('saveTableField.htm'));
  assert.equal(writes.length,1);assert.equal(writes[0].body.tablePkid,'TABLE-1');
  assert.equal(writes[0].body.isIncrement,'2');assert.equal(writes[0].body.fieldName,'明细ID');
  assert.ok(f.calls.every(call=>call.credentials==='include'));
  assert.ok(f.calls.at(-1).url.endsWith('getTableFields.htm'));
  assert.equal(f.calls.some(call=>/createTable|synchTable|sql/i.test(call.url)),false);
});

test('origin, datasource, stale field and database identity are rejected before any mutation',async()=>{
  for(const mode of ['origin','datasource','stale','identity','non-primary']){
    const f=fixture(),inspected=await f.run({action:'inspect-guid'});f.calls.length=0;
    let changes={};
    if(mode==='origin')changes.expectedOrigin='http://other.example';
    if(mode==='datasource')changes.dataSourceIds=['OTHER'];
    if(mode==='stale')f.field.fieldName='changed';
    if(mode==='identity')f.field.isIncrement=1;
    if(mode==='non-primary')f.field.isPrimary=0;
    const result=await f.run({action:'set-guid',expectedSnapshot:inspected.snapshot,...changes});
    assert.equal(result.state,'REJECTED',mode);
    assert.equal(f.calls.some(c=>c.url.endsWith('saveTableField.htm')),false,mode);
  }
});

test('lost native mutation response is UNKNOWN and never retried',async()=>{
  const f=fixture(),inspected=await f.run({action:'inspect-guid'}),fetch=f.box.fetch;let writes=0;
  f.box.fetch=async(url,options)=>{if(url.endsWith('saveTableField.htm')){writes++;throw Error('lost response');}return fetch(url,options);};
  const result=await f.run({action:'set-guid',expectedSnapshot:inspected.snapshot});
  assert.equal(result.state,'UNKNOWN');assert.equal(result.platformApplied,null);assert.equal(writes,1);
});

test('an already generated primary key is observed without writing',async()=>{
  const f=fixture();f.field.isIncrement=2;
  const inspected=await f.run({action:'inspect-guid'});
  const result=await f.run({action:'set-guid',expectedSnapshot:inspected.snapshot});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.changed,false);
  assert.equal(f.calls.some(c=>c.url.endsWith('saveTableField.htm')),false);
});

function pageFixture() {
  const f=fixture();f.field.isIncrement=2;
  f.box.crypto={};f.box.TextEncoder=TextEncoder;f.box.btoa=s=>Buffer.from(s,'binary').toString('base64');
  const bean={pageId:'PG-EXAMPLE',views:{rows:[{component:{datasource:{sql:'SELECT ROW_ID FROM EXAMPLE',
    fields:[{tbId:'EXAMPLE',fdId:'ROW_ID',isPk:1,ctName:'BIGINT'}]}}}]},pageSetup:{serviceEvents:{beforeSaveScript:'keep()'}},modalSaveBnt:{bntType:'save',serviceEvents:{beforeSaveScript:'old()'},name:'KEEP'}};
  let current=JSON.parse(JSON.stringify(bean)),version='version-1',normalize=false;
  const nativeFetch=f.box.fetch;
  f.box.fetch=async(url,options)=>{
    if(!url.includes('/dev/')) return nativeFetch(url,options);
    const body=Object.fromEntries(options.body);f.calls.push({url,body,credentials:options.credentials});let data;
    if(url.endsWith('getPageBaseInfo.htm'))data={page:{pageId:'PG-EXAMPLE',systemId:'SYS-EXAMPLE'}};
    else if(url.endsWith('getPageModuleXml.htm'))data={bean:JSON.parse(JSON.stringify(current)),version};
    else if(url.endsWith('savePageModuleXml.htm')){
      assert.equal(body.pageVersion,version);assert.equal(body.flag,'0');assert.equal(body.isAutoCompile,'1');
      current=JSON.parse(Buffer.from(decodeURIComponent(body.json),'base64').toString('utf8'));if(normalize)delete current.views.rows[0].component.datasource.fields[0].scale;version='version-2';data={version};
    } else throw Error('Unexpected native endpoint');
    return {ok:true,text:async()=>JSON.stringify({code:0,data})};
  };
  return {...f,bean,read:()=>current,drift:()=>{current.pageSetup.changed=true;},
    normalize:()=>{normalize=true;},run:p=>f.run({pageId:'PG-EXAMPLE',systemIds:['SYS-EXAMPLE'],...p})};
}

test('a missing hook is created only on an existing save button with its absent state frozen',async()=>{
  const f=pageFixture();
  f.read().views.rows[0].component.buttons=[{id:'save-1',bntType:'save',name:'Keep'}];
  const pointer='/views/rows/0/component/buttons/0/serviceEvents/beforeSaveScript';
  const inspected=await f.run({action:'inspect-page-script',jsonPointer:pointer});
  assert.equal(inspected.after.content,null);
  const expected=JSON.parse(JSON.stringify(f.read()));
  expected.views.rows[0].component.buttons[0].serviceEvents={beforeSaveScript:'new()'};
  const result=await f.run({action:'apply-page-script',jsonPointer:pointer,expectedVersion:'version-1',content:'new()'});
  assert.equal(result.state,'SUCCEEDED');assert.deepEqual(f.read(),expected);
  const repeated=await f.run({action:'apply-page-script',jsonPointer:pointer,expectedVersion:'version-2',expectedContent:null,content:'replace()'});
  assert.equal(repeated.state,'REJECTED');
  assert.equal(f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm')).length,1);
});

test('hook publication rejects a non-save owner and a changed supposedly missing hook before writing',async()=>{
  for(const changed of [false,true]){
    const f=pageFixture();
    f.read().views.rows[0].component.buttons=[{bntType:changed?'save':'query',serviceEvents:changed?{beforeSaveScript:'other()'}:{}}];
    const result=await f.run({action:'apply-page-script',jsonPointer:'/views/rows/0/component/buttons/0/serviceEvents/beforeSaveScript',expectedVersion:'version-1',expectedContent:null,content:'new()'});
    assert.equal(result.state,'REJECTED');
    assert.equal(f.calls.some(c=>c.url.endsWith('savePageModuleXml.htm')),false);
  }
});

test('PAGE GUID sync changes only the matching projection and uses native save/autocompile with readback',async()=>{
  const f=pageFixture(),inspected=await f.run({action:'inspect-page-guid'});
  assert.equal(inspected.state,'SUCCEEDED');assert.deepEqual(Array.from(inspected.guidFlags),[0]);
  const result=await f.run({action:'sync-page-guid',expectedSnapshot:inspected.snapshot});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.autoCompileRequested,true);
  const expected=JSON.parse(JSON.stringify(f.bean));expected.views.rows[0].component.datasource.fields[0].isIncrement=2;
  assert.deepEqual(f.read(),expected);
  assert.equal(f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm')).length,1);
  assert.equal(f.calls.some(c=>/runGuthonScript|createTable|checkIn|synchTable/.test(c.url)),false);
});

test('PAGE source drift and system mismatch cannot dispatch a write',async()=>{
  for(const mode of ['drift','system']){
    const f=pageFixture(),inspected=await f.run({action:'inspect-page-guid'});let changes={};
    if(mode==='drift') f.drift();else changes.systemIds=['OTHER'];
    const result=await f.run({action:'sync-page-guid',expectedSnapshot:inspected.snapshot,...changes});
    assert.equal(result.state,'REJECTED');assert.equal(f.calls.some(c=>c.url.endsWith('savePageModuleXml.htm')),false);
  }
});

test('lost PAGE save response stays UNKNOWN and never repeats save or compiles separately',async()=>{
  const f=pageFixture(),inspected=await f.run({action:'inspect-page-guid'}),fetch=f.box.fetch;let writes=0;
  f.box.fetch=async(url,options)=>{if(url.endsWith('savePageModuleXml.htm')){writes++;throw Error('lost PAGE receipt');}return fetch(url,options);};
  const result=await f.run({action:'sync-page-guid',expectedSnapshot:inspected.snapshot});
  assert.equal(result.state,'UNKNOWN');assert.equal(writes,1);
});


test('runtime inspection reads only the native entry and returns same-origin static script paths without query credentials',async()=>{
  const f=fixture();f.box.URL=URL;
  f.box.fetch=async(url,options)=>{f.calls.push({url,options});if(url==='/gdpaas/home/isLogin.htm')return {ok:true,text:async()=>JSON.stringify({code:0,data:{user:{userId:'runtime-user',userName:'Runtime User'}}})};return {ok:true,url:'http://platform.example/runtime/index.htm',
    text:async()=>'<script src="/runtime/app.js?v=1"></script><script src="https://outside.example/other.js"></script>'};};
  const result=await f.run({action:'inspect-runtime'});assert.equal(result.state,'SUCCEEDED');
  assert.deepEqual(Array.from(result.scripts),['/runtime/app.js']);assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].url,'/gdpaas/home/isLogin.htm');assert.equal(result.after.runtimeIdentity.userId,'runtime-user');
  assert.equal(f.calls[0].url,'/develop/systems/apps/view.htm');assert.equal(result.platformApplied,false);
});

function recordFixture(){
  const f=fixture(),calls=f.calls,id='2129999999999999999',pageId='PG-RECORD',buttonId='a'.repeat(32);
  const form={name:'inputForm',datasource:{saveTableId:'EXAMPLE',fields:[{label:'ROW_ID',isPk:1,isIncrement:2,tbId:'EXAMPLE'},{label:'CODE',tbId:'EXAMPLE'},{label:'ORG_CODE',tbId:'EXAMPLE'},{label:'OPERATOR_CODE',tbId:'EXAMPLE'}],pks:[{label:'ROW_ID'}]},
    fields:[{fieldId:'OPERATOR_CODE',selectCompId:'CP-STAFF',selectBox:{codeType:2}},{fieldId:'CODE',isMust:1},{fieldId:'ORG_CODE',isMust:1},{fieldId:'ORG_NAME',isMust:1,selectCompId:'CP-ORG',selectBox:{codeType:2,selectCodefieldId:'ORG_CODE',ownerSystemId:'SYS-EXAMPLE'}}]};
  let row;f.box.localStorage={getItem:()=>null};
  f.box.fetch=async(url,options)=>{
    const body=Object.fromEntries(options.body);calls.push({url,body,headers:options.headers});let data;
    if(url.endsWith('getPageBaseInfo.htm'))data={page:body.pageId==='PG-PARENT'?{pageId:'PG-PARENT',pageType:1,systemId:'SYS-EXAMPLE',mkId:'MK-EXAMPLE'}:{pageId,pageType:3,systemId:'SYS-EXAMPLE',mkId:'MK-EXAMPLE',pageAliasId:'demo.record'}};
    else if(url.endsWith('getPageModuleXml.htm'))data=body.pageId==='PG-PARENT'?{version:'parent-v1',bean:{pageId:'PG-PARENT',script:'demo.record'}}:{version:'version-1',bean:{pageId,views:{rows:[{component:form}]},modalSaveBnt:{id:buttonId,bntType:'save',bntAuth:'edit'}}};
    else if(url.endsWith('isLogin.htm'))data={user:{userId:'native-user',userName:'Native User'}};
    else if(url.endsWith('select/list.htm'))data={page:{result:[{code:'ORG1',name:'Native Org'}]}};
    else if(url.includes('editpage/save.htm')){row={...JSON.parse(body.json).inputForm,ROW_ID:id};data={bean:{inputForm:row}};}
    else if(url.includes('editpage/get.htm')){assert.equal(JSON.parse(body.json).ROW_ID,id);data={list:[row]};}
    else throw Error('Unexpected endpoint');
    return {ok:true,text:async()=>JSON.stringify({code:0,data}).replaceAll('"'+id+'"',id)};
  };
  const payload={action:'save-native-record',pageId,parentPageId:'PG-PARENT',bntId:buttonId,expectedVersion:'version-1',inputForm:{CODE:'TEST',ORG_CODE:'ORG1'},systemIds:['SYS-EXAMPLE']};
  return {...f,id,run:changes=>f.run({...payload,...changes})};
}

test('single-form creation preserves native identity, candidate permission checks and exact large primary keys on readback',async()=>{
  const f=recordFixture(),result=await f.run({});assert.equal(result.state,'SUCCEEDED');
  assert.equal(result.after.inputForm.ROW_ID,f.id);assert.equal(result.after.inputForm.OPERATOR_CODE,'native-user');assert.ok(f.calls.some(c=>c.url==='/gdpaas/home/isLogin.htm'));assert.equal(f.calls.some(c=>c.url==='/develop/login/isLogin.htm'),false);assert.equal(f.calls.some(c=>c.body.compId==='CP-STAFF'),false);
  const saves=f.calls.filter(c=>c.url.includes('editpage/save.htm'));assert.equal(saves.length,1);
  assert.equal(saves[0].headers.pageId,'PG_PARENT');assert.equal(saves[0].headers.menuId,'MK-EXAMPLE');assert.equal(saves[0].body.isNew,'1');const values=JSON.parse(saves[0].body.json).inputForm;
  assert.equal(values.ROW_ID,undefined);assert.equal(values.ORG_NAME,'Native Org');
  assert.ok(f.calls.at(-1).url.includes('editpage/get.htm'));
});

test('stale PAGE, caller primary key and unauthorized candidate are rejected before record save',async()=>{
  for(const kind of ['version','primary','candidate']){
    const f=recordFixture();let changes={};
    if(kind==='version')changes.expectedVersion='stale';
    if(kind==='primary')changes.inputForm={CODE:'TEST',ORG_CODE:'ORG1',ROW_ID:'caller-id'};
    if(kind==='candidate')changes.inputForm={CODE:'TEST',ORG_CODE:'OTHER'};
    assert.equal((await f.run(changes)).state,'REJECTED',kind);
    assert.equal(f.calls.some(c=>c.url.includes('editpage/save.htm')),false,kind);
  }
});

test('lost native record-save receipt is UNKNOWN with one dispatch and no implicit retry',async()=>{
  const f=recordFixture(),fetch=f.box.fetch;let writes=0;
  f.box.fetch=async(url,options)=>{if(url.includes('editpage/save.htm')){writes++;throw Error('lost receipt');}return fetch(url,options);};
  assert.equal((await f.run({})).state,'UNKNOWN');assert.equal(writes,1);
});


test('native record preparation validates current parent and candidates without dispatching a save',async()=>{
 const f=recordFixture(),r=await f.run({action:'prepare-native-record'});assert.equal(r.state,'SUCCEEDED');assert.equal(r.platformApplied,false);
 assert.equal(f.calls.some(c=>c.url.includes('editpage/save.htm')),false);
});


test('native PAGE verification tolerates only observed zero scale serialization and preserves other content',async()=>{
 const f=pageFixture();f.bean.views.rows[0].component.datasource.fields[0].scale=0;
 // Recreate a real native descriptor at the initial read; normalization occurs only during save.
 const nativeFetch=f.box.fetch;
 f.box.fetch=async(url,options)=>{
  const r=await nativeFetch(url,options);
  if(url.endsWith('getPageModuleXml.htm')){
   const data=JSON.parse(await r.text());
   if(data.data.version==='version-1')data.data.bean.views.rows[0].component.datasource.fields[0].scale=0;
   return {...r,text:async()=>JSON.stringify(data)};
  }return r;
 };
 f.normalize();const inspected=await f.run({action:'inspect-page-guid'});
 assert.equal((await f.run({action:'sync-page-guid',expectedSnapshot:inspected.snapshot})).state,'SUCCEEDED');
});


test('native script publication changes one reviewed existing hook and independently reads back the full PAGE',async()=>{
 const f=pageFixture(),expected=JSON.parse(JSON.stringify(f.bean));expected.modalSaveBnt.serviceEvents.beforeSaveScript='new()';
 const r=await f.run({action:'apply-page-script',expectedVersion:'version-1',jsonPointer:'/modalSaveBnt/serviceEvents/beforeSaveScript',
  expectedContent:'old()',content:'new()',sourceOperationId:'page-op:v1:'+'a'.repeat(64)});
 assert.equal(r.state,'SUCCEEDED');assert.deepEqual(f.read(),expected);
 assert.equal(f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm')).length,1);
 assert.equal(f.calls.some(c=>/runGuthonScript|runscript|executeSql/.test(c.url)),false);
});

test('native script drift is rejected before saving; lost publication receipt remains UNKNOWN',async()=>{
 const payload={action:'apply-page-script',expectedVersion:'version-1',jsonPointer:'/modalSaveBnt/serviceEvents/beforeSaveScript',expectedContent:'old()',content:'new()'};
 const f=pageFixture();f.read().modalSaveBnt.serviceEvents.beforeSaveScript='other editor';
 assert.equal((await f.run(payload)).state,'REJECTED');assert.equal(f.calls.some(c=>c.url.endsWith('savePageModuleXml.htm')),false);
 const g=pageFixture(),fetch=g.box.fetch;let saves=0;
 g.box.fetch=async(url,options)=>{if(url.endsWith('savePageModuleXml.htm')){saves++;throw Error('lost receipt');}return fetch(url,options);};
 assert.equal((await g.run(payload)).state,'UNKNOWN');assert.equal(saves,1);
});

function declaredFixture(){
 const f=fixture(),definition={origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',pageId:'PG-SERVICE',
  alias:'com.golden.example.step',sourceVersion:'v1',parentPageId:'PG-PARENT',mutates:true,timeoutMs:90000,manifestHash:'hash',arguments:{ORG_CODE:'ORG1'}};
 f.box.localStorage={getItem:()=>null};let version='v1',query=false;
 f.box.fetch=async(url,options)=>{
  const body=Object.fromEntries(options.body);f.calls.push({url,body,headers:options.headers});let data;
  if(url.endsWith('getPageBaseInfo.htm'))data={page:body.pageId==='PG-PARENT'?{pageId:'PG-PARENT',pageType:1,systemId:'SYS-EXAMPLE',mkId:'MK-EXAMPLE'}:
   {pageId:'PG-SERVICE',pageType:query?4:0,pageAliasId:'com.golden.example.step',systemId:'SYS-EXAMPLE'}};
  else if(url.endsWith('getPageModuleXml.htm'))data={version};
  else if(url.includes('/gdpaas/jscomp/run.htm'))data={count:1};else if(url.includes('mainpage/findPage.htm'))data={page:{result:[{CODE:'TEST'}],totalCount:1}};else throw Error('Unexpected endpoint');
  return {ok:true,text:async()=>JSON.stringify({code:0,data})};
 };
 return {...f,definition,query:()=>{query=true;definition.kind='page-query';definition.mutates=false;definition.ctrlId='mainTable';definition.searchBoxId='searchForm';},drift:()=>{version='v2';},run:changes=>f.run({action:'run-declared-step',step:'example',definition,systemIds:['SYS-EXAMPLE'],...changes})};
}

test('declared component inspection is read-only; execution sends exact frozen native parameters and parent headers',async()=>{
 const f=declaredFixture();assert.equal((await f.run({action:'inspect-declared-step'})).platformApplied,false);
 assert.equal(f.calls.some(c=>c.url.includes('jscomp/run')),false);
 const r=await f.run({});assert.equal(r.state,'SUCCEEDED');assert.equal(r.after.result.count,1);
 const call=f.calls.find(c=>c.url.includes('jscomp/run'));assert.equal(call.body.compId,f.definition.alias);
 assert.equal(call.body.params,JSON.stringify(f.definition.arguments));assert.equal(call.headers.pageId,'PG_PARENT');assert.equal(call.headers.menuId,'MK-EXAMPLE');
});

test('declared component source drift prevents dispatch and an uncertain mutating request is never replayed',async()=>{
 const f=declaredFixture();f.drift();assert.equal((await f.run({})).state,'REJECTED');assert.equal(f.calls.some(c=>c.url.includes('jscomp/run')),false);
 const g=declaredFixture(),fetch=g.box.fetch;let count=0;
 g.box.fetch=async(url,options)=>{if(url.includes('jscomp/run')){count++;throw Error('lost receipt');}return fetch(url,options);};
 assert.equal((await g.run({})).state,'UNKNOWN');assert.equal(count,1);
});


test('frozen native PAGE queries preserve real table/search controls and cannot dispatch writes',async()=>{
 const f=declaredFixture();f.query();const r=await f.run({});assert.equal(r.state,'SUCCEEDED');assert.equal(r.platformApplied,false);
 const call=f.calls.find(c=>c.url.includes('mainpage/findPage.htm'));assert.equal(call.body.ctrlId,'mainTable');assert.equal(call.body.searchBoxId,'searchForm');
 assert.equal(call.body.json,JSON.stringify(f.definition.arguments));assert.equal(f.calls.some(c=>c.url.includes('jscomp/run')),false);
});

function sourceFixture(){
 const f=fixture();f.box.TextEncoder=TextEncoder;f.box.btoa=s=>Buffer.from(s,'binary').toString('base64');
 const definition={origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',procedureId:'PR-EXAMPLE',procedureAlias:'com.golden.example',funId:'riskData',funName:'Risk data',operation:'CREATE_FUNCTION',manifestHash:'fixed'};
 let fun=null;
 f.box.fetch=async(url,options)=>{const body=Object.fromEntries(options.body);f.calls.push({url,body});let data;
  if(url.endsWith('getProcTree.htm'))data={list:[{procedureId:'PR-EXAMPLE',procedureAliasId:'com.golden.example'}]};
  else if(url.endsWith('getFunList.htm'))data={list:fun?[fun]:[]};
  else if(url.endsWith('saveFunInfo.htm')){fun={funId:'riskData',isTran:Number(body.isTran),isReturn:Number(body.isReturn),funParams:'[]',funScript:'',versionMac:'v1'};data={bean:fun};}
  else if(url.endsWith('getFunInfo.htm'))data={bean:fun};
  else if(url.endsWith('saveFunParams.htm')){fun.funParams=body.params;data={};}
  else if(url.endsWith('saveFunScript.htm')){fun.funScript=JSON.parse(Buffer.from(decodeURIComponent(body.funScript),'base64').toString('utf8')).script;fun.versionMac='v2';data={version:'v2'};}
  else throw Error('Unexpected source endpoint');
  return {ok:true,text:async()=>JSON.stringify({code:0,data})};
 };
 return {...f,read:()=>fun,run:(changes,context={})=>f.run({action:'apply-native-source',systemIds:['SYS-EXAMPLE'],...context,definition:{...definition,...changes}})};
}

test('DATABASE preflight resolves the native parent and exposes no source, without allowing writes', async()=>{
 const f=fixture();
 const payload={action:'inspect-database-procedure',systemIds:['SYS-EXAMPLE'],systemId:'SYS-EXAMPLE',
  procedureAlias:'com.golden.example',funId:'sample'};
 let parents=[{procedureId:'PR-EXAMPLE',procedureAliasId:payload.procedureAlias}], script='private source';
 f.box.fetch=async(url, options)=>{
  const body=Object.fromEntries(options.body);f.calls.push({url,body});
  let data;
  if(url.endsWith('getProcTree.htm'))data={list:parents};
  else if(url.endsWith('getFunList.htm'))data={list:[{funId:'sample'}]};
  else if(url.endsWith('getFunInfo.htm'))data={bean:{procedureId:'PR-EXAMPLE',funId:'sample',versionMac:'v1',funScript:script}};
  else assert.fail(`unexpected endpoint: ${url}`);
  return {ok:true,text:async()=>JSON.stringify({code:0,data})};
 };
 const result=await f.run(payload);
 assert.equal(result.state,'SUCCEEDED');assert.equal(result.platformApplied,false);
 assert.equal(result.after.procedureId,'PR-EXAMPLE');assert.equal(result.after.version,'v1');
 assert.equal(JSON.stringify(result).includes('private source'),false);
 assert.deepEqual(f.calls.map(call=>call.body),[{dataSourceId:'DS_1'},{procedureId:'PR-EXAMPLE'},
  {procedureId:'PR-EXAMPLE',funId:'sample'}]);
 const sourceEvidence=await f.run({...payload,includeSourceHash:true});
 assert.equal(sourceEvidence.sourceContent,script);
 assert.equal(sourceEvidence.platformApplied,false);
 script=undefined;
 assert.match((await f.run({...payload,includeSourceHash:true})).message,/无法核对编辑基线/);
 parents=[...parents,{...parents[0],procedureId:'PR-AMBIGUOUS'}];
 f.calls.length=0;
 assert.equal((await f.run(payload)).state,'REJECTED');assert.equal(f.calls.length,1);
 assert.equal((await f.run({...payload,systemId:'SYS-OTHER'})).state,'REJECTED');assert.equal(f.calls.length,1);
});

test('frozen source maintenance creates a nontransactional handler and independently verifies parameters and source',async()=>{
 const f=sourceFixture();assert.equal((await f.run({})).state,'SUCCEEDED');
 const parameters=[{id:'toolsId',remark:''},{id:'form',remark:''}];
 assert.equal((await f.run({operation:'SAVE_PARAMETERS',parameters})).state,'SUCCEEDED');
 assert.equal((await f.run({operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'',content:'return 1;'})).state,'SUCCEEDED');
 assert.equal(f.read().funScript,'return 1;');
 const blocked=await f.run({operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'',content:'return 2;'});
 assert.equal(blocked.state,'REJECTED');assert.equal(f.calls.filter(c=>c.url.endsWith('saveFunScript.htm')).length,1);
 assert.equal(f.calls.some(c=>/checkGdpaasScript|runScript|sql/.test(c.url)),false);
});

test('transactional function creation and parameter save preserve the frozen mode',async()=>{
 const f=sourceFixture(),mode={expectedIsTran:1,expectedIsReturn:1};
 assert.equal((await f.run(mode)).state,'SUCCEEDED');
 const create=f.calls.find(c=>c.url.endsWith('saveFunInfo.htm'));assert.equal(create.body.isTran,'1');assert.equal(create.body.isReturn,'1');
 const parameters=[{id:'form',remark:''}];
 const result=await f.run({operation:'SAVE_PARAMETERS',parameters,...mode});assert.equal(result.state,'SUCCEEDED',result.message);
 assert.equal(f.read().isTran,1);assert.equal(f.read().isReturn,1);
 const saves=f.calls.filter(c=>c.url.endsWith('saveFunParams.htm'));assert.equal(saves.length,1);
 assert.equal('isTran' in saves[0].body,false);assert.equal('isReturn' in saves[0].body,false);
});

test('parameter mode mismatch rejects before dispatch and readback drift is unknown',async()=>{
 const parameters=[{id:'form',remark:''}],step={operation:'SAVE_PARAMETERS',parameters,expectedIsTran:1,expectedIsReturn:1};
 for(const mode of [{isTran:0,isReturn:1},{isTran:1,isReturn:0},{isTran:null,isReturn:1},{isTran:1,isReturn:null}]){
  const f=sourceFixture();await f.run({});Object.assign(f.read(),mode);f.calls.length=0;
  const result=await f.run(step);assert.equal(result.state,'REJECTED');assert.equal(result.platformApplied,false);
  assert.equal(f.calls.some(c=>/saveFun/.test(c.url)),false);
 }
 const defaultMode=sourceFixture();await defaultMode.run({expectedIsTran:1,expectedIsReturn:1});defaultMode.calls.length=0;
 const rejected=await defaultMode.run({operation:'SAVE_PARAMETERS',parameters});assert.equal(rejected.state,'REJECTED');assert.equal(rejected.platformApplied,false);
 assert.equal(defaultMode.calls.some(c=>/saveFun/.test(c.url)),false);
 for(const changed of [{isTran:0},{isReturn:0}]){
  const f=sourceFixture();await f.run({expectedIsTran:1,expectedIsReturn:1});f.calls.length=0;
  const fetch=f.box.fetch;f.box.fetch=async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('saveFunParams.htm'))Object.assign(f.read(),changed);return response;};
  const result=await f.run(step);assert.equal(result.state,'UNKNOWN');assert.equal(result.platformApplied,null);
  assert.equal(f.calls.filter(c=>c.url.endsWith('saveFunParams.htm')).length,1);
 }
});

test('procedure maintenance uses the selected datasource and parent despite another UI system',async()=>{
 const f=sourceFixture(),context={systemIds:['SYS-ROOT']},mode={expectedIsTran:1,expectedIsReturn:1};
 const inspected=await f.run(mode,{...context,action:'inspect-native-source'});assert.equal(inspected.state,'SUCCEEDED');assert.equal(inspected.after.exists,false);
 for(const step of [mode,{operation:'SAVE_PARAMETERS',parameters:[{id:'form',remark:''}],...mode},
  {operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'',content:'old()',...mode},
  {operation:'SAVE_SOURCE_PATCH',expectedVersion:'v2',replacements:[{old:'old()',new:'new()',expectedCount:1}],...mode}]){
  const result=await f.run(step,context);assert.equal(result.state,'SUCCEEDED',result.message);
 }
 assert.equal(f.read().funScript,'new()');assert.equal(f.read().isTran,1);assert.equal(f.read().isReturn,1);
 assert.equal(f.calls.filter(c=>c.url.endsWith('getProcTree.htm')).every(c=>c.body.dataSourceId==='DS_1'),true);
 assert.equal(f.calls.filter(c=>/saveFun(?:Info|Params|Script)\.htm$/.test(c.url)).length,4);
});

test('procedure maintenance rejects wrong datasource or parent before any write',async()=>{
 const steps=[{}, {operation:'SAVE_PARAMETERS',parameters:[]},
  {operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'',content:'new()'},
  {operation:'SAVE_SOURCE_PATCH',expectedVersion:'v1',replacements:[{old:'old()',new:'new()',expectedCount:1}]}];
 for(const step of steps)for(const mismatch of ['selected-datasource','frozen-datasource','parent-id','parent-alias']){
  const f=sourceFixture();if(step.operation)assert.equal((await f.run({})).state,'SUCCEEDED');f.calls.length=0;
  const changes={...step},context={systemIds:['SYS-ROOT']};
  if(mismatch==='selected-datasource')context.dataSourceIds=['OTHER'];
  if(mismatch==='frozen-datasource')changes.dataSourceId='OTHER';
  if(mismatch==='parent-id')changes.procedureId='PR-OTHER';
  if(mismatch==='parent-alias')changes.procedureAlias='com.golden.other';
  const result=await f.run(changes,context);assert.equal(result.state,'REJECTED',mismatch);assert.equal(result.platformApplied,false);
  assert.equal(f.calls.some(c=>/saveFun(?:Info|Params|Script)\.htm$/.test(c.url)),false,mismatch);
  if(mismatch.includes('datasource'))assert.equal(f.calls.length,0,mismatch);
 }
});

test('MCP registration and frozen PAGE operations still reject another UI system',async()=>{
 const f=sourceFixture();assert.equal((await f.run({})).state,'SUCCEEDED');f.calls.length=0;
 const result=await f.run({operation:'REGISTER_TOOL',tool:{toolsId:'demo.tool',toolsParam:[]}},{systemIds:['SYS-ROOT']});
 assert.equal(result.state,'REJECTED');assert.equal(result.platformApplied,false);assert.equal(f.calls.length,0);
 for(const operation of ['INSPECT_PAGE_SOURCE','SAVE_PAGE_SOURCE_PATCH','SAVE_PAGE_FIELDS']){
  const page=servicePageInspectFixture(),definition={...page.definition,operation};
  const rejected=await page.run({action:operation==='INSPECT_PAGE_SOURCE'?'inspect-native-source':'apply-native-source',systemIds:['SYS-ROOT'],definition});
  assert.equal(rejected.state,'REJECTED',operation);assert.equal(rejected.platformApplied,false);assert.equal(page.calls.length,0,operation);
 }
});

test('frozen hidden save fields append only to unchanged native field collections and reread the whole PAGE',async()=>{
 const f=pageFixture();f.read().views.rows[0].component.fields=[{fieldId:'KEEP',type:'text'}];
 const definition={operation:'SAVE_PAGE_FIELDS',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',pageId:'PG-EXAMPLE',expectedVersion:'version-1',manifestHash:'fixed',sourceOperationId:'page-op:v1:'+'a'.repeat(64),collections:[{pointer:'/views/rows/0/component/fields',expectedIds:['KEEP'],fields:[{fieldId:'PARENT_CODE',type:'text',label:'Parent',isHideField:1}]}]};
 const inspected=await f.run({action:'inspect-native-source',definition});assert.equal(inspected.state,'SUCCEEDED');assert.equal(f.calls.some(c=>c.url.endsWith('savePageModuleXml.htm')),false);
 const saved=await f.run({action:'apply-native-source',definition});assert.equal(saved.state,'SUCCEEDED');assert.equal(f.read().views.rows[0].component.fields.length,2);
 assert.equal((await f.run({action:'apply-native-source',definition})).state,'REJECTED');assert.equal(f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm')).length,1);
});

test('reviewed source fragments preserve untouched source and reject changed version or duplicate/missing matches',async()=>{
 const f=sourceFixture();assert.equal((await f.run({})).state,'SUCCEEDED');
 assert.equal((await f.run({operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'',content:'keep();\nreturn 1;'})).state,'SUCCEEDED');
 const saved=await f.run({operation:'SAVE_SOURCE_PATCH',expectedVersion:'v2',replacements:[{old:'return 1;',new:'return 2;',expectedCount:1}]});
 assert.equal(saved.state,'SUCCEEDED');assert.equal(f.read().funScript,'keep();\nreturn 2;');
 for(const change of [{expectedVersion:'v1'},{replacements:[{old:'missing()',new:'x()',expectedCount:1}]}]){
  const result=await f.run({operation:'SAVE_SOURCE_PATCH',expectedVersion:'v2',replacements:[{old:'return 2;',new:'return 3;',expectedCount:1}],...change});
  assert.equal(result.state,'REJECTED');
 }
 assert.equal(f.calls.filter(c=>c.url.endsWith('saveFunScript.htm')).length,2);
});

test('source saves preserve default and explicitly frozen native modes without sending mode changes',async()=>{
 for(const operation of ['SAVE_SOURCE','SAVE_SOURCE_PATCH'])for(const mode of [{isTran:0,isReturn:1},{isTran:1,isReturn:0}]){
  const f=sourceFixture();assert.equal((await f.run({})).state,'SUCCEEDED');
  Object.assign(f.read(),mode,{funScript:'old()'});
  const source=operation==='SAVE_SOURCE'
   ? {operation,expectedVersion:'v1',expectedContent:'old()',content:'new()'}
   : {operation,expectedVersion:'v1',replacements:[{old:'old()',new:'new()',expectedCount:1}]};
  if(mode.isTran===1)Object.assign(source,{expectedIsTran:1,expectedIsReturn:0});
  const result=await f.run(source);assert.equal(result.state,'SUCCEEDED');
  assert.equal(f.read().isTran,mode.isTran);assert.equal(f.read().isReturn,mode.isReturn);assert.equal(f.read().funScript,'new()');
  const saves=f.calls.filter(c=>c.url.endsWith('saveFunScript.htm'));assert.equal(saves.length,1);
  assert.equal('isTran' in saves[0].body,false);assert.equal('isReturn' in saves[0].body,false);
 }
});

test('source mode mismatch rejects before dispatch and changed readback is unknown',async()=>{
 for(const operation of ['SAVE_SOURCE','SAVE_SOURCE_PATCH']){
  const source=operation==='SAVE_SOURCE'
   ? {operation,expectedVersion:'v1',expectedContent:'old()',content:'new()',expectedIsTran:1,expectedIsReturn:0}
   : {operation,expectedVersion:'v1',replacements:[{old:'old()',new:'new()',expectedCount:1}],expectedIsTran:1,expectedIsReturn:0};
  for(const mode of [{isTran:0,isReturn:0},{isTran:1,isReturn:1},{isTran:null,isReturn:0}]){
   const f=sourceFixture();await f.run({});Object.assign(f.read(),mode,{funScript:'old()'});
   const result=await f.run(source);assert.equal(result.state,'REJECTED');assert.equal(result.platformApplied,false);
   assert.equal(f.calls.filter(c=>c.url.endsWith('saveFunScript.htm')).length,0);
  }
  for(const changed of [{isTran:0},{isReturn:1}]){
   const f=sourceFixture();await f.run({});Object.assign(f.read(),{isTran:1,isReturn:0,funScript:'old()'});
   const fetch=f.box.fetch;f.box.fetch=async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('saveFunScript.htm'))Object.assign(f.read(),changed);return response;};
   const result=await f.run(source);assert.equal(result.state,'UNKNOWN');assert.equal(result.platformApplied,null);
   assert.equal(f.calls.filter(c=>c.url.endsWith('saveFunScript.htm')).length,1);
  }
 }
});

test('create readback and MCP registration retain the strict nontransactional return mode',async()=>{
 const created=sourceFixture(),fetchCreate=created.box.fetch;
 created.box.fetch=async(url,options)=>{const response=await fetchCreate(url,options);if(url.endsWith('saveFunInfo.htm'))created.read().isTran=1;return response;};
 const createResult=await created.run({});assert.equal(createResult.state,'UNKNOWN');
 const call=created.calls.find(c=>c.url.endsWith('saveFunInfo.htm'));assert.equal(call.body.isTran,'0');assert.equal(call.body.isReturn,'1');
 for(const mode of [{isTran:1,isReturn:1},{isTran:0,isReturn:0},{isTran:null,isReturn:1}]){
  const f=sourceFixture();await f.run({});Object.assign(f.read(),mode,{funScript:'return 1;'});
  const fetch=f.box.fetch;f.box.fetch=async(url,options)=>url.endsWith('/develop/mcp/tools/list.htm')
   ? (f.calls.push({url,body:Object.fromEntries(options.body)}),{ok:true,text:async()=>JSON.stringify({code:0,data:{list:[]}})})
   : fetch(url,options);
  const result=await f.run({operation:'REGISTER_TOOL',expectedIsTran:1,expectedIsReturn:1,tool:{toolsId:'demo.tool',toolsParam:[]}});
  assert.equal(result.state,'REJECTED');assert.equal(f.calls.some(c=>c.url.endsWith('/develop/mcp/tools/save.htm')),false);
 }
});

function servicePageInspectFixture(){
 const f=fixture();
 const definition={operation:'INSPECT_PAGE_SOURCE',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',pageId:'PG-EXAMPLE',alias:'com.golden.example.service',manifestHash:'fixed'};
 const page={pageId:'PG-EXAMPLE',systemId:'SYS-EXAMPLE',pageType:0,pageAliasId:definition.alias,runInTran:10};
 const source={version:'v1',bean:{pageId:'PG-EXAMPLE',pageType:0,compScript:'private script',superScript:'private inherited',other:{keep:true}}};
 f.box.fetch=async(url,options)=>{f.calls.push({url,body:Object.fromEntries(options.body)});let data;
  if(url.endsWith('getPageBaseInfo.htm'))data={page};else if(url.endsWith('getPageModuleXml.htm'))data=source;else throw Error('Unexpected endpoint');
  return {ok:true,text:async()=>JSON.stringify({code:0,data})};};
 return {...f,page,source,run:changes=>f.run({action:'inspect-native-source',step:'inspect',definition,systemIds:['SYS-EXAMPLE'],...changes})};
}

test('service PAGE inspection returns only structure and native mode using two read calls',async()=>{
 const f=servicePageInspectFixture(),result=await f.run({});
 assert.equal(result.state,'SUCCEEDED');assert.equal(result.platformApplied,false);
 assert.equal(result.after.page.runInTran.value,10);assert.equal(result.after.beanKeys.compScript,'string');
 assert.equal(result.after.compScriptLength,14);assert.equal(result.after.sourceVersion,'v1');
 assert.equal(JSON.stringify(result).includes('private script'),false);
 assert.deepEqual(f.calls.map(c=>c.url),['/develop/dev/pages/getPageBaseInfo.htm','/develop/dev/pages/getPageModuleXml.htm']);
});

test('service PAGE inspect rejects wrong identity or attempted apply and reports absent native mode',async()=>{
 for(const change of [{pageType:1},{pageAliasId:'com.golden.example.other'},{systemId:'SYS-OTHER'}]){
  const f=servicePageInspectFixture();Object.assign(f.page,change);assert.equal((await f.run({})).state,'REJECTED');
  assert.equal(f.calls.length,1);
 }
 const f=servicePageInspectFixture();assert.equal((await f.run({action:'apply-native-source'})).state,'REJECTED');assert.equal(f.calls.length,0);
 delete f.page.runInTran;const result=await f.run({});assert.equal(result.after.page.runInTran.present,false);
});

function servicePageSaveFixture(){
 const f=servicePageInspectFixture();f.box.TextEncoder=TextEncoder;f.box.btoa=btoa;f.page.runInTran=1;f.source.bean.pageAliasId=f.page.pageAliasId;f.source.bean.compScript='old()';
 const definition={operation:'SAVE_PAGE_SOURCE_PATCH',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',pageId:'PG-EXAMPLE',alias:f.page.pageAliasId,expectedVersion:'v1',expectedContent:'old()',expectedRunInTran:1,sourceHash:'a'.repeat(64),replacements:[{old:'old()',new:'new()',expectedCount:1}],manifestHash:'fixed'};
 const fetch=f.box.fetch;
 f.box.fetch=async(url,options)=>{
  if(!url.endsWith('savePageModuleXml.htm'))return fetch(url,options);
  const body=Object.fromEntries(options.body);f.calls.push({url,body});
  f.source.bean=JSON.parse(Buffer.from(decodeURIComponent(body.json),'base64').toString('utf8'));f.source.version='v2';
  return {ok:true,text:async()=>JSON.stringify({code:0,data:{version:'v2'}})};
 };
 return {...f,definition,run:(phase='apply-native-source',changes={})=>f.run({action:phase,step:'save',definition:{...definition,...changes}})};
}

test('service source publish compares complete source, preserves bean and transaction, and requests compilation',async()=>{
 const f=servicePageSaveFixture(),before=JSON.parse(JSON.stringify(f.source.bean));
 const preview=await f.run('inspect-native-source');assert.equal(preview.state,'SUCCEEDED');assert.equal(preview.after.ready,true);assert.equal(f.calls.length,2);
 const result=await f.run();assert.equal(result.state,'SUCCEEDED',result.message);assert.equal(result.platformApplied,true);assert.equal(result.after.runInTran,1);
 assert.deepEqual(f.source.bean,{...before,compScript:'new()'});assert.equal(f.page.runInTran,1);
 const writes=f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm'));assert.equal(writes.length,1);assert.equal(writes[0].body.isAutoCompile,'1');assert.equal('runInTran' in writes[0].body,false);
});

test('service source drift or transaction mismatch rejects before any write',async()=>{
 for(const change of [{expectedVersion:'other'},{expectedContent:'different()'},{expectedRunInTran:0},{replacements:[{old:'absent()',new:'new()',expectedCount:1}]}]){
  const f=servicePageSaveFixture(),result=await f.run('apply-native-source',change);assert.equal(result.state,'REJECTED');assert.equal(result.platformApplied,false);assert.equal(f.calls.some(c=>c.url.endsWith('savePageModuleXml.htm')),false);
 }
});

test('service source post-save content or transaction drift is unknown after exactly one write',async()=>{
 for(const corrupt of [f=>f.page.runInTran=0,f=>f.source.bean.other.keep=false,f=>f.source.bean.compScript='different()']){
  const f=servicePageSaveFixture(),fetch=f.box.fetch;
  f.box.fetch=async(url,options)=>{const result=await fetch(url,options);if(url.endsWith('savePageModuleXml.htm'))corrupt(f);return result;};
  const result=await f.run();assert.equal(result.state,'UNKNOWN',result.message);assert.equal(result.platformApplied,null);assert.equal(f.calls.filter(c=>c.url.endsWith('savePageModuleXml.htm')).length,1);
 }
});
