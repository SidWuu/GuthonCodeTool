const test=require('node:test');const assert=require('node:assert/strict');
const {parseSourceLink,sourceLink,findExactCandidates}=require('../src/api/navigation');
const uri=(path,query)=>({authority:'gushen-local.guthon-nexus-vscode',path,query});
test('API source share link roundtrips project and exact relative path',()=>{
  const link=new URL(sourceLink('projects.demo','systems/S/pages/测试.json'));
  assert.deepEqual(parseSourceLink(uri(link.pathname,link.search.slice(1))),{type:'open-source',workspaceKey:'projects.demo',path:'systems/S/pages/测试.json'});
  assert.throws(()=>parseSourceLink(uri('/open-source','workspaceKey=projects.demo&path=../escape')),/路径/);
  assert.throws(()=>parseSourceLink(uri('/open-source','workspaceKey=projects.demo&path=a&path=b')),/字段/);
});
test('external PAGE and procedure links require exact unique identity',()=>{
  assert.deepEqual(parseSourceLink(uri('/locate-page','pageId=PG-123')),{type:'locate-page',pageId:'PG-123'});
  assert.throws(()=>parseSourceLink(uri('/locate-page','pageId=PG-1&pageId=PG-2')),/字段/);
  assert.deepEqual(parseSourceLink(uri('/locate-procedure','alias=demo.pkg&funId=save')),{type:'locate-procedure',alias:'demo.pkg',funId:'save'});
  assert.throws(()=>parseSourceLink(uri('/locate-procedure','alias=demo.pkg&funId=save&extra=x')),/字段/);
});
test('exact PAGE and procedure candidates preserve distinct paths across index pages',async()=>{
  const calls=[],run=async(_key,_action,input)=>{calls.push(input.offset);return {indexGeneration:'g',hits:input.offset===0?
    [{path:'a',sourceType:'page',sourceId:'PG-1'},{path:'a',sourceType:'page',sourceId:'PG-1'}]:[{path:'b',sourceType:'page',sourceId:'PG-1'},{path:'c',sourceType:'procedure',alias:'demo',funId:'save'}],nextOffset:input.offset?null:100};};
  const pages=await findExactCandidates(run,'projects.demo','page','PG-1',x=>x.sourceId==='PG-1');assert.deepEqual(pages.items.map(x=>x.path),['a','b']);assert.deepEqual(calls,[0,100]);
  const functions=await findExactCandidates(run,'projects.demo','procedure','save',x=>x.alias==='demo' && x.funId==='save');assert.deepEqual(functions.items.map(x=>x.path),['c']);
});
test('exact locator rejects index generation changes rather than mixing snapshots',async()=>{
  await assert.rejects(findExactCandidates(async(_k,_a,p)=>({indexGeneration:String(p.offset),hits:[],nextOffset:p.offset?null:100}),'projects.demo','page','PG-1',()=>true),/索引已变化/);
});
