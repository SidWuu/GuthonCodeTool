const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {isWorkspaceKey} = require('../src/workspace-identity');

const valid = ['a', '9', 'ws_abc-123.X', 'products.legacy', 'projects.legacy'];
const invalid = ['', '.hidden', '_hidden', '-hidden', 'ws/a', 'ws one', '中文', 'ws\n', 123, null];

test('workspace identities use exact neutral safe strings', () => {
  for (const key of valid) assert.equal(isWorkspaceKey(key), true, String(key));
  for (const key of invalid) assert.equal(isWorkspaceKey(key), false, String(key));
});

test('database schemas accept neutral workspace keys and reject unsafe names', () => {
  const schemaDir = path.resolve(__dirname, '../../../../config/schema');
  const plan = JSON.parse(fs.readFileSync(path.join(schemaDir, 'database-test-plan.schema.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(schemaDir, 'database-testing.schema.json'), 'utf8'));
  const patterns = [plan.properties.workspaceKey.pattern,
    ...Object.keys(config.properties.databaseTests.patternProperties),
    config.properties.profiles.patternProperties['^[A-Za-z0-9][A-Za-z0-9._-]*$'].properties.workspaceKey.pattern];
  for (const pattern of patterns) {
    assert.equal(pattern, '^[A-Za-z0-9][A-Za-z0-9._-]*$');
    const regex = new RegExp(pattern);
    for (const key of valid) assert.equal(regex.test(key), true, key);
    for (const key of invalid.filter(value => typeof value === 'string' && value !== 'ws\n')) assert.equal(regex.test(key), false, key);
  }
});
