const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseChecksums, sha256, runProcess, withUpdateLock } = require('./tool-updater');
const { readTrust, verifySignature, SIGNATURE_ASSET } = require('./release-signature');
const { ASSETS } = require('./release-catalog');
const { ToolProcessClient } = require('./tool-process-client');

const CHECKSUMS = 'GuthonCodeTool-checksums.txt';
const PROVIDERS = ['pymysql', 'oracledb', 'psycopg', 'keyring'];
const CORE_MODULES = ['ssl', 'sqlite3', 'subprocess', 'venv'];
const ARCHITECTURES = { arm64: ['arm64', 'aarch64'], x64: ['x86_64', 'amd64'] };

function verifyScriptChecksum(scriptPath) {
  const checksumPath = path.join(path.dirname(scriptPath), CHECKSUMS);
  if (!fs.existsSync(checksumPath)) throw new Error(`调试脚本缺少校验文件：${checksumPath}`);
  const checksums = parseChecksums(fs.readFileSync(checksumPath, 'utf8'));
  const expected = checksums.get(path.basename(scriptPath)) || checksums.get(ASSETS.script);
  if (!expected) throw new Error('校验文件没有当前调试脚本的 SHA-256');
  if (sha256(scriptPath) !== expected) throw new Error('调试脚本 SHA-256 校验失败');
}

async function probeScriptRuntime(runtime, { verifyChecksum = verifyScriptChecksum } = {}) {
  verifyChecksum(runtime.toolEntry);
  const probe = `import importlib,json,platform,struct,sys
modules={}
for name in ${JSON.stringify([...CORE_MODULES, ...PROVIDERS, 'certifi', 'yaml'])}:
 try: importlib.import_module(name); modules[name]='ok'
 except Exception as error: modules[name]=type(error).__name__ + ': ' + str(error)
print(json.dumps({'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,'machine':platform.machine().lower(),'modules':modules}))`;
  let environment;
  try {
    environment = JSON.parse((await runProcess(runtime.toolPath, ['-I', '-c', probe])).stdout);
  } catch (error) {
    throw new Error(`Python 环境不可用：${error.message}`);
  }
  if (environment.version[0] !== 3 || environment.version[1] < 12 || environment.bits !== 64) {
    throw new Error(`调试模式需要 Python 3.12 或更新的 64 位环境；当前为 ${environment.version.join('.')} / ${environment.bits} 位`);
  }
  if (!ARCHITECTURES[process.arch]?.includes(environment.machine)) {
    throw new Error(`Python 架构与 Nexus 不匹配：${environment.machine} / ${process.arch}`);
  }
  const missingCore = CORE_MODULES.filter((name) => environment.modules[name] !== 'ok');
  if (missingCore.length) throw new Error(`调试环境缺少基础能力：${missingCore.join('、')}`);
  const version = JSON.parse((await runProcess(runtime.toolPath, [runtime.toolEntry, 'version'])).stdout);
  if (!/^\d+\.\d+\.\d+$/.test(version.version || '')) throw new Error('调试脚本版本无效');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-script-probe-'));
  const client = new ToolProcessClient();
  try {
    await runProcess(runtime.toolPath, [runtime.toolEntry, 'self-test', '--home', home]);
    const response = await client.request({ ...runtime, toolHome: home }, 'version');
    if (response.version !== version.version) throw new Error('ToolHost 与脚本版本不一致');
  } finally {
    await client.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return {
    version: version.version,
    missingProviders: [...PROVIDERS, 'certifi', 'yaml']
      .filter((name) => environment.modules[name] !== 'ok')
      .map((name) => `${name}: ${environment.modules[name]}`),
  };
}

async function findBasePython(preferred, runner, platform, arch) {
  const commands = [];
  if (path.isAbsolute(preferred || '') && fs.existsSync(preferred)) commands.push([preferred]);
  if (platform === 'win32') {
    const windows = process.env.SystemRoot || process.env.WINDIR || '';
    const local = process.env.LOCALAPPDATA || '';
    const launchers = [windows, path.isAbsolute(local) ? path.join(local, 'Programs', 'Python', 'Launcher') : ''];
    const pathDirectories = (process.env.PATH || '').split(path.delimiter).filter(directory =>
      path.isAbsolute(directory) && path.basename(directory).toLowerCase() !== 'windowsapps');
    for (const directory of new Set([...launchers.filter(directory => path.isAbsolute(directory)), ...pathDirectories])) {
      const launcher = path.join(directory, 'py.exe');
      if (fs.existsSync(launcher)) commands.push([launcher, '-3.12'], [launcher, '-3']);
    }
    for (const directory of pathDirectories) {
      const executable = path.join(directory, 'python.exe');
      if (fs.existsSync(executable)) commands.push([executable]);
    }
  } else {
    commands.push(['python3.12'], ['python3']);
    if (platform === 'darwin') {
      for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin']) {
        for (const name of ['python3.12', 'python3']) {
          const candidate = path.join(directory, name);
          if (fs.existsSync(candidate)) commands.push([candidate]);
        }
      }
    }
  }
  const query = `import ensurepip,json,platform,sqlite3,ssl,struct,subprocess,sys,venv
print(json.dumps({'executable':sys._base_executable,'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,'machine':platform.machine().lower()}))`;
  for (const [command, ...args] of commands) {
    try {
      const { stdout } = await runner(command, [...args, '-I', '-c', query], { timeoutMs: 8000 });
      const info = JSON.parse(stdout);
      if (info.version[0] === 3 && info.version[1] >= 12 && info.bits === 64
          && ARCHITECTURES[arch]?.includes(info.machine) && path.isAbsolute(info.executable)) {
        return { ...info, executable: fs.realpathSync(info.executable) };
      }
    } catch { /* Try the next installed interpreter. */ }
  }
  throw new Error('找不到与 Nexus 架构匹配且支持 venv 的 64 位 Python 3.12 或更新版本。请安装标准 Python 后重新选择 pyz。');
}

