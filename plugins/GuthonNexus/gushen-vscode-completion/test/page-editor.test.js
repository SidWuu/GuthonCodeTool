const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {PageDraft} = require('../src/page-editor/model');
const {nativeChanges, projectNative} = require('../src/page-editor/native-model');
const {verifyAssets, instrument, nativeHtml} = require('../src/page-editor/platform-assets');
const {PageEditorController} = require('../src/page-editor/controller');
const {SvnVirtualFileSystem, fragmentIdentity, documentFilename} = require('../src/svn/virtual-fs');
const source = {pageId:'PG-1', views:[{id:'view',type:'input-box', fields:[
  {fieldId:'A',type:'text',label:'A',width:1,pageEvents:{onChangeScript:'old();'}},
  {fieldId:'B',type:'text',label:'B',width:2}],datasource:{sql:'select 1'}}],opaque:'keep'};
function model() {return {pageId:'PG-1', collections:[{pointer:'/views/0/fields',label:'form',region:'FORM',reorderable:true,fields:source.views[0].fields.map((f,i)=>
  ({key:'fieldId:'+f.fieldId,pointer:'/views/0/fields/'+i,label:f.label,type:f.type,editable:true,properties:[{name:'label',value:f.label},{name:'width',value:f.width}]}))}],
  nodes:[{key:'A-event',pointer:'/views/0/fields/0/pageEvents/onChangeScript',content:'old();',type:'SCRIPT',editable:true},
    {key:'sql',pointer:'/views/0/datasource/sql',content:'select 1',type:'SQL',editable:true}]};}
const clone = value => JSON.parse(JSON.stringify(value));
const recoveryRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(),'page-recovery-tests-'));
test.after(()=>fs.rm(recoveryRoot,{recursive:true,force:true}));

test('one draft combines properties, code and order; undo/redo and recovery remain coherent',()=>{
  const draft=new PageDraft(model());
  draft.property('/views/0/fields','fieldId:A','label','中文'); draft.text('sql','select 2');
  draft.order('/views/0/fields',['fieldId:B','fieldId:A']);
  assert.equal(draft.operations().length,3);draft.undo();assert.equal(draft.operations().length,2);
  draft.redo();const recovered=new PageDraft(model());recovered.restore(draft.operations());
  assert.deepEqual(recovered.model,draft.model);assert.equal(draft.version,5);
  assert.throws(()=>draft.order('/views/0/fields',['fieldId:A','fieldId:A']),/拖拽/);
  assert.equal(draft.operations().length,3);
});
test('native normalization ignores untouched defaults, preserves code mapping across reorder, rejects unsupported edits atomically',()=>{
  const draft=new PageDraft(model()), snapshot={model:model(),sourceText:JSON.stringify(source)};
  draft.order('/views/0/fields',['fieldId:B','fieldId:A']);draft.text('A-event','draft();');
  const projection=projectNative(snapshot,draft);
  assert.equal(projection.data.views[0].fields[1].pageEvents.onChangeScript,'draft();');
  assert.equal(projection.model.nodes[0].pointer,'/views/0/fields/1/pageEvents/onChangeScript');
  const baseline=clone(projection.data);baseline.views[0].fields[0].platformDefault=true;
  assert.deepEqual(nativeChanges(baseline,clone(baseline),projection.model),[]);
  const changed=clone(baseline);changed.views[0].fields[1].label='native';changed.views[0].datasource.sql='select 3';
  assert.equal(nativeChanges(baseline,changed,projection.model).length,2);
  changed.opaque='changed';assert.throws(()=>nativeChanges(baseline,changed,projection.model),/超出/);
  const version=draft.version,old=clone(draft.model);
  assert.throws(()=>draft.batch(()=>{draft.text('sql','bad');draft.text('missing','bad');}));
  assert.equal(draft.version,version);assert.deepEqual(draft.model,old);
});
test('native field moves become order operations and retain event targeting',()=>{
  const data=clone(source);data.views[0].fields.reverse();data.views[0].fields[1].pageEvents.onChangeScript='next();';
  const changes=nativeChanges(source,data,model());
  assert.deepEqual(changes.find(op=>op.kind==='order').fieldKeys,['fieldId:B','fieldId:A']);
  assert.equal(changes.find(op=>op.kind==='text').key,'A-event');
  data.views[0].fields.pop();assert.throws(()=>nativeChanges(source,data,model()),/增删/);
});
test('collection order is independent of unknown-control property editing and preserves its payload',()=>{
  const data=clone(source), description=model(); description.pageName='测试主页面';
  data.views[0].fields[1].type='custom-search';data.views[0].fields[1].custom={opaque:'keep'};
  description.collections[0].fields[1].editable=false;
  const draft=new PageDraft(description);
  assert.throws(()=>draft.property('/views/0/fields','fieldId:B','label','bad'),/不可编辑/);
  draft.order('/views/0/fields',['fieldId:B','fieldId:A']);
  const projected=projectNative({model:description,sourceText:JSON.stringify(data)},draft);
  assert.deepEqual(projected.data.views[0].fields[0],data.views[0].fields[1]);
  assert.equal(projected.model.pageName,'测试主页面');
  assert.equal(projected.model.nodes[0].pointer,'/views/0/fields/1/pageEvents/onChangeScript');
  assert.equal(nativeChanges(data,projected.data,description)[0].kind,'order');
});
async function assetsFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-assets-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app='n.p="/guthon/";v.a.prototype.$api=a,v.a.prototype.$config=c,v.a.prototype.$gScript=s;var root=new v.a({});';
  const files={'guthon/js/app.abc123.js':app,'guthon/index.html':'<script src="/guthon/js/app.abc123.js"></script>',
    'guthon/editor.worker.js':'self.onmessage=()=>{}','guthon/ts.worker.js':'self.onmessage=()=>{}'};
  const manifest={files:[]};
  for(const [name,text] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),text);manifest.files.push({path:name,bytes:Buffer.byteLength(text),sha256:crypto.createHash('sha256').update(text).digest('hex')});}
  await fs.writeFile(path.join(root,'snapshot.json'),JSON.stringify(manifest));return {root,manifest,app};
}
test('asset loader verifies every file and rejects traversal, duplicates, symlinks, hash mismatch and startup incompatibility',async t=>{
  const f=await assetsFixture(t),assets=await verifyAssets(f.root);assert.equal(assets.names.size,4);
  assert.match(instrument(f.app,'local/'),/GuthonOfflineDesigner/);assert.throws(()=>instrument('broken','local/'),/不兼容/);
  const fake={cspSource:'http://127.0.0.1',asWebviewUri:uri=>({toString:()=>uri.fsPath})},vscode={Uri:{file:fsPath=>({fsPath})}};
  const html=await nativeHtml(assets,fake,vscode,'/extension','nonce');assert.match(html,/connect-src 'none'/);assert.match(html,/worker-src blob:/);
  await fs.appendFile(path.join(f.root,'guthon/editor.worker.js'),'tamper');await assert.rejects(verifyAssets(f.root),/大小|哈希/);
  for(const extra of [{...f.manifest.files[0],path:'guthon/../escape'},f.manifest.files[0]]) {
    await fs.writeFile(path.join(f.root,'snapshot.json'),JSON.stringify({files:[f.manifest.files[0],extra]}));
    await assert.rejects(verifyAssets(f.root),/清单/);
  }
  if(process.platform!=='win32') {
    await fs.writeFile(path.join(f.root,'snapshot.json'),JSON.stringify(f.manifest));
    await fs.unlink(path.join(f.root,'guthon/editor.worker.js'));
    await fs.symlink('ts.worker.js',path.join(f.root,'guthon/editor.worker.js'));
    await assert.rejects(verifyAssets(f.root),/符号链接/);
  }
});
function hostFixture() {
  const panels=[],store=new Map(),calls=[],documents=[];
  class Emitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  const uri=value=>({...value,toString(){return `${this.scheme}://${this.authority}${this.path}?${this.query||''}`;}});
  const vscode={EventEmitter:Emitter,Uri:{from:uri,file:fsPath=>({fsPath})},ViewColumn:{Active:1,Beside:2},
    FileType:{File:1},FilePermission:{Readonly:1},FileSystemError:{FileNotFound:()=>new Error('missing'),NoPermissions:()=>new Error('readonly')},
    WorkspaceEdit:class {replace(){}},Range:class {},commands:{async executeCommand(){}},
    workspace:{textDocuments:documents,registerFileSystemProvider(){return {dispose(){}};},onDidChangeTextDocument(){return {dispose(){}};},async applyEdit(){return true;}},
    window:{async showErrorMessage(){},createWebviewPanel(){const receiver=new (require('../src/page-editor/state').PageStateReceiver)();
      const panel={title:'',webview:{cspSource:'local:',asWebviewUri:()=>({toString:()=> 'local:file'}),async postMessage(message){ panel.wire=clone(message);
        panel.latest=message.type==='state' ? receiver.receive(clone(message))?.state : message;
      },onDidReceiveMessage(fn){panel.receive=fn;}},reveal(){},onDidDispose(fn){panel.closed=fn;},dispose(){panel.closed?.();}};panels.push(panel);return panel;}}};
  const identity={workspaceKey:'products.demo',sourceNamespace:'pages-A',sourceId:'PG-1',sourceType:'page'};
  const snapshot={...identity,workingCopyId:'wc',sourceHash:'a'.repeat(64),editToken:'token',editable:true,model:model(),sourceText:JSON.stringify(source)};
  const backend={async run(key,args,payload){calls.push({key,args,payload});if(payload.action==='open')return clone(snapshot);
    if(payload.action==='comparison') return {available:true,sourceHash:snapshot.sourceHash,baseRevision:'1',changes:{rows:[],paths:[],total:0}};
    if(payload.action==='preview')return {candidateSourceHash:'b'.repeat(64)};
    if(payload.action==='save') {
      const draft=new PageDraft(snapshot.model);draft.restore(payload.operations);
      const projected=projectNative(snapshot,draft);snapshot.model=projected.model;snapshot.sourceText=JSON.stringify(projected.data);
      snapshot.sourceHash='b'.repeat(64);
    }
    return {operationId:'op',localVerificationComplete:true,currentSourceMatches:true,currentIndexMatches:true,currentDiffMatches:true,state:'DIFF_VERIFIED'};}};
  const context={extensionPath:'/extension',storageUri:{fsPath:recoveryRoot},workspaceState:{get:key=>store.get(key),async update(key,value){store.set(key,value);}}};
  return {vscode,context,backend,identity,snapshot,panels,store,calls,documents,resources:{cached:async()=>null,resolve:async()=>null}};
}

