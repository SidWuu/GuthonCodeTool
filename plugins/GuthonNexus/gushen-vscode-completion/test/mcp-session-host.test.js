const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {McpSessionHost,descriptorName}=require('../src/api/mcp-session-host');

function query(home,key,action='systems',input={}) {
  const root=path.resolve(__dirname,'../../../..');
  const script='import json,sys\nfrom providers.api.session_proxy import execute\nfrom providers.api.client import ApiError\ntry: print(json.dumps(execute(sys.argv[1],sys.argv[2],sys.argv[3],json.loads(sys.argv[4]))))\nexcept ApiError as e: print(json.dumps({"error":e.code}))';
  return new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python'),['-c',script,home,key,action,JSON.stringify(input)],
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
  if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600); // POSIX mode; Windows ACL requires its own acceptance.
  assert.deepEqual(await query(home,'projects.A'),{owner:'new'});
  await b.sync(home,['projects.B']);assert.equal(fs.existsSync(file),false);
});

test('generated stdio finds the exact workspace mode without an online session',async t=>{
  const {execFile}=require('node:child_process'),{promisify}=require('node:util');
  const {configurationText,probeMcp}=require('../src/api/mcp-configuration');
  const root=path.resolve(__dirname,'../../../..'),home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon config '));
  const python=path.join(root,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  const setup=`import os,sys\nfrom pathlib import Path\nimport guthon_tool\nfrom common import gusen_hub\nfrom common.workspace_config import create_workspace\nfrom providers.api import workspace\nhome=Path(sys.argv[1]);os.environ['GUTHON_HOME']=str(home)\nguthon_tool.setup_config(home, workspace_name='研发根')\ncreate_workspace(home,{'id':'probe','name':'Probe'},gusen_hub)\nw=gusen_hub.resolve_workspace(gusen_hub.load_config(),'probe')\nworkspace.configure(w,{'serverUrl':'https://fixture.invalid','systemIds':['A']})`;
  await promisify(execFile)(python,['-c',setup,home],{env:{...process.env,PYTHONPATH:path.join(root,'scripts'),PYTHONDONTWRITEBYTECODE:'1'}});
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  assert(!fs.existsSync(path.join(home,'var')));
  const {server}=configurationText('',{key:'servers'},{toolPath:python,toolEntry:path.join(root,'scripts/guthon_tool.py'),toolHome:home},true);
  const result=await probeMcp(server,'probe');assert.ok(result.workspaceTools>10);assert.equal(result.sourceMode,'api');
  await assert.rejects(probeMcp(server,'missing'));
});

test('the full MCP wizard routes one generated service to independent product and project sources',async t=>{
  const {execFileSync}=require('node:child_process');
  const {createHash}=require('node:crypto');
  const {generateConfiguration,CLIENTS}=require('../src/api/mcp-configuration');
  const root=path.resolve(__dirname,'../../../..');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus full mcp '));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const python=path.join(root,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  const tool={toolPath:python,toolEntry:path.join(root,'scripts/guthon_tool.py'),toolHome:home};
  const env={...process.env,PYTHONPATH:path.join(root,'scripts'),PYTHONDONTWRITEBYTECODE:'1'};
  const sourcePath='datasources/D/procedures/sample/read.gss';
  const setup=`
import json, sys
from pathlib import Path
import guthon_tool
from common import config_store, gusen_hub
from common.runtime_paths import runtime_home_context
from common.workspace_config import create_workspace
from providers.api import workspace
from providers.api.download import source_file
from providers.api.store import ApiStore

home = Path(sys.argv[1]).resolve()
source_path = sys.argv[2]
fixtures = []
with runtime_home_context(home):
    guthon_tool.setup_config(home, workspace_name="独立 验证区")
    for kind, name, code in [("product", "样例产品", 101), ("project", "样例项目", 202)]:
        key = kind + "s.sample"
        create_workspace(home, {"id": key, "name": name}, gusen_hub)
        doc = config_store.read(home)
        doc["workspaces"][key]["identity"] = {"kind": kind, "layer": kind.upper()}
        config_store.write(home, doc)
        w = gusen_hub.resolve_workspace(gusen_hub.load_config(), key)
        workspace.configure(w, {"serverUrl": "https://fixture.invalid", "systemIds": ["S"], "dataSourceIds": ["D"]})
        text = f"#set($fixture = {code});\\n"
        file = source_file(source_path, text, "procedure", {
            "dataSourceId": "D", "procedureId": "SAMPLE", "funId": "read", "subPath": "sample",
        })
        ApiStore(w).publish([file])
        fixtures.append({"workspaceKey": key, "sourceMode": w["sourceMode"], "kind": w["kind"],
                         "root": str(w["root"]), "spaceRoot": str(w["spaceRoot"]),
                         "checkoutPath": str(w["providerSourceRoot"]), "source": text})
print(json.dumps(fixtures))
`;
  const fixtures=JSON.parse(execFileSync(python,['-c',setup,home,sourcePath],{env,encoding:'utf8',timeout:15000}));
  assert.deepEqual(fixtures.map(w=>w.kind),['product','project']);
  const client=CLIENTS.find(item=>item.label==='VS Code');
  const opened=fixtures[0].spaceRoot;
  const configs=[];
  for(const workspace of fixtures) {
    let preview;
    const vscode={
      workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:opened}}],
        openTextDocument:async doc=>({uri:doc.content})},
      window:{
        showQuickPick:async choices=>choices===CLIENTS?client:choices.find(x=>x.label==='完整 MCP 能力'),
        showWarningMessage:async(_text,options)=>{
          assert.match(options.detail,/完整 MCP 能力/);
          return '合并配置';
        },
        showInformationMessage:async()=>{},
      },
      commands:{executeCommand:async(name,_before,after)=>{assert.equal(name,'vscode.diff');preview=after;}},
    };
    const checked=await generateConfiguration({vscode,getTool:async()=>tool,workspaceKey:workspace.workspaceKey,
      selectWorkspace:async key=>{assert.equal(key,workspace.workspaceKey);return workspace;}});
    assert.equal(checked.workspaceTools,58);
    assert.equal(checked.platformTools,true);
    const written=fs.readFileSync(path.join(opened,client.file),'utf8');
    assert.equal(written,preview);
    const servers=JSON.parse(written).servers;
    assert.deepEqual(Object.keys(servers),['guthon-source-helper']);
    configs.push(servers['guthon-source-helper']);
  }
  assert.deepEqual(configs[0],configs[1]);
  const [server]=configs;
  const messages=[
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    ...fixtures.map(({workspaceKey},i)=>({jsonrpc:'2.0',id:i+2,method:'tools/call',params:{
      name:'api_read_source',arguments:{workspaceKey,path:sourcePath},
    }})),
  ];
  const result=execFileSync(server.command,server.args,{env,timeout:15000,encoding:'utf8',
    input:messages.map(message=>JSON.stringify(message)).join('\n')+'\n'});
  const replies=new Map(result.trim().split('\n').map(JSON.parse).map(item=>[item.id,item.result]));
  for(const [i,workspace] of fixtures.entries()) {
    const read=replies.get(i+2).structuredContent;
    const sample=fs.readFileSync(path.join(workspace.checkoutPath,sourcePath));
    assert.equal(read.workspaceKey,workspace.workspaceKey);
    assert.equal(read.data.content,workspace.source);
    assert.equal(read.data.sourceHash,createHash('sha256').update(sample).digest('hex'));
  }
});

