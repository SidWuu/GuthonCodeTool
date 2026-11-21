const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

test('API refresh rechecks identity and capability, forwards one target and reports conflicts', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-api-refresh-'));
  const host=path.join(home,'host.js'), requests=path.join(home,'requests');
  fs.writeFileSync(host, `const fs=require('node:fs');process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(r)+'\\n');
    let result;
    if(r.command==='route') result={ok:true,workspaceKey:r.input.workspaceKey,workspace:{capabilities:{'api.pull':r.input.dataSourceId!=='DENIED'}}};
    else if(r.command==='api' && JSON.stringify(r.args)===JSON.stringify(['refresh','--stdin'])) result={ok:true,workspaceKey:r.workspaceKey,complete:false,conflicts:[{path:'local.gss'}]};
    else process.exit(2);
    process.stdout.write(JSON.stringify({type:'result',id:r.id,ok:true,result})+'\\n');
  });`);
  const listener=http.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,GUTHON_TOOL_HOME:home,GUTHON_TOOL_PATH:process.execPath,GUTHON_TOOL_ENTRY:host,GUTHON_BRIDGE_PORT:String(port)},stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;const deadline=Date.now()+5000;
    while(true){try{if((await fetch(base+'/health')).ok)break;}catch{} if(Date.now()>deadline)throw new Error('Bridge startup failed');await new Promise(resolve=>setTimeout(resolve,30));}
    const token=fs.readFileSync(path.join(home,'var/nexus/bridge/token'),'utf8');
    const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
    const job=(payload,operation='refresh-api-source')=>({requestId:`${Date.now()}_${require('node:crypto').randomUUID()}`,workspaceKey:'projects.demo',pageOrigin:'https://platform.test',operation,payload});
    const wait=async body=>{let r;for(let i=0;i<100;i++){r=await post('/jobStatus',body);if(['COMPLETED','FAILED','UNKNOWN'].includes(r.state))return r;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('job did not finish');};
    const selected=job({sourceType:'procedure',sourceId:'PR-1',procedureId:'PR-1',alias:'demo.pkg',funId:'save',dataSourceId:'DS',force:true});
    assert.equal((await post('/submitJob',selected)).status,202);
    const done=await wait(selected);assert.equal(done.state,'FAILED');assert.match(done.result.message,/冲突/);assert.equal(done.result.conflicts[0].path,'local.gss');
    const logged=fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse);const command=logged.find(r=>r.command==='api');
    assert.deepEqual(command.args,['refresh','--stdin']);assert.equal(command.workspaceKey,'projects.demo');
    assert.deepEqual(command.input,{sourceType:'procedure',sourceId:'PR-1',procedureId:'PR-1',alias:'demo.pkg',funId:'save',dataSourceId:'DS'});
    for(const payload of [{sourceType:'page'}, {sourceType:'view',dataSourceId:'DS'}, {sourceType:'procedure',alias:'demo'}]) {
      const bad=job(payload);await post('/submitJob',bad);assert.equal((await wait(bad)).state,'FAILED');
    }
    const denied=job({sourceType:'view',sourceId:'v',dataSourceId:'DENIED'});await post('/submitJob',denied);assert.match((await wait(denied)).message,/未授权/);
    const calls=fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(r=>r.command==='api').length,1);
    assert.equal((await post('/submitJob',job({},'export-table-schema'))).status,400);
    assert.equal((await post('/pullHubSource',{})).status,404);
  } finally {if(child.exitCode===null){child.kill();await once(child,'exit');}fs.rmSync(home,{recursive:true,force:true});}
});
