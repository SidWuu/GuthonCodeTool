const assert=require('node:assert/strict');const test=require('node:test');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {exportAiContext,apiContext,writePrivateContext}=require('../src/ai-context-export');
const identity={sourceId:'PX',sourceType:'procedure',sourcePath:'datasources/DS/procedures/PX/run.gss'};
async function fixture(t){const toolHome=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-context-'));t.after(()=>fs.rm(toolHome,{recursive:true,force:true}));const root=path.join(toolHome,'var','workspace','demo');await fs.mkdir(root,{recursive:true});return {toolHome,workspace:{root,workspaceKey:'projects.demo'},identity};}
function runner(calls,overrides={}) {return async(key,action,input)=>{calls.push({key,action,input});if(overrides[action])return overrides[action];
  if(action==='read')return {sourceHash:'a',metadata:{sourceType:'procedure'}};
  if(action==='context')return {workspaceKey:key,source:{path:identity.sourcePath,sourceHash:'a',sourceType:'procedure'},calls:[],incoming:[],indexGeneration:'g1',complete:true};
  if(action==='facts')return {facts:[],indexGeneration:'g1',complete:true};
  if(action==='inheritance')return {sourceHash:'a',status:'ACTIVE',effective:'parent();',truncated:true};throw Error(action);};}
test('exports bounded indexed context with exact path and private file permissions',async t=>{
  const f=await fixture(t),calls=[],result=await exportAiContext({...f,run:runner(calls)});
  assert.equal(path.dirname(result.artifactPath),await fs.realpath(path.join(f.workspace.root,'context','ai')));
  assert.match(await fs.readFile(result.artifactPath,'utf8'),/datasources\/DS/);assert.deepEqual(calls.map(x=>x.action),['read','context']);
  if(process.platform!=='win32')assert.equal((await fs.stat(result.artifactPath)).mode&0o777,0o600);
});
test('rejects wrong source identity and stale index before writing',async t=>{
  const f=await fixture(t);await assert.rejects(exportAiContext({...f,run:runner([],{read:{sourceHash:'a',metadata:{sourceType:'page'}}})}),/类型/);
  await assert.rejects(exportAiContext({...f,run:runner([],{context:{workspaceKey:'projects.demo',source:{path:identity.sourcePath,sourceHash:'old'}}})}),/快照/);
  await assert.rejects(fs.stat(path.join(f.workspace.root,'context')),{code:'ENOENT'});
});
test('does not overwrite exports and fingerprints distinct source paths',async t=>{
  const f=await fixture(t),a=await writePrivateContext({...f,markdown:'a'}),b=await writePrivateContext({...f,identity:{...identity,sourcePath:'other.gss'},markdown:'b'}),c=await writePrivateContext({...f,markdown:'c'});
  assert.notEqual(path.basename(a).split('-')[1],path.basename(b).split('-')[1]);assert.notEqual(a,c);assert.equal(await fs.readFile(a,'utf8'),'a');
});
test('rejects external roots, symlinks and oversized exports',async t=>{
  const f=await fixture(t);await assert.rejects(writePrivateContext({...f,workspace:{...f.workspace,root:f.toolHome},markdown:'x'}),/var/);
  await fs.symlink(f.toolHome,path.join(f.workspace.root,'context'));await assert.rejects(writePrivateContext({...f,markdown:'x'}),/边界/);
  await assert.rejects(writePrivateContext({...f,markdown:'x'.repeat(128*1024+1)}),/上限/);
});
test('inheritance is explicit and bounded, impact rejects mixed index generations',async t=>{
  const f=await fixture(t),calls=[],result=await apiContext({run:runner(calls),workspaceKey:f.workspace.workspaceKey,identity,includeInheritance:true});
  assert.equal(calls.find(x=>x.action==='inheritance').input.maxChars,8000);assert.match(result.markdown,/parent/);
  await assert.rejects(apiContext({run:runner([],{facts:{facts:[],indexGeneration:'other'}}),workspaceKey:f.workspace.workspaceKey,identity,includeImpact:true}),/代次/);
});
