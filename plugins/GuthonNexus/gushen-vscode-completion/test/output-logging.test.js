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
  output.append('tial\r\nsecond\n[12:34:56.789] [API] ');
  output.append('finished');
  output.appendLine('');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] partial$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] second$/);
  assert.equal(lines[2], '[12:34:56.789] [API] finished');
});

test('elapsed duration has hour, minute, second and millisecond fields', () => {
  assert.match(operationTimer()(), /^\d{2,}:\d{2}:\d{2}\.\d{3}$/);
});

test('API index summaries preserve incomplete status and bound diagnostics',()=>{
  const {indexResultSummary}=require('../src/output-logging');
  const payload={ok:true,workspaceKey:'projects.demo',complete:false,index:{complete:false,objects:50,diagnosticCount:12,
    diagnostics:Array.from({length:12},(_,i)=>({path:`bad-${i}.xml`,code:'PARSE'})),truncated:false}};
  const result=indexResultSummary('api',payload),summary=JSON.parse(result);
  assert.equal(summary.complete,false);assert.equal(summary.index.complete,false);assert.equal(summary.index.diagnosticCount,12);
  assert.equal(summary.index.diagnostics.length,10);assert.equal(summary.index.truncated,true);
  assert.equal(indexResultSummary('api',{stdout:JSON.stringify(payload)}),result);
  assert.equal(indexResultSummary('database-query-readonly',payload),undefined);
});
