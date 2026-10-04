const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
  updateUrl,
  withUpdateLock,
  downloadAsset,
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

test('persists update state and probes the active managed executable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-'));
  const extension = path.join(root, 'extension');
  const toolPath = path.join(root, 'runtime', '0.2.2', 'GuthonCodeTool');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'tool-version.json'), '{"version":"0.2.1"}\n');
  fs.mkdirSync(path.dirname(toolPath), { recursive: true });
  fs.writeFileSync(toolPath, 'application');
  writeUpdateState(root, { activeVersion: '0.2.2', activePath: toolPath });
  assert.equal(readUpdateState(root).activeVersion, '0.2.2');
  assert.equal(await detectCurrentVersion(extension, root, toolPath, async () => ({stdout:'{"version":"0.2.2"}'})), '0.2.2');
  fs.rmSync(root, { recursive: true });
});

test('detects versions and retries failed probes without inventing a baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-version-'));
  const extension = path.join(root, 'extension');
  const currentTool = path.join(root, 'GuthonCodeTool-current');
  const legacyTool = path.join(root, 'GuthonCodeTool-legacy');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'tool-version.json'), '{"version":"0.2.2"}\n');
  fs.writeFileSync(currentTool, 'current');
  fs.writeFileSync(legacyTool, 'legacy');
  assert.equal(await detectCurrentVersion(extension, root, currentTool, async () => ({ stdout: '{"version":"0.2.2"}\n' })), '0.2.2');
  await assert.rejects(detectCurrentVersion(extension, root, legacyTool, async () => { throw new Error('unsupported'); }), /无法探测/);
  assert.equal(await detectCurrentVersion(extension, root, legacyTool, async () => ({stdout:'{"version":"0.2.8"}'})), '0.2.8');
  fs.rmSync(root, { recursive: true });
});

test('reuses the persisted version probe instead of starting the app again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-cache-'));
  const extension = path.join(root, 'extension');
  const toolPath = path.join(root, 'runtime', '0.2.8', 'GuthonCodeTool', 'GuthonCodeTool');
  fs.mkdirSync(extension);
  fs.mkdirSync(path.dirname(toolPath), { recursive: true });
  fs.writeFileSync(path.join(extension, 'tool-version.json'), '{"version":"0.2.2"}\n');
  fs.writeFileSync(toolPath, 'launcher');

  let probes = 0;
  const processRunner = async () => {
    probes += 1;
    return { stdout: '{"version":"0.2.8"}\n' };
  };
  assert.equal(await detectCurrentVersion(extension, root, toolPath, processRunner), '0.2.8');
  const cache = fs.readdirSync(path.join(root, 'version-cache'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'version-cache', cache[0]), 'utf8')).version, '0.2.8');
  assert.equal(await detectCurrentVersion(extension, root, toolPath, processRunner), '0.2.8');
  assert.equal(probes, 1);

  // 应用被替换后必须重新探测。
  fs.writeFileSync(toolPath, 'replaced launcher');
  assert.equal(await detectCurrentVersion(extension, root, toolPath, processRunner), '0.2.8');
  assert.equal(probes, 2);
  fs.rmSync(root, { recursive: true });
});

test('calculates sha256 for downloaded artifacts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-hash-'));
  const target = path.join(root, 'artifact');
  fs.writeFileSync(target, 'guthon');
  assert.equal(await sha256(target), 'fa89ae3f979c33cc553304799e443ea07b0e5fbb039cd84836ec022803806293');
  fs.rmSync(root, { recursive: true });
});

test('downloads, verifies, self-tests and installs a Windows release', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-install-'));
  const artifact = Buffer.from('packaged application');
  const hash = crypto.createHash('sha256').update(artifact).digest('hex');
  const baseUrl = 'https://fixture.example';
  const requester = async () => Buffer.from(`${hash}  GuthonCodeTool-windows-x64.exe\n`);
  const downloader = async (url, target) => { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target,artifact); return artifact.length; };
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
      bundledTrustFile:path.join(root,"no-bundle-fixture.json"),
      requester, downloader,
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
    assert.match(path.basename(path.dirname(processCalls[0].command)), /^\.0\.2\.2-\d+-[a-f0-9-]+\.staging$/);
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
      bundledTrustFile:path.join(root,"no-bundle-fixture.json"),
      requester, downloader,
      platform: 'win32',
      arch: 'x64',
      processRunner: async (command, args) => (
        args[0] === 'version' ? { stdout: '{"version":"0.2.2"}\n' } : { stdout: '' }
      ),
    });
    assert.equal(reused.toolPath, installed.toolPath);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

