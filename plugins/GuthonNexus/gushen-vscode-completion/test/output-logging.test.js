const test = require('node:test');
const assert = require('node:assert/strict');
const { timestamp, timedOutput, operationTimer } = require('../src/output-logging');

test('formats local wall time to milliseconds', () => {
  assert.equal(timestamp(new Date(2026, 9, 15, 1, 2, 3, 4)), '01:02:03.004');
});

test('timestamps physical lines across arbitrary stream chunk boundaries', () => {
  const lines = [];
  const output = timedOutput({ appendLine: value => lines.push(value) });
  output.append('par');
  output.append('tial\r\nsecond\n[12:34:56.789] [SVN] ');
  output.append('finished');
  output.appendLine('');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] partial$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] second$/);
  assert.equal(lines[2], '[12:34:56.789] [SVN] finished');
});

test('elapsed duration has hour, minute, second and millisecond fields', () => {
  assert.match(operationTimer()(), /^\d{2,}:\d{2}:\d{2}\.\d{3}$/);
});

test('initial SVN results summarize duplicate paths and bound failure output', () => {
  const { indexResultSummary } = require('../src/output-logging');
  const payload = { ok: true, action: 'checked-out-from-config', workspaceKey: 'projects.demo',
    reindex: { mode: 'svn-scan', changed: 7813, failures: 12, counts: { page: 3583 },
      ignored: Array.from({ length: 5000 }, () => ({ path: 'private-source-path' })),
      errors: Array.from({ length: 12 }, (_, i) => ({ path: `bad-${i}.json`, error: 'invalid' })) } };
  const result = indexResultSummary('svn', payload);
  assert.ok(result.length < 2500);
  const summary = JSON.parse(result);
  assert.equal(summary.reindex.ignoredCount, 5000);
  assert.equal(summary.reindex.errors.length, 10);
  assert.equal(summary.reindex.omittedErrors, 2);
  assert.equal(result.includes('private-source-path'), false);
  assert.equal(payload.reindex.ignored.length, 5000);
  assert.equal(indexResultSummary('svn', { stdout: JSON.stringify(payload) }), result);
  assert.equal(indexResultSummary('database-query-readonly', payload), undefined);
});
