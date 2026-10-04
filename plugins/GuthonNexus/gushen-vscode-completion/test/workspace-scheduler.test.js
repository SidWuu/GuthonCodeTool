const test=require('node:test');const assert=require('node:assert/strict');
const {WorkspaceQueue,WorkspaceToolPool}=require('../src/workspace-scheduler');
const pause=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('workspace queue permits different scopes concurrently, keeps one scope serial and bounds admission',async()=>{
 const queue=new WorkspaceQueue({limit:3,concurrency:2});const gate=pause();const started=[];
 const first=queue.enqueue('a',async()=>{started.push('a1');await gate.promise;});
 const second=queue.enqueue('a',async()=>{started.push('a2');});
 const third=queue.enqueue('b',async()=>{started.push('b1');});
 await assert.rejects(queue.enqueue('c',async()=>{}),/已满/);
 await third;assert.deepEqual(started,['a1','b1']);assert.equal(queue.size,2);
 gate.resolve();await Promise.all([first,second]);assert.deepEqual(started,['a1','b1','a2']);
 assert.equal(queue.size,0);await Promise.resolve();assert.equal(queue.tails.size,0);
});

test('workspace semaphore never exceeds concurrency while failed scopes release their slots',async()=>{
 const queue=new WorkspaceQueue({limit:10,concurrency:2});const gate=pause();let active=0,peak=0;
 const promises=Array.from({length:5},(_,index)=>queue.enqueue(String(index),async()=>{
  active++;peak=Math.max(peak,active);await gate.promise;active--;if(index===2)throw new Error('fixture failure');return index;
 }));
 await new Promise(setImmediate);assert.equal(active,2);gate.resolve();const results=await Promise.allSettled(promises);
 assert.equal(peak,2);assert.equal(results.filter(result=>result.status==='rejected').length,1);assert.equal(queue.active,0);
});

test('tool pool keeps separate clients, reuses one scope and only evicts idle clients',async()=>{
 let ids=0;const stopped=[],gate=pause();
 const pool=new WorkspaceToolPool({limit:2,createClient:()=>{
  const id=++ids;return {child:true,request:async(_tool,_command,_args,workspace)=>{if(workspace==='busy')await gate.promise;return {id,workspace};},stop:async()=>stopped.push(id)};
 }});
 const busy=pool.request({},'write',[],'busy');const first=await pool.request({},'write',[],'other');
 const repeat=await pool.request({},'read',[],'other');assert.equal(first.id,repeat.id);
 const last=await pool.request({},'read',[],'last');assert.notEqual(last.id,first.id);assert.deepEqual(stopped,[first.id]);
 gate.resolve();const done=await busy;assert.notEqual(done.id,last.id);
 await pool.stop();assert.equal(pool.clients.size,0);await assert.rejects(pool.request({},'read',[],'busy'),/已停止/);
});