for (const archiveEntry of ['GuthonCodeTool', 'dist/GuthonCodeTool']) test(`installs a macOS release containing ${archiveEntry}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-updater-macos-'));
  const artifact = Buffer.from('macOS archive fixture');
  const hash = crypto.createHash('sha256').update(artifact).digest('hex');
  const baseUrl = 'https://fixture.example';
  const requester = async () => Buffer.from(`${hash}  GuthonCodeTool-macos-arm64.zip\n`);
  const downloader = async (url, target) => { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target,artifact); return artifact.length; };
  try {
    const installed = await installRelease({
      release: {
        sourceLabel: '测试源',
        version: '0.2.5',
        assets: [
          { name: 'GuthonCodeTool-checksums.txt', url: `${baseUrl}/checksums` },
          { name: 'GuthonCodeTool-macos-arm64.zip', url: `${baseUrl}/application`, size: artifact.length },
        ],
      },
      storageRoot: root,
      bundledTrustFile:path.join(root,"no-bundle-fixture.json"),
      requester, downloader,
      platform: 'darwin',
      arch: 'arm64',
      processRunner: async (command, args) => {
        if (command === '/usr/bin/ditto') {
          const extracted = path.join(args[3], archiveEntry);
          fs.mkdirSync(path.dirname(extracted), { recursive: true });
          fs.writeFileSync(extracted, 'packaged macOS application');
          // onedir 发行包同时带有 _internal 运行库，安装时必须与启动文件一起保留。
          fs.mkdirSync(path.join(args[3], '_internal'), { recursive: true });
          fs.writeFileSync(path.join(args[3], '_internal', 'base_library.zip'), 'runtime');
          return { stdout: '' };
        }
        return args[0] === 'version' ? { stdout: '{"version":"0.2.5"}\n' } : { stdout: '' };
      },
    });
    assert.equal(fs.readFileSync(installed.toolPath, 'utf8'), 'packaged macOS application');
    assert.equal(installed.toolPath, path.join(root, 'runtime', '0.2.5', 'GuthonCodeTool'));
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed.toolPath)).sort(),
      ['GuthonCodeTool', '_internal']
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('rejects insecure and credentialed URLs before network access, including redirect targets', async () => {
  for (const url of ['http://example/app','ftp://example/app','https://user:secret@example/app']) {
    assert.throws(() => updateUrl(url), /HTTPS.*凭据/);
    await assert.rejects(downloadAsset(url, '/unused'), /HTTPS.*凭据/);
  }
  const https = require('node:https');
  const { PassThrough } = require('node:stream');
  const original = https.get;
  let requested = 0;
  https.get = (url, options, respond) => {
    requested += 1;
    const response = new PassThrough();
    response.statusCode = 302;
    response.headers = {location:'http://example/insecure'};
    queueMicrotask(() => respond(response));
    return {setTimeout(){},on(){}};
  };
  try {
    await assert.rejects(downloadAsset('https://example/app', '/unused'), /HTTPS.*凭据/);
    assert.equal(requested, 1);
  } finally {https.get = original;}
});

function installationFixture(root, overrides = {}) {
  const content = Buffer.from('fresh application');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const release = {sourceLabel:'测试',version:'0.2.9',assets:[
    {name:'GuthonCodeTool-checksums.txt',url:'https://fixture/checksums'},
    {name:'GuthonCodeTool-windows-x64.exe',url:'https://fixture/app',size:content.length,digest:`sha256:${hash}`},
  ]};
  return {release, storageRoot:root,bundledTrustFile:path.join(root,"no-bundle-fixture.json"),platform:'win32',arch:'x64',
    requester:async()=>Buffer.from(`${hash}  GuthonCodeTool-windows-x64.exe\n`),
    downloader:async(url,target)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);return content.length;},
    processRunner:async(command,args)=>({stdout:args[0]==='version'?'{"version":"0.2.9"}':''}),
    ...overrides};
}

test('bundled signature trust rejects unsigned and forged releases before any download or execution',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'updater-pinned-'));
 try {
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const file=path.join(root,'bundle-trust.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,requireSignature:true,keys:{fixture:publicKey.export({format:'pem',type:'spki'})}}));
  let downloads=0,executions=0;
  const options=installationFixture(root,{bundledTrustFile:file,downloader:async()=>{downloads++;},processRunner:async()=>{executions++;}});
  await assert.rejects(installRelease(options),/缺少必需的独立签名/);
  assert.equal(downloads,0);assert.equal(executions,0);
  const signing=require('../src/release-signature');
  options.release.assets.push({name:signing.SIGNATURE_ASSET,url:'https://fixture/signature'});
  const checksums=await options.requester();
  const signature={schemaVersion:1,algorithm:'ed25519',keyId:'fixture',version:'0.2.9',signature:crypto.sign(null,signing.signingPayload('0.2.9',checksums),privateKey).toString('base64')};
  const original=options.requester;
  options.requester=async url=>url.endsWith('/signature')?Buffer.from(JSON.stringify({...signature,version:'0.2.8'})):original(url);
  await assert.rejects(installRelease(options),/Untrusted.*version/);
  assert.equal(downloads,0);assert.equal(executions,0);
  const install=installationFixture(root,{bundledTrustFile:file,release:options.release,requester:async url=>url.endsWith('/signature')?Buffer.from(JSON.stringify(signature)):original(url)});
  assert.equal((await installRelease(install)).signatureEvidence.verified,true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('checks Release API digests against checksums and downloaded files before execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'updater-digests-'));
  let executions = 0;
  try {
    const options = installationFixture(root,{processRunner:async()=>{executions+=1;return {stdout:''};}});
    options.release.assets[1].digest = `sha256:${'a'.repeat(64)}`;
    await assert.rejects(installRelease(options), /摘要与校验文件不一致/);
    options.release.assets[1].digest = 'md5:unsupported';
    await assert.rejects(installRelease(options), /不支持或无效/);
    const downloaded = installationFixture(root,{processRunner:options.processRunner,downloader:async(url,target)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'wrong application');return 17;}});
    await assert.rejects(installRelease(downloaded), /大小不一致|SHA-256 校验失败/);
    const checksums = installationFixture(root);
    checksums.release.assets[0].digest = `sha256:${'b'.repeat(64)}`;
    await assert.rejects(installRelease(checksums), /校验文件与 Release 资产摘要不一致/);
    assert.equal(executions,0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('safely replaces incomplete installs only after validation and preserves recoverable files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'updater-partial-'));
  const partial = path.join(root,'runtime','0.2.9');
  fs.mkdirSync(partial,{recursive:true});fs.writeFileSync(path.join(partial,'user-note'),'keep');
  try {
    await assert.rejects(installRelease(installationFixture(root,{processRunner:async()=>{throw new Error('failed verification');}})), /failed verification/);
    assert.equal(fs.readFileSync(path.join(partial,'user-note'),'utf8'),'keep');
    const installed = await installRelease(installationFixture(root));
    assert.equal(fs.readFileSync(path.join(installed.recoveryPath,'user-note'),'utf8'),'keep');
    assert.equal(fs.readFileSync(installed.toolPath,'utf8'),'fresh application');
    assert.equal(fs.existsSync(path.join(root,'.application-update.lock')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('update lock spans application-state changes and rejects concurrent windows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'updater-lock-'));
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const first = withUpdateLock(root,async()=>{await gate;writeUpdateState(root,{activeVersion:'0.2.9'});});
  try {
    await assert.rejects(withUpdateLock(root,async()=>{}), /其它窗口正在更新/);
    await assert.rejects(installRelease(installationFixture(root)), /其它窗口正在更新/);
    release();await first;
    assert.equal(readUpdateState(root).activeVersion,'0.2.9');
    await withUpdateLock(root,async()=>writeUpdateState(root,{activeVersion:'0.2.8'}));
    assert.equal(readUpdateState(root).activeVersion,'0.2.8');
    const extension = fs.readFileSync(path.join(__dirname,'../src/extension.js'),'utf8');
    const start = extension.indexOf("registerCommand('gushenCompletion.checkToolUpdate'");
    const end = extension.indexOf("registerCommand('gushenCompletion.rollbackToolUpdate'");
    assert.ok(extension.slice(start,end).includes('withUpdateLock(storageRoot, async () =>'));
    assert.ok(extension.slice(start,end).includes('alreadyLocked: true'));
    assert.ok(extension.slice(end).includes('withUpdateLock(storageRoot, async () =>'));
    assert.ok(extension.slice(end).includes('verifyExecutable(rollbackPath, state.previousVersion)'));
  } finally {release();await first;fs.rmSync(root,{recursive:true,force:true});}
});

test('streams download response to disk and cleans incomplete installs on body errors', async () => {
  const https = require('node:https');
  const { PassThrough } = require('node:stream');
  const original = https.get;
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'updater-stream-'));
  https.get = (url,options,respond) => {
    const response = new PassThrough();response.statusCode=200;response.headers={};
    queueMicrotask(()=>{respond(response);response.write(Buffer.alloc(1024*1024,'x'));response.end('end');});
    return {setTimeout(){},on(){}};
  };
  try {
    assert.equal(await downloadAsset('https://fixture/app',path.join(root,'app')),1024*1024+3);
    assert.equal(fs.statSync(path.join(root,'app')).size,1024*1024+3);
  } finally {https.get=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('version probes never rewrite application rollback state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'updater-version-state-'));
  const tool = path.join(root,'tool');fs.writeFileSync(tool,'executable');
  writeUpdateState(root,{activeVersion:'0.2.9',previousVersion:'0.2.8',previousPath:'/previous'});
  try {
    const original = fs.readFileSync(path.join(root,'tool-update-state.json'),'utf8');
    assert.equal(await detectCurrentVersion('/unused',root,tool,async()=>({stdout:'{"version":"0.2.9"}'})), '0.2.9');
    assert.equal(fs.readFileSync(path.join(root,'tool-update-state.json'),'utf8'),original);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
