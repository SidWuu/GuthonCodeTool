const test = require('node:test');
const assert = require('node:assert/strict');

test('inheritance view deduplicates reads, handles Unicode source offsets and rejects stalled paging',async()=>{
  const {SvnInheritanceView}=require('../src/svn/inheritance-view');
  class EventEmitter{constructor(){this.event=()=>{};}fire(){}dispose(){}}
  const Uri={parse:value=>({toString:()=>value})};let reads=0;let release;
  const provider=new SvnInheritanceView({vscode:{EventEmitter,Uri,workspace:{textDocuments:[]}},backend:{pageQuery:async()=>{reads+=1;return new Promise(resolve=>{release=resolve;});}}});
  const uri={toString:()=> 'guthon-svn-inherit://projects.demo/test'};
  provider.identities.set(uri.toString(),{workspaceKey:'projects.demo',sourceType:'procedure',sourceId:'demo#save',workingCopyId:'wc'});
  const first=provider.provideTextDocumentContent(uri);const same=provider.provideTextDocumentContent(uri);assert.equal(reads,1);
  release({complete:true,effective:{content:'😀abc'},inheritanceStatus:'ACTIVE',project:{sourceHash:'a'},product:{sourceHash:'b'},segments:[{layer:'product',start:1,end:4,sourceLine:1,effectiveLine:1}]});
  const [text,duplicate]=await Promise.all([first,same]);assert.equal(text,duplicate);assert.ok(text.includes('\nabc\n'));assert.equal(text.includes('\n\ude00ab\n'),false);
  provider.invalidate('projects.demo');provider.backend.pageQuery=async()=>({complete:false,nextOffset:0,project:{sourceHash:'a'},product:{sourceHash:'b'}});
  assert.match(await provider.provideTextDocumentContent(uri),/分页未前进/);provider.dispose();
});
