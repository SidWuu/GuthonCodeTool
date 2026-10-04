const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('label maps refresh after TTL and failed old requests preserve the new datasource cache', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'page-bridge.js'), 'utf8');
  const code = source.slice(source.indexOf('  let displayMapsCache;'), source.indexOf('  function readMappedFirst'));
  let now = 1000, datasource = 'first', calls = 0, rejectOld;
  const context = { Date: {now: () => now}, Map, getDataSourceId: () => datasource,
    extractList: value => value, putMapValue: (map, key, value) => map.set(key, value), getTemplateLabel: item => item.name,
    postForm: async () => {calls++; return [];}};
  vm.runInNewContext(code + '\nglobalThis.loadMaps = getDisplayMaps;', context);
  await Promise.all([context.loadMaps(), context.loadMaps()]);
  assert.equal(calls, 3);
  now += 60_001;
  await context.loadMaps();
  assert.equal(calls, 6);
  datasource = 'old';
  context.postForm = () => {calls++; return new Promise((resolve, reject) => {rejectOld ||= reject;});};
  const old = context.loadMaps();
  datasource = 'new';
  context.postForm = async () => {calls++; return [];};
  await context.loadMaps();
  const count = calls;
  rejectOld(new Error('old request failed'));
  await assert.rejects(old, /old request failed/);
  await context.loadMaps();
  assert.equal(calls, count);
});