test('preview title derives the real PAGE name when an older backend model omits it',async()=>{
  const f=hostFixture();f.snapshot.sourceText=JSON.stringify({...source,pageName:'开票申请编辑'});
  const host=new PageEditorController(f),session=await host.open(f.identity);
  await host.message(session,{type:'ready'});
  assert.match(session.panel.title,/开票申请编辑.*PG-1/);
  assert.equal(session.draft.model.pageName,'开票申请编辑');
  const other=hostFixture();other.identity.sourceName='来源页面名称';
  assert.equal((await new PageEditorController(other).open(other.identity)).draft.model.pageName,'来源页面名称');
});

test('PAGE ID placeholders cannot hide the authoritative catalog name in preview and shared code titles',async()=>{
  const f=hostFixture();f.identity.sourceName=f.snapshot.sourceName=f.snapshot.model.pageName=f.identity.sourceId;
  f.identity.treeLabel='目录中的页面名称';
  f.snapshot.sourceText=JSON.stringify({...source,pageName:f.identity.sourceId});
  const host=new PageEditorController(f),session=await host.open(f.identity);await host.message(session,{type:'ready'});
  assert.equal(session.panel.title,'目录中的页面名称 · PG-1 · 本地页面');
  assert.equal(session.draft.model.pageName,'目录中的页面名称');
  const opened=[];f.backend.fragments=async()=>({fragments:[{jsonPointer:model().nodes[0].pointer,scriptType:'js',label:'form / A / onChangeScript'}]});
  host.virtualFs={async open(identity){opened.push(identity);return f.vscode.Uri.from({scheme:'guthon-svn-edit',authority:'products.demo',path:'/event.js'});}};
  await host.message(session,{type:'openCode',version:session.draft.version,key:'A-event'});
  assert.equal(documentFilename(opened[0]),'目录中的页面名称 · form · A · onChangeScript.js');
  assert.equal(opened[0].documentName,fragmentIdentity('products.demo',f.identity,
    {label:'form / A / onChangeScript'}).documentName);
  assert.equal(JSON.parse(session.snapshot.sourceText).pageName,'PG-1');
});

test('missing names show the PAGE ID once and reopening with fresh catalog metadata preserves the draft',async()=>{
  const f=hostFixture();f.identity.sourceName=f.snapshot.model.pageName=f.identity.sourceId;
  f.snapshot.sourceText=JSON.stringify({...source,pageName:f.identity.sourceId});
  const host=new PageEditorController(f),session=await host.open(f.identity);await host.message(session,{type:'ready'});
  assert.equal(session.panel.title,'PG-1 · 本地页面');
  session.draft.property('/views/0/fields','fieldId:A','label','尚未保存');
  assert.equal(await host.open({...f.identity,treeLabel:'目录已更新'}),session);
  assert.equal(session.draft.model.pageName,'目录已更新');assert.equal(session.draft.baseline.pageName,'目录已更新');
  assert.equal(session.draft.operations()[0].value,'尚未保存');assert.match(session.panel.title,/目录已更新 · PG-1/);
});

