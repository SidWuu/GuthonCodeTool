const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabasePublishJournal } = require('./database-source-publish');

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

test('competing confirms admit exactly one platform write, then verify independently', async t => {
  const directory = fixture(t);
  let writes = 0, mirrorVisible = false;
  let actual = { ...request.target, version: 'v1', content: 'original', canSave: true };
  const platform = {
    readPlatform: async () => ({ ...actual }),
    savePlatform: async (_target, { operationId }) => {
      writes++;
      actual = { ...actual, version: 'v2', content: 'candidate' };
      return { operationId, version: 'v2' };
    },
    refreshMirror: async (target, evidence) => {
      assert.deepEqual(target, request.target);
      assert.deepEqual(evidence, {workspaceKey:request.workspaceKey, operationId:request.operationId,
        baseVersion:'db-v1', version:'v2', content:'candidate'});
      if (!mirrorVisible) throw new Error('mirror temporarily unavailable');
      return {verified:true};
    },
  };
  const first = createDatabasePublishJournal(directory, platform);
  const other = createDatabasePublishJournal(directory, platform);
  await Promise.all([first.publish(request), other.publish(request)]);
  assert.equal(writes, 1);
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

test('a new request ID cannot redispatch the same platform revision after a lost response', async t => {
  const directory = fixture(t);
  let writes = 0;
  const transport = {
    readPlatform: async target => ({...target, version:'v1', content:'original', canSave:true}),
    savePlatform: async () => { writes++; throw new Error('response lost'); },
    refreshMirror: async () => assert.fail('no version was verified'),
  };
  const first = createDatabasePublishJournal(directory, transport);
  assert.equal((await first.publish(request)).state, 'PLATFORM_UNKNOWN');
  const restarted = createDatabasePublishJournal(directory, transport);
  const competing = await restarted.publish({...request, operationId:'b'.repeat(64)});
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

test('an old version or wrong platform identity is rejected before saving', async t => {
  const directory = fixture(t);
  let actual = { ...request.target, version: 'v2', content: 'original', canSave: true };
  const journal = createDatabasePublishJournal(directory, {
    readPlatform: async () => actual,
    savePlatform: async () => assert.fail('must not dispatch'),
    refreshMirror: async () => assert.fail('must not refresh'),
  });
  assert.equal((await journal.publish(request)).state, 'NOT_WRITTEN');
  actual = { ...actual, dataSourceId: 'other' };
  await assert.rejects(journal.publish({ ...request, operationId: 'b'.repeat(64) }), /对象与审阅目标不一致/);
});
