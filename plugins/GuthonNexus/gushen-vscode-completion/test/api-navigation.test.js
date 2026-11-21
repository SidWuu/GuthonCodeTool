const test=require('node:test');const assert=require('node:assert/strict');
const {allPages,sourceLink,parseSourceLink}=require('../src/api/navigation');
test('API searches follow all hits pages and disclose partial index coverage',async()=>{
  const offsets=[];const result=await allPages(async(_key,_action,input)=>{offsets.push(input.offset);return {indexGeneration:'v1',hits:[{path:`${input.offset}.gss`}],nextOffset:input.offset<200?input.offset+100:null,partialSourceCount:1};},'projects.demo','search',{query:'save'},'hits');
  assert.equal(result.items.length,3);assert.deepEqual(offsets,[0,100,200]);assert.equal(result.truncated,true);
  await assert.rejects(allPages(async(_key,_action,input)=>({indexGeneration:String(input.offset),hits:[],nextOffset:input.offset?null:100}),'projects.demo','search',{query:'x'},'hits'),/索引已变化/);
});
test('locator links keep exact project and path identity and reject malformed links',()=>{
  const link=sourceLink('projects.demo','systems/one/pages/中文.json');const parsed=new URL(link);
  assert.deepEqual(parseSourceLink({authority:parsed.host,path:parsed.pathname,query:parsed.search.slice(1)}),{type:'open-source',workspaceKey:'projects.demo',path:'systems/one/pages/中文.json'});
  assert.throws(()=>sourceLink('projects.demo','../other'),/路径/);
  assert.throws(()=>parseSourceLink({authority:parsed.host,path:parsed.pathname,query:'workspaceKey=projects.demo&path=a&path=b'}),/字段/);
});
test('PAGE ID locator opens the page manager instead of an arbitrary indexed script fragment',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),calls=[],disposable={dispose(){}};
  const vscode={commands:{registerCommand:(name,handler)=>(commands.set(name,handler),disposable),executeCommand:async(...args)=>calls.push(args)},
    window:{showErrorMessage:async message=>assert.fail(message)},workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  const key='products.GuthonOfficial',path='systems/S/pages/X/PG-123/page.xml';
  const api={editorState:{workspaces:new Map()},sourceTree:{open:()=>assert.fail('should open PAGE manager')},run:async(workspace,action)=>{
    assert.equal(workspace,key);assert.equal(action,'search');return {hits:[{sourceType:'page',sourceId:'PG-123',path,jsonPointer:'/events/onOpenScript'}]};}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>({workspaceKey:key}),getTool:()=>{},bridge:{}});
  await commands.get('gushenCompletion.locateApiPageById')(key,'PG-123');
  assert.deepEqual(calls,[['gushenCompletion.openApiPageEditor',{workspaceKey:key,path}]]);nav.dispose();
});
test('procedure names copy only after exact source and index hash verification',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),copied=[],errors=[],disposable={dispose(){}};
  const vscode={commands:{registerCommand:(name,handler)=>(commands.set(name,handler),disposable)},env:{clipboard:{writeText:async value=>copied.push(value)}},
    window:{showInformationMessage:async()=>{},showErrorMessage:async message=>errors.push(message)},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  let stale=false;const api={editorState:{workspaces:new Map()},sourceTree:{status:async()=>({})},run:async(_key,action)=>action==='read'?
    {sourceHash:'hash',metadata:{sourceType:'procedure'}}:{source:{sourceHash:stale?'other':'hash',sourceType:'procedure',alias:'demo.pkg',funId:'save'}}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>{},getTool:()=>{},bridge:{}});
  const target={workspaceKey:'projects.demo',path:'datasources/DS/procedures/save.gss'};
  await commands.get('gushenCompletion.copyApiProcedureName')(target);await commands.get('gushenCompletion.copyApiQualifiedProcedureName')(target);
  assert.deepEqual(copied,['save','demo.pkg.save']);stale=true;await commands.get('gushenCompletion.copyApiProcedureName')(target);
  assert.equal(copied.length,2);assert.match(errors[0],/不一致/);nav.dispose();
});
test('PAGE inheritance view selects an exact script node before reading its projection',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),calls=[],disposable={dispose(){}};let shown='';
  const vscode={commands:{registerCommand:(name,handler)=>(commands.set(name,handler),disposable)},
    window:{showInformationMessage:async()=>{},showErrorMessage:async message=>assert.fail(message),showTextDocument:async doc=>{shown=doc.content;}},
    workspace:{textDocuments:[],openTextDocument:async value=>value,onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  const api={editorState:{workspaces:new Map()},sourceTree:{status:async()=>({})},run:async(_key,action,input)=>{calls.push({action,input});
    if(action==='read')return {sourceHash:'hash',metadata:{sourceType:'page'}};
    if(action==='page')return {sourcePath:'page.xml',sourceHash:'hash',model:{nodes:[{pointer:'/pageEvents/onOpenScript',content:'inherit();'}]}};
    if(action==='inheritance')return {path:'page.xml',sourceHash:'hash',status:'ACTIVE',parentPointer:'/superPageEvents/onOpenScript',segments:[],effective:'parent();',totalChars:9,truncated:false};throw Error(action);}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>{},getTool:()=>{},bridge:{}});
  await commands.get('gushenCompletion.showApiInheritance')({workspaceKey:'projects.demo',path:'page.xml'});
  assert.equal(calls.find(x=>x.action==='inheritance').input.jsonPointer,'/pageEvents/onOpenScript');assert.match(shown,/parent\(\)/);nav.dispose();
});
test('objects without inheritance show the exact message without opening an empty document or scanning checkout',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),messages=[],disposable={dispose(){}};
  let inherited=false;
  const vscode={commands:{registerCommand:(name,handler)=>(commands.set(name,handler),disposable)},
    window:{showInformationMessage:async message=>messages.push(message),showErrorMessage:async message=>assert.fail(message),showTextDocument:()=>assert.fail('no empty inheritance document')},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  const api={editorState:{workspaces:new Map()},sourceTree:{status:()=>assert.fail('no full status scan')},run:async(_key,action)=>{
    if(action==='read')return {content:'return 1;',sourceHash:'hash',metadata:{sourceType:'procedure',...(inherited?{}:{isInhert:0})}};
    assert.equal(action,'inheritance');return {path:'fn.gss',sourceHash:'hash',status:'INACTIVE',parentPath:null,effective:'return 1;',segments:[],totalChars:9,truncated:false};
  }};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>{},getTool:()=>{},bridge:{}});
  const target={workspaceKey:'products.demo',path:'fn.gss'};
  await commands.get('gushenCompletion.showApiInheritance')(target);inherited=true;
  await commands.get('gushenCompletion.showApiInheritance')(target);assert.deepEqual(messages,['无继承源码','无继承源码']);nav.dispose();
});
test('source tree expand and collapse act only after the selected node is focused',async()=>{
  const {sourceTreeAction}=require('../src/api/navigation'),calls=[],item={label:'folder'};
  const vscode={window:{showInformationMessage:async message=>calls.push(message)},commands:{executeCommand:async command=>calls.push(command)}};
  const tree={selection:[item],reveal:async(selected,options)=>calls.push({selected,options})};
  await sourceTreeAction(vscode,tree,'list.expand');assert.equal(calls[0].selected,item);assert.equal(calls[0].options.focus,true);assert.equal(calls[1],'list.expand');
  calls.length=0;await sourceTreeAction(vscode,{selection:[]},'list.collapseAllToFocus');assert.equal(calls.length,1);assert.match(calls[0],/选择/);
});
test('references use exact source path, follow pages and open the selected occurrence',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),calls=[],opened=[],disposable={dispose(){}};
  const vscode={commands:{registerCommand:(name,fn)=>(commands.set(name,fn),disposable)},window:{showErrorMessage:async message=>assert.fail(message),showQuickPick:async values=>values.at(-1)},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  const api={editorState:{workspaces:new Map()},sourceTree:{status:async()=>{},open:async(key,path)=>opened.push({key,path})},run:async(_key,action,input)=>{
    calls.push({action,input});if(action==='read')return {sourceHash:'h'};if(action==='context')return {source:{sourceHash:'h',sourceType:'page'}};
    if(action==='callers')return {callers:[{path:`caller${input.offset}.gss`,sourceId:'A',name:'调用方',line:3}],nextOffset:input.offset===0?100:null,indexGeneration:'v1'};throw Error(action);
  }};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>{},getTool:()=>{},bridge:{}});
  await commands.get('gushenCompletion.showApiReferences')({key:'projects.a',object:{path:'systems/S/pages/A/P/page.xml'}});
  assert.deepEqual(calls.filter(x=>x.action==='callers').map(x=>x.input),[{path:'systems/S/pages/A/P/page.xml',limit:100,offset:0},{path:'systems/S/pages/A/P/page.xml',limit:100,offset:100}]);
  assert.deepEqual(opened,[{key:'projects.a',path:'caller100.gss'}]);nav.dispose();
});
test('procedure layout command persists the setting and refreshes the catalog',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),commands=new Map(),updates=[],disposable={dispose(){}};let invalidated=0,refreshed=0;
  const vscode={ConfigurationTarget:{Global:1},commands:{registerCommand:(name,fn)=>(commands.set(name,fn),disposable)},window:{showErrorMessage:async message=>assert.fail(message)},
    workspace:{textDocuments:[],getConfiguration:()=>({update:async(...args)=>updates.push(args)}),onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable}};
  const api={editorState:{workspaces:new Map()},sourceTree:{invalidate:()=>invalidated++,refresh:()=>refreshed++},run:async()=>{}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>{},getTool:()=>{},bridge:{}});
  await commands.get('gushenCompletion.showApiProcedureFlat')();await commands.get('gushenCompletion.showApiProcedureTree')();
  assert.deepEqual(updates,[['procedureTreeLayout','flat',1],['procedureTreeLayout','tree',1]]);assert.equal(invalidated,2);assert.equal(refreshed,2);nav.dispose();
});
test('source menu removes only requested actions for PAGE and procedure',()=>{
  const manifest=require('../package.json'),entries=manifest.contributes.menus['view/item/context'];
  const find=command=>entries.filter(x=>x.command==='gushenCompletion.'+command && x.when.includes('gushenCompletion.sourceView'));
  for(const command of ['openApiSource','previewApiSource','browseApiImpactEvidence','showApiImpact','exportAiContext']) {
    const when=find(command)[0].when;const regex=new RegExp(when.match(/=~ \/(.*)\/$/)[1]);
    assert.equal(regex.test('guthonApi.page'),false,command);assert.equal(regex.test('guthonApi.procedure'),false,command);assert.equal(regex.test('guthonApi.table'),true,command);
  }
  assert.match(find('createApiFunction')[0].when,/guthonApi\.procedurePackage/);
  assert.match(find('showApiReferences')[0].when,/page\|procedure/);
  assert.equal(find('openApiPageEditor').length,1);assert.equal(find('openApiDesigner').length,0);
  assert.match(manifest.contributes.commands.find(x=>x.command==='gushenCompletion.openApiPageEditor').title,/编辑页面/);
});
