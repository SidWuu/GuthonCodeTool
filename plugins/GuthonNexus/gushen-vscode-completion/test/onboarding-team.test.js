const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkRepository, publicKey, authorizationCommand, repositoryUrl } = require('../src/onboarding-team');

test('repository access uses an argument array and never stores command output', async () => {
  let args;
  await checkRepository('ssh://git@example.test:2222/team/guthon-team.git', async (...call) => { args = call; return { stdout: 'a'.repeat(40) + '\tHEAD\n' }; });
  assert.deepEqual(args[1], ['ls-remote', 'ssh://git@example.test:2222/team/guthon-team.git', 'HEAD']);
  assert.equal(args[2].env.GIT_TERMINAL_PROMPT, '0');
  await assert.rejects(checkRepository('https://example.test/team.git', async () => { throw new Error('private credential details'); }), error => !error.message.includes('credential details'));
  assert.throws(() => repositoryUrl('https://user:secret@example.test/repo'));
});

test('public-key assistance preserves existing keys and cannot copy private contents', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-key-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = path.join(home, '.ssh/id_ed25519');
  fs.mkdirSync(path.dirname(key));
  fs.writeFileSync(key, 'existing private file');
  fs.writeFileSync(key + '.pub', 'ssh-ed25519 AAAA user');
  const value = await publicKey(home, async () => assert.fail('must not generate over an existing key'));
  assert.equal(value, 'ssh-ed25519 AAAA user');
  assert.equal(fs.readFileSync(key, 'utf8'), 'existing private file');
  fs.writeFileSync(key + '.pub', '-----BEGIN OPENSSH PRIVATE KEY-----');
  await assert.rejects(publicKey(home));
});

test('first-connection terminal command quotes shell metacharacters', () => {
  const command = authorizationCommand("https://example.test/team/a'b.git", 'win32');
  assert.ok(command.startsWith("& 'git' 'ls-remote'"));
  assert.ok(command.includes("a''b.git"));
  assert.ok(authorizationCommand('ssh://git@example.test:2222/repo.git', 'win32').includes("'-p' '2222' 'git@example.test'"));
});
