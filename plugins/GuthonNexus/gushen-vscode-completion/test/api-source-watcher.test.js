const test=require('node:test');const assert=require('node:assert/strict');
const {ApiSourceWatcher,RECOVERY_KEY}=require('../src/api/source-watcher');
const A='systems/S/pages/main/PG/a.xml',B='systems/S/pages/main/PG/b.xml',C='systems/S/pages/main/PG/c.xml',D='systems/S/pages/main/PG/d.xml',E='systems/S/pages/main/PG/e.xml';
const accepted=input=>({updatedPaths:input.paths});
test('watcher checks managed paths and never enqueues unrelated configuration files',async()=>{
  const calls=[],changed=[],watcher=new ApiSourceWatcher({delay:10000,run:async(key,action,input)=>(calls.push({key,action,input}),accepted(input)),onChanged:async(key,paths)=>changed.push({key,paths}),onError:()=>assert.fail()});
  for(const p of [A,B,'temp','.vscode/settings.json','config/sync.yaml','systems/S/.vscode/settings.json','systems/S/config/sync.yaml','AGENTS.md','skills/AGENTS.md','systems/S/pages/main/PG/AGENTS.md'])watcher.enqueue('projects.a',p);
  await watcher.flush('projects.a');assert.deepEqual(calls.map(x=>[x.action,!!x.input.checkOnly]),[['index',true],['index',false]]);
  assert.deepEqual(calls[0].input.paths,[A,B]);assert.deepEqual(changed[0].paths,[A,B]);await watcher.close();
});
test('only backend-selected sources are indexed, including clean and missing registered paths',async()=>{
  const calls=[],changed=[],watcher=new ApiSourceWatcher({delay:10000,run:async(key,action,input)=>{
    calls.push({key,action,input});return {updatedPaths:input.paths.filter(p=>!p.endsWith('unknown.gss')),ignoredCount:1,indexGeneration:'next'};
  },onChanged:async(key,paths,result)=>changed.push({key,paths,generation:result.indexGeneration}),onError:()=>assert.fail()});
  const clean='datasources/D/procedures/clean.gss',missing='systems/S/pages/main/P/missing.xml',unknown='datasources/D/procedures/unknown.gss';
  for(const p of [clean,missing,unknown])watcher.enqueue('products.A',p);await watcher.flush('products.A');
  assert.deepEqual(calls.map(x=>[x.action,!!x.input.checkOnly]),[['index',true],['index',false]]);assert.deepEqual(calls[1].input.paths,[clean,missing]);
  assert.deepEqual(changed,[{key:'products.A',paths:[clean,missing],generation:'next'}]);assert.deepEqual(watcher.recovery('products.A').paths,[]);await watcher.close();
});
test('watcher retains confirmed failed paths and retries on a later event',async()=>{
  let attempt=0,errors=0;const watcher=new ApiSourceWatcher({delay:10000,retryDelays:[],run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);if(++attempt===1)throw Error('offline');return accepted(input);},onChanged:async()=>{},onError:()=>errors++});
  watcher.enqueue('projects.a',A);await watcher.flush('projects.a');assert.equal(errors,1);assert.deepEqual(watcher.recovery('projects.a').paths,[A]);
  watcher.enqueue('projects.a',A);await watcher.flush('projects.a');assert.equal(attempt,2);await watcher.close();
});
test('events arriving during indexing are queued for a later batch',async()=>{
  let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r),batches=[];
  const watcher=new ApiSourceWatcher({delay:5,run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);batches.push(input.paths);if(batches.length===1){started();await gate;}return accepted(input);},onChanged:async()=>{},onError:()=>assert.fail()});
  watcher.enqueue('projects.a',A);const first=watcher.flush('projects.a');await began;watcher.enqueue('projects.a',B);await new Promise(r=>setTimeout(r,15));release();await first;await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(batches,[[A],[B]]);await watcher.close();
});
test('failed paths survive restart only for the same workspace and checkout root and are rechecked',async()=>{
  const saved=new Map(),workspaceState={get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))};
  const first=new ApiSourceWatcher({workspaceState,delay:10000,retryDelays:[],run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);throw Error('offline');},onChanged:async()=>{},onError(){}});
  first.register('projects.a','/checkout/a');first.enqueue('projects.a',A);await first.flush('projects.a');await first.close();assert.deepEqual(saved.get(RECOVERY_KEY)['projects.a'].paths,[A]);
  const second=new ApiSourceWatcher({workspaceState,delay:10000,run:async(_key,_action,input)=>accepted(input),onChanged:async()=>{},onError(){}});
  second.register('projects.a','/checkout/other');assert.equal(second.recovery('projects.a').paths.length,0);await second.close();
  saved.set(RECOVERY_KEY,{'projects.a':{root:'/checkout/a',paths:[A]}});
  const calls=[],third=new ApiSourceWatcher({workspaceState,delay:10000,run:async(_key,_action,input)=>(calls.push(input),accepted(input)),onChanged:async()=>{},onError(){}});
  third.register('projects.a','/checkout/a');assert.deepEqual(third.recovery('projects.a').paths,[]);await third.flush('projects.a');assert.equal(calls[0].checkOnly,true);assert.deepEqual(calls[0].paths,[A]);await third.close();
});
test('an in-flight batch stays in persisted recovery until indexing succeeds',async()=>{
  let release,entered;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),saved=new Map();
  const watcher=new ApiSourceWatcher({workspaceState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))},delay:10000,
    run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);entered();await gate;return accepted(input);},onChanged:async()=>{},onError(){}});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a',A);const pending=watcher.flush('projects.a');await began;await watcher.persist();
  assert.deepEqual(saved.get(RECOVERY_KEY)['projects.a'].paths,[A]);
  assert.deepEqual(watcher.recovery('projects.a').paths,[]);
  release();await pending;assert.equal(saved.get(RECOVERY_KEY)['projects.a'],undefined);await watcher.close();
});
test('unverified events remain recoverable but are not shown as confirmed pending sources',async()=>{
  const saved=new Map(),workspaceState={get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))};
  const watcher=new ApiSourceWatcher({workspaceState,delay:10000,retryDelays:[],run:async()=>{throw Error('offline');},onChanged:async()=>{},onError(){}});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a',A);await watcher.flush('projects.a');
  assert.deepEqual(watcher.recovery('projects.a').paths,[]);assert.deepEqual(saved.get(RECOVERY_KEY)['projects.a'].unchecked,[A]);await watcher.close();
});
test('legacy pending configuration events are removed and unknown source-like paths are checked before indexing',async()=>{
  const saved=new Map([[RECOVERY_KEY,{'projects.a':{root:'/checkout/a',paths:['.vscode/settings.json','config/sync.yaml','datasources/D/procedures/unknown.gss']}}]]),calls=[];
  const watcher=new ApiSourceWatcher({workspaceState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))},delay:10000,
    run:async(_key,action,input)=>(calls.push({action,input}),{updatedPaths:[],ignoredCount:1,checkOnly:true}),onChanged:()=>assert.fail(),onError:()=>assert.fail()});
  watcher.register('projects.a','/checkout/a');assert.deepEqual(watcher.recovery('projects.a').paths,[]);await watcher.flush('projects.a');
  assert.deepEqual(calls,[{action:'index',input:{paths:['datasources/D/procedures/unknown.gss'],checkOnly:true,compareIndex:true}}]);
  assert.equal(saved.get(RECOVERY_KEY)['projects.a'],undefined);await watcher.close();
});
test('a duplicate indexed event reports a newly observed generation once without reporting source updates',async()=>{
  const changed=[],watcher=new ApiSourceWatcher({delay:10000,run:async(_key,_action,input)=>input.checkOnly?accepted(input):{updatedPaths:[],unchanged:true,indexGeneration:'new'},
    onChanged:async(key,paths,result)=>changed.push({key,paths,generation:result.indexGeneration}),onError:()=>assert.fail()});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a',A);await watcher.flush('projects.a');watcher.enqueue('projects.a',A);await watcher.flush('projects.a');
  assert.deepEqual(changed,[{key:'projects.a',paths:[],generation:'new'}]);await watcher.close();
});
test('failed automatic indexing retries are bounded and remain available for recovery',async()=>{
  let attempts=0,errors=0;const watcher=new ApiSourceWatcher({delay:1,retryDelays:[1,1],run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);attempts++;throw Error('offline');},onChanged:async()=>{},onError:()=>errors++});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a',A);await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(attempts,3);assert.deepEqual(watcher.recovery('projects.a').paths,[A]);assert.equal(errors,2);await watcher.close();
});
test('indexing remains bounded to explicit batches',async()=>{
  const batches=[],watcher=new ApiSourceWatcher({delay:10000,batchSize:2,run:async(_key,_action,input)=>{if(!input.checkOnly)batches.push(input.paths);return accepted(input);},onChanged:async()=>{},onError:()=>assert.fail()});
  watcher.register('projects.a','/checkout/a');for(const p of [A,B,C,D,E])watcher.enqueue('projects.a',p);await watcher.drain();assert.deepEqual(batches,[[A,B],[C,D],[E]]);await watcher.close();
});
test('manual retry rebuilds only persisted failed paths',async()=>{
  let online=false;const batches=[],watcher=new ApiSourceWatcher({delay:10000,retryDelays:[],run:async(_key,_action,input)=>{if(input.checkOnly)return accepted(input);batches.push(input.paths);if(!online)throw Error('offline');return accepted(input);},onChanged:async()=>{},onError(){}});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a',A);await watcher.flush('projects.a');assert.deepEqual(watcher.recovery('projects.a').paths,[A]);
  online=true;assert.deepEqual(await watcher.retry('projects.a'),{attempted:1});assert.deepEqual(batches,[[A],[A]]);assert.deepEqual(watcher.recovery('projects.a').paths,[]);await watcher.close();
});
test('a completed full index rechecks failed paths, removes stale prompts, and retains concurrent edits',async()=>{
  const calls=[],recoveryCounts=[];
  let rebuildComplete=false;
  const watcher=new ApiSourceWatcher({delay:10000,retryDelays:[],
    run:async(_key,_action,input)=>{
      calls.push(input);
      if(input.checkOnly) return {updatedPaths:input.paths.filter(p=>!rebuildComplete || p===B)};
      if(!rebuildComplete) throw Error('index unavailable');
      return accepted(input);
    },onChanged:async()=>{},onError:()=>{},
    onRecoveryChanged:key=>recoveryCounts.push(watcher.recovery(key).paths.length)});
  watcher.register('projects.a','/checkout/a');
  watcher.enqueue('projects.a',A);await watcher.flush('projects.a');
  assert.deepEqual(recoveryCounts,[1]);
  rebuildComplete=true;
  await watcher.markIndexed('projects.a','rebuilt');
  watcher.enqueueMany('projects.a',[A,B,A]);
  await watcher.flush('projects.a');
  assert.deepEqual(calls.slice(-2),[
    {paths:[A,B],checkOnly:true,compareIndex:true},
    {paths:[B]},
  ]);
  assert.deepEqual(recoveryCounts,[1,0]);
  assert.deepEqual(watcher.recovery('projects.a').paths,[]);
  await watcher.close();
});
