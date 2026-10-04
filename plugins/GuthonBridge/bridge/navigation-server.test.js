const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

test('pageContext and SSE require Bearer, reject web Origin and recheck workspace identity for navigation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-navigation-'));
  const host = path.join(home, 'host.js');
  fs.writeFileSync(host, `process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line), p=r.input;
 if(r.command!=='route' || JSON.stringify(p).includes('PRIVATE'))process.exit(3);
 const valid=p.workspaceKey==='products.demo' && p.pageOrigin==='https://platform.test' && p.dataSourceId==='DS-1';
 process.stdout.write(JSON.stringify({type:'result',id:r.id,ok:valid,...(valid?{result:{ok:true,workspaceKey:p.workspaceKey}}:{error:{message:'Page identity does not match workspace'}})})+'\\n');
});`);
  const port = 17548;
  const child = spawn(process.execPath, ['server.js'], {cwd: __dirname,
    env: {...process.env, GUTHON_TOOL_HOME: home, GUTHON_TOOL_PATH: process.execPath, GUTHON_TOOL_ENTRY: host, GUTHON_BRIDGE_PORT: String(port)}, stdio: 'ignore'});
  const base = `http://127.0.0.1:${port}`;
  const streams = [];
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try {if ((await fetch(`${base}/health`)).ok) break;} catch {}
      if (Date.now() > deadline) throw new Error('Bridge startup failed');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const token = fs.readFileSync(path.join(home, 'var/nexus/bridge/token'), 'utf8');
    const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
    const post = (route, body) => fetch(base + route, {method: 'POST', headers, body: JSON.stringify(body)});
    assert.equal((await fetch(base + '/events?workspaceKey=products.demo')).status, 401);
    assert.equal((await fetch(base + '/pageContext?workspaceKey=products.demo', {headers: {...headers, Origin: 'https://platform.test'}})).status, 403);
    assert.equal((await fetch(base + '/events?clientId=' + 'a'.repeat(32), {headers: {...headers, Origin: 'https://platform.test'}})).status, 403);
    const payload = {clientId: 'a'.repeat(32), tabId: 1, workspaceKey: 'products.demo', pageOrigin: 'https://platform.test',
      metadata: {dataSourceId: 'DS-1', pageId: 'PG-1', mode: 'page-source', script: 'PRIVATE', selectedText: 'PRIVATE'}};
    assert.equal((await post('/pageContext', {...payload, workspaceKey: 'projects.other'})).status, 400);
    const published = await (await post('/pageContext', payload)).json();
    assert.equal(published.ok, true, published.message);
    assert.equal(JSON.stringify(published).includes('PRIVATE'), false);
    const controller = new AbortController(); streams.push(controller);
    const stream = await fetch(base + '/events?clientId=' + payload.clientId, {headers, signal: controller.signal});
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader(); await reader.read();
    assert.equal((await post('/navigate', {contextId: published.context.contextId, workspaceKey: 'projects.other', target: {type: 'page', pageId: 'PG-1'}})).status, 400);
    const accepted = await (await post('/navigate', {contextId: published.context.contextId, workspaceKey: payload.workspaceKey, target: {type: 'page', pageId: 'PG-1'}})).json();
    assert.equal(accepted.state, 'PENDING');
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /event: navigate/);
    const receipt = await (await post('/navigationResult', {...payload, requestId: accepted.requestId, ok: true})).json();
    assert.equal(receipt.state, 'SUCCEEDED');
    const state = await (await fetch(base + `/navigationResult?workspaceKey=products.demo&requestId=${accepted.requestId}`, {headers})).json();
    assert.equal(state.state, 'SUCCEEDED');
    await post('/removePageContext', {clientId: payload.clientId, tabId: 1});
    const contexts = await (await fetch(base + '/pageContext?workspaceKey=products.demo', {headers})).json();
    assert.equal(contexts.contexts.length, 0);
  } finally {
    for (const stream of streams) stream.abort();
    if (child.exitCode === null) {child.kill(); await once(child, 'exit');}
    fs.rmSync(home, {recursive: true, force: true});
  }
});
