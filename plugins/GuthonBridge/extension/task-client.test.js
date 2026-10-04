const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const crypto=require('node:crypto');const test=require('node:test');
function fixture(){
 const storage={guthonBridgeToken:'f'.repeat(64)};const jobs=new Map();let submissions=0;let loseAck=false;
 const sender={id:'a'.repeat(32),tab:{id:1,url:'https://gusen.steel56.com.cn/guthon/'}};
 const send=async(message)=>{
  // A fresh service-worker global for every request; only Chrome storage and
  // backend records survive. No pending promise/global variable is retained.
  let listener;const context={importScripts(){},URL,AbortController,setTimeout,clearTimeout,
   GuthonBridgeHost:require('./host-config'),GuthonBridgeNexusLocator:require('./nexus-locator'),GuthonBridgeTaskHistory:require('./task-history'),
   chrome:{tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}},runtime:{id:sender.id,getURL:name=>`chrome-extension://${sender.id}/${name}`,onInstalled:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},
    storage:{local:{async get(){return JSON.parse(JSON.stringify(storage));},async set(value){Object.assign(storage,value);}}}},
   fetch:async(url,options)=>{
    const body=JSON.parse(options.body||'{}');let result;
    if(url.endsWith('/submitJob')){submissions+=1;jobs.set(body.requestId,{...body,reads:0,state:'RUNNING'});result={ok:true,state:'QUEUED'};if(loseAck)throw new Error('worker stopped after accepted write');}
    else if(url.endsWith('/jobStatus')){const job=jobs.get(body.requestId);if(!job)throw new Error('no job');job.reads+=1;result={ok:true,state:job.state==='UNKNOWN'?'UNKNOWN':job.reads>1?'COMPLETED':'RUNNING',workspaceKey:job.workspaceKey,result:{ok:true,message:'finished'},message:'restart unknown'};}
    else throw new Error(`unexpected ${url}`);
    return {ok:true,status:200,json:async()=>result};
   }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),context);
  return new Promise(resolve=>listener(message,sender,resolve));
 };
 const client=()=>{const context={crypto,Date,Promise,Map,Set,setTimeout:fn=>{queueMicrotask(fn);return 1;},chrome:{runtime:{sendMessage:send}}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'task-client.js'),'utf8'),context);return context.GuthonBridgeTasks;};
 return {client,storage,jobs,get submissions(){return submissions;},set loseAck(value){loseAck=value;}};
}
test('short worker requests survive service-worker teardown between submission and every poll',async()=>{
 const f=fixture();const result=await f.client().run('pull-hub-source',{workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',alias:'demo',funId:'save'});
 assert.equal(result.ok,true);assert.equal(f.submissions,1);assert.deepEqual(f.storage.guthonBridgePendingJobs,{});
 assert.equal(f.storage.guthonBridgeRecentPulls.length,1);
});
test('lost acknowledgment and popup reload resume only the durable request without resubmitting writes',async()=>{
 const f=fixture();f.loseAck=true;const result=await f.client().run('pull-hub-source',{workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',alias:'demo',funId:'save'});
 assert.equal(result.taskPending,true);assert.equal(f.submissions,1);assert.equal(Object.keys(f.storage.guthonBridgePendingJobs).length,1);
 const resumed=await f.client().resume();assert.equal(resumed[0].ok,true);assert.equal(f.submissions,1);
});
test('server restart unknown is surfaced and never automatically replays a write',async()=>{
 const f=fixture();f.loseAck=true;await f.client().run('export-view-sql',{workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',viewIds:['view1']});
 for(const job of f.jobs.values())job.state='UNKNOWN';
 const result=await f.client().resume();assert.equal(result[0].resultUnknown,true);assert.equal(f.submissions,1);
 assert.equal((f.storage.guthonBridgeRecentPulls||[]).length,0);
});

test('explicit recent-target pull creates a new task without reusing force or confirmation',async()=>{
 const f=fixture();
 await f.client().run('pull-hub-source',{workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',alias:'demo.pkg',funId:'save',force:true,confirmation:'products.demo'});
 const request=require('./task-history').replay(f.storage.guthonBridgeRecentPulls[0],'https://gusen.steel56.com.cn');
 await f.client().run(request.type,request.payload);
 assert.equal(f.submissions,2);
 const latest=[...f.jobs.values()].at(-1);
 assert.equal(latest.payload.force,false);assert.equal(latest.payload.confirmation,undefined);
 assert.equal(latest.workspaceKey,'products.demo');
});

test('concurrent identical button requests share the persisted operation identity',async()=>{
 const f=fixture();const client=f.client();const payload={workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',alias:'demo',funId:'save'};
 const results=await Promise.all([client.run('pull-hub-source',payload),client.run('pull-hub-source',payload)]);
 assert.ok(results.every(result=>result.ok));assert.equal(f.submissions,1);
});
