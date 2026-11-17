const test=require('node:test');
const assert=require('node:assert/strict');
const {selectUploadFiles}=require('../src/api/upload-review');
const {procedureTargetAt,localFunctionAt,inheritCallAt}=require('../src/definition');

function reviewFixture() {
  const handlers={},opened=[];
  const picker={items:[],selectedItems:[],show(){},dispose(){this.disposed=true;},
    onDidHide(fn){handlers.hide=fn;return {dispose(){}};},
    onDidAccept(fn){handlers.accept=fn;return {dispose(){}};},
    onDidTriggerItemButton(fn){handlers.diff=fn;return {dispose(){}};}};
  const vscode={ThemeIcon:class {constructor(id){this.id=id;}},window:{createQuickPick:()=>picker,
    showInformationMessage:async()=>{},showErrorMessage:async message=>assert.fail(message)}};
  return {picker,handlers,opened,vscode};
}
test('upload review keeps business labels and exact paths, opens diff, submits only selection',async()=>{
  const f=reviewFixture(),entries=[{path:'a.gss',name:'保存采购',type:'过程函数',state:'本地修改'},
    {path:'b.json',name:'采购表',type:'表',state:'本地修改'}];
  const pending=selectUploadFiles(f.vscode,entries,async path=>f.opened.push(path));
  assert.equal(f.picker.items[0].label,'保存采购');assert.equal(f.picker.items[0].detail,'a.gss');
  await f.handlers.diff({item:f.picker.items[0]});assert.deepEqual(f.opened,['a.gss']);
  f.picker.selectedItems=[f.picker.items[1]];f.handlers.accept();
  assert.deepEqual(await pending,['b.json']);assert.equal(f.picker.disposed,true);
});
test('cancelling review returns no upload selection',async()=>{
  const f=reviewFixture(),pending=selectUploadFiles(f.vscode,[],async()=>{});
  f.handlers.hide();assert.equal(await pending,undefined);
});
test('global transaction targets and regular calls resolve the same exact function',()=>{
  for(const method of ['proc.invoke','proc.invokeWithGlobalTrans','thread.runFutureTaskWithGlobalTrans']) {
    const source=`$vs.${method}(\n 'demo.pkg', 'save', $x);`;
    assert.deepEqual(procedureTargetAt(source,source.indexOf('save')+1),{alias:'demo.pkg',fun:'save'});
  }
  const source='$vs.proc.invokeWithGlobalTrans("demo.pkg", "save" + $suffix, $x);';
  assert.equal(procedureTargetAt(source,source.indexOf('save')+1),null);
});
test('local function hover uses only adjacent comments and resolves declaration or call',()=>{
  const source='// 保存采购\n// 返回采购编码\n#function save($form)\n#end\n@save($x);';
  for(const offset of [source.indexOf('save')+1,source.lastIndexOf('save')+1]) {
    const value=localFunctionAt(source,offset);assert.equal(value.signature,'save($form)');
    assert.equal(value.comment,'保存采购\n返回采购编码');
  }
  const separated='// unrelated\n\n#function save()\n#end';
  assert.equal(localFunctionAt(separated,separated.indexOf('save')+1).comment,'');
  assert.equal(inheritCallAt('@inherit();',3),true);assert.equal(inheritCallAt('@inheritOther();',3),false);
});