test('refreshing a catalog name changes native titles without reloading an unconfirmed designer dialog',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity),messages=[];
  const version=session.draft.version;
  session.native={version,unconfirmed:true,panel:{reveal(){},webview:{postMessage(message){messages.push(message);}}}};
  await host.open({...f.identity,treeLabel:'目录中的名称'});
  assert.equal(session.native.version,version);assert.equal(session.native.unconfirmed,true);
  assert.deepEqual(messages,[{type:'nativeTitle',pageName:'目录中的名称',pageId:'PG-1'}]);
  assert.equal(session.native.panel.title,'目录中的名称 · PG-1 · 原版设计视图');
});

test('preview and source tree share the same readable URI, inheritance expansion and save path',async()=>{
  const f=hostFixture(),prefix='before();\n',marker='inherit();',suffix='\nafter();',product='product();';
  const physical=prefix+marker+suffix,effective=prefix+product+suffix;
  f.identity.workspaceKey=f.snapshot.workspaceKey='projects.demo';
  f.identity.sourceName='测试页面';f.snapshot.sourcePath='pages/PG-1.json';
  f.snapshot.model.nodes[0].content=physical;f.snapshot.model.nodes[0].editable=false;
  const data=clone(source);data.views[0].fields[0].pageEvents.onChangeScript=physical;f.snapshot.sourceText=JSON.stringify(data);
  const fragment={jsonPointer:model().nodes[0].pointer,scriptType:'js',label:'form / A / onChangeScript'},writes=[],shown=[];
  f.backend.fragments=async()=>({sourcePath:f.snapshot.sourcePath,fragments:[fragment]});
  f.backend.read=async()=>({editable:true,sessionId:'common-session',documentId:'common-document',sourcePath:f.snapshot.sourcePath,
    sourceNamespace:f.identity.sourceNamespace,content:f.snapshot.model.nodes[0].content});
  f.backend.pageQuery=async(_key,name)=>{
    assert.equal(name,'read_inherited_source');return {inheritanceStatus:'ACTIVE',indexGeneration:'gen',
      project:{sourceHash:'project-hash'},product:{sourceHash:'product-hash'},segments:[
        {layer:'project',start:0,end:prefix.length,sourceStart:0,sourceEnd:prefix.length},
        {layer:'product',start:prefix.length,end:prefix.length+product.length,sourceStart:0,sourceEnd:product.length},
        {layer:'project',start:prefix.length+product.length,end:effective.length,sourceStart:prefix.length+marker.length,sourceEnd:physical.length}],
      effective:{content:effective},projectOriginal:{content:physical},productOriginal:{content:product},complete:true};};
  f.backend.write=async(...args)=>{
    writes.push(args);f.snapshot.model.nodes[0].content=args[3];
    const data=JSON.parse(f.snapshot.sourceText);data.views[0].fields[0].pageEvents.onChangeScript=args[3];
    f.snapshot.sourceText=JSON.stringify(data);f.snapshot.sourceHash='c'.repeat(64);
    return {written:true,sourceHash:f.snapshot.sourceHash};};
  f.vscode.workspace.openTextDocument=async uri=>{
    const existing=f.documents.find(doc=>doc.uri.toString()===uri.toString());if(existing)return existing;
    const content=(await f.virtualFs.readFile(uri)).toString();const doc={uri,isDirty:false,getText:()=>content};f.documents.push(doc);return doc;};
  f.vscode.window.showTextDocument=async(doc,options)=>{shown.push({doc,options});return {document:doc};};
  f.virtualFs=new SvnVirtualFileSystem({...f,onSaved:async(_key,_result,uri)=>host.codeSaved(uri)});
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','未保存的字段名称');
  await host.message(session,{type:'openCode',version:session.draft.version,key:'A-event'});
  assert.equal(shown[0].doc.getText(),effective);
  assert.equal(shown[0].doc.uri.scheme,'guthon-svn-edit');
  assert.equal(shown[0].options.viewColumn,f.vscode.ViewColumn.Beside);
  assert.equal(shown[0].doc.uri.path.split('/').at(-1),'测试页面 · form · A · onChangeScript.js');
  const treeIdentity=fragmentIdentity(f.identity.workspaceKey,{...f.identity,sourcePath:f.snapshot.sourcePath,workingCopyId:'wc'},fragment);
  assert.equal(f.virtualFs.uriFor(treeIdentity).toString(),shown[0].doc.uri.toString());
  assert.equal(documentFilename(treeIdentity),'测试页面 · form · A · onChangeScript.js');
  await f.virtualFs.writeFile(shown[0].doc.uri,Buffer.from(effective+'\ncustom();'),{});
  assert.equal(writes[0][1],'common-session');assert.equal(writes[0][3],physical+'\ncustom();');
  assert.equal(session.blocked,'');assert.equal(session.snapshot.sourceHash,'c'.repeat(64));
  assert.equal(session.draft.operations().length,1);
  assert.equal(session.draft.operations()[0].value,'未保存的字段名称');
  f.virtualFs.dispose();host.dispose();
});

test('code save rebases matching native code drafts and preserves conflicts for comparison',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.text('A-event','local();');
  const uri=f.vscode.Uri.from({scheme:'guthon-svn-edit',authority:'products.demo',path:'/event.js',
    query:new URLSearchParams({sourceType:'page',sourceId:'PG-1',workingCopyId:'wc'}).toString()});
  f.snapshot.model.nodes[0].content='local();';await host.codeSaved(uri);
  assert.equal(session.draft.operations().length,0);
  session.draft.text('A-event','native();');f.snapshot.model.nodes[0].content='editor();';
  await host.codeSaved(uri);assert.equal(session.sourceStale,true);assert.equal(session.sourceMerge.evidence.conflicts[0].local,'native();');
  assert.equal(session.draft.model.nodes[0].content,'native();');
});

