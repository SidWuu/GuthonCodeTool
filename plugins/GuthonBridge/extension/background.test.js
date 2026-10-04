const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  let listener;
  const calls = [];
  const id = 'a'.repeat(32);
  const context = {
    importScripts() {},
    GuthonBridgeHost: require('./host-config'),
    GuthonBridgeNexusLocator: require('./nexus-locator'),
    URL, AbortController, setTimeout, clearTimeout,
    GuthonBridgeEvents: {consume: async () => new Promise(() => {})},
    chrome: {
      runtime: { id, getURL: (name) => `chrome-extension://${id}/${name}`, onInstalled: { addListener() {} }, onMessage: { addListener(value) { listener = value; } } },
      storage: { local: { async get() { return { guthonBridgeToken: 'f'.repeat(64), guthonBridgePort: 17499, guthonBridgeClientId: 'a'.repeat(32) }; } } },
      tabs: { async query() { return [{id:1,url:'https://gusen.steel56.com.cn/guthon/'}]; } }
    },
    async fetch(url, options) { calls.push({url,options}); return {ok:true,status:200,async json(){return {ok:true, workspaceKey: 'products.demo'};}}; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);
  return { id, calls, context, send: (message, sender) => new Promise((resolve) => listener(message, sender, resolve)) };
}

test('background rejects foreign extension and untrusted page senders', async () => {
  const f = fixture();
  const message = { type: 'pull-hub-source', payload: {} };
  assert.equal((await f.send(message, {id:'b'.repeat(32),tab:{url:'https://gusen.steel56.com.cn/guthon/'}})).ok, false);
  assert.equal((await f.send(message, {id:f.id,tab:{url:'https://malicious.example/guthon/'}})).ok, false);
  assert.equal(f.calls.length, 0);
});

test('background owns snapshot client/tab/origin and rejects popup publication', async () => {
  const f = fixture();
  const payload = {clientId: 'forged', tabId: 999, pageOrigin: 'https://forged.example', workspaceKey: 'products.demo', metadata: {dataSourceId: 'DS-1'}};
  const popup = {id:f.id,url:`chrome-extension://${f.id}/popup.html`};
  assert.equal((await f.send({type: 'publish-page-context', payload}, popup)).ok, false);
  const result = await f.send({type: 'publish-page-context', payload}, {id: f.id, tab: {id: 1, url: 'https://gusen.steel56.com.cn/guthon/'}});
  assert.equal(result.ok, true);
  const posted = JSON.parse(f.calls.find(call => call.url.endsWith('/pageContext')).options.body);
  assert.equal(posted.clientId, 'a'.repeat(32)); assert.equal(posted.tabId, 1);
  assert.equal(posted.pageOrigin, 'https://gusen.steel56.com.cn');
});

test('reverse event rechecks current platform identity before navigation and reports explicit failure', async () => {
  const f = fixture(); const pageCalls = [];
  const tab = {id: 1, windowId: 2, url: 'https://gusen.steel56.com.cn/guthon/'};
  f.context.chrome.tabs.get = async () => tab;
  f.context.chrome.tabs.update = async () => {};
  f.context.chrome.windows = {update: async () => {}};
  f.context.chrome.tabs.sendMessage = async (tabId, message) => {
    pageCalls.push(message);
    return message.command === 'inspect-page-context' ? {ok: true, data: {dataSourceId: 'DS-1'}} : {ok: true};
  };
  await f.send({type: 'publish-page-context', payload: {workspaceKey: 'products.demo', metadata: {dataSourceId: 'DS-1'}}}, {id: f.id, tab});
  const command = {requestId: 'request-1', clientId: 'a'.repeat(32), contextId: `${'a'.repeat(32)}:1`,
    tabId: 1, workspaceKey: 'products.demo', pageOrigin: 'https://gusen.steel56.com.cn', target: {type: 'procedure', alias: 'demo.pkg', funId: 'save'}};
  await f.context.handleBridgeEvent('navigate', command);
  assert.equal(pageCalls.find(message => message.command === 'open-source-target').payload.dataSourceId, 'DS-1');
  assert.equal(JSON.parse(f.calls.find(call => call.url.endsWith('/navigationResult')).options.body).ok, true);
  pageCalls.length = 0; f.calls.length = 0;
  f.context.fetch = async (url, options) => {f.calls.push({url, options}); return {ok: true, json: async () => ({ok: true, workspaceKey: 'projects.other'})};};
  await f.context.handleBridgeEvent('navigate', command);
  assert.equal(pageCalls.some(message => message.command === 'open-source-target'), false);
  const receipt = JSON.parse(f.calls.find(call => call.url.endsWith('/navigationResult')).options.body);
  assert.equal(receipt.ok, false); assert.match(receipt.message, /工作区/);
});

test('background owns origin and pairs every backend request at the configured port', async () => {
  const f = fixture();
  const result = await f.send({type:'pull-hub-source',payload:{workspaceKey:'products.demo',pageOrigin:'https://forged.example'}},{id:f.id,tab:{id:1,url:'https://gusen.steel56.com.cn/guthon/'}});
  assert.equal(result.ok, true);
  assert.equal(f.calls[0].url,'http://127.0.0.1:17499/pullHubSource');
  assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${'f'.repeat(64)}`);
  assert.equal(JSON.parse(f.calls[0].options.body).pageOrigin,'https://gusen.steel56.com.cn');
});

test('popup health uses authenticated status and reports non-JSON proxy responses', async () => {
  const f = fixture();
  const sender = {id:f.id,url:`chrome-extension://${f.id}/popup.html`};
  assert.equal((await f.send({type:'bridge-health'},sender)).ok,true);
  assert.equal(f.calls[0].url,'http://127.0.0.1:17499/status');
  f.context.fetch = async () => ({ok:false,status:502,json:async()=>{throw new Error('HTML');}});
  const result = await f.send({type:'bridge-health'},sender);
  assert.equal(result.ok,false);
  assert.match(result.message,/无效响应.*502/);
});
