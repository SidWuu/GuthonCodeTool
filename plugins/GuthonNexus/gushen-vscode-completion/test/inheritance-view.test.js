const test=require('node:test');const assert=require('node:assert/strict');const {readInheritance}=require('../src/source/inheritance');
test('inheritance reads all bounded pages with stable Unicode offsets and deduplicates concurrent requests',async()=>{
  const calls=[];const run=async(_key,_action,input)=>{calls.push(input.offset);return {path:'page.json',sourceHash:'hash',parentPointer:'/super',status:'ACTIVE',segments:[],effective:input.offset===0?'🧪甲':'乙',totalChars:3,truncated:input.offset===0,nextOffset:input.offset===0?2:null};};
  const options={run,workspaceKey:'projects.a',path:'page.json',jsonPointer:'/event',maxChars:2};
  const [one,two]=await Promise.all([readInheritance(options),readInheritance(options)]);assert.equal(one.effective,'🧪甲乙');assert.deepEqual(one,two);assert.deepEqual(calls,[0,2]);
});
test('inheritance rejects changed identities and stalled pagination',async()=>{
  const options={workspaceKey:'projects.a',path:'page.json'};
  await assert.rejects(readInheritance({...options,run:async()=>({path:'page.json',sourceHash:'a',status:'ACTIVE',segments:[],effective:'x',totalChars:3,truncated:true,nextOffset:0})}),/分页/);
  await assert.rejects(readInheritance({...options,run:async(_k,_a,p)=>({path:'page.json',sourceHash:p.offset?'b':'a',status:'ACTIVE',segments:[],effective:'x',totalChars:2,truncated:!p.offset,nextOffset:p.offset?null:1})}),/发生变化/);
});
