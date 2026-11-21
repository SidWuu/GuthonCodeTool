const test=require('node:test');const assert=require('node:assert/strict');const {createApiNavigation}=require('../src/api/navigation');
test('quick open searches the selected API project and opens the exact result',async()=>{
  const calls=[],commands=new Map(),dispose={dispose(){}};let uriHandler;
  const vscode={commands:{registerCommand:(id,fn)=>(commands.set(id,fn),dispose)},env:{clipboard:{writeText:async()=>{}}},ThemeIcon:class{},
    window:{createQuickPick(){const handlers={};const pick={items:[],selectedItems:[],onDidChangeValue:fn=>(handlers.change=fn,dispose),onDidAccept:fn=>(handlers.accept=fn,dispose),onDidHide:fn=>(handlers.hide=fn,dispose),onDidTriggerItemButton:()=>dispose,dispose(){},show(){handlers.change('save');setTimeout(()=>{this.selectedItems=[this.items[0]];handlers.accept();},260);}};return pick;},registerUriHandler:fn=>(uriHandler=fn,dispose)},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>dispose,onDidChangeTextDocument:()=>dispose,onDidCloseTextDocument:()=>dispose},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>dispose}};
  const api={editorState:{workspaces:new Map()},sourceTree:{open:async(key,p)=>calls.push({key,path:p})},run:async(key,action,input)=>{calls.push({key,action,input});return {hits:[{path:'a/save.gss',sourceType:'procedure',sourceId:'save',name:'save'}],indexGeneration:'g',nextOffset:null};}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async key=>({workspaceKey:key,displayName:'Demo'}),getTool:()=>({toolHome:'/tmp'}),bridge:{}});
  await commands.get('gushenCompletion.quickOpenApiSource')('projects.demo');
  assert.equal(calls.find(x=>x.action==='search').key,'projects.demo');assert.deepEqual(calls.at(-1),{key:'projects.demo',path:'a/save.gss'});assert.ok(uriHandler);nav.dispose();
});