test('saving a layout order closes only this PAGE clean positional code tabs and never overwrites dirty code',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity),closed=[];
  const uri=f.vscode.Uri.from({scheme:'guthon-svn-edit',authority:'products.demo',path:'/event.js',
    query:new URLSearchParams({sourceType:'page',sourceId:'PG-1',workingCopyId:'wc'}).toString()});
  const tab={input:{uri}},other={input:{uri:{...uri,authority:'projects.other'}}};
  f.vscode.window.tabGroups={all:[{tabs:[tab,other]}],async close(tabs){closed.push(...tabs);return true;}};
  const doc={uri,isDirty:true};f.documents.push(doc);
  session.draft.order('/views/0/fields',['fieldId:B','fieldId:A']);
  await assert.rejects(host.save(session),/请先保存代码/);assert.equal(closed.length,0);
  doc.isDirty=false;await host.save(session);assert.deepEqual(closed,[tab]);
  session.native={unconfirmed:true};assert.throws(()=>host.beforeCodeSave(uri),/对话框/);
  delete session.native;session.busy=true;assert.throws(()=>host.beforeCodeSave(uri),/保存检查/);
});
test('controller owns one PAGE and saves a mixed draft through preflight and existing backend without a platform commit',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  await host.open(f.identity);assert.equal(f.panels.length,1);
  session.draft.text('sql','select 2');session.draft.order('/views/0/fields',['fieldId:B','fieldId:A']);
  await host.save(session);
  assert.deepEqual(f.calls.map(call=>call.payload.action),['open','comparison','preview','save','open','comparison']);
  assert.ok(f.calls.every(call=>call.args[0]==='page-editor'));assert.equal(session.pending,null);
  assert.equal(session.draft.model.nodes.find(n=>n.key==='sql').content,'select 2');
  assert.equal(session.draft.model.collections[0].fields[0].key,'fieldId:B');
});
test('closing and concurrent reopening reuse the same draft and reload archives old inputs',async()=>{
  const f=hostFixture(),host=new PageEditorController(f);
  const [a,b]=await Promise.all([host.open(f.identity),host.open(f.identity)]);
  assert.equal(a,b);assert.equal(f.panels.length,1);
  a.draft.text('sql','unsaved');f.panels[0].dispose();
  assert.equal(await host.open(f.identity),a);assert.equal(a.draft.operations().length,1);
  await host.message(a,{type:'reload'});
  assert.equal(a.draft.operations().length,0);assert.equal(a.recovery.operations[0].content,'unsaved');
  assert.ok([...f.store.values()][0].recovery);
});
test('failed or unknown save result retains original idempotency request and blocks source replay',async()=>{
  const f=hostFixture(),original=f.backend.run;
  f.backend.run=async(key,args,payload)=>{if(payload.action==='save')throw new Error('response lost');return original(key,args,payload);};
  const host=new PageEditorController(f),session=await host.open(f.identity);session.draft.text('sql','select 2');
  await assert.rejects(host.save(session),/response lost/);assert.ok(session.pending.idempotencyKey);
  assert.equal(session.draft.operations().length,1);assert.match(session.blocked,/待核对/);
  await assert.rejects(host.save(session),/待核对/);assert.equal(f.calls.filter(call=>call.payload.action==='preview').length,1);
  assert.ok([...f.store.values()][0].pending);
});
test('old-baseline recovery never applies to a newer source and stale UI messages cannot mutate',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),first=await host.open(f.identity);
  await f.context.workspaceState.update(first.storageKey,{sourceHash:'old',operations:[{kind:'text',jsonPointer:'/views/0/datasource/sql',content:'old edit'}]});
  const secondHost=new PageEditorController(f),session=await secondHost.open(f.identity);
  assert.equal(session.draft.operations().length,0);assert.ok(session.recovery);
  await assert.rejects(secondHost.message(session,{type:'property',version:77}),/版本/);
});

test('configured PAGE defaults to the local manager; explicit native view compares a read-only saved baseline', async t => {
  const assets = await assetsFixture(t), f = hostFixture();
  const verified=await verifyAssets(assets.root);
  let resourceReads=0;
  f.resources={cached:async()=>{resourceReads++;return {};},resolve:async()=>{resourceReads++;return {assets:verified,app:verified.app,digest:verified.digest,build:'a'.repeat(64),platformUrl:'http://example.invalid/guthon/index.html',message:'cached'};}};
  const host = new PageEditorController(f), session = await host.open(f.identity);
  assert.equal(f.panels.length,1);assert.equal(resourceReads,0);assert.equal(session.native,undefined);
  await host.message(session,{type:'native',version:session.draft.version});
  assert.equal(f.panels.length, 2);
  assert.equal(session.native.panel, f.panels[1]);
  assert.match(session.native.panel.webview.html, /native-stage/);
  assert.equal(session.native.assets.app, 'guthon/js/app.abc123.js');
  let revealedNative=0,revealedManager=0;
  session.native.panel.reveal=()=>revealedNative++;session.panel.reveal=()=>revealedManager++;
  assert.equal(await host.open(f.identity),session);
  assert.equal(revealedManager,1);assert.equal(revealedNative,0);assert.equal(f.panels.length,2);
  session.draft.property('/views/0/fields', 'fieldId:A', 'label', 'changed'); host.publish(session);
  assert.equal(session.native.panel.latest.data.views[0].fields[0].label, 'changed');
  const version = session.draft.version;
  session.native.panel.receive({type: 'nativeCompare', version});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.native.panel.latest.data.views[0].fields[0].label, 'A');
  assert.equal(session.native.panel.latest.before, true);
  assert.equal(session.native.panel.latest.editable, false);
  assert.equal(session.draft.operations().length, 1);
  session.native.panel.receive({type: 'nativeCompare', version});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.native.panel.latest.data.views[0].fields[0].label, 'changed');
  assert.equal(session.native.panel.latest.editable, true);
});

test('manager groups platform and local actions without a duplicate designer card', () => {
  const f = hostFixture(), host = new PageEditorController(f);
  const html = host.html({cspSource:'local:',asWebviewUri:()=>({toString:()=> 'local:file'})});
  assert.match(html, /字段与代码管理/);
  assert.equal(html.includes('id="preview"'), false);
  const source = require('node:fs').readFileSync(path.join(__dirname, '../src/page-editor/editor.js'), 'utf8');
  assert.equal(source.includes('width * 170'), false);
  assert.equal(source.includes("el('input'); input.placeholder"), false);
  assert.match(html, /aria-label="谷神平台与设计器"/);
  assert.match(html, /aria-label="本地编辑"/);
  assert.equal(source.includes('用谷神原版界面查看布局'),false);
  assert.equal(source.includes("['字段', '控件类型', '宽度', '显示']"),false);
});

test('manager and original designer tab titles include the PAGE name and ID',async()=>{
  const f=hostFixture(),run=f.backend.run;
  f.backend.run=async(...args)=>{const result=await run(...args);if(result.model)result.model.pageName='测试主页面';return result;};
  const host=new PageEditorController(f),session=await host.open(f.identity);
  await host.message(session,{type:'ready'});
  assert.equal(session.panel.title,'测试主页面 · PG-1 · 本地页面');
  session.native={panel:{webview:{postMessage(){}}},version:session.draft.version};
  host.publish(session);assert.equal(session.native.panel.title,'测试主页面 · PG-1 · 原版设计视图');
});

