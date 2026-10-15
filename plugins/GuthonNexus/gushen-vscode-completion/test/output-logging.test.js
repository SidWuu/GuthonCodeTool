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
