const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDatabasePublishJournal, sourceHash } = require('./database-source-publish');

const request = {
  workspaceKey: 'ws_fixture_database', operationId: 'a'.repeat(64),
  target: { origin: 'https://example.test', systemId: 'SYS-1', dataSourceId: 'DS-1',
    procedureId: 'PR-1', procedureAlias: 'com.golden.fixture', funId: 'example', sourceId: 'FN-ROW' },
  databaseBaseVersion: 'db-v1', expectedVersion: 'v1', expectedContent: 'original', content: 'candidate',
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'database-publish-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('PAGE comparison ignores only scoped defaults and a verified hydrated alias', () => {
    const target = {pageId:'PG-FIXTURE', pageAlias:'fixture.page'};
    const base = {pageId:target.pageId, pageType:1, views:{rows:[{component:{
        fields:[{fieldId:'F1', label:'Before'}, {fieldId:'F2'}],
        params:{sortable:0}, datasource:{fields:[{fieldId:'F1'}]},
    }}]}};
    const readback = structuredClone(base);
    readback.pageAliasId = target.pageAlias;
    readback.pageType = '1';
    readback.isProduct = 0;
    const row = readback.views.rows[0];
    Object.assign(row.component.fields[0], {sortable:1, isDefaultLike:1, isDisAdvSearch:0});
    row.component.datasource.fields[0].isPk = 0;
    const hash = model => sourceHash(target, JSON.stringify(model));
    assert.equal(hash(base), hash(readback));
    assert.notEqual(sourceHash(target, JSON.stringify(base), 1), sourceHash(target, JSON.stringify(readback), 1));
    for (const makeChange of [
        model => { model.pageAliasId = 'other.page'; },
        model => { model.views.rows[0].component.fields[0].sortable = 0; },
        model => { model.views.rows[0].component.fields[0].isDefaultLike = '1'; },
        model => { model.views.rows[0].component.datasource.fields[0].isPk = 1; },
        model => { model.views.rows[0].component.fields.reverse(); },
        model => { delete model.views.rows[0].component.params.sortable; },
        model => { model.views.rows[0].component.fields[0].label = 'Actual source edit'; },
    ]) {
        const changed = structuredClone(readback);
        makeChange(changed);
        assert.notEqual(hash(base), hash(changed));
    }
});

test('competing confirms use the latest equivalent version for a single write', async t => {
  const directory = fixture(t);
  let writes = 0, mirrorVisible = false;
  let actual = { ...request.target, version: 'v1-current', content: 'original\r\n', canSave: true };
  const platform = {
    readPlatform: async () => ({ ...actual }),
    savePlatform: async (_target, { operationId, expectedVersion, expectedContent }) => {
      assert.equal(expectedVersion, 'v1-current');
      assert.equal(expectedContent, 'original\r\n');
      writes++;
      actual = { ...actual, version: 'v2', content: 'candidate\n' };
      return { operationId, version: 'v2' };
    },
    refreshMirror: async (target, evidence) => {
      assert.deepEqual(target, request.target);
      assert.deepEqual(evidence, {workspaceKey:request.workspaceKey, operationId:request.operationId,
        baseVersion:'db-v1', version:'v2', content:'candidate\n'});
      if (!mirrorVisible) throw new Error('mirror temporarily unavailable');
      return {verified:true};
    },
  };
  const first = createDatabasePublishJournal(directory, platform);
  const other = createDatabasePublishJournal(directory, platform);
  await Promise.all([first.publish(request), other.publish(request)]);
  assert.equal(writes, 1);
  assert.equal(first.status(request.workspaceKey, request.operationId).reviewedVersion, 'v1');
  assert.equal(first.status(request.workspaceKey, request.operationId).expectedVersion, 'v1-current');
  assert.equal((await other.verify(request.workspaceKey, request.operationId)).state, 'MIRROR_PENDING');
  await assert.rejects(other.publish({ ...request, content: 'different' }), /已绑定/);
  mirrorVisible = true;
  assert.equal((await other.verify(request.workspaceKey, request.operationId)).state, 'VERIFIED');
  assert.equal((await other.publish(request)).state, 'VERIFIED');
  assert.equal(writes, 1);
});

