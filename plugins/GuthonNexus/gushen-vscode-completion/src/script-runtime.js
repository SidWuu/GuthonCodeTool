const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseChecksums, sha256 } = require('./tool-updater');
const { ToolProcessClient } = require('./tool-process-client');

function runProcess(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `退出码 ${code}`).trim()));
    });
  });
}

function verifyScriptChecksum(scriptPath) {
  const checksumPath = path.join(path.dirname(scriptPath), 'GuthonCodeTool-checksums.txt');
  if (!fs.existsSync(checksumPath)) throw new Error(`调试脚本缺少校验文件：${checksumPath}`);
  const checksums = parseChecksums(fs.readFileSync(checksumPath, 'utf8'));
  const expected = checksums.get(path.basename(scriptPath));
  if (!expected) throw new Error('校验文件没有当前调试脚本的 SHA-256');
  if (sha256(scriptPath) !== expected) throw new Error('调试脚本 SHA-256 校验失败');
}

async function probeScriptRuntime(runtime, { verifyChecksum = verifyScriptChecksum } = {}) {
  verifyChecksum(runtime.toolEntry);
  const probe = `import importlib,json,platform,struct,sys
modules={}
for name in ('ssl','sqlite3','subprocess','venv','pymysql','oracledb','psycopg','keyring'):
 try: importlib.import_module(name); modules[name]='ok'
 except Exception as error: modules[name]=type(error).__name__ + ': ' + str(error)
print(json.dumps({'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,'machine':platform.machine().lower(),'modules':modules}))`;
  let environment;
  try {
    environment = JSON.parse(await runProcess(runtime.toolPath, ['-c', probe]));
  } catch (error) {
    throw new Error(`Python 环境不可用：${error.message}`);
  }
  if (environment.version[0] !== 3 || environment.version[1] < 12 || environment.bits !== 64) {
    throw new Error(`调试模式需要 Python 3.12 或更新的 64 位环境；当前为 ${environment.version.join('.')} / ${environment.bits} 位`);
  }
  const machines = process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'amd64'];
  if (!machines.includes(environment.machine)) {
    throw new Error(`Python 架构与 Nexus 不匹配：${environment.machine} / ${process.arch}`);
  }
  const required = ['ssl', 'sqlite3', 'subprocess', 'venv'];
  const missingCore = required.filter((name) => environment.modules[name] !== 'ok');
  if (missingCore.length) throw new Error(`调试环境缺少基础能力：${missingCore.join('、')}`);
  const version = JSON.parse(await runProcess(runtime.toolPath, [runtime.toolEntry, 'version']));
  if (!/^\d+\.\d+\.\d+$/.test(version.version || '')) throw new Error('调试脚本版本无效');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-script-probe-'));
  const client = new ToolProcessClient();
  try {
    await runProcess(runtime.toolPath, [runtime.toolEntry, 'self-test', '--home', home], 120000);
    const response = await client.request({ ...runtime, toolHome: home }, 'version');
    if (response.version !== version.version) throw new Error('ToolHost 与脚本版本不一致');
  } finally {
    await client.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return {
    version: version.version,
    missingProviders: ['pymysql', 'oracledb', 'psycopg', 'keyring']
      .filter((name) => environment.modules[name] !== 'ok')
      .map((name) => `${name}: ${environment.modules[name]}`),
  };
}

module.exports = { probeScriptRuntime, verifyScriptChecksum };