test('resource preparation downloads only explicit same-origin static assets, verifies and refuses overwrite', async t => {
  const http = require('node:http');
  const {download} = await import('../../../../scripts/prepare_page_designer.mjs');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'designer-download-'));
  t.after(() => fs.rm(parent, {recursive:true,force:true}));
  const app = 'n.p="/guthon/";v.a.prototype.$api=a,v.a.prototype.$config=c,v.a.prototype.$gScript=s;var root=new v.a({});';
  const requested = [];
  const resources = {
    '/guthon/index.html': '<script src="/guthon/js/app.abc123.js"></script><link href="/guthon/css/app.css" rel="stylesheet"><img src="https://elsewhere.invalid/foreign.png">',
    '/guthon/js/app.abc123.js': app, '/guthon/editor.worker.js':'worker', '/guthon/ts.worker.js':'worker',
    '/guthon/css/app.css':'@font-face{src:url(../fonts/font.woff)}', '/guthon/fonts/font.woff':'font',
  };
  const server = http.createServer((req,res) => {
    requested.push(req.url);
    const body = resources[req.url];res.writeHead(body === undefined ? 404 : 200);res.end(body || 'missing');
  });
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/guthon/index.html#/gdpaas/dev/modules`;
  const output = path.join(parent, 'snapshot');
  const result = await download(url, output);
  assert.equal(result.files, 6);assert.equal(result.ok, true);
  assert.ok(requested.every(name=>name.startsWith('/guthon/')));
  assert.ok(requested.includes('/guthon/fonts/font.woff'));
  await assert.rejects(download(url, output), /exist/i);
  await assert.rejects(download('http://user:password@example.com/guthon/index.html', path.join(parent,'unsafe')), /凭据/);
});

test('resource UI connects only the selected workspace and preserves the current draft', async t => {
  const f=hostFixture(),bundle=await assetsFixture(t),assets=await verifyAssets(bundle.root),actions=[];
  f.resources={cached:async()=>null,resolve:async()=>null,async connect(key,url){actions.push({key,url});return {
    assets,platformUrl:url,app:assets.app,digest:assets.digest,build:'a'.repeat(64),message:'ready'};}};
  f.vscode.ProgressLocation={Notification:1};
  f.vscode.window.withProgress=async(_,action)=>action();
  f.vscode.window.showQuickPick=async choices=>choices.find(item=>item.action==='connect');
  f.vscode.window.showInputBox=async()=> 'http://example.invalid/guthon/index.html';
  f.vscode.workspace.getConfiguration=()=>{throw Error('Global directory must not be used');};
  const controller=new PageEditorController(f),session=await controller.open(f.identity);
  session.draft.text('sql','select 2');
  await controller.message(session,{type:'manageResources'});
  assert.deepEqual(actions,[{key:'products.demo',url:'http://example.invalid/guthon/index.html'}]);
  assert.equal(session.draft.operations()[0].content,'select 2');
  assert.ok(session.native);
  session.native.unconfirmed=true;
  await assert.rejects(controller.message(session,{type:'manageResources'}),/对话框/);
  assert.equal(actions.length,1);
});

test('resource prompts and native view clicks share one workspace task through completion with progress output',async t=>{
  const f=hostFixture(),bundle=await assetsFixture(t),assets=await verifyAssets(bundle.root),logs=[],reports=[],notices=[];
  let release,started,connects=0,picks=0,inputs=0;
  const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  f.resources={cached:async()=>null,resolve:async()=>null,async connect(_key,url,{onProgress}){
    connects++;onProgress('正在下载 guthon/js/app.abc123.js');started();await gate;
    onProgress('资源已校验');return {assets,platformUrl:url,app:assets.app,digest:assets.digest,build:'a'.repeat(64)};
  }};
  f.onResourceOutput=(key,message)=>logs.push({key,message});f.vscode.ProgressLocation={Notification:1};
  f.vscode.window.withProgress=async(_options,action)=>action({report:value=>reports.push(value.message)});
  f.vscode.window.showQuickPick=async choices=>{picks++;return choices.find(item=>item.action==='connect');};
  f.vscode.window.showInputBox=async options=>{inputs++;assert.match(options.prompt,/不读取浏览器登录态/);return 'http://example.invalid/guthon/index.html';};
  f.vscode.window.showInformationMessage=message=>{notices.push(message);return new Promise(()=>{});};
  const host=new PageEditorController(f),session=await host.open(f.identity);
  const first=host.message(session,{type:'manageResources'});await entered;
  assert.equal(session.panel.latest.resourceBusy,true);
  const duplicate=host.message(session,{type:'manageResources'}),native=host.message(session,{type:'native',version:session.draft.version});
  const sibling=await host.open({...f.identity,sourceId:'PG-2'});
  const otherPage=host.message(sibling,{type:'manageResources'});
  assert.equal(inputs,1);assert.equal(picks,1);assert.equal(connects,1);
  release();await Promise.all([first,duplicate,native,otherPage]);
  assert.equal(session.panel.latest.resourceBusy,false);assert.equal(sibling.panel.latest.resourceBusy,false);
  assert.equal(f.panels.length,3);assert.equal(notices.length,1);
  assert.ok(logs.some(item=>/正在下载/.test(item.message)));assert.ok(reports.some(message=>/资源准备完成/.test(message)));
  assert.match(session.panel.latest.status,/资源准备完成/);assert.equal(host.resourceJobs.size,0);
});

test('failed resource tasks release the UI guard and a retry prompts once again',async()=>{
  const f=hostFixture(),logs=[];let inputs=0;
  f.onResourceOutput=(_key,message)=>logs.push(message);f.vscode.ProgressLocation={Notification:1};
  f.vscode.window.withProgress=async(_options,action)=>action({report(){}});
  f.vscode.window.showQuickPick=async choices=>choices.find(item=>item.action==='connect');
  f.vscode.window.showInputBox=async()=>{inputs++;return 'http://example.invalid/guthon/index.html';};
  f.resources.connect=async()=>{throw new Error('网络不可达');};
  const host=new PageEditorController(f),session=await host.open(f.identity);
  for (let i=0;i<2;i++) await assert.rejects(host.message(session,{type:'manageResources'}),/网络不可达/);
  assert.equal(inputs,2);assert.equal(session.panel.latest.resourceBusy,false);
  assert.equal(host.resourceJobs.size,0);assert.equal(logs.filter(message=>/资源操作失败/.test(message)).length,2);
});

test('draft comparison excludes saved SVN changes and keeps labels, order and event pointers stable',()=>{
  const {draftChanges}=require('../src/page-editor/comparison');
  const draft=new PageDraft(model());
  assert.equal(draftChanges(draft).total,0);
  draft.property('/views/0/fields','fieldId:A','label','窗口草稿');
  draft.order('/views/0/fields',['fieldId:B','fieldId:A']);
  draft.text('A-event','draft();');
  const diff=draftChanges(draft);
  assert.equal(diff.total,3);
  assert.equal(diff.rows[0].beforeText,'"A"');
  assert.equal(diff.rows[0].afterText,'"窗口草稿"');
  assert.equal(diff.rows[2].pointer,'/views/0/fields/0/pageEvents/onChangeScript');
  assert.deepEqual(diff.rows[1].afterText,JSON.stringify(['B','窗口草稿'],null,2));
  const saved=new PageDraft(draft.model);
  assert.equal(draftChanges(saved).total,0);
});

