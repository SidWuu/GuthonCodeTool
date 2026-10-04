const test = require('node:test');
const assert = require('node:assert/strict');
const {browserTarget, navigateInBrowser} = require('../src/svn/browser-navigation');
const identity = {workspaceKey: 'products.demo', sourceType: 'procedure', sourceAliasId: 'demo.pkg', funId: 'save'};
test('browser target accepts exact PAGE/procedure identity and rejects guessable or unsupported identities', () => {
  assert.deepEqual(browserTarget(identity), {type: 'procedure', alias: 'demo.pkg', funId: 'save'});
  assert.deepEqual(browserTarget({...identity, sourceType: 'page', sourceId: 'PG-1'}), {type: 'page', pageId: 'PG-1'});
  assert.throws(() => browserTarget({...identity, sourceAliasId: '', sourceId: 'demo.pkg#save'}), /平台身份/);
  assert.throws(() => browserTarget({...identity, workspaceKey: ''}), /工作区/);
  assert.throws(() => browserTarget({...identity, sourceType: 'table'}), /平台身份/);
});
function fixture(contexts, choose) {
  const calls = []; let ticks = 0;
  const bridge = {start() {}, async waitForReady() {}, async request(home, route, body) {
    calls.push({home, route, body});
    if (route.startsWith('/pageContext?')) return {contexts};
    if (route === '/navigate') return {requestId: 'request-1'};
    return {state: ticks++ ? 'SUCCEEDED' : 'PENDING'};
  }};
  const vscode = {window: {async showQuickPick(items) {calls.push({items}); return choose?.(items);}}};
  return {calls, options: {vscode, bridge, tool: {toolHome: '/tmp/tool'}, identity, sleep: async () => {}}};
}
test('unique workspace tab navigates without picker; multiple tabs require explicit choice', async () => {
  const context = {contextId: 'context-a', workspaceKey: 'products.demo', tabId: 1, pageOrigin: 'https://demo.test'};
  const f = fixture([context, {...context, workspaceKey: 'projects.other'}]);
  assert.equal((await navigateInBrowser(f.options)).state, 'SUCCEEDED');
  assert.equal(f.calls.some(call => call.items), false);
  assert.deepEqual(f.calls.find(call => call.route === '/navigate').body, {workspaceKey: identity.workspaceKey, contextId: 'context-a', target: browserTarget(identity)});
  const selected = fixture([context, {...context, contextId: 'context-b', tabId: 2}], items => items[1]);
  await navigateInBrowser(selected.options);
  assert.equal(selected.calls.find(call => call.route === '/navigate').body.contextId, 'context-b');
  const cancelled = fixture([context, {...context, contextId: 'context-b'}]);
  assert.equal(await navigateInBrowser(cancelled.options), undefined);
  assert.equal(cancelled.calls.some(call => call.route === '/navigate'), false);
});
test('no tab and failed receipt report actionable error, never replay commands', async () => {
  await assert.rejects(() => navigateInBrowser(fixture([]).options), /未找到/);
  const f = fixture([{contextId: 'context-a', workspaceKey: identity.workspaceKey}]);
  const original = f.options.bridge.request;
  f.options.bridge.request = async (home, route, body) => route.startsWith('/navigationResult?')
    ? {state: 'FAILED', message: '数据源已改变'} : original(home, route, body);
  await assert.rejects(() => navigateInBrowser(f.options), /数据源已改变/);
  assert.equal(f.calls.filter(call => call.route === '/navigate').length, 1);
});
