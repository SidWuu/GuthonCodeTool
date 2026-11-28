const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const locator = require('./nexus-locator');

test('popup switches to module tools before a PAGE is selected', async () => {
    const source = fs.readFileSync(require.resolve('./popup'), 'utf8');
    const modeHandler = source.slice(source.indexOf('function isProcedureUrl'), source.indexOf('function isAbsolutePath'));
    const refresh = source.slice(source.indexOf('async function refreshPopupTarget'), source.indexOf('async function initializePopup'));
    const nodes = new Map();
    function element(id) {
        if (!nodes.has(id)) nodes.set(id, {});
        return nodes.get(id);
    }
    let mode = 'procedure';
    let target = {mode, procedureKeyword:'fixture.pkg', funId:'save'};
    const host = 'https://example.test/guthon/index.html';
    const context = vm.createContext({
        ...Object.fromEntries(['procedureLabelEl', 'funIdLabelEl', 'pullPageBtn', 'pullHubBtn', 'fieldActions', 'localFieldsBtn',
            'locateNexusBtn', 'ideActions', 'copyFieldsBtn', 'pasteFieldsBtn'].map(id => [id, element(id)])),
        outputDirEl: {closest: () => element('outputDirLabel')},
        document: {querySelector: element},
        GuthonBridgeNexusLocator: locator,
        popupWorkspaceKey: '',
        inspection: 0,
        bridgeConnected: true,
        getActiveTab: async () => ({id:1, url:`${host}#/gdpaas/dev/${mode === 'procedure' ? 'procedure_develop' : 'modules'}`}),
        isSupportedGuthonUrl: () => true,
        runInMainWorld: async () => ({ok:true, data:{mode}}),
        resolveHubSourceTarget: async () => {
            if (!target) throw new Error('当前模块开发页面没有识别到页面编码');
            return target;
        },
        sendWorkspaceRequest: async () => ({ok:true, workspaceKey:'projects.database', workspace:{
            sourceMode:'database', capabilities:{'workcopy.open':true},
        }}),
        setResolvedTarget() {},
        setStatus: value => { context.status = value; },
    });
    vm.runInContext(modeHandler + refresh, context);
    await context.refreshPopupTarget();
    assert.equal(element('pullPageBtn').textContent, '导出当前过程函数');
    assert.equal(element('pullPageBtn').hidden, false);
    assert.equal(element('localFieldsBtn').hidden, true);
    assert.equal(context.popupWorkspaceKey, 'projects.database');
    mode = 'page-source';
    target = null;
    await context.refreshPopupTarget();
    assert.equal(element('pullPageBtn').hidden, true);
    assert.equal(element('.source-identity').hidden, true);
    assert.equal(element('outputDirLabel').hidden, true);
    assert.equal(element('localFieldsBtn').hidden, false);
    assert.equal(element('localFieldsBtn').disabled, true);
    assert.match(context.status, /模块开发.*打开要操作的页面/);
    target = {mode, pageId:'PG-FIXTURE'};
    await context.refreshPopupTarget();
    assert.equal(element('pullPageBtn').textContent, '打开复制模式');
    assert.equal(element('localFieldsBtn').disabled, false);
    assert.equal(element('locateNexusBtn').hidden, false);
});
