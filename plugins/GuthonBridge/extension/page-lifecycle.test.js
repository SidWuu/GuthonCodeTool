const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const calls = [], page = {pageId:'PG-1',pageType:2,pageName:'Source',pageAliasId:'demo.source',title:'Source',systemId:'SYS-1',mkId:'MK-1'};
  const tree = {data:[{t:2,item:{systemId:'SYS-1',mkId:'MK-1',mkName:'Module'}}],getTreeNodeData(){},$store:{state:{modeDev:{systemId:'SYS-1'}}}};
  const box = {location:{origin:'https://platform.example',pathname:'/guthon/index.html'},document:{querySelectorAll:()=>[{__vue__:tree}]},URLSearchParams,AbortSignal,
    async fetch(url,options){const body=Object.fromEntries(options.body);calls.push({url,body});let result;
      if(url.endsWith('getPageBaseInfo.htm'))result={code:0,page};
      else if(url.endsWith('getPageModuleXml.htm'))result={code:0,version:'v1'};
      else result={code:0,bean:{pageId:'PG-NEW',systemId:'SYS-1',mkId:'MK-1'}};
      return {ok:true,json:async()=>({code:0,data:result})};}};
  const code=fs.readFileSync(require.resolve('./page-lifecycle.js'),'utf8');
  vm.runInNewContext(code,box);
  return {box,calls,page,tree,run:payload=>box.runPageLifecycle({...payload,expectedOrigin:'https://platform.example',systemIds:['SYS-1']})};
}

test('native creation sends only registration metadata and receives the platform PAGE identity',async()=>{
  const f=fixture();const result=await f.run({action:'create',properties:{systemId:'SYS-1',mkId:'MK-1',pageType:1,pageName:'主页面',title:'Example'}});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.page.pageId,'PG-NEW');
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith('/pages/savePages.htm'));
  assert.equal(f.calls[0].body.pageId,undefined);
});

test('copy uses the native paste endpoint and binds source version/metadata before writing',async()=>{
  const f=fixture();const inspected=await f.run({action:'inspect',pageId:'PG-1'});f.calls.length=0;
  const payload={action:'copy',pageId:'PG-1',expectedVersion:'v1',expectedPage:inspected.page,properties:{pageAliasId:'demo.copy'}};
  assert.equal((await f.run(payload)).state,'SUCCEEDED');
  const write=f.calls.find(call=>call.url.endsWith('/models/pastePageInfo.htm'));
  assert.equal(write.body.pageId,'PG-1');assert.equal(write.body.xml,undefined);
  f.calls.length=0;
  assert.equal((await f.run({...payload,expectedVersion:'stale'})).state,'REJECTED');
  assert.equal(f.calls.some(call=>call.url.endsWith('/models/pastePageInfo.htm')),false);
});

test('delete rejects product PAGE, wrong system and stale metadata without dispatch',async()=>{
  const f=fixture();const inspected=await f.run({action:'inspect',pageId:'PG-1'});
  f.page.isProduct=1;
  const result=await f.run({action:'delete',pageId:'PG-1',expectedVersion:'v1',expectedPage:{...inspected.page,isProduct:1}});
  assert.equal(result.state,'REJECTED');assert.equal(f.calls.some(call=>call.url.endsWith('/pages/remove.htm')),false);
  f.page.systemId='OTHER';assert.equal((await f.run({action:'inspect',pageId:'PG-1'})).state,'REJECTED');
});

test('lost mutation response is UNKNOWN and the page handler never retries',async()=>{
  const f=fixture();let writes=0;
  f.box.fetch=async()=>{writes++;throw Error('lost response');};
  const result=await f.run({action:'create',properties:{systemId:'SYS-1',mkId:'MK-1',pageType:1,pageName:'主页面',title:'Example'}});
  assert.equal(result.state,'UNKNOWN');assert.equal(writes,1);assert.equal(result.platformApplied,null);
});
