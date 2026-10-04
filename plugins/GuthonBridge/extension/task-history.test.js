const test=require('node:test');const assert=require('node:assert/strict');
const history=require('./task-history');
const requestId='1760000000000_00000000-0000-4000-8000-000000000001';
const origin='https://gusen.steel56.com.cn';
test('successful recent targets discard body, secrets, output overrides and prior force confirmation',()=>{
 const entry=history.create({requestId,operation:'pull-hub-source',workspaceKey:'products.demo',payload:{sourceType:'procedure',alias:'demo.pkg',funId:'save',force:true,confirmation:'products.demo',password:'secret',content:'source',outputDir:'/untrusted'}},{ok:true,outputDir:'/trusted/root'},origin);
 assert.equal(entry.outputDir,'/trusted/root');
 assert.ok(!JSON.stringify(entry).includes('secret'));assert.equal(entry.payload.content,undefined);
 const request=history.replay(entry,origin);
 assert.equal(request.payload.force,false);assert.equal(request.payload.confirmation,undefined);assert.equal(request.payload.outputDir,undefined);
 assert.equal(request.payload.workspaceKey,'products.demo');
 assert.throws(()=>history.replay(entry,'https://elsewhere.example'),/原谷神平台/);
 assert.equal(history.create({...entry,operation:'query-procedure-callers'},{ok:true},origin),null);
 assert.equal(history.create(entry,{ok:false},origin),null);
});
test('history retains a bounded list, isolates bad entries and refuses partial target lists',()=>{
 const entry=history.create({requestId,operation:'export-table-schema',workspaceKey:'projects.demo',payload:{tableIds:[],dataSourceId:'ds'}},{ok:true},origin);
 assert.equal(history.retain([null,...Array.from({length:30},(_,index)=>({...entry,requestId:String(index),completedAt:index}))],entry).length,20);
 assert.equal(history.create({...entry,payload:{tableIds:Array(51).fill('table')}},{ok:true},origin),null);
 assert.equal(history.create({...entry,requestId:'bad'},{ok:true},origin),null);
});
