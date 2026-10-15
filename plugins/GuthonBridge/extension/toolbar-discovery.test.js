const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./content.js'), 'utf8');
const discovery = source.slice(source.indexOf('async function applyInlineWorkspaceMode()'), source.indexOf('async function publishPageContext('));

test('automatic toolbar discovery stays quiet until a target is available and retries successfully', async () => {
  const messages = [];
  const root = { dataset: { mode: 'module' }, querySelector: () => ({ hidden: false }) };
  let target = { ok: false, message: '当前模块开发页面没有识别到页面编码' };
  let routes = 0;
  let published = 0;
  const context = vm.createContext({
    document: { getElementById: () => root },
    FLOATING_ROOT_ID: 'toolbar',
    location: { origin: 'https://platform.example', pathname: '/index.html', hash: '#/gdpaas/dev/modules' },
    runPageCommand: async () => target,
    sendWorkspaceRequest: async () => { routes++; return { ok: true, workspaceKey: 'projects.demo', workspace: { sourceMode: 'database' } }; },
    publishPageContext: async () => { published++; },
    setMessage: (...args) => messages.push(args),
  });
  vm.runInContext(discovery, context);
  await context.applyInlineWorkspaceMode();
  assert.equal(messages.length, 0);
  assert.equal(routes, 0);
  assert.equal(root.dataset.workspaceModeChecking, undefined);
  assert.equal(root.dataset.workspaceModeCheckedAt, undefined);
  target = { ok: true, data: { pageId: 'PG-DEMO', dataSourceId: '0001' } };
  await context.applyInlineWorkspaceMode();
  assert.equal(routes, 1);
  assert.equal(published, 1);
  assert.equal(root.dataset.workspaceMode, 'database');
  assert.equal(messages.length, 0);
});

test('automatic discovery does not clear the result of a user action', async () => {
  const context = vm.createContext({
    document: { getElementById: () => ({ dataset: {} }) },
    FLOATING_ROOT_ID: 'toolbar',
    location: { origin: 'https://platform.example', pathname: '/', hash: '' },
    runPageCommand: async () => ({ ok: false }),
    setMessage: () => assert.fail('Automatic discovery must not overwrite user feedback'),
  });
  vm.runInContext(discovery, context);
  await context.applyInlineWorkspaceMode();
});


test('automatic routing stays quiet when Bridge is offline and recovers on the next refresh', async () => {
  const root = { dataset: { mode: 'module' }, querySelector: () => ({ hidden: false }) };
  let route = { ok: false, message: 'Failed to fetch' };
  let published = 0;
  const context = vm.createContext({
    document: { getElementById: () => root },
    FLOATING_ROOT_ID: 'toolbar',
    location: { origin: 'https://platform.example', pathname: '/', hash: '' },
    runPageCommand: async () => ({ ok: true, data: { pageId: 'PG-DEMO' } }),
    sendWorkspaceRequest: async () => route,
    publishPageContext: async () => { published++; },
    setMessage: () => assert.fail('Background connection failure must not overwrite toolbar feedback'),
  });
  vm.runInContext(discovery, context);
  await context.applyInlineWorkspaceMode();
  assert.equal(root.dataset.workspaceModeCheckedAt, undefined);
  assert.equal(root.dataset.workspaceModeChecking, undefined);
  assert.equal(published, 0);
  route = { ok: true, workspaceKey: 'projects.demo', workspace: { sourceMode: 'database' } };
  await context.applyInlineWorkspaceMode();
  assert.equal(root.dataset.workspaceMode, 'database');
  assert.equal(published, 1);
});
