const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const target = {origin:'http://platform.test', systemId:'SYS-1', dataSourceId:'0001',
    procedureId:'PR-1', procedureAlias:'pkg.temp', funId:'sample'};
const operationId = 'a'.repeat(64);
const admin = '/develop/procedure/admin/';
const source = fs.readFileSync(require.resolve('./database-procedure.js'), 'utf8');

function fixture(owner = null) {
    const calls = [];
    const state = {owner, userId:'TESTER', version:'v1', content:'before', saveCode:0};
    const box = {
        location:{origin:target.origin, pathname:'/guthon/index.html'}, TextEncoder, URLSearchParams, AbortSignal, btoa,
        async fetch(endpoint, options) {
            const body = Object.fromEntries(options.body || []);
            calls.push({endpoint, body});
            const responses = {
                [admin + 'getProcTree.htm']:{list:[{procedureId:'PR-1', procedureAliasId:'pkg.temp'}]},
                [admin + 'getFunInfo.htm']:{bean:{...target, versionMac:state.version,
                    funScript:state.content, prodScript:state.product, checkOutUserId:state.owner}},
                '/develop/login/isLogin.htm':{user:{userId:state.userId}},
            };
            if (endpoint === '/develop/login/isLogin.htm') assert.equal(options.method, 'GET');
            if (endpoint in responses) return {ok:true, json:async () => ({code:0, data:responses[endpoint]})};
            if (endpoint === admin + 'checkOut.htm') {
                assert.deepEqual(body, {procedureId:'PR-1', funId:'sample'});
                if (state.checkout) return {ok:true, json:async () => ({code:state.checkout()})};
                state.owner = state.userId;
                return {ok:true, json:async () => ({code:0})};
            }
            assert.equal(endpoint, admin + 'saveFunScript.htm');
            return {ok:true, json:async () => ({
                code:state.saveCode, message:state.saveCode ? '函数已被其他人修改，请核实后再保存' : '',
            })};
        },
    };
    vm.runInNewContext(source, box);
    const input = {action:'save', target, systemId:'SYS-1', dataSourceId:'0001',
        evidence:{operationId, expectedVersion:'v1', expectedContent:'before', content:'after'}};
    return {calls, state, run:overrides => box.runDatabaseProcedure({...input, ...overrides})};
}

test('DATABASE native confirmation checks out a free function and reads it before saving', async () => {
    const f = fixture();
    assert.equal((await f.run({action:'read', evidence:null})).canSave, true);
    assert.ok(f.calls.every(({endpoint}) => !endpoint.endsWith('checkOut.htm')));
    f.calls.length = 0;

    assert.equal((await f.run()).acknowledged, true);
    assert.deepEqual(f.calls.map(({endpoint}) => endpoint), [
        admin + 'getProcTree.htm', admin + 'getFunInfo.htm', '/develop/login/isLogin.htm',
        admin + 'checkOut.htm', admin + 'getFunInfo.htm', admin + 'saveFunScript.htm',
    ]);
    const {body} = f.calls.at(-1);
    assert.equal(body.versionMac, 'v1');
    assert.equal(body.flag, '0');
    assert.deepEqual(JSON.parse(body.funScript), {script:'after'});
    assert.equal(body.isBase64, undefined);
});

test('DATABASE native save reuses the current account checkout and reports stale writes', async () => {
    const f = fixture('TESTER');
    assert.equal((await f.run()).acknowledged, true);
    f.state.saveCode = 1;
    assert.equal((await f.run()).rejected, 'PLATFORM_VERSION_CHANGED');
    f.state.saveCode = 7;
    const rejected = await f.run();
    assert.equal(rejected.rejected, 'PLATFORM_SAVE_REJECTED');
    assert.equal(rejected.platformCode, 7);
    assert.ok(f.calls.every(({endpoint}) => !endpoint.endsWith('checkOut.htm')));
});

test('DATABASE native save tolerates an equivalent line ending after checkout', async () => {
    const f = fixture();
    f.state.content = 'before\r\n';
    f.state.checkout = () => {
        f.state.owner = f.state.userId;
        f.state.content = 'before\r';
        return 0;
    };
    assert.equal((await f.run()).acknowledged, true);
    assert.equal(f.calls.at(-1).body.versionMac, 'v1');
});

test('DATABASE compares a standalone inherited procedure with its expanded product source', async () => {
    const f = fixture('TESTER');
    f.state.content = 'inherit();  \r\n';
    f.state.product = 'product body\r\n\r\n';
    assert.equal((await f.run({action:'read', evidence:null})).content, 'product body\n');
    const result = await f.run({evidence:{operationId, expectedVersion:'v1',
        expectedContent:'product body\n', content:'project override\n'}});
    assert.equal(result.acknowledged, true);
    assert.deepEqual(JSON.parse(f.calls.at(-1).body.funScript), {script:'project override\n'});
});

test('DATABASE stops before saving a function signed out by another account', async () => {
    const f = fixture('OTHER');
    const readonly = await f.run({action:'read', evidence:null});
    assert.equal(readonly.canSave, false);
    assert.equal(readonly.blockedReason, 'CHECKED_OUT_BY_OTHER');
    assert.equal((await f.run()).rejected, 'CHECKED_OUT_BY_OTHER');
    assert.ok(f.calls.every(({endpoint}) => !/\/(?:checkOut|saveFunScript)\.htm$/.test(endpoint)));
});

test('DATABASE stops when a competing checkout or a changed baseline is seen after checkout', async t => {
    const scenarios = [
        ['another account wins', state => {state.owner = 'OTHER'; return 1;}, 'CHECKED_OUT_BY_OTHER'],
        ['ownership is unconfirmed', () => 0, 'CHECKOUT_UNVERIFIED'],
        ['checkout result is unknown', () => {throw new Error('timeout');}, 'CHECKOUT_UNVERIFIED'],
        ['version changes', state => {state.owner = state.userId; state.version = 'v2'; return 0;},
            'PLATFORM_VERSION_CHANGED'],
        ['content changes', state => {state.owner = state.userId; state.content = 'remote'; return 0;},
            'PLATFORM_CONTENT_CHANGED'],
    ];
    for (const [label, checkout, expected] of scenarios) {
        await t.test(label, async () => {
            const f = fixture();
            f.state.checkout = () => checkout(f.state);
            assert.equal((await f.run()).rejected, expected);
            assert.equal(f.calls.filter(({endpoint}) => endpoint.endsWith('checkOut.htm')).length, 1);
            assert.ok(f.calls.every(({endpoint}) => !endpoint.endsWith('saveFunScript.htm')));
        });
    }
});
