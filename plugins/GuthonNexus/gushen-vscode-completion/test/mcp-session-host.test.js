const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {McpSessionHost,descriptorName}=require('../src/api/mcp-session-host');

function query(home,key,action='systems') {
  const root=path.resolve(__dirname,'../../../..');
  const script='import json,sys\nfrom providers.api.session_proxy import execute\nfrom providers.api.client import ApiError\ntry: print(json.dumps(execute(sys.argv[1],sys.argv[2],sys.argv[3],{})))\nexcept ApiError as e: print(json.dumps({"error":e.code}))';
  return new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'.venv','bin','python'),['-c',script,home,key,action],
      {env:{...process.env,PYTHONPATH:path.join(root,'scripts'),PYTHONDONTWRITEBYTECODE:'1'}});
    let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);
    child.on('error',reject);child.on('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)));
  });
}
test('independent Python process reuses only the matching Nexus session; logout and close invalidate access',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-session-test-'));let authenticated=true,calls=0;
  const host=new McpSessionHost({run:async(key,action)=>{calls++;if(!authenticated)throw Object.assign(Error('请登录'),{code:'API_LOGIN_REQUIRED'});return {key,action,systems:[{systemId:'A'}]};}});
  t.after(async()=>{await host.close();fs.rmSync(home,{recursive:true,force:true});});
  assert.equal((await query(home,'projects.A')).error,'API_MCP_SESSION_REQUIRED');
  await Promise.all([host.sync(home,['projects.A']),host.sync(home,['projects.A'])]);
  assert.deepEqual(await query(home,'projects.A'),{key:'projects.A',action:'systems',systems:[{systemId:'A'}]});
  assert.equal((await query(home,'projects.B')).error,'API_MCP_SESSION_REQUIRED');
  assert.equal(calls,1);
  authenticated=false;assert.equal((await query(home,'projects.A')).error,'API_LOGIN_REQUIRED');
  assert.equal(calls,2);await host.close();
  assert.equal((await query(home,'projects.A')).error,'API_MCP_SESSION_REQUIRED');
});
test('session descriptor is private and old windows cannot delete a replacement registration',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-session-owner-'));
  const a=new McpSessionHost({run:async()=>({owner:'old'})}),b=new McpSessionHost({run:async()=>({owner:'new'})});
  t.after(async()=>{await a.close();await b.close();fs.rmSync(home,{recursive:true,force:true});});
  await a.sync(home,['projects.A']);await b.sync(home,['projects.A']);await a.close();
  const file=path.join(home,'var','nexus','mcp',descriptorName('projects.A'));
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.deepEqual(await query(home,'projects.A'),{owner:'new'});
  await b.sync(home,['projects.B']);assert.equal(fs.existsSync(file),false);
});

test('generated stdio configuration discovers real backend tools and completes an online readonly query',async t=>{
  const {execFile}=require('node:child_process'),{promisify}=require('node:util');
  const {configurationText,probeMcp}=require('../src/api/mcp-configuration');
  const root=path.resolve(__dirname,'../../../..'),home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon config '));
  const python=path.join(root,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  const setup=`import os,sys\nfrom pathlib import Path\nimport guthon_tool\nfrom common import gusen_hub\nfrom common.workspace_config import create_workspace\nfrom providers.api import workspace\nhome=Path(sys.argv[1]);os.environ['GUTHON_HOME']=str(home)\nguthon_tool.setup_config(home)\ncreate_workspace(home,{'kind':'project','id':'probe','name':'Probe','sourceMode':'api'},gusen_hub)\nw=gusen_hub.resolve_workspace(gusen_hub.load_config(),'projects.probe')\nworkspace.configure(w,{'serverUrl':'https://fixture.invalid','systemIds':['A']})`;
  await promisify(execFile)(python,['-c',setup,home],{env:{...process.env,PYTHONPATH:path.join(root,'scripts'),PYTHONDONTWRITEBYTECODE:'1'}});
  const seen=[],host=new McpSessionHost({run:async(key,action)=>{seen.push({key,action});return {menu:[{systemId:'A',menus:[]}]};}});
  t.after(async()=>{await host.close();fs.rmSync(home,{recursive:true,force:true});});
  await host.sync(home,['projects.probe']);
  const {server}=configurationText('',{key:'servers'},{toolPath:python,toolEntry:path.join(root,'scripts/guthon_tool.py'),toolHome:home},true);
  const result=await probeMcp(server,'projects.probe');assert.ok(result.tools>10);assert.equal(result.online,true);
  assert.deepEqual(seen,[{key:'projects.probe',action:'system-menu'}]);
  await host.close();const after=await probeMcp(server,'projects.probe');assert.equal(after.online,false);
});
