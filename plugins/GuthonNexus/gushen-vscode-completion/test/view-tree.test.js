const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const vm=require('node:vm');
const {ViewTree,contextCommands}=require('../src/view-tree');

test('source view reveal expands its original ancestors and dispatches context actions on the actual node',async()=>{
  const folder={label:'过程函数'},leaf={label:'fixture',key:'project-a',object:{path:'test.gss'}};
  const provider={
    getChildren:async node=>node===folder?[leaf]:node?[]:[folder],
    getParent:node=>node===leaf?folder:undefined,
    getTreeItem:node=>({label:node.label,collapsibleState:node===folder?1:0,contextValue:node===leaf?'guthonApi.procedure':undefined}),
  };
  const messages=[],calls=[];
  const disposable={dispose(){}};
  const vscode={window:{registerWebviewViewProvider:()=>disposable},commands:{executeCommand:async(...args)=>calls.push(args)}};
  const tree=new ViewTree({vscode,id:'gushenCompletion.sourceView',provider,title:'项目源码',
    extensionPath:path.resolve(__dirname,'..')});
  const webview={onDidReceiveMessage:()=>disposable,postMessage:async message=>messages.push(message)};
  const view={webview,onDidDispose(){},show:preserve=>calls.push(['show',preserve])};
  tree.resolveWebviewView(view);
  tree.title='项目源码 · 项目甲';
  assert.equal(view.description,'项目甲');
  await tree.receive({type:'ready'});
  assert.deepEqual(messages.at(-1).rows.map(row=>row.label),['过程函数']);
  await tree.reveal(leaf,{focus:true});
  const {generation,rows,reveal}=messages.at(-1);
  assert(!webview.html.includes('<header'));
  assert(!webview.html.includes('role="toolbar"'));
  assert.equal(rows[1].id,reveal);
  assert.equal(rows[1].parentId,rows[0].id);
  assert.equal(tree.selection[0],leaf);
  await tree.receive({type:'menu',generation,id:reveal});
  assert(messages.at(-1).items.some(item=>item.command==='gushenCompletion.showApiReferences'));
  await tree.receive({type:'context',generation,id:reveal,command:'gushenCompletion.showApiReferences'});
  await tree.receive({type:'context',generation,id:reveal,command:'gushenCompletion.deleteWorkspace'});
  assert.deepEqual(calls,[['show',false],['gushenCompletion.showApiReferences',leaf]]);
  await tree.collapseAll();
  assert.deepEqual(messages.at(-1).rows.map(row=>row.label),['过程函数']);
  await tree.reveal(leaf,{focus:false});
  assert.equal(tree.selection[0],leaf);
  tree.setScope('project-b');
  await tree.receive({type:'context',generation,id:reveal,command:'gushenCompletion.showApiReferences'});
  assert.equal(calls.length,3);
  tree.title='项目源码';
  assert.equal(view.description,undefined);
  tree.dispose();
});

test('context commands preserve the API layout condition and project capabilities',()=>{
  const vscode={workspace:{getConfiguration:()=>({get:()=> 'tree'})}};
  const source=contextCommands('gushenCompletion.sourceView','guthonApi.category.procedures',vscode).map(action=>action.command);
  assert(source.includes('gushenCompletion.showApiProcedureFlat'));
  assert(!source.includes('gushenCompletion.showApiProcedureTree'));
  const overview=contextCommands('gushenCompletion.projectOverview','guthonProject.project.svn',vscode).map(action=>action.command);
  assert.deepEqual(overview,[]);
  assert.deepEqual(contextCommands('gushenCompletion.projectOverview','guthonProject.project.api',vscode).map(action=>action.command),
    ['gushenCompletion.deleteWorkspace']);
});

test('the webview renders a distinct icon for each API source module separately from its expand arrow',()=>{
  const element=()=>({dataset:{},classList:{add(){}},style:{},children:[],hidden:true,
    setAttribute(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    querySelectorAll(){return [];},contains(){return false;}});
  const tree=element(),menu=element();
  const source=fs.readFileSync(path.join(__dirname,'../src/view-tree-webview.js'),'utf8');
  const context={acquireVsCodeApi:()=>({}),document:{getElementById:id=>id==='tree'?tree:menu,
    createElement:element,createDocumentFragment:element}};
  const icons=['layout','symbol-method','table','symbol-structure','code','settings-gear',
    'symbol-enum','list-selection','book','files'];
  vm.runInNewContext(source.slice(0,source.indexOf('function activate('))+'\nrender(message)',{...context,
    message:{rows:icons.map(id=>({id,icon:id,capable:true,depth:0})),generation:1}});
  const rendered=tree.children[0].children.map(row=>{
    assert.equal(row.children[0].textContent,'›');
    assert.notEqual(row.children[1].textContent,'▸');
    return row.children[1].textContent;
  });
  assert.equal(new Set(rendered).size,icons.length);
});

test('a single project action uses the menu layout without scrollbars',()=>{
  const toggles=[];
  const menu={classList:{toggle:(name,enabled)=>toggles.push([name,enabled])},style:{},
    offsetWidth:80,offsetHeight:32,replaceChildren(...items){this.firstElementChild=items[0];}};
  const document={getElementById:id=>id==='menu'?menu:{},
    createElement:()=>({setAttribute(){},addEventListener(){},focus(){}})};
  const dir=path.join(__dirname,'../src');
  const js=fs.readFileSync(path.join(dir,'view-tree-webview.js'),'utf8');
  vm.runInNewContext(js.slice(0,js.indexOf('function render('))+
    '\nshowMenu([{label:"删除工作区",command:"gushenCompletion.deleteWorkspace"}],90,50,"fixture");showMenu([],0,0,"legacy")',
    {document,innerWidth:100,innerHeight:60,acquireVsCodeApi:()=>({})});
  assert.deepEqual(toggles,[['single-item',true]]);
  assert.equal(menu.style.top,'28px');
  assert.equal(menu.hidden,true);
  assert.match(fs.readFileSync(path.join(dir,'view-tree.css'),'utf8'),
    /#menu\.single-item\{max-height:none;overflow:hidden\}/);
});
