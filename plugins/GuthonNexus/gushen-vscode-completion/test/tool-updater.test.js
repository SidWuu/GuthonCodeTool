const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assetNameFor,
  compareVersions,
  detectCurrentVersion,
  installRelease,
  normalizeVersion,
  parseChecksums,
  readUpdateState,
  releaseAsset,
  sha256,
  writeUpdateState,
} = require('../src/tool-updater');

test('compares strict semantic application versions', () => {
  assert.equal(normalizeVersion('v0.2.1'), '0.2.1');
  assert.equal(compareVersions('0.2.2', '0.2.1'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.throws(() => normalizeVersion('latest'), /无效版本号/);
});

test('bundled application version matches the repository release version', () => {
  const rootVersion = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'VERSION'), 'utf8').trim();
  const bundledVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tool-version.json'), 'utf8')).version;
  assert.equal(bundledVersion, rootVersion);
});

test('selects only the two supported release assets', () => {
  assert.equal(assetNameFor('win32', 'x64'), 'GuthonCodeTool-windows-x64.exe');
  assert.equal(assetNameFor('darwin', 'arm64'), 'GuthonCodeTool-macos-arm64.zip');
  assert.throws(() => assetNameFor('darwin', 'x64'), /没有 GuthonCodeTool 发行版本/);
});

test('parses checksums and resolves release assets', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksums(`${hash}  GuthonCodeTool-windows-x64.exe\n`).get('GuthonCodeTool-windows-x64.exe'), hash);
  assert.equal(releaseAsset({ sourceLabel: 'Gitee', assets: [{ name: 'app', url: 'https://example/app' }] }, 'app').url, 'https://example/app');
  assert.throws(() => releaseAsset({ sourceLabel: 'Gitee', assets: [] }, 'app'), /缺少 app/);
});

test('persists update state and resolves the active managed version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-'));
  const extension = path.join(root, 'extension');
  const toolPath = path.join(root, 'runtime', '0.2.2', 'GuthonCodeTool');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'tool-version.json'), '{"version":"0.2.1"}\n');
  writeUpdateState(root, { activeVersion: '0.2.2', activePath: toolPath });
  assert.equal(readUpdateState(root).activeVersion, '0.2.2');
  assert.equal(await detectCurrentVersion(extension, root, toolPath), '0.2.2');
  fs.rmSync(root, { recursive: true });
});

test('detects the executable version and treats pre-updater applications as 0.2.1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-version-'));
  const extension = path.join(root, 'extension');
  const currentTool = path.join(root, 'GuthonCodeTool-current');
  const legacyTool = path.join(root, 'GuthonCodeTool-legacy');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'tool-version.json'), '{"version":"0.2.2"}\n');
  fs.writeFileSync(currentTool, 'current');
  fs.writeFileSync(legacyTool, 'legacy');
  assert.equal(await detectCurrentVersion(extension, root, currentTool, async () => ({ stdout: '{"version":"0.2.2"}\n' })), '0.2.2');
  assert.equal(await detectCurrentVersion(extension, root, legacyTool, async () => { throw new Error('unsupported'); }), '0.2.1');
  fs.rmSync(root, { recursive: true });
});

test('calculates sha256 for downloaded artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-hash-'));
  const target = path.join(root, 'artifact');
  fs.writeFileSync(target, 'guthon');
  assert.equal(sha256(target), 'fa89ae3f979c33cc553304799e443ea07b0e5fbb039cd84836ec022803806293');
  fs.rmSync(root, { recursive: true });
});

test('downloads, verifies, self-tests and installs a Windows release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-install-'));
  const artifact = Buffer.from('packaged application');
  const hash = crypto.createHash('sha256').update(artifact).digest('hex');
  const server = http.createServer((request, response) => {
    if (request.url === '/checksums') response.end(`${hash}  GuthonCodeTool-windows-x64.exe\n`);
    else if (request.url === '/application') response.end(artifact);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const processCalls = [];
  try {
    const installed = await installRelease({
      release: {
        sourceLabel: '测试源',
        version: '0.2.2',
        assets: [
          { name: 'GuthonCodeTool-checksums.txt', url: `${baseUrl}/checksums` },
          { name: 'GuthonCodeTool-windows-x64.exe', url: `${baseUrl}/application`, size: artifact.length },
        ],
      },
      storageRoot: root,
      platform: 'win32',
      arch: 'x64',
      processRunner: async (command, args) => {
        processCalls.push({ command, args });
        return args[0] === 'version' ? { stdout: '{"version":"0.2.2"}\n' } : { stdout: '' };
      },
    });
    assert.equal(installed.version, '0.2.2');
    assert.equal(fs.readFileSync(installed.toolPath, 'utf8'), artifact.toString());
    assert.equal(processCalls.length, 2);
    assert.equal(processCalls[0].command, installed.toolPath.replace(`${path.sep}runtime${path.sep}0.2.2`, `${path.sep}runtime${path.sep}.0.2.2-${process.pid}.staging`));
    assert.deepEqual(processCalls[0].args, ['version']);
    assert.deepEqual(processCalls[1].args.slice(0, 2), ['self-test', '--home']);
    const reused = await installRelease({
      release: {
        sourceLabel: '测试源',
        version: '0.2.2',
        assets: [
          { name: 'GuthonCodeTool-checksums.txt', url: `${baseUrl}/checksums` },
          { name: 'GuthonCodeTool-windows-x64.exe', url: `${baseUrl}/application`, size: artifact.length },
        ],
      },
      storageRoot: root,
      platform: 'win32',
      arch: 'x64',
      processRunner: async (command, args) => (
        args[0] === 'version' ? { stdout: '{"version":"0.2.2"}\n' } : { stdout: '' }
      ),
    });
    assert.equal(reused.toolPath, installed.toolPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true });
  }
});