test('lost response is unknown; restarting only reconciles, never resends', async t => {
  const directory = fixture(t);
  let writes = 0, actual = { ...request.target, version: 'v1', content: 'original', canSave: true };
  const platform = {
    readPlatform: async () => ({ ...actual }),
    savePlatform: async () => { writes++; actual = { ...actual, version: 'v2', content: 'candidate' }; throw new Error('timeout'); },
    refreshMirror: async () => ({ verified: true }),
  };
  const first = createDatabasePublishJournal(directory, platform);
  assert.equal((await first.publish(request)).state, 'PLATFORM_UNKNOWN');
  const restarted = createDatabasePublishJournal(directory, platform);
  assert.equal((await restarted.verify(request.workspaceKey, request.operationId)).state, 'PLATFORM_UNKNOWN');
  actual.appliedOperationId = request.operationId;
  assert.equal((await restarted.verify(request.workspaceKey, request.operationId)).state, 'VERIFIED');
  assert.equal(writes, 1);
});

test('a new request based on the latest version cannot resend a rebased operation', async t => {
  const directory = fixture(t);
  let writes = 0;
  const transport = {
    readPlatform: async target => ({...target, version:'v1-current', content:'original', canSave:true}),
    savePlatform: async () => { writes++; throw new Error('response lost'); },
    refreshMirror: async () => assert.fail('no version was verified'),
  };
  const first = createDatabasePublishJournal(directory, transport);
  assert.equal((await first.publish(request)).state, 'PLATFORM_UNKNOWN');
  const restarted = createDatabasePublishJournal(directory, transport);
  const competing = await restarted.publish({...request, operationId:'b'.repeat(64), expectedVersion:'v1-current'});
  assert.equal(competing.state, 'NOT_WRITTEN');
  assert.equal(competing.reason, 'VERSION_RESERVED');
  assert.equal(competing.originalOperationId, request.operationId);
  assert.deepEqual(await restarted.verify(request.workspaceKey, competing.operationId), competing);
  const other = await restarted.publish({...request, workspaceKey:'projects.other', operationId:'c'.repeat(64),
    target:{...request.target, systemId:'SYS-2'}});
  assert.equal(other.state, 'NOT_WRITTEN');
  assert.equal(other.originalOperationId, undefined);
  assert.equal((await restarted.verify(request.workspaceKey, request.operationId)).state, 'PLATFORM_UNKNOWN');
  assert.equal(writes, 1);
});

test('an interruption after reservation leaves the original operation queryable without dispatch', async t => {
  const directory = fixture(t);
  let reads = 0;
  const transport = {
    readPlatform: async () => {reads++; return {...request.target, version:'v1', content:'original', canSave:true};},
    savePlatform: async () => assert.fail('must not dispatch'),
    refreshMirror: async () => assert.fail('must not refresh'),
  };
  const link = fs.linkSync;
  const interrupted = t.mock.method(fs, 'linkSync', (from, to) => {
    if (to.endsWith('.dispatch')) throw new Error('interrupted before dispatch');
    return link(from, to);
  });
  await assert.rejects(createDatabasePublishJournal(directory, transport).publish(request), /interrupted/);
  interrupted.mock.restore();
  const restarted = createDatabasePublishJournal(directory, transport);
  assert.equal((await restarted.verify(request.workspaceKey, request.operationId)).reason, 'DISPATCH_NOT_RECORDED');
  assert.equal((await restarted.publish(request)).state, 'NOT_WRITTEN');
  assert.equal(reads, 1);
  const competing = await restarted.publish({...request, operationId:'d'.repeat(64)});
  assert.equal(competing.originalOperationId, request.operationId);
  assert.equal(competing.state, 'NOT_WRITTEN');
});

test('changed content, wrong identity and a blocked checkout prevent rebinding', async t => {
  const directory = fixture(t);
  let actual = { ...request.target, version: 'v2', content: 'new content', canSave: true };
  const journal = createDatabasePublishJournal(directory, {
    readPlatform: async () => actual,
    savePlatform: async () => assert.fail('must not dispatch'),
    refreshMirror: async () => assert.fail('must not refresh'),
  });
  assert.equal((await journal.publish(request)).state, 'NOT_WRITTEN');
  assert.equal((await journal.publish(request)).reason, 'PLATFORM_VERSION_CHANGED');
  actual = { ...actual, dataSourceId: 'other' };
  await assert.rejects(journal.publish({ ...request, operationId: 'b'.repeat(64) }), /对象与审阅目标不一致/);
  actual = { ...request.target, version: 'v1', content: 'new content', canSave: true };
  assert.equal((await journal.publish({ ...request, operationId: 'c'.repeat(64) })).reason, 'PLATFORM_CONTENT_CHANGED');
  actual = { ...request.target, version: 'v2', content: 'original', canSave: false, blockedReason:'CHECKED_OUT_BY_OTHER' };
  assert.equal((await journal.publish({ ...request, operationId: 'd'.repeat(64) })).reason, 'CHECKED_OUT_BY_OTHER');
});