const {filterChildren}=require('../src/api/tree-filter');
const {configurationText,probeMcp}=require('../src/api/mcp-configuration');
const {contract,assessOfficial}=require('../src/official-assessment');
const jsonc=require('jsonc-parser');
test('tree filtering preserves canonical nodes and parent chains without changing source collections',()=>{
  const root={label:'页面'},group={label:'采购',parent:root},a={label:'保存',object:{path:'systems/A/save.gss',sourceId:'P1'},parent:group},b={label:'查看',object:{path:'systems/A/view.gss'},parent:group};
  group.children=[a,b];root.children=[group];
  assert.deepEqual(filterChildren(root.children,'P1',root),[group]);
  assert.deepEqual(filterChildren(group.children,'P1',group),[a]);
  assert.deepEqual(filterChildren(group.children,'采购',group),[a,b]);
  assert.strictEqual(filterChildren(group.children,'',group),group.children);
  assert.equal(group.children.length,2);assert.strictEqual(a.parent,group);
});
test('MCP configuration preserves comments and other services, supports all runtime paths, and is repeatable',()=>{
  const original='// keep\n{"mcpServers":{"other":{"command":"other"}},}';
  for(const tool of [{toolPath:'/tmp/app with spaces',toolHome:'/tmp/private home'},
    {toolPath:'/tmp/python',toolEntry:'/tmp/source tools/guthon_tool.py',toolHome:'/tmp/home'},
    {toolPath:'/tmp/python',toolEntry:'/tmp/tool.pyz',toolHome:'/tmp/home'}]) {
    const client={key:'mcpServers'},result=configurationText(original,client,tool,true);
    const parsed=jsonc.parse(result.text);assert.equal(parsed.mcpServers.other.command,'other');assert.match(result.text,/\/\/ keep/);
    assert.equal(parsed.mcpServers['guthon-api'].command,tool.toolPath);
    assert.ok(parsed.mcpServers['guthon-api'].args.includes('--read-only'));
    assert.equal(configurationText(result.text,client,tool,true).text,result.text);
    assert.equal(result.text.includes('password'),false);
  }
  assert.throws(()=>configurationText('{bad',{key:'servers'},{},true),/配置无效/);
});
test('official assessment separates added commands, API resources and protocol changes from enabled capabilities',()=>{
  const old=contract({version:'1',contributes:{commands:[{command:'a',title:'原入口'}]}},'/develop/old.htm');
  const next=contract({version:'2',guthonConfig:{minDateVersion:'new'},contributes:{commands:[{command:'a',title:'原入口'},{command:'b',title:'新功能'}],customEditors:[{viewType:'new'}]}},'/develop/new.htm');
  const catalog={modules:{util:{functions:[{label:'trim()',doc:'old',params:[]}]}}};
  const changed={modules:{util:{functions:[{label:'trim()',doc:'new',params:[]}]}}};
  const result=assessOfficial(old,next,catalog,changed);
  assert.deepEqual(result.commandChanges.added,['b']);assert.deepEqual(result.implemented,['a']);
  assert.ok(result.pending.includes('contract:customEditors'));assert.ok(result.pending.includes('contract:endpoints'));
  assert.deepEqual(result.apiChanges.changed,['util.trim()']);
});

test('inherit definition opens only the verified readonly parent from physical and virtual documents',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),{uriFor}=require('../src/source/virtual-fs');
  const disposed={dispose(){}},commands=new Map(),messages=[],key='projects.A',child='datasources/D/procedures/demo/save.gss',parent='datasources/D/procedures/demo/save.inherit.gss';let parentReadonly=true;
  const vscode={Uri:{from:value=>({...value,toString:()=>JSON.stringify(value)})},Position:class{constructor(line,character){Object.assign(this,{line,character});}},Location:class{constructor(uri,position){Object.assign(this,{uri,position});}},
    commands:{registerCommand:(id,fn)=>(commands.set(id,fn),disposed)},window:{showInformationMessage:async text=>messages.push(text),showErrorMessage:async text=>assert.fail(text)},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposed,onDidChangeTextDocument:()=>disposed,onDidCloseTextDocument:()=>disposed},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposed}};
  const api={editorState:{workspaces:new Map([[key,{root:'/checkout'}]]),documentPath:()=>child},
    sourceTree:{readonlyUri:(_key,path,content)=>({scheme:'guthon-api-readonly',path,content})},
    run:async(_key,action,input)=>action==='read' ? input.path===parent ? {sourceHash:'parent-hash',readonly:parentReadonly,content:'product();'} : {sourceHash:'child-hash'} :
      {path:child,sourceHash:'child-hash',parentPath:parent,parentHash:'parent-hash',status:'ACTIVE',segments:[],effective:'product();',totalChars:10,truncated:false}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async()=>({workspaceKey:key}),bridge:{}});
  for(const uri of [{scheme:'file',fsPath:'/checkout/'+child},uriFor(vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:child,jsonPointer:'',fragmentType:'gss'})]) {
    const doc={uri,getText:()=> '@inherit();',offsetAt:()=>3};
    const location=await nav.definition(doc,{});assert.equal(location.uri.scheme,'guthon-api-readonly');assert.equal(location.uri.path,parent);
    parentReadonly=false;await assert.rejects(nav.definition(doc,{}),/未确认为只读/);parentReadonly=true;
  }
  nav.dispose();
});

test('filtering one project keeps all workspace roots accessible',async()=>{
  const {ApiSourceUI}=require('../src/api/source-ui');
  const ui=new ApiSourceUI({vscode:{workspace:{textDocuments:[]}},run:async()=>({objects:[]})});
  ui.syncWorkspaces(['projects.A','projects.B']);ui.setFilter('projects.A','采购');
  assert.deepEqual((await ui.getChildren()).map(item=>item.key),['projects.A','projects.B']);ui.dispose();
});