test('SVN comparison is refreshed independently of the preserved window draft',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','草稿');
  const oldOperations=session.draft.operations();
  await host.message(session,{type:'compare',version:session.draft.version});
  assert.deepEqual(session.draft.operations(),oldOperations);
  assert.equal(session.panel.latest.comparison.local.total,1);
  assert.equal(session.panel.latest.comparison.svn.sourceHash,f.snapshot.sourceHash);
  const savedVersion=session.draft.version;
  f.backend.run=async()=>{throw new Error('SVN BASE unavailable');};
  await host.message(session,{type:'compare',version:savedVersion});
  assert.equal(session.panel.latest.comparison.svn.available,false);
  assert.match(session.panel.latest.comparison.svn.message,/unavailable/);
  assert.equal(session.draft.version,savedVersion);
});

test('external source refresh loads a clean page and preserves a dirty page as a stale baseline',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  f.snapshot.model.collections[0].fields[0].properties[0].value='外部修改';f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.draft.baseline.collections[0].fields[0].properties[0].value,'外部修改');
  assert.equal(session.draft.operations().length,0);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口修改');
  f.snapshot.model.collections[0].fields[0].properties[0].value='再次外部修改';
  f.snapshot.sourceHash='d'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.sourceStale,true);
  assert.equal(session.panel.latest.editable,false);
  assert.equal(session.draft.operations()[0].value,'窗口修改');
  assert.equal(session.snapshot.sourceHash,'c'.repeat(64));
  await assert.rejects(host.save(session),/外部更新/);
  await host.message(session,{type:'reload',version:session.draft.version});
  assert.equal(session.sourceStale,false);
  assert.equal(session.draft.operations().length,0);
  assert.equal(session.recovery.operations[0].value,'窗口修改');
});

test('SCM status refresh updates a committed SVN baseline without clearing local draft differences',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','草稿');
  session.svnComparison={available:true,sourceHash:f.snapshot.sourceHash,baseRevision:'1',changes:{rows:[{}],paths:['/views/0/fields/0/label'],total:1}};
  await host.statusChanged(f.identity.workspaceKey);
  assert.equal(session.panel.latest.comparison.svn.changes.total,0);
  assert.equal(session.panel.latest.comparison.local.total,1);
  assert.equal(session.draft.operations()[0].value,'草稿');
});

test('concurrent comparison reads share one request for the same page snapshot',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  let release,reads=0;
  f.backend.run=async()=>{reads++;return new Promise(resolve=>{release=resolve;});};
  const pending=Array.from({length:8},()=>host.refreshComparison(session));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);
  release({available:true,sourceHash:session.snapshot.sourceHash,baseRevision:'2',changes:{total:0}});
  await Promise.all(pending);
  assert.equal(session.svnComparison.baseRevision,'2');
  assert.equal(session.comparisonRequest,undefined);
});

test('bursts of SCM notifications share one comparison refresh',async()=>{
  const f=hostFixture(),host=new PageEditorController(f);
  await host.open(f.identity);f.calls.length=0;
  await Promise.all(Array.from({length:8},()=>host.statusChanged(f.identity.workspaceKey)));
  assert.equal(f.calls.filter(call=>call.payload.action==='comparison').length,1);
  assert.equal(host.comparisonRefreshes.size,0);
});

test('a commit during a comparison read schedules a trailing read of the new BASE',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  let started,release,reads=0;
  const firstRead=new Promise(resolve=>{started=resolve;});
  f.backend.run=async()=>{
    const result={available:true,sourceHash:session.snapshot.sourceHash,baseRevision:String(++reads),changes:{total:0}};
    if(reads===1){started();await new Promise(resolve=>{release=resolve;});}
    return result;
  };
  const first=host.statusChanged(f.identity.workspaceKey);
  await firstRead;
  const second=host.statusChanged(f.identity.workspaceKey);
  release();await Promise.all([first,second]);
  assert.equal(reads,2);
  assert.equal(session.svnComparison.baseRevision,'2');
});

test('closed pages defer status comparisons until reopened while preserving their drafts',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.text('sql','unsaved');f.panels[0].dispose();f.calls.length=0;
  await host.statusChanged(f.identity.workspaceKey);
  assert.equal(f.calls.length,0);
  assert.equal(await host.open(f.identity),session);
  assert.deepEqual(f.calls.map(call=>call.payload.action),['comparison']);
  assert.equal(session.draft.operations()[0].content,'unsaved');
});

test('disposing the controller settles a pending status refresh without reading a disposed page',async()=>{
  const f=hostFixture(),host=new PageEditorController(f);
  await host.open(f.identity);f.calls.length=0;
  const pending=host.statusChanged(f.identity.workspaceKey);host.dispose();await pending;
  assert.equal(f.calls.length,0);
  assert.equal(host.comparisonRefreshes.size,0);
});

test('a late comparison cannot overwrite a newer page snapshot',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  const releases=[];
  f.backend.run=async(key,args,payload)=>new Promise(resolve=>releases.push(()=>resolve({available:true,sourceHash:payload.sourceHash,changes:{total:0}})));
  const old=host.refreshComparison(session);
  await new Promise(resolve=>setImmediate(resolve));
  session.snapshot={...session.snapshot,sourceHash:'c'.repeat(64)};
  const current=host.refreshComparison(session);
  await new Promise(resolve=>setImmediate(resolve));
  releases[1]();await current;releases[0]();await old;
  assert.equal(session.svnComparison.sourceHash,'c'.repeat(64));
});

test('external changes migrate independent window edits without writing the file',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口 A');
  f.snapshot.model.collections[0].fields[1].properties[0].value='外部 B';f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.sourceStale,false);assert.equal(session.sourceMerge,null);
  assert.equal(session.snapshot.sourceHash,'c'.repeat(64));
  assert.equal(session.draft.model.collections[0].fields[1].properties[0].value,'外部 B');
  assert.equal(session.draft.operations()[0].value,'窗口 A');
  assert.equal(f.calls.some(call=>['preview','save'].includes(call.payload.action)),false);
  assert.equal([...f.store.values()][0].sourceHash,'c'.repeat(64));
});

test('external conflicts apply together after explicit choices and preserve external values on save',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口 A');
  session.draft.property('/views/0/fields','fieldId:B','width',18);session.draft.text('sql','select draft');
  f.snapshot.model.collections[0].fields[0].properties[0].value='文件 A';
  f.snapshot.model.collections[0].fields[1].properties[1].value=24;f.snapshot.sourceHash='c'.repeat(64);
  const file=clone(source);file.views[0].fields[0].label='文件 A';file.views[0].fields[1].width=24;f.snapshot.sourceText=JSON.stringify(file);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.draft.operations().length,3);assert.equal(session.snapshot.sourceHash,'a'.repeat(64));
  const [first,second]=session.sourceMerge.evidence.conflicts;
  const choose=async(id,choice)=>host.message(session,{type:'resolveSourceConflict',id,choice,sourceHash:'c'.repeat(64),version:session.draft.version});
  await choose(first.id,'draft');assert.equal(session.sourceStale,true);assert.equal(session.snapshot.sourceHash,'a'.repeat(64));
  await choose(second.id,'file');assert.equal(session.sourceStale,false);assert.equal(session.sourceMerge,null);
  assert.deepEqual(session.draft.operations().map(op=>op.kind),['property','text']);
  assert.equal(session.draft.model.collections[0].fields[1].properties[1].value,24);
  assert.equal(session.recovery.sourceMerge.conflicts[1].local,18);
  assert.equal(f.calls.some(call=>call.payload.action==='save'),false);
  await host.save(session);
  assert.equal(JSON.parse(f.snapshot.sourceText).views[0].fields[0].label,'窗口 A');
  assert.equal(JSON.parse(f.snapshot.sourceText).views[0].fields[1].width,24);
});