test('procedure comparison normalizes line endings and only one final line terminator', () => {
    const {target} = request;
    assert.equal(sourceHash(target, 'a\rb\r\n'), sourceHash(target, 'a\nb'));
    assert.notEqual(sourceHash(target, 'a\nb\n\n'), sourceHash(target, 'a\nb'));
    assert.notEqual(sourceHash(target, 'ab '), sourceHash(target, 'ab'));
});

test('preexisting procedure receipts still verify and retry with their original hashes', async t => {
    const directory = fixture(t);
    const input = {...request, content:'candidate\n'};
    const {workspaceKey, operationId, target, databaseBaseVersion, expectedVersion, expectedContent, content} = input;
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const file = path.join(directory, sha256(`${workspaceKey}\n${operationId}`) + '.json');
    const candidateHash = sha256(content);
    const fingerprint = sha256(JSON.stringify([target, undefined, databaseBaseVersion,
        expectedVersion, sha256(expectedContent), candidateHash]));
    fs.writeFileSync(file, JSON.stringify({
        workspaceKey, operationId, target, databaseBaseVersion, expectedVersion, candidateHash, fingerprint,
        state:'PLATFORM_UNKNOWN',
    }));
    fs.writeFileSync(file + '.dispatch', JSON.stringify({operationId}));
    fs.writeFileSync(file + '.accepted', JSON.stringify({version:'v2'}));
    let actual = 'candidate';
    const journal = createDatabasePublishJournal(directory, {
        readPlatform: async () => ({...target, version:'v2', content:actual}),
        savePlatform: async () => assert.fail('must not dispatch an existing operation'),
        refreshMirror: async () => ({verified:true}),
    });
    assert.equal((await journal.publish(input)).state, 'PLATFORM_UNKNOWN');
    assert.equal((await journal.verify(workspaceKey, operationId)).state, 'PLATFORM_UNKNOWN');
    actual = content;
    assert.equal((await journal.verify(workspaceKey, operationId)).state, 'VERIFIED');
    assert.equal((await journal.publish(input)).state, 'VERIFIED');
});

test('checkout failures keep the source unsaved and a fresh confirmation can retry the same revision', async t => {
    const directory = fixture(t);
    let actual = {...request.target, version:'v1', content:'original', canSave:false, blockedReason:'CHECKED_OUT_BY_OTHER'};
    let rejectCheckout = true;
    let writes = 0;
    const journal = createDatabasePublishJournal(directory, {
        readPlatform:async () => actual,
        savePlatform:async (_target, {operationId}) => {
            if (rejectCheckout) return {operationId, rejected:'CHECKOUT_UNVERIFIED'};
            writes++;
            actual = {...actual, version:'v2', content:'candidate'};
            return {operationId, version:'v2'};
        },
        refreshMirror:async () => ({verified:true}),
    });
    const missingCheckout = await journal.publish(request);
    assert.equal(missingCheckout.state, 'NOT_WRITTEN');
    assert.equal(missingCheckout.reason, 'CHECKED_OUT_BY_OTHER');

    actual = {...actual, canSave:true, blockedReason:undefined};
    const lostCheckout = await journal.publish({...request, operationId:'b'.repeat(64)});
    assert.equal(lostCheckout.state, 'NOT_WRITTEN');
    assert.equal(lostCheckout.reason, 'CHECKOUT_UNVERIFIED');
    assert.deepEqual(await journal.publish(request), missingCheckout);
    assert.equal(writes, 0);

    rejectCheckout = false;
    const next = {...request, operationId:'c'.repeat(64)};
    assert.equal((await journal.publish(next)).state, 'VERIFIED');
    assert.deepEqual(await journal.publish({...request, operationId:'b'.repeat(64)}), lostCheckout);
    assert.equal((await journal.publish(next)).state, 'VERIFIED');
    assert.equal(writes, 1);
});

test('explicit native PAGE and procedure rejections require an unchanged platform readback', async t => {
    const page = {
        ...request, operationId:'c'.repeat(64),
        target:{origin:request.target.origin, systemId:'SYS-1', pageId:'PG-FORM', pageAlias:'PG-FORM', pageType:'1', sourceId:'PG-FORM'},
        expectedContent:JSON.stringify({pageId:'PG-FORM', pageType:1, title:'before'}),
        content:JSON.stringify({pageId:'PG-FORM', pageType:1, title:'after'}),
    };
    const journal = createDatabasePublishJournal(fixture(t), {
        readPlatform:async target => ({...target, version:'v1', content:target.pageId ? page.expectedContent : 'original', canSave:true}),
        savePlatform:async (_target, {operationId}) => ({operationId, rejected:'PLATFORM_SAVE_REJECTED', platformCode:7}),
        refreshMirror:async () => assert.fail('an unwritten change cannot refresh the mirror'),
    });
    for (const candidate of [request, page]) {
        const result = await journal.publish(candidate);
        assert.equal(result.state, 'NOT_WRITTEN');
        assert.equal(result.reason, 'PLATFORM_SAVE_REJECTED');
        assert.equal(result.platformCode, 7);
    }
});

