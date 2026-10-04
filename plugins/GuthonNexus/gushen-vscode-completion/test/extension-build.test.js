const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {extensionBuildInfo,registerExtensionBuild}=require('../src/extension-build');
test('same-version code changes alter the Nexus build ID while private logs and test files do not',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-build-'));
 try {
  fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.2.3'}));
  const code=path.join(root,'src','entry.js');fs.writeFileSync(code,'original');
  const first=extensionBuildInfo(root);
  fs.mkdirSync(path.join(root,'test'));fs.writeFileSync(path.join(root,'test','private.log'),'private');
  assert.deepEqual(extensionBuildInfo(root),first);
  fs.writeFileSync(code,'changed');const next=extensionBuildInfo(root);
  assert.equal(next.version,first.version);assert.notEqual(next.buildId,first.buildId);
  let shown=false;const item={show(){shown=true;},dispose(){}};const context={extensionPath:root,subscriptions:[]};
  const info=registerExtensionBuild({window:{createStatusBarItem:()=>item},StatusBarAlignment:{Right:1}},context);
  assert.equal(shown,true);assert.equal(context.subscriptions[0],item);assert.match(item.tooltip,new RegExp(info.buildId));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
