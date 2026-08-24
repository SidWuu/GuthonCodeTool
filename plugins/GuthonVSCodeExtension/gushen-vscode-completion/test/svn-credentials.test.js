const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PASSWORD_ENV,
  USERNAME_ENV,
  credentialEnvironment,
  promptAndStoreCredentials,
} = require('../src/svn/credentials');

function memorySecrets() {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key),
    store: async (key, value) => values.set(key, value),
  };
}

test('stores one shared SVN credential per local data workspace', async () => {
  const secrets = memorySecrets();
  const answers = ['demo-user', 'demo-password'];
  const calls = [];
  const window = {
    showInputBox: async (options) => {
      calls.push(options);
      return answers.shift();
    },
  };
  const environment = await promptAndStoreCredentials(window, secrets, '/tool-home-a');
  assert.deepEqual(environment, {
    [USERNAME_ENV]: 'demo-user',
    [PASSWORD_ENV]: 'demo-password',
  });
  assert.equal(calls[1].password, true);
  assert.deepEqual(await credentialEnvironment(secrets, '/tool-home-a'), environment);
  assert.deepEqual(await credentialEnvironment(secrets, '/tool-home-b'), {});
});