test('a PAGE with a durable save receipt reconciles the exact saved version without repeating the write', async t => {
    const directory = fixture(t);
    const target = {origin:request.target.origin, systemId:'SYS-1', pageId:'PG-FORM', pageAlias:'PG-FORM',
        pageType:'1', sourceId:'PG-FORM'};
    const model = title => JSON.stringify({pageId:target.pageId, pageType:1, title});
    const input = {...request, target, expectedContent:model('mirror'), content:model('candidate')};
    let saves = 0;
    const original = createDatabasePublishJournal(directory, {
        readPlatform:async () => {
            if (saves) throw new Error('first readback unavailable');
            return {...target, version:'v1', content:input.expectedContent, canSave:true};
        },
        savePlatform:async () => { saves++; return {operationId:input.operationId, version:'v2'}; },
        refreshMirror:async () => assert.fail('no readback reached the mirror'),
    });
    assert.equal((await original.publish(input)).state, 'PLATFORM_UNKNOWN');
    assert.equal(original.list(input.workspaceKey)[0].platformVersion, 'v2');

    let currentVersion = 'v3';
    let mirrorMatches = false;
    let mirrorChecks = 0;
    const returned = model('different saved body');
    const resumed = createDatabasePublishJournal(directory, {
        readPlatform:async () => ({...target, version:currentVersion, content:returned}),
        savePlatform:async () => assert.fail('readback must never save'),
        refreshMirror:async (_target, evidence) => {
            assert.equal(evidence.version,'v2');
            assert.equal(evidence.content,returned);
            mirrorChecks++;
            return {verified:mirrorMatches, workcopyState:'EDITED'};
        },
    });
    const verify = close => resumed.verify(input.workspaceKey,input.operationId,close);
    assert.equal((await verify()).state, 'PLATFORM_UNKNOWN');
    assert.equal(mirrorChecks, 0);
    currentVersion = 'v2';
    await assert.rejects(verify(true), /已返回保存回执/);
    const pending = await verify();
    assert.equal(pending.state, 'MIRROR_PENDING');
    assert.equal(pending.platformDiffers, true);
    mirrorMatches = true;
    const result = await verify();
    assert.equal(result.state, 'SAVED_WITH_DIFFERENCES');
    assert.equal(result.workcopyState, 'EDITED');
    assert.deepEqual(await verify(), result);
    assert.equal(mirrorChecks, 2);
    assert.equal(saves, 1);
});

test('an unresolved request with the original platform source can only be closed after a fresh exact reread', async t => {
    let content = 'original', saves = 0;
    const journal = createDatabasePublishJournal(fixture(t), {
        readPlatform:async () => ({...request.target, version:'v1', content, canSave:true}),
        savePlatform:async () => {saves++; throw new Error('response was lost');},
        refreshMirror:async () => assert.fail('closing a record cannot refresh the mirror'),
    });
    const {workspaceKey, operationId} = request;
    assert.equal((await journal.publish(request)).state, 'PLATFORM_UNKNOWN');
    assert.equal((await journal.verify(workspaceKey, operationId)).reason, 'PLATFORM_BASE_UNCHANGED');
    assert.equal(journal.status(workspaceKey, operationId).state, 'PLATFORM_UNKNOWN');
    assert.equal((await journal.publish({...request, operationId:'b'.repeat(64)})).reason, 'VERSION_RESERVED');

    content = 'other source';
    await assert.rejects(journal.verify(workspaceKey, operationId, true), /源码与上传前不一致/);
    assert.equal(journal.status(workspaceKey, operationId).state, 'PLATFORM_UNKNOWN');
    content = 'original';
    assert.equal((await journal.verify(workspaceKey, operationId, true)).state, 'CLOSED_UNCHANGED');
    assert.equal((await journal.verify(workspaceKey, operationId)).state, 'CLOSED_UNCHANGED');
    assert.equal(saves, 1);
    assert.equal((await journal.publish({...request, operationId:'c'.repeat(64)})).state, 'PLATFORM_UNKNOWN');
    assert.equal(saves, 2);
});
