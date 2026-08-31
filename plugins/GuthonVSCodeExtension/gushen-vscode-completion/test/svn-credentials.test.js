const assert = require('node:assert/strict');
const test = require('node:test');
const { clearLegacyCredentials, promptForPassword } = require('../src/svn/credentials');

test('prompts for a transient SVN password without owning credential storage', async () => {
  const calls = [];
  const window = {
    showInputBox: async (options) => {
      calls.push(options);
      return 'demo-password';
    },
  };

  assert.equal(await promptForPassword(window), 'demo-password');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].password, true);
  assert.match(calls[0].prompt, /stdin.*SVN 系统保存/);
});

test('removes legacy Nexus username and password secrets', async () => {
  const deleted = [];
  await clearLegacyCredentials({ delete: async (key) => deleted.push(key) }, '/tool-home');
  assert.equal(deleted.length, 2);
  assert.ok(deleted.some((key) => key.includes('.username.')));
  assert.ok(deleted.some((key) => key.includes('.password.')));
});