test('the final conflict choice is rechecked against the latest file and never carried to a newer hash',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口');
  f.snapshot.model.collections[0].fields[0].properties[0].value='文件一';f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  const conflict=session.sourceMerge.evidence.conflicts[0];
  f.snapshot.model.collections[0].fields[0].properties[0].value='文件二';f.snapshot.sourceHash='d'.repeat(64);
  await host.message(session,{type:'resolveSourceConflict',id:conflict.id,choice:'draft',sourceHash:'c'.repeat(64),version:session.draft.version});
  assert.equal(session.sourceStale,true);assert.equal(session.snapshot.sourceHash,'a'.repeat(64));
  assert.equal(session.sourceMerge.evidence.sourceHash,'d'.repeat(64));
  assert.equal(session.sourceMerge.evidence.conflicts[0].choice,null);
  assert.equal(session.sourceMerge.evidence.conflicts[0].file,'文件二');
  await assert.rejects(host.message(session,{type:'resolveSourceConflict',id:conflict.id,choice:'draft',sourceHash:'c'.repeat(64),version:session.draft.version}),/状态已变化/);
});

test('dirty code and unconfirmed native dialogs preserve the old draft without reloading the designer',async()=>{
  for(const native of [false,true]){
    const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
    const host=new PageEditorController(f),session=await host.open(f.identity);
    session.draft.property('/views/0/fields','fieldId:A','label','窗口');
    const messages=[];
    if(native)session.native={unconfirmed:true,version:session.draft.version,panel:{webview:{postMessage:message=>messages.push(message)}}};
    else f.documents.push({isDirty:true,uri:f.vscode.Uri.from({scheme:'guthon-svn-edit',authority:'products.demo',path:'/event.js',
      query:new URLSearchParams({sourceType:'page',sourceId:'PG-1',workingCopyId:'wc'}).toString()})});
    f.snapshot.sourceHash='c'.repeat(64);
    await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
    assert.equal(session.sourceStale,true);assert.equal(session.draft.operations()[0].value,'窗口');
    assert.match(session.sourceMerge.evidence.blockedReason,native?/尚未确认/:/未保存输入/);
    assert.equal(messages.some(message=>message.type==='nativeDocument'),false);
    if(native)await assert.rejects(host.message(session,{type:'reload'}),/对话框/);
  }
});

test('inputs arriving during an external read are included in the migrated draft',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity),run=f.backend.run;
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  f.snapshot.sourceHash='c'.repeat(64);
  f.backend.run=async(...args)=>{const result=await run(...args);if(args[2].action==='open'){started();await new Promise(resolve=>{release=resolve;});}return result;};
  const refresh=host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);await began;
  await host.message(session,{type:'property',collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'等待时输入',version:session.draft.version});
  release();await refresh;
  assert.equal(session.snapshot.sourceHash,'c'.repeat(64));assert.equal(session.draft.operations()[0].value,'等待时输入');
});

test('overlapping source reads accept only the newest snapshot',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity),run=f.backend.run,releases=[];
  f.backend.run=async(...args)=>{const result=await run(...args);if(args[2].action==='open')await new Promise(resolve=>releases.push(resolve));return result;};
  f.snapshot.sourceHash='c'.repeat(64);const first=host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  await new Promise(resolve=>setImmediate(resolve));
  f.snapshot.sourceHash='d'.repeat(64);const second=host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  await new Promise(resolve=>setImmediate(resolve));
  releases[1]();await second;releases[0]();await first;
  assert.equal(session.snapshot.sourceHash,'d'.repeat(64));
});

test('conflict evidence is persisted in full while webview previews are bounded and restart does not auto-apply',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.text('sql','D'.repeat(10000));f.snapshot.model.nodes[1].content='F'.repeat(10000);f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.panel.latest.sourceMerge.conflicts[0].truncated,true);
  assert.equal(session.panel.latest.sourceMerge.conflicts[0].texts[1].length,8000);
  assert.equal([...f.store.values()][0].sourceMerge.conflicts[0].file.length,10000);
  const restarted=await new PageEditorController(f).open(f.identity);
  assert.equal(restarted.draft.operations().length,0);
  assert.equal(restarted.recovery.sourceMerge.conflicts[0].local.length,10000);
  assert.equal(f.calls.some(call=>call.payload.action==='save'),false);
});

test('unknown saves remain pending when source events arrive',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.pending={idempotencyKey:'existing-save'};session.draft.text('sql','pending');f.calls.length=0;
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.deepEqual(session.pending,{idempotencyKey:'existing-save'});assert.equal(session.sourceStale,true);assert.equal(f.calls.length,0);
});

test('reverting an external conflict preserves its report and keeps the original undo history',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口');const previous=session.draft;
  f.snapshot.model.collections[0].fields[0].properties[0].value='文件';f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  f.snapshot.model.collections[0].fields[0].properties[0].value='A';f.snapshot.sourceHash='a'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.sourceStale,false);assert.equal(session.sourceMerge,null);assert.equal(session.draft,previous);
  assert.equal(session.recovery.sourceMerge.conflicts[0].file,'文件');
  session.draft.undo();assert.equal(session.draft.operations().length,0);
});

test('a changed checkout identity is rejected even when the new file hash is identical',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口');f.snapshot.workingCopyId='different';
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.sourceStale,true);assert.match(session.sourceMerge.evidence.blockedReason,/身份/);
  assert.equal(session.snapshot.workingCopyId,'wc');assert.equal(session.draft.operations()[0].value,'窗口');
});

test('restart retains an earlier conflict report when the file has returned to the draft baseline',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口');
  f.snapshot.model.collections[0].fields[0].properties[0].value='文件';f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  f.snapshot.model.collections[0].fields[0].properties[0].value='A';f.snapshot.sourceHash='a'.repeat(64);
  const restarted=await new PageEditorController(f).open(f.identity);
  assert.equal(restarted.draft.operations()[0].value,'窗口');
  assert.equal(restarted.recovery.sourceMerge.conflicts[0].file,'文件');
  assert.equal(restarted.sourceMerge,undefined);
});

test('a draft storage failure after migration retains the new in-memory inputs and surfaces the error',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.draft.property('/views/0/fields','fieldId:A','label','窗口');f.snapshot.sourceHash='c'.repeat(64);
  const update=f.context.workspaceState.update;let attempts=0;
  f.context.workspaceState.update=async(...args)=>{if(++attempts===1)throw new Error('storage unavailable');return update(...args);};
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.snapshot.sourceHash,'c'.repeat(64));assert.equal(session.draft.operations()[0].value,'窗口');
  assert.equal(session.sourceStale,true);assert.match(session.panel.latest.status,/storage unavailable/);
  assert.equal([...f.store.values()][0].operations[0].value,'窗口');
});

