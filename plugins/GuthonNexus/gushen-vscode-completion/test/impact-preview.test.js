const assert=require('node:assert/strict');const test=require('node:test');const {apiContext}=require('../src/ai-context-export');
const key='projects.demo',identity={path:'systems/S/page.json',sourceType:'page'};
function backend(changes={}) {const calls=[];return {calls,run:async(_key,action,input)=>{calls.push({action,input});
 if(action==='read')return changes.read || {sourceHash:'hash',metadata:{sourceType:'page'}};
 if(action==='context')return changes.context || {workspaceKey:key,source:{path:identity.path,sourceHash:'hash',sourceType:'page'},calls:[{targetAlias:'pkg',targetFunId:'save'}],incoming:[],indexGeneration:'g1',complete:true};
 if(action==='facts')return changes.facts || {facts:[{kind:'data',subject:'T_ORDER',operation:'SELECT',jsonPointer:'/views/0/datasource/sql',line:3,evidence:'select'}],indexGeneration:'g1',truncated:true};throw Error(action);}};}
test('API impact preview retains the exact path, call and partial fact evidence',async()=>{
 const f=backend(),result=await apiContext({run:f.run,workspaceKey:key,identity,includeImpact:true});
 assert.deepEqual(f.calls.map(x=>x.action),['read','context','facts']);assert.equal(f.calls[2].input.path,identity.path);
 assert.match(result.markdown,/T_ORDER/);assert.match(result.markdown,/datasource\/sql/);assert.match(result.markdown,/factsTruncated/);
});
test('impact preview rejects a different source path or mixed index generation',async()=>{
 const a=backend({context:{workspaceKey:key,source:{path:'other',sourceHash:'hash'},indexGeneration:'g1'}});
 await assert.rejects(apiContext({run:a.run,workspaceKey:key,identity,includeImpact:true}),/不一致/);
 const b=backend({facts:{facts:[],indexGeneration:'g2'}});await assert.rejects(apiContext({run:b.run,workspaceKey:key,identity,includeImpact:true}),/代次/);
});
