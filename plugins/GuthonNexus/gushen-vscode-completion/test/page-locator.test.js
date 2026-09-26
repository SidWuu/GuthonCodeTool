const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findExactPageCandidates, findExactProcedureCandidates,
  procedureFromFullName, sourceLocatorFromUri,
} = require('../src/svn/page-locator');

test('external PAGE locator accepts one PAGE ID and rejects extra routing state', () => {
  const uri = { authority: 'gushen-local.guthon-nexus-vscode', path: '/locate-page', query: 'pageId=PG-1234-5678' };
  assert.deepEqual(sourceLocatorFromUri(uri), { type: 'page', pageId: 'PG-1234-5678' });
  assert.equal(sourceLocatorFromUri({ ...uri, path: '/other' }), null);
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: `${uri.query}&workspaceKey=products.demo` }), /唯一/);
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: `${uri.query}&pageId=PG-OTHER` }), /唯一/);
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: 'pageId=../other' }), /唯一/);
});

test('external procedure locator accepts only package and function identities', () => {
  const uri = { authority: 'gushen-local.guthon-nexus-vscode', path: '/locate-procedure',
    query: 'alias=com.golden.demo.common&funId=saveForecast' };
  assert.deepEqual(sourceLocatorFromUri(uri), {
    type: 'procedure', alias: 'com.golden.demo.common', funId: 'saveForecast',
  });
  assert.deepEqual(procedureFromFullName('com.golden.demo.common.saveForecast'),
    sourceLocatorFromUri(uri));
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: `${uri.query}&workingCopyId=other` }), /唯一/);
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: `${uri.query}&funId=other` }), /唯一/);
  assert.throws(() => sourceLocatorFromUri({ ...uri, query: 'alias=../demo&funId=save' }), /唯一/);
  assert.throws(() => procedureFromFullName('saveForecast'), /完整包名/);
});

test('PAGE locator keeps exact IDs and full source identities across index pages', async () => {
  const calls = [];
  const backend = { async pageQuery(workspaceKey, name, args) {
    calls.push({ workspaceKey, name, args });
    return args.cursor ? {
      indexGeneration: 'g1', sources: [{ sourceType: 'page', sourceId: 'PG-1',
        sourceNamespace: 'system-B', sourcePath: 'b/PG-1.json', workingCopyId: 'wc-b' }],
    } : {
      indexGeneration: 'g1', nextCursor: 'next', sources: [
        { sourceType: 'page', sourceId: 'PG-10', sourcePath: 'a/PG-10.json', workingCopyId: 'wc-a' },
        { sourceType: 'page', sourceId: 'PG-1', sourceNamespace: 'system-A',
          sourcePath: 'a/PG-1.json', workingCopyId: 'wc-a' },
      ],
    };
  } };
  const result = await findExactPageCandidates(backend, 'products.demo', 'PG-1');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.sourceNamespace), ['system-A', 'system-B']);
  assert.equal(calls[0].args.sourceType, 'page');
  assert.equal(calls[1].args.cursor, 'next');
});

test('PAGE locator refuses a changed index generation', async () => {
  let count = 0;
  const backend = { async pageQuery() {
    return { indexGeneration: ++count === 1 ? 'g1' : 'g2', nextCursor: count === 1 ? 'next' : '' };
  } };
  await assert.rejects(findExactPageCandidates(backend, 'products.demo', 'PG-1'), /索引已变化/);
});

test('procedure locator keeps exact package and function across duplicate source identities', async () => {
  const calls = [];
  const backend = { async pageQuery(workspaceKey, name, args) {
    calls.push({ workspaceKey, name, args });
    return args.cursor ? {
      indexGeneration: 'g1', sources: [{ sourceType: 'procedure',
        sourceId: 'com.demo.pkg#save', sourceAliasId: 'com.demo.pkg', funId: 'save',
        sourceNamespace: 'DS-B', sourcePath: 'b/com/demo/pkg/save.gss', workingCopyId: 'wc-b' }],
    } : {
      indexGeneration: 'g1', nextCursor: 'next', sources: [
        { sourceType: 'procedure', sourceId: 'com.demo.pkg#saveExtra',
          sourceAliasId: 'com.demo.pkg', funId: 'saveExtra', sourceNamespace: 'DS-A',
          sourcePath: 'a/saveExtra.gss', workingCopyId: 'wc-a' },
        { sourceType: 'procedure', sourceId: 'com.demo.pkg#save',
          sourceAliasId: 'com.demo.pkg', funId: 'save', sourceNamespace: 'DS-A',
          sourcePath: 'a/save.gss', workingCopyId: 'wc-a' },
      ],
    };
  } };
  const result = await findExactProcedureCandidates(backend, 'products.demo', 'com.demo.pkg', 'save');
  assert.deepEqual(result.map((source) => source.workingCopyId), ['wc-a', 'wc-b']);
  assert.equal(calls[0].name, 'search_sources');
  assert.equal(calls[0].args.sourceType, 'procedure');
  assert.equal(calls[0].args.keyword, 'com.demo.pkg#save');
});