test('an unprocessed native candidate prevents migration and remains available for export',async()=>{
  const f=hostFixture();f.snapshot.sourcePath='pages/PG-1.json';
  const host=new PageEditorController(f),session=await host.open(f.identity);
  session.nativeRecovery={pageId:'PG-1',unsupportedInput:'preserve'};f.snapshot.sourceHash='c'.repeat(64);
  await host.sourceChanged(f.identity.workspaceKey,['pages/PG-1.json']);
  assert.equal(session.sourceStale,true);assert.match(session.sourceMerge.evidence.blockedReason,/待核对候选/);
  assert.equal([...f.store.values()][0].nativeRecovery.unsupportedInput,'preserve');
});

test('page publications send one baseline then small patches and resynchronize on ready',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  assert.equal(session.panel.wire.update,'patch');assert.equal(session.panel.wire.baseline,undefined);
  await host.message(session,{type:'property',collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'changed',version:session.draft.version});
  const wire=session.panel.wire;assert.equal(wire.model,undefined);assert.equal(wire.baseline,undefined);
  assert.equal(wire.operations[0].value,'changed');assert.ok(JSON.stringify(wire).length<5000);
  assert.equal(session.panel.latest.model.collections[0].fields[0].properties[0].value,'changed');
  const sequence=wire.sequence;host.publish(session);assert.equal(session.panel.wire.operations,undefined);
  assert.equal(session.panel.wire.comparison.svn,undefined);assert.equal(session.panel.wire.comparison.local,undefined);
  await host.message(session,{type:'ready'});assert.equal(session.panel.wire.update,'full');
  assert.ok(session.panel.wire.sequence>sequence);assert.equal(session.panel.latest.operations[0].value,'changed');
});

test('closing a persisted clean page reclaims it while unsaved pages remain pinned',async()=>{
  const f=hostFixture(),host=new PageEditorController({...f,maxClosedPages:0}),session=await host.open(f.identity);
  f.panels[0].dispose();await session.persistence;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.pages.size,0);
  const reopened=await host.open(f.identity);assert.notEqual(reopened,session);
  reopened.draft.text('sql','keep unsaved');f.panels.at(-1).dispose();await reopened.persistence;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.pages.size,1);assert.equal((await host.open(f.identity)).draft.operations()[0].content,'keep unsaved');
});

test('recovery history uses compact private references while export retains all archived values',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  for(let i=0;i<12;i++){
    session.draft.text('sql','x'.repeat(10000)+i);host.archiveDraft(session);await host.persist(session);
  }
  const stored=[...f.store.values()][0];assert.equal(stored.recovery.kind,'page-recovery-v1');
  assert.ok(JSON.stringify(stored.recovery).length<150);assert.equal(session.recovery.previous.kind,'page-recovery-v1');
  host.publish(session);assert.deepEqual(session.panel.wire.recovery,{available:true});
  const expanded=await host.recoveryStore.expand(session.storageKey,session.recovery);let count=0,item=expanded;
  while(item){assert.match(item.operations[0].content,/^x/);count++;item=item.previous;}
  assert.equal(count,12);
});

test('reopening legacy recovery migrates nested state before publishing a compact reference',async()=>{
  const f=hostFixture(),host=new PageEditorController(f),session=await host.open(f.identity);
  const legacy={sourceHash:'old',operations:[{kind:'text',content:'keep'}],previous:{sourceHash:'older',operations:[],previous:null}};
  f.store.set(session.storageKey,{sourceHash:session.snapshot.sourceHash,operations:[],recovery:legacy});
  const restarted=new PageEditorController(f),restored=await restarted.open(f.identity);
  await restarted.persist(restored);
  const saved=f.store.get(session.storageKey).recovery;assert.equal(saved.kind,'page-recovery-v1');
  assert.deepEqual(await restarted.recoveryStore.expand(restored.storageKey,saved),legacy);
});

test('a closed page is reclaimed only after its newest queued state has persisted',async()=>{
  const f=hostFixture(),host=new PageEditorController({...f,maxClosedPages:0}),session=await host.open(f.identity);
  const update=f.context.workspaceState.update,releases=[];
  f.context.workspaceState.update=async(...args)=>{await new Promise(resolve=>releases.push(resolve));return update(...args);};
  f.panels[0].dispose();const first=session.persistence;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(releases.length,1);
  const second=host.persist(session);releases[0]();await first;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(releases.length,2);
  host.pruneClosedPages();assert.equal(host.pages.size,1);assert.equal(session.persistedClose,false);
  releases[1]();await second;assert.equal(host.pages.size,0);
});

test('a failed close persistence keeps the session until a later successful retry',async()=>{
  const f=hostFixture(),host=new PageEditorController({...f,maxClosedPages:0}),session=await host.open(f.identity);
  const update=f.context.workspaceState.update;f.context.workspaceState.update=async()=>{throw new Error('cannot persist close');};
  f.panels[0].dispose();await assert.rejects(session.persistence,/cannot persist close/);
  host.pruneClosedPages();assert.equal(host.pages.size,1);assert.equal(session.persistedClose,false);
  f.context.workspaceState.update=update;await host.persist(session);assert.equal(host.pages.size,0);
});

test('closed pages with stale sources or unsaved code remain pinned even without page operations',async()=>{
  for(const reason of ['stale','dirtyCode']){
    const f=hostFixture(),host=new PageEditorController({...f,maxClosedPages:0}),session=await host.open(f.identity);
    if(reason==='stale')session.sourceStale=true;
    else f.documents.push({isDirty:true,uri:f.vscode.Uri.from({scheme:'guthon-svn-edit',authority:'products.demo',path:'/event.js',
      query:new URLSearchParams({sourceType:'page',sourceId:'PG-1',workingCopyId:'wc'}).toString()})});
    f.panels[0].dispose();await session.persistence;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(host.pages.size,1);assert.equal(session.draft.operations().length,0);
    session.sourceStale=false;f.documents.length=0;await host.persist(session);assert.equal(host.pages.size,0);
  }
});

test('closed-page byte estimates include redo history rather than only the current clean model',async()=>{
  const f=hostFixture(),host=new PageEditorController({...f,maxClosedPages:4,maxClosedBytes:100000}),session=await host.open(f.identity);
  for(let i=0;i<12;i++)session.draft.text('sql','x'.repeat(20000)+i);
  for(let i=0;i<12;i++)session.draft.undo();assert.equal(session.draft.operations().length,0);
  f.panels[0].dispose();await session.persistence;await new Promise(resolve=>setImmediate(resolve));
  assert.ok(session.closedBytes>100000);assert.equal(host.pages.size,0);
});
