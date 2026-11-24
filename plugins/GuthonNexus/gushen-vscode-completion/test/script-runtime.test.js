const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareScriptRuntime, verifyScriptChecksum } = require('../src/script-runtime');
const { signingPayload } = require('../src/release-signature');

test('requires a matching release checksum before launching a script runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-script-checksum-'));
  try {
    const script = path.join(dir, 'GuthonCodeTool-python.pyz');
    fs.writeFileSync(script, 'fixture');
    const hash = crypto.createHash('sha256').update('fixture').digest('hex');
    fs.writeFileSync(path.join(dir, 'GuthonCodeTool-checksums.txt'), `${hash}  GuthonCodeTool-python.pyz\n`);
    assert.doesNotThrow(() => verifyScriptChecksum(script));
    fs.writeFileSync(script, 'tampered');
    assert.throws(() => verifyScriptChecksum(script), /SHA-256/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

function signedDebugFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-debug-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'Nexus');
  fs.mkdirSync(storageRoot);
  const pythonPath = path.join(root, 'base-python');
  const script = path.join(root, 'GuthonCodeTool-python.pyz');
  const requirements = path.join(root, 'GuthonCodeTool-python-requirements.txt');
  fs.writeFileSync(pythonPath, 'interpreter fixture');
  fs.writeFileSync(script, 'zipapp fixture');
  fs.writeFileSync(requirements, 'pymysql==1.2.0\n');
  const checksums = Buffer.from([script, requirements].map(file =>
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + path.basename(file)).join('\n'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(storageRoot, 'release-trust.json'), JSON.stringify({
    schemaVersion: 1, requireSignature: true, keys: { fixture: publicKey.export({ format: 'pem', type: 'spki' }) },
  }));
  fs.writeFileSync(path.join(root, 'GuthonCodeTool-checksums.txt'), checksums);
  fs.writeFileSync(path.join(root, 'GuthonCodeTool-checksums.signature.json'), JSON.stringify({
    schemaVersion: 1, algorithm: 'ed25519', version: '0.4.1', keyId: 'fixture',
    signature: crypto.sign(null, signingPayload('0.4.1', checksums), privateKey).toString('base64'),
  }));
  return { script, requirements, storageRoot, pythonPath };
}

test('prepares a signed debug bundle, retries a failed install, and reuses the completed environment', async t => {
  const fixture = signedDebugFiles(t);
  let installs = 0, probes = 0;
  const options = {
    storageRoot: fixture.storageRoot, pythonPath: fixture.pythonPath, platform: 'darwin', arch: 'arm64',
    runner: async (_command, args) => {
      if (args.includes('-c')) return { stdout: JSON.stringify({
        executable: fixture.pythonPath, version: [3, 12, 0], bits: 64, machine: 'arm64',
      }) };
      if (args.includes('venv')) {
        const bin = path.join(args.at(-1), 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'python'), '');
      } else {
        assert.ok(args.includes('--only-binary=:all:'));
        assert.equal(fs.readFileSync(args.at(-1), 'utf8'), fs.readFileSync(fixture.requirements, 'utf8'));
        if (++installs === 1) throw new Error('fixture network failure');
      }
    },
    probeRuntime: async (runtime, { verifyChecksum }) => {
      probes++;
      verifyChecksum(runtime.toolEntry);
      return { version: '0.4.1', missingProviders: [] };
    },
  };
  await assert.rejects(prepareScriptRuntime(fixture.script, options), /fixture network failure/);
  const phase = fs.readdirSync(path.join(fixture.storageRoot, 'script-runtimes'))[0];
  assert.equal(fs.existsSync(path.join(fixture.storageRoot, 'script-runtimes', phase, '.venv')), false);
  const first = await prepareScriptRuntime(fixture.script, options);
  const again = await prepareScriptRuntime(fixture.script, options);
  assert.deepEqual(first.runtime, again.runtime);
  assert.equal(installs, 2);
  assert.equal(probes, 2);
});

test('rejects missing or modified signed dependencies before starting Python', async t => {
  const fixture = signedDebugFiles(t);
  const options = { storageRoot: fixture.storageRoot, runner: () => assert.fail('Python must not start') };
  fs.writeFileSync(fixture.requirements, 'changed requirements');
  await assert.rejects(prepareScriptRuntime(fixture.script, options), /SHA-256/);
  fs.unlinkSync(fixture.requirements);
  await assert.rejects(prepareScriptRuntime(fixture.script, options), /缺少：GuthonCodeTool-python-requirements.txt/);
});