test('MCP host cleanup succeeds after a descriptor publication failure',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-session-failure-'));
  fs.writeFileSync(path.join(home,'var'),'not a directory');
  const host=new McpSessionHost({run:async()=>({})});
  try {await assert.rejects(host.sync(home,['projects.A']));await host.close();assert.equal(host.server,undefined);}
  finally {await host.close();fs.rmSync(home,{recursive:true,force:true});}
});
test('MCP probe reports a missing runtime without an unhandled stdin error',async()=>{
  const {probeMcp}=require('../src/api/mcp-configuration');
  await assert.rejects(probeMcp({command:path.join(os.tmpdir(),'guthon-missing-'+require('node:crypto').randomUUID()),args:[]}),/ENOENT|EPIPE/);
});

test('independent MCP detail load preserves parameter identity and only exposes the typed remote action',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-module-session-')),seen=[];
 const host=new McpSessionHost({run:async(key,action,input)=>{seen.push({key,action,input});return {path:'systems/A/module-parameters/x.json',complete:true};}});
 t.after(async()=>{await host.close();fs.rmSync(home,{recursive:true,force:true});});
 await host.sync(home,['api-test']);const input={systemId:'A',configId:'x'};
 assert.deepEqual(await query(home,'api-test','module-parameter-load',input),{path:'systems/A/module-parameters/x.json',complete:true});
 assert.deepEqual(seen,[{key:'api-test',action:'module-parameter-load',input}]);
 assert.equal((await query(home,'api-test','module-parameter',{action:'save'})).error,'API_MCP_SESSION_FAILED');assert.equal(seen.length,1);
});

test('the Nexus session forwards exact PAGE edit preparation without exposing generic refresh',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-page-session-'));
  const calls=[];
  const host=new McpSessionHost({run:async(key,action,input)=>{
    calls.push({key,action,input});
    return {path:input.path,complete:true};
  }});
  t.after(async()=>{await host.close();fs.rmSync(home,{recursive:true,force:true});});
  const key='api-test';
  await host.sync(home,[key]);
  const input={path:'systems/A/pages/main/PG-1/PG-1.xml',expectedSourceHash:'a'.repeat(64)};
  assert.deepEqual(await query(home,key,'prepare-page-edit',input),{path:input.path,complete:true});
  assert.equal((await query(home,key,'refresh',{prefix:'systems/A'})).error,'API_MCP_SESSION_FAILED');
  assert.deepEqual(calls,[{key,action:'prepare-page-edit',input}]);
});
