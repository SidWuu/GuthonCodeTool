const test=require('node:test');const assert=require('node:assert/strict');const {createApiNavigation}=require('../src/api/navigation');
const {quickPickFixture,waitFor}=require('./quick-pick-fixture');
test('API quick open keeps the keyword and restarts pagination for the selected type',async()=>{
  const calls=[],commands=new Map(),dispose={dispose(){}};let uriHandler;
  const f=quickPickFixture();
  const vscode={...f.vscode,commands:{registerCommand:(id,fn)=>(commands.set(id,fn),dispose)},env:{clipboard:{writeText:async()=>{}}},
    window:{...f.vscode.window,registerUriHandler:fn=>(uriHandler=fn,dispose),showQuickPick:async(items,options)=>{
      assert.equal(options.title,'筛选源码类型');
      assert.deepEqual(items.slice(0,5).map(item=>item.label),['全部类型','页面','过程函数','表','视图']);
      f.hide();
      return items.find(item=>item.sourceType==='procedure');
    }},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>dispose,onDidChangeTextDocument:()=>dispose,onDidCloseTextDocument:()=>dispose},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>dispose}};
  const api={editorState:{workspaces:new Map()},sourceTree:{open:async(key,p)=>calls.push({key,path:p})},run:async(key,action,input)=>{
    calls.push({key,action,input});
    return {hits:[{path:input.offset ? 'b/save.gss' : 'a/save.gss',sourceType:'procedure',sourceId:'save',name:'save'}],
      indexGeneration:'g',nextOffset:input.offset ? null : 100,truncated:!input.offset};
  }};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async key=>({workspaceKey:key,displayName:'Demo'}),getTool:()=>({toolHome:'/tmp'}),bridge:{}});
  const pending=commands.get('gushenCompletion.quickOpenApiSource')('projects.demo');
  await waitFor(()=>f.picker.shown);
  f.input('save');
  await waitFor(()=>!f.picker.busy && f.picker.items.length===2);
  assert.deepEqual(calls,[{key:'projects.demo',action:'search',input:{query:'save',limit:100,offset:0}}]);
  assert.match(f.picker.items[1].label,/加载更多/);
  assert.match(f.picker.title,/1 条结果 · 还有更多$/);
  f.accept(1);
  await waitFor(()=>!f.picker.busy);
  assert.deepEqual(calls[1],{key:'projects.demo',action:'search',input:{query:'save',limit:100,offset:100}});
  f.titleButton();
  await waitFor(()=>f.picker.shown && !f.picker.busy && calls.length===3);
  assert.equal(f.picker.value,'save');
  assert.match(f.picker.title,/过程函数 · 1 条结果/);
  assert.deepEqual(calls[2],{key:'projects.demo',action:'search',input:{query:'save',sourceType:'procedure',limit:100,offset:0}});
  f.accept(1);
  await waitFor(()=>!f.picker.busy);
  assert.deepEqual(calls[3],{key:'projects.demo',action:'search',input:{query:'save',sourceType:'procedure',limit:100,offset:100}});
  assert.deepEqual(f.picker.items.map(item=>item.description),['a/save.gss','b/save.gss']);
  f.accept(1);
  await pending;
  assert.deepEqual(calls.at(-1),{key:'projects.demo',path:'b/save.gss'});assert.ok(uriHandler);nav.dispose();
});