async function prepareScriptRuntime(scriptPath, { storageRoot, pythonPath, onProgress = () => {},
  runner = runProcess, probeRuntime = probeScriptRuntime, platform = process.platform, arch = process.arch } = {}) {
  if (!path.isAbsolute(scriptPath || '') || path.extname(scriptPath).toLowerCase() !== '.pyz') {
    throw new Error('请选择 GuthonCodeTool-python.pyz');
  }
  const source = path.dirname(scriptPath);
  const required = [scriptPath, ...[ASSETS.requirements, CHECKSUMS, SIGNATURE_ASSET].map(name => path.join(source, name))];
  const missing = required.filter(file => !fs.existsSync(file)).map(file => path.basename(file));
  if (missing.length) throw new Error('请将同一 Release 的四个调试附件放在同一目录。缺少：' + missing.join('、'));
  const scriptStat = fs.statSync(scriptPath);
  if (!scriptStat.isFile() || scriptStat.size > 256 * 1024 * 1024) throw new Error('调试脚本不是有效的 pyz 文件');
  const metadata = required.slice(1);
  if (metadata.some(file => {
    const stat = fs.statSync(file);
    return !stat.isFile() || stat.size > 65536;
  })) {
    throw new Error('调试模式的依赖清单或签名文件无效');
  }
  const [requirements, checksums, signatureBytes] = metadata.map(file => fs.readFileSync(file));
  const signature = JSON.parse(signatureBytes.toString('utf8'));
  verifySignature(signature?.version, checksums, signature, readTrust(storageRoot));
  const hashes = parseChecksums(checksums.toString('utf8'));
  const requirementsHash = crypto.createHash('sha256').update(requirements).digest('hex');
  if (hashes.get(ASSETS.requirements) !== requirementsHash || hashes.get(ASSETS.script) !== sha256(scriptPath)) {
    throw new Error('pyz 或依赖清单的 SHA-256 与同版发行签名不符');
  }

  onProgress('检查本机 Python');
  const python = await findBasePython(pythonPath, runner, platform, arch);
  const key = crypto.createHash('sha256').update(JSON.stringify([requirementsHash, python])).digest('hex').slice(0, 24);
  const cache = path.join(storageRoot, 'script-runtimes');
  const profile = path.join(cache, key);
  for (const directory of [cache, profile]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('调试运行目录必须是普通目录');
  }
  const venv = path.join(profile, '.venv');
  const executable = platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  const ready = path.join(profile, 'ready');
  const runtime = { mode: 'script', toolPath: executable, toolEntry: scriptPath };
  return withUpdateLock(profile, async () => {
    const reused = fs.existsSync(ready) && fs.existsSync(executable);
    try {
      if (!reused) {
        fs.rmSync(ready, { force: true });
        fs.rmSync(venv, { recursive: true, force: true });
        onProgress('创建调试虚拟环境');
        await runner(python.executable, ['-I', '-m', 'venv', venv], { timeoutMs: 120000 });
        const requirementsFile = path.join(profile, ASSETS.requirements);
        fs.rmSync(requirementsFile, { force: true });
        fs.writeFileSync(requirementsFile, requirements, { flag: 'wx', mode: 0o600 });
        onProgress('安装调试依赖');
        await runner(executable, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input',
          'install', '--only-binary=:all:', '-r', requirementsFile], { timeoutMs: 600000 });
      }
      onProgress(reused ? '检查已准备的调试环境' : '验证 pyz 与 ToolHost');
      const result = await probeRuntime(runtime, { verifyChecksum: file => {
        if (sha256(file) !== hashes.get(ASSETS.script)) throw new Error('验证前 pyz 内容已变化');
      } });
      if (result.version !== signature.version) throw new Error('调试脚本与发行签名的版本不一致');
      if (result.missingProviders.length) throw new Error('调试环境缺少依赖：' + result.missingProviders.join('；'));
      if (!reused) fs.writeFileSync(ready, signature.version + '\n', { flag: 'wx', mode: 0o600 });
      return { runtime, version: result.version };
    } catch (error) {
      if (!reused) fs.rmSync(venv, { recursive: true, force: true });
      throw error;
    }
  });
}

module.exports = { prepareScriptRuntime, verifyScriptChecksum };
