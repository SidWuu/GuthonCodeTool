const test=require('node:test');const assert=require('node:assert/strict');const {ApiSourceWatcher}=require('../src/api/source-watcher');
test('watcher batches controlled paths and ignores unrelated files',async()=>{
  const calls=[],changed=[];const watcher=new ApiSourceWatcher({delay:10000,run:async(key,action,input)=>{calls.push({key,action,input});return action==='status'?{files:[{path:'a'},{path:'b'}]}:{};},onChanged:async(key,paths)=>changed.push({key,paths}),onError:()=>assert.fail()});
  watcher.enqueue('projects.a','a');watcher.enqueue('projects.a','b');watcher.enqueue('projects.a','temp');await watcher.flush('projects.a');
  assert.deepEqual(calls.map(x=>x.action),['status','index']);assert.deepEqual(calls[1].input.paths,['a','b']);assert.deepEqual(changed[0].paths,['a','b']);watcher.dispose();
});
test('watcher retains failed paths and retries only on a later event',async()=>{
  let attempt=0,errors=0;const watcher=new ApiSourceWatcher({delay:10000,retryDelays:[],run:async(_key,action)=>{if(action==='status')return {files:[{path:'a'}]};if(++attempt===1)throw Error('offline');return {};},onChanged:async()=>{},onError:()=>errors++});
  watcher.enqueue('projects.a','a');await watcher.flush('projects.a');assert.equal(errors,1);assert.equal(watcher.projects.get('projects.a').paths.has('a'),true);
  watcher.enqueue('projects.a','a');await watcher.flush('projects.a');assert.equal(attempt,2);watcher.dispose();
});
test('events arriving during indexing are queued for a later batch',async()=>{
  let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r),batches=[];
  const watcher=new ApiSourceWatcher({delay:5,run:async(_key,action,input)=>{if(action==='status')return {files:[{path:'a'},{path:'b'}]};batches.push(input.paths);if(batches.length===1){started();await gate;}return {};},onChanged:async()=>{},onError:()=>assert.fail()});
  watcher.enqueue('projects.a','a');const first=watcher.flush('projects.a');await began;watcher.enqueue('projects.a','b');
  await new Promise(r=>setTimeout(r,15));release();await first;await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(batches,[['a'],['b']]);watcher.dispose();
});
test('failed paths survive restart only for the same workspace and checkout root',async()=>{
  const {RECOVERY_KEY}=require('../src/api/source-watcher');const saved=new Map();
  const workspaceState={get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))};
  const first=new ApiSourceWatcher({workspaceState,delay:10000,retryDelays:[],run:async(_key,action)=>{if(action==='status')return {files:[{path:'a'}]};throw Error('offline');},onChanged:async()=>{},onError(){}});
  first.register('projects.a','/checkout/a');first.enqueue('projects.a','a');await first.flush('projects.a');await first.close();
  assert.deepEqual(saved.get(RECOVERY_KEY)['projects.a'].paths,['a']);
  const second=new ApiSourceWatcher({workspaceState,delay:10000,run:async()=>({}),onChanged:async()=>{},onError(){}});
  second.register('projects.a','/checkout/other');assert.equal(second.projects.get('projects.a').paths.size,0);await second.close();
  saved.set(RECOVERY_KEY,{'projects.a':{root:'/checkout/a',paths:['a']}});
  const third=new ApiSourceWatcher({workspaceState,delay:10000,run:async()=>({}),onChanged:async()=>{},onError(){}});
  third.register('projects.a','/checkout/a');assert.equal(third.projects.get('projects.a').paths.has('a'),true);await third.close();
});
test('an in-flight batch stays in persisted recovery until indexing succeeds',async()=>{
  const {RECOVERY_KEY}=require('../src/api/source-watcher');let release,entered;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r),saved=new Map();
  const watcher=new ApiSourceWatcher({workspaceState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,structuredClone(value))},delay:10000,
    run:async(_key,action)=>{if(action==='status')return {files:[{path:'a'}]};entered();await gate;return {};},onChanged:async()=>{},onError(){}});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a','a');const pending=watcher.flush('projects.a');await began;await watcher.persist();
  assert.deepEqual(saved.get(RECOVERY_KEY)['projects.a'].paths,['a']);release();await pending;assert.equal(saved.get(RECOVERY_KEY)['projects.a'],undefined);await watcher.close();
});
test('failed automatic indexing retries are bounded and remain available for recovery',async()=>{
  let attempts=0,errors=0;const watcher=new ApiSourceWatcher({delay:1,retryDelays:[1,1],run:async(_key,action)=>{
    if(action==='status')return {files:[{path:'a'}]};attempts++;throw Error('offline');},onChanged:async()=>{},onError:()=>errors++});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a','a');
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(attempts,3);assert.equal(watcher.projects.get('projects.a').paths.has('a'),true);assert.equal(errors,2);await watcher.close();
});
test('indexing remains bounded to explicit batches',async()=>{
  const batches=[],watcher=new ApiSourceWatcher({delay:10000,batchSize:2,run:async(_key,action,input)=>{
    if(action==='status')return {files:['a','b','c','d','e'].map(path=>({path}))};batches.push(input.paths);return {};},onChanged:async()=>{},onError:()=>assert.fail()});
  watcher.register('projects.a','/checkout/a');for(const p of ['a','b','c','d','e'])watcher.enqueue('projects.a',p);
  await watcher.drain();assert.deepEqual(batches,[['a','b'],['c','d'],['e']]);await watcher.close();
});
test('manual retry rebuilds only persisted failed paths',async()=>{
  let online=false;const batches=[],watcher=new ApiSourceWatcher({delay:10000,retryDelays:[],run:async(_key,action,input)=>{
    if(action==='status')return {files:[{path:'a'},{path:'b'}]};batches.push(input.paths);if(!online)throw Error('offline');return {complete:true};},onChanged:async()=>{},onError(){}});
  watcher.register('projects.a','/checkout/a');watcher.enqueue('projects.a','a');await watcher.flush('projects.a');assert.deepEqual(watcher.recovery('projects.a').paths,['a']);
  online=true;assert.deepEqual(await watcher.retry('projects.a'),{attempted:1});assert.deepEqual(batches,[['a'],['a']]);assert.deepEqual(watcher.recovery('projects.a').paths,[]);await watcher.close();
});
