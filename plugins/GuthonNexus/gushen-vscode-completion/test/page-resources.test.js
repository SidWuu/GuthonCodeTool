const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {DesignerResources,CHECK_INTERVAL}=require('../src/page-editor/resource-manager');
const snapshot=require('../src/page-editor/asset-snapshot');

async function fixture(t) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'designer-resources-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  let release='a',fail=false,incompatible=false,css='body{font-size:14px}';
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(fail){res.writeHead(503);res.end('offline');return;}
    let body;
    if(req.url==='/guthon/index.html')body=`<script src="/guthon/js/app.${release.repeat(6)}.js"></script><link href="/guthon/css/app.css" rel="stylesheet">`;
    else if(req.url===`/guthon/js/app.${release.repeat(6)}.js`)body=incompatible?'unsupported bundle':`n.p="/guthon/";v.a.prototype.$api=a,v.a.prototype.$config=c,v.a.prototype.$gScript=s;var root=new v.a({version:'${release}'});`;
    else if(req.url==='/guthon/css/app.css')body=css;
    else if(['/guthon/editor.worker.js','/guthon/ts.worker.js'].includes(req.url))body='worker';
    res.writeHead(body===undefined?404:200);res.end(body||'missing');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/guthon/index.html`;
  let time=100000;
  const manager=new DesignerResources({getTool:async()=>({toolHome:home}),now:()=>time});
  return {home,url,manager,requests,setRelease(value){release=value;},setFail(value){fail=value;},
    setIncompatible(value){incompatible=value;},setCss(value){css=value;},advance(){time+=CHECK_INTERVAL+1;}};
}

test('first connection prepares assets; per-workspace binding persists; cache reuse makes no network call',async t=>{
  const f=await fixture(t);
  assert.equal(await f.manager.cached('projects.one'),null);
  const first=await f.manager.connect('projects.one',f.url+'#/gdpaas/dev/modules');
  assert.equal(first.state,'current');assert.equal(first.platformUrl,f.url);
  assert.match(first.root,/var\/nexus\/page-designer\/platforms\//);
  const count=f.requests.length;
  const cached=await f.manager.resolve('projects.one');
  assert.equal(cached.build,first.build);assert.equal(f.requests.length,count);
  const second=await f.manager.connect('projects.two',f.url);
  assert.equal(second.root,first.root);
  const restarted=new DesignerResources({getTool:async()=>({toolHome:f.home}),now:()=>100000});
  assert.equal((await restarted.resolve('projects.one')).build,first.build);
  assert.equal(await restarted.cached('projects.other'),null);
});

test('resource preparation reports probing, each downloaded file, validation and binding',async t=>{
  const f=await fixture(t),messages=[];
  await f.manager.connect('projects.progress',f.url,{onProgress:message=>messages.push(message)});
  assert.match(messages[0],/读取平台入口/);
  assert.ok(messages.some(message=>/探测入口资源.*app\./.test(message)));
  assert.ok(messages.some(message=>/正在下载 guthon\/index.html/.test(message)));
  assert.ok(messages.some(message=>/已下载.*累计.*MB/.test(message)));
  assert.ok(messages.some(message=>/校验资源清单/.test(message)));
  assert.match(messages.at(-1),/资源已校验.*正在绑定/);
  messages.length=0;
  await f.manager.connect('projects.progress',f.url,{onProgress:message=>messages.push(message)});
  assert.ok(messages.some(message=>/资源已校验/.test(message)));
  assert.equal(messages.some(message=>message.startsWith('正在下载')),false);
});

test('platform upgrades are detected without switching; old and new versions coexist and rollback is workspace-local',async t=>{
  const f=await fixture(t),old=await f.manager.connect('projects.one',f.url);
  await f.manager.connect('projects.two',f.url);
  f.setRelease('b');f.advance();
  const changed=await f.manager.resolve('projects.one');
  assert.equal(changed.state,'update-available');assert.equal(changed.build,old.build);
  assert.equal(changed.updateAvailable,true);assert.notEqual(changed.observedBuild,old.build);
  const updated=await f.manager.connect('projects.one',f.url);
  assert.equal(updated.build,changed.observedBuild);
  assert.equal((await f.manager.cached('projects.two')).build,old.build);
  assert.equal((await f.manager.versions('projects.one')).length,2);
  const rolled=await f.manager.select('projects.one',old.build);
  assert.equal(rolled.state,'pinned');assert.equal(rolled.updateAvailable,true);assert.equal(rolled.upgradeAcknowledged,true);
  assert.equal((await f.manager.cached('projects.one')).build,old.build);
});

test('offline checks retain verified resources, suppress repeated failures briefly and remain explicitly unverified',async t=>{
  const f=await fixture(t),old=await f.manager.connect('projects.one',f.url);
  f.setFail(true);f.advance();
  const offline=await f.manager.resolve('projects.one');assert.equal(offline.state,'offline');assert.equal(offline.build,old.build);
  assert.match(offline.message,/检查失败/);const count=f.requests.length;
  await f.manager.resolve('projects.one');assert.equal(f.requests.length,count);
  await f.manager.resolve('projects.one',{forceCheck:true});assert.ok(f.requests.length>count);
});

test('failed downloads, incompatible adapters and source changes never replace a usable binding',async t=>{
  const f=await fixture(t),old=await f.manager.connect('projects.one',f.url);
  f.setRelease('b');f.setIncompatible(true);
  await assert.rejects(f.manager.connect('projects.one',f.url),/不兼容/);
  assert.equal((await f.manager.cached('projects.one')).build,old.build);
  f.setIncompatible(false);
  const realDownload=f.manager.download;
  f.manager.download=async(...args)=>{f.setRelease('c');return realDownload(...args);};
  await assert.rejects(f.manager.connect('projects.one',f.url),/构建变化/);
  assert.equal((await f.manager.cached('projects.one')).build,old.build);
  const location=await f.manager.readBinding('projects.one');
  const names=await fs.readdir(path.join(location.root,'platforms',old.platformKey));
  assert.equal(names.some(name=>name.startsWith('.pending-')),false);
});

test('platforms and runtime homes are isolated; one workspace never takes another platform cache',async t=>{
  const one=await fixture(t),two=await fixture(t);
  const a=await one.manager.connect('projects.one',one.url);
  const b=await one.manager.connect('projects.two',two.url);
  assert.notEqual(a.root,b.root);assert.notEqual(a.platformKey,b.platformKey);
  assert.equal((await one.manager.cached('projects.one')).platformUrl,one.url);
  const otherHome=new DesignerResources({getTool:async()=>({toolHome:two.home})});
  assert.equal(await otherHome.cached('projects.one'),null);
  await assert.rejects(one.manager.select('projects.one','../bad'),/构建标识/);
  await assert.rejects(one.manager.cached('projects.one/../../bad'),/workspaceKey/);
});

test('corrupt caches and corrupt binding records are reported instead of silently falling back or overwriting',async t=>{
  const f=await fixture(t),original=await f.manager.connect('projects.one',f.url);
  await fs.appendFile(path.join(original.root,original.app),'tampered');
  await assert.rejects(f.manager.cached('projects.one'),/大小|哈希/);
  await assert.rejects(f.manager.connect('projects.one',f.url),/大小|哈希/);
  const location=await f.manager.location('projects.one');
  await fs.writeFile(location.binding,'{"version":1,"workspaceKey":"projects.other"}');
  await assert.rejects(f.manager.cached('projects.one'),/绑定损坏/);
});

test('local imports are copied to managed immutable cache and require matching platform provenance',async t=>{
  const f=await fixture(t),source=path.join(f.home,'external-snapshot');
  await snapshot.download(f.url,source);
  const imported=await f.manager.importLocal('projects.one',source);
  assert.equal(imported.state,'imported');assert.notEqual(imported.root,source);
  assert.equal(imported.lastCheckedAt,0);
  await assert.rejects(f.manager.importLocal('projects.two',source,'http://different.invalid/guthon/index.html'),/来源/);
  await fs.rm(source,{recursive:true,force:true});
  assert.equal((await f.manager.cached('projects.one')).build,imported.build);
});

test('simultaneous changes are serialized and cross-window locks do not permit partial activation',async t=>{
  const f=await fixture(t);
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const startedPromise=new Promise(resolve=>{started=resolve;});
  const probe=f.manager.remoteProbe;
  f.manager.remoteProbe=async(...args)=>{started();await gate;return probe(...args);};
  const job=f.manager.connect('projects.one',f.url);await startedPromise;
  await assert.rejects(f.manager.connect('projects.one',f.url),/正在处理/);
  const otherWindow=new DesignerResources({getTool:async()=>({toolHome:f.home})});
  await assert.rejects(otherWindow.connect('projects.one',f.url),/其他窗口/);
  release();await job;
  assert.equal((await f.manager.cached('projects.one')).state,'cached');
});

test('unchanged app filename with changed CSS still creates a distinct build',async t=>{
 const f=await fixture(t),old=await f.manager.connect('projects.one',f.url);
 f.setCss('body{font-size:15px}');
 const changed=await f.manager.resolve('projects.one',{forceCheck:true});
 assert.equal(changed.app,old.app);assert.equal(changed.updateAvailable,true);
 const updated=await f.manager.connect('projects.one',f.url);
 assert.notEqual(updated.build,old.build);assert.equal((await f.manager.versions('projects.one')).length,2);
});
test('snapshot preparation works with the IDE bundled Node HTTP client when fetch is unavailable',async t=>{
 const f=await fixture(t);
 const remote=await snapshot.probe(f.url,{fetchImpl:null});
 assert.match(remote.build,/^[a-f0-9]{64}$/);
 const directory=path.join(f.home,'node-http-snapshot');
 const downloaded=await snapshot.download(f.url,directory,{fetchImpl:null});
 assert.equal(downloaded.build,remote.build);
});
