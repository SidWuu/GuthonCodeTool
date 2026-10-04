const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createPageContexts, snapshot} = require('./page-context');
const payload = {clientId: 'a'.repeat(32), tabId: 1, workspaceKey: 'products.demo', pageOrigin: 'https://example.test',
  metadata: {mode: 'page-source', pageId: 'PG-1', dataSourceId: 'DS-1', hash: '#/dev?secret=private', script: 'PRIVATE', selectedText: 'PRIVATE',
    openTabs: Array.from({length: 100}, () => ({id: 'tab-1', label: 'Page', script: 'PRIVATE'}))}};
function response() {
  const res = new EventEmitter(); res.frames = []; res.destroyed = false;
  res.writeHead = () => {}; res.write = frame => {res.frames.push(frame); return true;};
  res.end = res.destroy = () => {res.destroyed = true; res.emit('close');};
  return res;
}
test('snapshot projects bounded metadata and strips bodies, selections and URL query', () => {
  const value = snapshot(payload);
  assert.equal(value.openTabs.length, 32);
  assert.equal(value.hash, '#/dev');
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.throws(() => snapshot({...payload, workspaceKey: 'demo'}), /工作区/);
  assert.throws(() => snapshot({...payload, pageOrigin: 'https://example.test/path'}), /来源/);
});
test('snapshots expire, clear changed workspace and enforce capacity', () => {
  let now = 1; const registry = createPageContexts({now: () => now, ttlMs: 10, limit: 1});
  const res = response(); registry.subscribe(res, {workspaceKey: 'products.demo'});
  try {
    const value = registry.publish(payload);
    assert.throws(() => registry.get(value.contextId, 'projects.other'), /不属于/);
    assert.throws(() => registry.publish({...payload, tabId: 2}), /容量/);
    registry.publish({...payload, workspaceKey: 'projects.other'});
    assert.equal(registry.list('products.demo').length, 0);
    assert.ok(res.frames.some(frame => frame.includes('page-context-removed')));
    now = 12; assert.equal(registry.list('projects.other').length, 0);
  } finally {registry.dispose();}
});
test('navigation requires connected exact context, strips unexpected target fields and validates receipt', () => {
  const registry = createPageContexts(); const context = registry.publish(payload);
  const input = {contextId: context.contextId, workspaceKey: context.workspaceKey,
    target: {type: 'page', pageId: 'PG-2', script: 'PRIVATE', execute: 'PRIVATE'}};
  assert.throws(() => registry.navigate(input), /事件连接/);
  const res = response(); registry.subscribe(res, {clientId: payload.clientId});
  try {
    assert.throws(() => registry.navigate({...input, workspaceKey: 'projects.other'}), /不属于/);
    assert.throws(() => registry.navigate({...input, target: {type: 'script', script: 'PRIVATE'}}), /精确/);
    const accepted = registry.navigate(input);
    assert.ok(res.frames.some(frame => frame.includes('event: navigate')));
    assert.equal(res.frames.join('').includes('PRIVATE'), false);
    assert.throws(() => registry.complete({...payload, requestId: accepted.requestId, tabId: 2, ok: true}), /身份不匹配/);
    registry.complete({...payload, requestId: accepted.requestId, ok: true});
    assert.equal(registry.result({...input, requestId: accepted.requestId}).state, 'SUCCEEDED');
    registry.complete({...payload, requestId: accepted.requestId, ok: false});
    assert.equal(registry.result({...input, requestId: accepted.requestId}).state, 'SUCCEEDED');
  } finally {registry.dispose();}
});
test('reconnection replaces stale subscriber and never replays navigation', () => {
  const registry = createPageContexts(); const context = registry.publish(payload);
  const old = response(); registry.subscribe(old, {clientId: payload.clientId});
  registry.navigate({contextId: context.contextId, workspaceKey: context.workspaceKey, target: {type: 'page', pageId: 'PG-1'}});
  const res = response(); registry.subscribe(res, {clientId: payload.clientId});
  try {assert.equal(old.destroyed, true); assert.equal(res.frames.join('').includes('navigate'), false);}
  finally {registry.dispose();}
});
