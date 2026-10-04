const test = require('node:test');
const assert = require('node:assert/strict');
const {diagnosisHistoryMarkdown, diagnosisEntryMarkdown, showDiagnosisHistory} = require('../src/diagnosis-history-view');
const entry = {id: 'a'.repeat(32), workspaceKey: 'products.demo', createdAt: 1791036000, targetId: 'dev', environment: 'dev', command: 'database-diagnose', status: 'SUCCESS',
  rowCountReturned: 1, columnCount: 2, truncation: 'none', sqlDigest: 'f'.repeat(64), querySummary: {kind: 'SELECT', characters: 10, physicalTableCount: 1}, sql: 'PRIVATE', rows: ['PRIVATE'], password: 'PRIVATE'};
test('history projects metadata only, validates workspace and marks retained coverage', () => {
  const listing = diagnosisHistoryMarkdown('products.demo', {history: [entry], truncated: true, retainedLimit: 100});
  assert.match(listing, /更多保留记录未展示/); assert.match(listing, /UTC/);
  assert.equal(listing.includes('PRIVATE'), false);
  const detail = diagnosisEntryMarkdown('products.demo', {...entry, stage: '<script> | [link](command:evil)'});
  assert.equal(detail.includes('PRIVATE'), false); assert.equal(detail.includes('<script>'), false);
  assert.match(detail, /sqlDigest/); assert.match(detail, /physicalTableCount/);
  assert.throws(() => diagnosisEntryMarkdown('projects.other', entry), /工作区/);
  assert.throws(() => diagnosisHistoryMarkdown('products.demo', {history: [{...entry, id: '../secret'}]}), /身份/);
});
function fixture(selection, history = [entry]) {
  const calls = [];
  return {calls, options: {workspaceKey: entry.workspaceKey, client: {async run(key, command, args) {calls.push({key, command, args}); return command === 'diagnosis-list' ? {history} : {entry};}},
    vscode: {window: {async showQuickPick(items) {return selection?.(items);}, async showTextDocument(document) {calls.push({document}); return document;}},
      workspace: {async openTextDocument(value) {return value;}}}}};
}
test('detail reads only the chosen history ID with explicit workspace, cancellation performs no further calls', async () => {
  const f = fixture(items => items[1]); await showDiagnosisHistory(f.options);
  assert.deepEqual(f.calls.slice(0, 2), [{key: entry.workspaceKey, command: 'diagnosis-list', args: ['--limit', '100']},
    {key: entry.workspaceKey, command: 'diagnosis-show', args: ['--id', entry.id]}]);
  assert.equal(f.calls[2].document.content.includes('PRIVATE'), false);
  const cancelled = fixture(); assert.equal(await showDiagnosisHistory(cancelled.options), undefined); assert.equal(cancelled.calls.length, 1);
});
test('empty history opens a truthful summary and mismatched details are rejected', async () => {
  const empty = fixture(undefined, []); await showDiagnosisHistory(empty.options); assert.match(empty.calls[1].document.content, /无历史记录/);
  const f = fixture(items => items[1]); const original = f.options.client.run;
  f.options.client.run = async (key, command, args) => command === 'diagnosis-show' ? {entry: {...entry, id: 'b'.repeat(32)}} : original(key, command, args);
  await assert.rejects(() => showDiagnosisHistory(f.options), /不一致/);
});
