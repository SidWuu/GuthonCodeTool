const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./content.js'), 'utf8');
const discovery = source.slice(source.indexOf('function renderFloatingToolbar('), source.indexOf('function installSystemScriptSelection('));

const api = { sourceMode: 'api', capabilities: { 'api.pull': true, 'source.read': true } };
const database = { sourceMode: 'database', capabilities: { 'database.sourceSync': true, 'source.read': true, 'workcopy.open': true } };
const svn = { sourceMode: 'svn', capabilities: { 'source.read': true } };
const matched = workspace => ({ ok: true, workspaceKey: 'projects.demo', workspace });

function toolbarFixture(mode = 'module') {
    const nodes = new Map(
        ['[data-mode-label]', ...['sync', 'fields', 'ide'].map(group => `[data-group="${group}"]`),
            ...['workspace', 'local-fields', 'locate'].map(action => `[data-action="${action}"]`)]
            .map(selector => [selector, {}])
    );
    const root = {
        isConnected: true,
        dataset: { mode },
        querySelector(selector) {
            assert.ok(nodes.has(selector), selector);
            return nodes.get(selector);
        },
    };
    const visible = () => [...nodes.entries()]
        .filter(([selector, node]) => selector !== '[data-mode-label]' && !node.hidden)
        .map(([selector]) => selector.match(/"([^"]+)"/)[1]);
    const state = { tab: 'first', target: { ok: true, data: { pageId: 'PG-DEMO' } }, route: matched(api), routed: [], published: [] };
    const context = vm.createContext({
        toolbarContextMarker: () => state.tab,
        runPageCommand: async () => state.target,
        sendWorkspaceRequest: async (_type, data, options) => {
            assert.equal(options.allowWorkspaceSelection, false);
            state.routed.push(data);
            return state.route;
        },
        sendRuntimeMessage: async message => state.published.push(message.payload),
        gRefreshRequested: false,
        toolbarWorkspaceKey: '',
        setMessage: () => assert.fail('Discovery must preserve user feedback'),
    });
    vm.runInContext(discovery, context);
    return { root, visible, state, context, modeLabel: nodes.get('[data-mode-label]') };
}

test('module toolbar separates field transfer from IDE actions and follows provider capabilities', () => {
    const { root, visible, context, modeLabel } = toolbarFixture();
    for (const [workspace, expected] of [
        [api, ['sync', 'fields', 'ide', 'locate']],
        [svn, ['fields', 'ide', 'locate']],
        [database, ['sync', 'fields', 'ide', 'local-fields', 'locate']],
        [{ sourceMode: 'database', capabilities: {} }, ['fields']],
    ]) {
        context.renderFloatingToolbar(root, matched(workspace));
        assert.deepEqual(visible(), expected);
        assert.equal(modeLabel.textContent, workspace.sourceMode.toUpperCase());
    }
});

test('procedure and management tabs show only the operations each provider supports', () => {
    const { root, visible, context } = toolbarFixture('procedure');
    for (const workspace of [api, database, svn]) {
        context.renderFloatingToolbar(root, matched(workspace));
        assert.deepEqual(visible(), workspace === svn ? ['ide', 'locate'] : ['sync', 'ide', 'locate']);
    }
    for (const mode of ['table', 'views', 'system-scripts']) {
        root.dataset.mode = mode;
        context.renderFloatingToolbar(root, matched(api));
        assert.deepEqual(visible(), ['sync']);
        assert.equal(root.hidden, false);
        for (const workspace of [database, svn]) {
            context.renderFloatingToolbar(root, matched(workspace));
            assert.deepEqual(visible(), []);
            assert.equal(root.hidden, true);
        }
    }
});

test('discovery keeps local positioning available and removes connection-dependent actions when Bridge disconnects', async () => {
    const { root, visible, state, context, modeLabel } = toolbarFixture();
    const refresh = () => context.applyInlineWorkspaceMode(root);
    const target = state.target;
    state.target = { ok: false };
    await refresh();
    assert.deepEqual(visible(), ['fields', 'ide', 'locate']);
    assert.equal(state.routed.length, 0);
    state.target = target;
    state.route = matched(database);
    await refresh();
    assert.deepEqual(visible(), ['sync', 'fields', 'ide', 'local-fields', 'locate']);
    assert.equal(state.published.length, 1);
    assert.equal(state.published[0].metadata, target.data);
    assert.equal(context.toolbarWorkspaceKey, 'projects.demo');
    state.route = { ok: false, message: 'Failed to fetch' };
    await refresh();
    assert.deepEqual(visible(), ['fields', 'ide', 'locate']);
    assert.equal(context.toolbarWorkspaceKey, '');
    assert.equal(modeLabel.textContent, '');
    assert.equal(state.published.length, 1);
    state.route = matched(svn);
    await refresh();
    assert.deepEqual(visible(), ['fields', 'ide', 'locate']);
    assert.equal(state.published.length, 2);
});

test('ambiguous capability discovery offers project selection and does not choose a provider', async () => {
    const { root, visible, state, context } = toolbarFixture();
    state.route = { ok: false, code: 'WORKSPACE_AMBIGUOUS', candidates: [api, database] };
    await context.applyInlineWorkspaceMode(root);
    assert.deepEqual(visible(), ['fields', 'ide', 'workspace', 'locate']);
    assert.equal(state.published.length, 0);
});

test('ignores an old route result after switching platform tabs', async () => {
    const { root, visible, state, context } = toolbarFixture();
    let finishRoute;
    const started = new Promise(resolve => {
        context.sendWorkspaceRequest = () => new Promise(finish => {
            finishRoute = finish;
            resolve();
        });
    });
    const refresh = context.applyInlineWorkspaceMode(root);
    await started;
    state.tab = 'second';
    finishRoute(matched(database));
    await refresh;
    assert.deepEqual(visible(), ['fields', 'ide', 'locate']);
    assert.equal(state.published.length, 0);
});
