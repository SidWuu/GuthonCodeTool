const assert=require('node:assert/strict');const test=require('node:test');
const {createApiNavigation}=require('../src/api/navigation');
function fixture() {
  const calls=[],disposable={dispose(){}},workspace={workspaceKey:'projects.demo',displayName:'Demo'};
  const root='/checkout/demo',state={root};
  const vscode={Uri:{file:fsPath=>({scheme:'file',fsPath})},Position:class{constructor(line,character){Object.assign(this,{line,character});}},Location:class{constructor(uri,position){Object.assign(this,{uri,position});}},
    commands:{registerCommand:()=>disposable},window:{},languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable}};
  const editorState={workspaces:new Map([['projects.demo',state]]),documentPath:(_key,_state,doc)=>doc.uri.fsPath?.startsWith(root+'/')?doc.uri.fsPath.slice(root.length+1):''};
  const api={editorState,sourceTree:{status:async()=>({checkoutPath:root})},run:async(key,action,input)=>{calls.push({key,action,input});return {indexGeneration:'g1',hits:[
    {sourceType:'procedure',alias:'demo.pkg',funId:'save',path:'datasources/DS/procedures/demo/save.gss'},
    {sourceType:'procedure',alias:'other',funId:'save',path:'datasources/DS/procedures/other/save.gss'},
    {sourceType:'page',sourceId:'PG-COMP',path:'systems/S/pages/comp.gss'},
  ],nextOffset:null};}};
  const nav=createApiNavigation({vscode,context:{subscriptions:[]},api,selectWorkspace:async key=>key===workspace.workspaceKey?workspace:undefined,getTool:()=>({toolHome:'/tmp'}),bridge:{}});
  const doc=(text,term)=>({uri:{scheme:'file',fsPath:root+'/caller.gss'},getText:()=>text,offsetAt:()=>text.indexOf(term)+1,positionAt:x=>({offset:x})});
  return {calls,nav,doc,api};
}
test('API procedure definitions use exact alias and function within the current project',async()=>{
  const f=fixture(),source='$vs.proc.invoke("demo.pkg", "save", $args)';const locations=await f.nav.definition(f.doc(source,'save'),{});
  assert.deepEqual(locations.map(x=>x.uri.fsPath),['/checkout/demo/datasources/DS/procedures/demo/save.gss']);assert.equal(f.calls[0].key,'projects.demo');f.nav.dispose();
});
test('API service component definitions verify the exact PAGE ID',async()=>{
  const f=fixture(),source='$vs.proc.runServiceComp("PG-COMP", $args)';const locations=await f.nav.definition(f.doc(source,'PG-COMP'),{});
  assert.deepEqual(locations.map(x=>x.uri.fsPath),['/checkout/demo/systems/S/pages/comp.gss']);f.nav.dispose();
});

test('definition navigation opens an inherited procedure through its editable virtual URI',async()=>{
  const f=fixture(),source='$vs.proc.invoke("demo.pkg", "save", $args)',virtual={scheme:'guthon-api-edit',path:'/save.gss'};let target;
  f.api.sourceUri=async(key,path)=>(target={key,path},virtual);
  const locations=await f.nav.definition(f.doc(source,'save'),{});assert.equal(locations[0].uri,virtual);
  assert.deepEqual(target,{key:'projects.demo',path:'datasources/DS/procedures/demo/save.gss'});f.nav.dispose();
});
