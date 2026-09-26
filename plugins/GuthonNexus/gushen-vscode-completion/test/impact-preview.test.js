const assert = require('node:assert/strict');
const test = require('node:test');
const { impactEvidenceChoices, impactMarkdown } = require('../src/svn/impact-preview');

test('PAGE impact preview uses exact PAGE identity and labels partial relation evidence', async () => {
  const calls = [];
  const backend = { async pageQuery(workspace, name, args) {
    calls.push([workspace, name, args]);
    if (name === 'get_source_context') return {
      sourcePath: 'page/a.json', indexGeneration: 'g1', indexedSourceHash: 'h1', tableAccesses: [{ table_name: 'T', operation: 'SELECT' }],
      logicFacts: [], truncated: false,
    };
    return { sourcePath: 'page/a.json', indexGeneration: 'g1', indexedSourceHash: 'h1', relations: [{ sourceFieldId: 'a', targetFieldId: 'b', relationType: 'SELECTBOX', resolution: 'RESOLVED' }], truncated: true };
  } };
  const markdown = await impactMarkdown(backend, {
    workspaceKey: 'products.demo', sourceType: 'page', sourceNamespace: 'system',
    sourceId: 'PG-1', sourcePath: 'page/a.json',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], { sourceNamespace: 'system', sourceId: 'PG-1', funId: '', limit: 20 });
  assert.match(markdown, /仅覆盖显式 selectBox/);
  assert.match(markdown, /结果已截断/);
  assert.match(markdown, /\| T \| SELECT/);
});

test('procedure impact refuses a same-name source from another path', async () => {
  const backend = { async context() { return { source: { source_path: 'other/a.gss' } }; } };
  await assert.rejects(impactMarkdown(backend, {
    workspaceKey: 'projects.demo', sourceType: 'procedure', sourceId: 'P#F', funId: 'F',
    sourcePath: 'current/a.gss',
  }), /索引身份不唯一/);
});

test('procedure impact refuses a same-path source from another working copy', async () => {
  const backend = { async context() { return { source: {
    source_path: 'procedure/a.gss', source_namespace: 'data-1', working_copy_id: 'wc-other',
  } }; } };
  await assert.rejects(impactMarkdown(backend, {
    workspaceKey: 'projects.demo', sourceType: 'procedure', sourceId: 'P#F', funId: 'F',
    sourcePath: 'procedure/a.gss', sourceNamespace: 'data-1', workingCopyId: 'wc-current',
  }), /索引身份不唯一/);
});

test('impact evidence navigation keeps PAGE fragment and caller working-copy identity', () => {
  const identity = { workspaceKey: 'products.demo', sourceType: 'page', sourceId: 'PG-1',
    workingCopyId: 'wc-1', sourcePath: 'page/a.json' };
  const page = impactEvidenceChoices({ kind: 'page', identity, relations: { relations: [{
    sourceFieldId: 'F1', targetFieldId: 'F2', collectionPointer: '/views/0/fields',
    evidencePointer: '/views/0/fields/0/selectBox/selectCodefieldId',
  }] } });
  assert.deepEqual(page[0].source, { ...identity, jsonPointer: '/views/0/fields', fragmentType: 'fields' });
  const pageFacts = impactEvidenceChoices({ kind: 'page', identity, relations: { relations: [] }, context: {
    tableAccesses: [{ table_name: 'T_ORDER', operation: 'SELECT', confidence: 'HIGH',
      json_pointer: '/views/0/datasource/sql', line_no: 3 }],
    logicFacts: [{ fact_kind: 'CONDITION', subject: 'ready', confidence: 'MEDIUM',
      json_pointer: '/pageSetup/pageEvents/onOpenScript', line_start: 2 }],
  } });
  assert.equal(pageFacts[0].source.jsonPointer, '/views/0/datasource/sql');
  assert.equal(pageFacts[0].lineNumber, 3);
  assert.equal(pageFacts[1].source.jsonPointer, '/pageSetup/pageEvents/onOpenScript');
  assert.equal(pageFacts[1].lineNumber, 2);
  const procedure = impactEvidenceChoices({ kind: 'procedure', identity: {
    workspaceKey: 'products.demo', sourceType: 'procedure', sourceId: 'P#run', funId: 'run',
    workingCopyId: 'wc-1', sourcePath: 'procedure/run.gss',
  }, context: { incoming: [{ source_table: 'procedure', source_id: 'Q#call', fun_id: 'call',
    working_copy_id: 'wc-2', source_path: 'procedure/call.gss', line_no: 7 }],
  outgoing: [], dynamic: [] } });
  assert.equal(procedure[0].source.workingCopyId, 'wc-2');
  assert.equal(procedure[0].lineNumber, 7);
});
