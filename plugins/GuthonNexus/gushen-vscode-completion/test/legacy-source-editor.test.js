const assert=require('node:assert/strict');
const test=require('node:test');
const {SvnVirtualFileSystem}=require('../src/svn/virtual-fs');
const {SvnCatalogTreeProvider}=require('../src/svn/catalog-tree');
const {createDatabaseSourceTree}=require('../src/database-source-tree');

const disposable={dispose(){}};
const vscode={
  EventEmitter:class { event=()=>disposable; fire(){} dispose(){} },
  Uri:{from:fields=>({...fields,toString(){return JSON.stringify(fields);}})},
  TreeItem:class { constructor(label,collapsibleState){Object.assign(this,{label,collapsibleState});} },
  TreeItemCollapsibleState:{Collapsed:1,None:0},
  ThemeIcon:class { constructor(id,color){Object.assign(this,{id,color});} },
  ThemeColor:class { constructor(id){this.id=id;} },
  workspace:{textDocuments:[]},window:{},
};

test('SVN expands product code for an opaque workspace key without rewriting the project marker',async()=>{
  const calls=[],marker='@inherit();',body='return 1;';
  const fs=new SvnVirtualFileSystem({vscode,backend:{
    read:async()=>({editable:true,sourceNamespace:'svn:scope',sourceHash:'project',sourcePath:'run.gss',content:marker}),
    pageQuery:async(key,name,input)=>{
      calls.push([key,name,input]);
      return {project:{sourceHash:'project'},product:{sourceHash:'parent'},inheritanceStatus:'ACTIVE',complete:true,
        projectOriginal:{content:marker},productOriginal:{content:body},effective:{content:body},
        segments:[{layer:'project',sourceEnd:0},{layer:'product',start:0,end:body.length},
          {layer:'project',sourceStart:marker.length}]};
    },
  }});
  const uri=fs.uriFor({workspaceKey:'ws_opaque',sourceType:'procedure',sourceId:'PROC',funId:'run',workingCopyId:'root'});
  const result=await fs._load(uri);
  assert.equal(calls[0][0],'ws_opaque');
  assert.equal(calls[0][2].indexedSourceHash,'project');
  assert.equal(result.value.content,body);
  assert.equal(result.inheritance.marker,marker);
  fs.dispose();
});

test('SVN bill types expand directly into named datasource groups with naturally sorted code labels',async()=>{
  const objects=[
    {sourceType:'public',sourceName:'bill-types.json',sourceId:'root:bill-types',sourcePath:'public/bill-types.json',referenceCategory:'bill-type'},
    {sourceType:'procedure',sourceId:'P',treeScopeId:'D1',treePath:['国际贸易','package'],sourcePath:'datasources/D1/procedures/package/save.gss'},
  ];
  const provider=new SvnCatalogTreeProvider({vscode,listSvnWorkspaces:async()=>[{workspaceKey:'ws',displayName:'test'}],
    backend:{catalog:async()=>({objects}),fragments:async()=>({fragments:[
      {label:'后项',code:'B10',jsonPointer:'/comps/0',dataSourceId:'D1',scriptType:'json'},
      {label:'前项',code:'B2',jsonPointer:'/comps/1',dataSourceId:'D1',scriptType:'json'},
    ]})}});
  const [workspace]=await provider.getChildren();
  const category=(await provider.getChildren(workspace)).find(item=>item.category==='bill-type');
  const [group]=await provider.getChildren(category);
  assert.equal(group.label,'贸易系统');
  assert.equal(provider.getTreeItem(group).guthonCode,'D1');
  assert.deepEqual(group.children.map(item=>item.label),['前项','后项']);
  assert.equal(provider.getTreeItem(group.children[0]).guthonCode,'B2');
  assert.equal(group.children[0].command.arguments[0].sourcePath,'public/bill-types.json');
  provider.dispose();
});

test('legacy trees use the current project datasource ID and place unmapped subsystems last',async()=>{
  const navigationGroups={dataSourceIdsBySystem:{'sys-z':'0001','sys-a':'0007'}};
  const objects=['sys-a','sys-custom','sys-z'].map((id,index)=>({
    sourceType:'page',sourceId:`PAGE-${index}`,treeScopeId:id,treePath:[id],sourcePath:`systems/${id}/pages/x.json`,
  }));
  const provider=new SvnCatalogTreeProvider({vscode,listSvnWorkspaces:async()=>[{workspaceKey:'ws',displayName:'test'}],
    backend:{catalog:async()=>({objects,navigationGroups})}});
  const [svn]=await provider.getChildren();
  const [pages]=await provider.getChildren(svn);
  assert.deepEqual((await provider.getChildren(pages)).map(node=>node.code),['sys-z','sys-a','sys-custom']);
  provider.dispose();

  const db={workspaceKey:'ws-db',index:{ready:true}};
  const dbTree=createDatabaseSourceTree({vscode,getTool:()=>({toolHome:'/test'}),run:async(_ws,_command,args)=>
    args.length===1 ? {categories:['procedure'],exportIndexReady:true,navigationGroups} : {items:['0007','0001','0002'].map(id=>({
      sourceType:'procedure',sourceId:`FUNC-${id}`,scopeCode:id,groups:[id],sourcePath:`${id}/source.vm`,
    }))}});
  const [procedures]=await dbTree.children(db);
  assert.deepEqual((await dbTree.children(db,procedures)).map(node=>node.code),['0001','0002','0007']);
});
