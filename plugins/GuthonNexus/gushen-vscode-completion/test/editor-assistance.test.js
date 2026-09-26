const assert = require('node:assert/strict');
const test = require('node:test');
const { completions, diagnostics, documentKind, fieldReferencePrefix, registerEditorAssistance } = require('../src/svn/editor-assistance');

function document(sourceType, jsonPointer, languageId = 'json') {
  const params = new URLSearchParams({ sourceType, sourceId: 'PG-1', jsonPointer });
  return { uri: { scheme: 'guthon-svn-edit', query: params.toString(), authority: 'products.demo' }, languageId };
}

test('diagnoses repeated GSS function definitions at the second declaration', () => {
  const source = '#function calc($x)\n#end\n#function calc($y)\n#end';
  assert.deepEqual(diagnostics('gss', source), [{
    name: 'calc', start: source.lastIndexOf('calc'), end: source.lastIndexOf('calc') + 4,
    message: '重复的本地函数定义：calc', code: 'GUTHON_DUPLICATE_FUNCTION',
  }]);
  assert.deepEqual(completions('gss', source + '\n@ca', (source + '\n@ca').length).map((item) => item.name), ['calc']);
});

test('completes and diagnoses PAGE field IDs only within the active collection', () => {
  const source = '[{"fieldId":"code"},{"fieldId":"code","selectBox":{"selectCodefieldId":"co"}}]';
  const duplicate = diagnostics('fields', source);
  assert.equal(duplicate.length, 1);
  assert.equal(source.slice(duplicate[0].start, duplicate[0].end), 'code');
  const cursor = source.indexOf('"co"', source.indexOf('selectCodefieldId')) + 3;
  assert.deepEqual(completions('fields', source, cursor).map((item) => item.name), ['code']);
  assert.deepEqual(diagnostics('fields', '[{"fieldId":'), []);
  assert.deepEqual(completions('fields', '[{"fieldId":', 12), []);
});

test('limits assistance to supported SVN virtual documents', () => {
  assert.equal(documentKind(document('page', '/views/0/fields')), 'fields');
  assert.equal(documentKind(document('procedure', '', 'guthon-gss')), 'gss');
  assert.equal(documentKind({ ...document('page', '/views/0/fields'), uri: { scheme: 'file' } }), '');
  assert.equal(documentKind(document('page', '/pageSetup/pageEvents/onOpenScript', 'javascript')), '');
});

test('combines current collection and indexed PAGE field suggestions with provenance', async () => {
  let provider;
  const dispose = { dispose() {} };
  const vscode = {
    languages: {
      createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
      registerCompletionItemProvider: (_selectors, value) => { provider = value; return dispose; },
    },
    workspace: {
      textDocuments: [],
      onDidOpenTextDocument: () => dispose,
      onDidChangeTextDocument: () => dispose,
      onDidCloseTextDocument: () => dispose,
    },
    CompletionItem: class { constructor(label) { this.label = label; } },
    CompletionItemKind: { Field: 1 },
    CompletionList: class { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  };
  const source = '[{"fieldId":"code"},{"selectBox":{"selectCodefieldId":"co"}}]';
  const cursor = source.indexOf('"co"', source.indexOf('selectCodefieldId')) + 3;
  const current = { ...document('page', '/views/0/fields'), getText: () => source,
    offsetAt: () => cursor, positionAt: (offset) => offset };
  let prefix;
  const registration = registerEditorAssistance(vscode, { async pageFieldCandidates(_document, value) {
    prefix = value;
    return { fields: [{ fieldId: 'country', collectionPointer: '/views/1/fields', label: '国家' }], truncated: true };
  } });
  const result = await provider.provideCompletionItems(current, cursor);
  assert.equal(prefix, 'co');
  assert.deepEqual(result.items.map((item) => item.label), ['code', 'country']);
  assert.match(result.items[1].detail, /国家.*\/views\/1\/fields/);
  assert.equal(result.isIncomplete, true);
  assert.equal(fieldReferencePrefix('[{"fieldId":', 12), null);
  registration.dispose();
});
