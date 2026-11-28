const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {consume} = require('../extension/event-client');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('paired Bridge dispatches PAGE inspection and one native write, then returns the original receipt', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-page-life-'));
  const host = path.join(home, 'host.js');
  fs.writeFileSync(host, `process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line), p=r.input;
 const valid=r.command==='route' && p.workspaceKey==='products.demo' && p.pageOrigin==='https://platform.test' && p.systemId==='SYS-1';
 process.stdout.write(JSON.stringify({type:'result',id:r.id,ok:valid,...(valid?{result:{ok:true,workspaceKey:p.workspaceKey,workspace:{capabilities:{'source.read':true,'api.edit':true}}}}:{error:{message:'identity mismatch'}})})+'\\n');
});`);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {cwd: __dirname, env: {...process.env,
    GUTHON_TOOL_HOME: home, GUTHON_TOOL_PATH: process.execPath, GUTHON_TOOL_ENTRY: host, GUTHON_BRIDGE_PORT: String(port)}, stdio: 'ignore'});
  const base = `http://127.0.0.1:${port}`;
  let worker;
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error('Bridge startup failed');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const token = fs.readFileSync(path.join(home, 'var/nexus/bridge/token'), 'utf8').trim();
    const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
    const identity = 'a'.repeat(32);
    const tab = {id: 1, url: 'https://platform.test/guthon/'};
    const metadata = {mode: 'page-source', pageId: '', dataSourceId: '', systemId: 'SYS-1', systemIds: ['SYS-1']};
    const tree = {data: [{t: 2, item: {systemId: 'SYS-1', mkId: 'MK-1'}}], getTreeNodeData() {}, $store: {state: {modeDev: {systemId: 'SYS-1'}}}};
    let writes = 0, loseResponse = false, listener, streamReady;
    const connected = new Promise(resolve => {streamReady = resolve;});
    const native = {location: {origin: 'https://platform.test', pathname: '/guthon/'}, document: {querySelectorAll: () => [{__vue__: tree}]},
      URLSearchParams, AbortSignal, async fetch(url) {
        if (url.endsWith('/getPageBaseInfo.htm')) return {ok: true, text: async () => JSON.stringify({code: 0, data: {page: {pageId: 'PG-NEW', systemId: 'SYS-1', mkId: 'MK-1'}}})};
        writes++; if (loseResponse) throw new Error('connection lost');
        return {ok: true, text: async () => JSON.stringify({code: 0, data: {bean: {pageId: 'PG-NEW', systemId: 'SYS-1', mkId: 'MK-1'}}})};}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/page-lifecycle.js'), 'utf8'), native);
    worker = {importScripts() {}, URL, AbortController, setTimeout, clearTimeout, fetch,
      GuthonBridgeHost: {isAllowed: url => url === tab.url},
      GuthonBridgeEvents: {consume: async (response, callback) => {streamReady(); return consume(response, callback);}},
      runPageLifecycle: native.runPageLifecycle,
      chrome: {runtime: {id: identity, getURL: name => `chrome-extension://${identity}/${name}`, onInstalled: {addListener() {}}, onMessage: {addListener(fn) {listener = fn;}}},
        storage: {local: {get: async () => ({guthonBridgeToken: token, guthonBridgePort: port, guthonBridgeClientId: identity})}},
        tabs: {get: async () => tab, sendMessage: async () => ({ok: true, data: metadata})},
        scripting: {executeScript: async ({args}) => [{result: await native.runPageLifecycle(args[0])}]}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), worker);
    const published = await new Promise(resolve => listener({type: 'publish-page-context', payload: {workspaceKey: 'products.demo', metadata}}, {id: identity, tab}, resolve));
    assert.equal(published.ok, true);
    await connected;
    const contexts = await (await fetch(base + '/pageContext?workspaceKey=products.demo', {headers})).json();
    assert.equal(contexts.contexts.length, 1);
    const contextId = contexts.contexts[0].contextId;
    const dispatch = async target => {
      const response = await fetch(base + '/pageLifecycle', {method: 'POST', headers, body: JSON.stringify({workspaceKey: 'products.demo', contextId, target})});
      const accepted = await response.json();
      assert.equal(accepted.state, 'PENDING', accepted.message);
      for (let i = 0; i < 100; i++) {
        const result = await (await fetch(base + `/navigationResult?workspaceKey=products.demo&requestId=${accepted.requestId}`, {headers})).json();
        if (result.state !== 'PENDING') return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('original receipt did not arrive');
    };
    const inspected = await dispatch({action: 'inspect', pageId: ''});
    assert.equal(inspected.data.state, 'SUCCEEDED');
    assert.equal(inspected.data.modules[0].mkId, 'MK-1');
    const target = {action: 'create', pageId: '', properties: {systemId: 'SYS-1', mkId: 'MK-1', pageType: 1, pageName: 'Example', title: 'Example'}};
    const saved = await dispatch(target);
    assert.equal(saved.data.state, 'SUCCEEDED');
    assert.equal(saved.data.page.pageId, 'PG-NEW');
    assert.equal(writes, 1);
    loseResponse = true;
    const unknown = await dispatch(target);
    assert.equal(unknown.data.state, 'UNKNOWN');
    assert.equal(writes, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(writes, 2, 'an unknown write must not be retried');
  } finally {
    if (worker) vm.runInNewContext('publishedTabs.clear(); eventConnection?.abort()', worker);
    if (child.exitCode === null) {child.kill(); await once(child, 'exit');}
    fs.rmSync(home, {recursive: true, force: true});
  }
});
