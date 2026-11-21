const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { toolArguments } = require('./tool-runtime');
const execute = promisify(execFile);

function sshTool(name) {
  if (process.platform !== 'win32') return name;
  const candidates = [process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'OpenSSH', name + '.exe')];
  for (const key of ['ProgramFiles', 'LOCALAPPDATA']) {
    if (process.env[key]) for (const prefix of ['', 'Programs']) candidates.push(path.join(process.env[key], prefix, 'Git', 'usr', 'bin', name + '.exe'));
  }
  return candidates.find(file => file && fs.existsSync(file)) || name;
}

function repositoryUrl(value) {
  const url = new URL(value);
  if (/[\x00-\x20"\\]/.test(value) || !['ssh:', 'https:', 'http:'].includes(url.protocol)
      || !url.hostname || url.pathname === '/' || url.password || url.search || url.hash
      || (url.protocol !== 'ssh:' && url.username)) throw new Error('请输入团队提供的不含密码或令牌的内网 Git 地址');
  return url;
}

async function workspaceTeamSource(window, configured = process.env.GUTHON_TEAM_MARKETPLACE_URL, edit = false) {
  if (configured && !edit) {
    repositoryUrl(configured);
    return configured;
  }
  return window.showInputBox({
    title: '连接 guthon-team',
    prompt: '输入团队提供的内网 Git 克隆地址，用于同步规则和开发门禁。',
    value: edit ? configured : undefined,
    validateInput: value => {
      try { repositoryUrl(value); }
      catch { return '请输入团队提供的不含密码或令牌的内网 Git 地址'; }
    },
  });
}

async function checkRepository(value, run = execute, environment = {}) {
  repositoryUrl(value);
  try {
    const result = await run('git', ['ls-remote', value, 'HEAD'], { timeout: 20000, windowsHide: true,
      env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10' } });
    if (!/^[a-f0-9]{40,64}\s+HEAD\s*$/m.test(result.stdout || '')) throw new Error();
  } catch { throw new Error('内网仓库访问未通过。请先连接公司网络，确认账号权限、SSH 公钥与首次服务器信任，再重试；可在“首次连接授权”终端查看具体提示。'); }
}

async function publicKey(home = os.homedir(), run = execute) {
  const key = path.join(home, '.ssh', 'id_ed25519'), pub = key + '.pub';
  if (!fs.existsSync(key) && !fs.existsSync(pub)) {
    fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
    await run(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-f', key], { timeout: 30000, windowsHide: true });
  }
  if (!fs.existsSync(pub) || fs.lstatSync(pub).isSymbolicLink() || fs.statSync(pub).size > 16384) throw new Error('已有 SSH 密钥未找到有效公钥；请由维护者核对，向导不会覆盖已有密钥');
  const value = fs.readFileSync(pub, 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(value)) throw new Error('SSH 公钥格式无效');
  return value;
}

function terminalCommand(args, platform) {
  const quote = platform === 'win32' ? text => "'" + text.replace(/'/g, "''") + "'" : text => "'" + text.replace(/'/g, "'\"'\"'") + "'";
  return (platform === 'win32' ? '& ' : '') + args.map(quote).join(' ');
}

function authorizationCommand(value, platform = process.platform) {
  const url = repositoryUrl(value);
  const args = url.protocol === 'ssh:' ? [sshTool('ssh'), '-T', '-p', url.port || '22', `${decodeURIComponent(url.username || 'git')}@${url.hostname}`]
    : ['git', 'ls-remote', value, 'HEAD'];
  return terminalCommand(args, platform);
}

function openTeamSyncTerminal(window, tool, args, platform = process.platform) {
  const terminal = window.createTerminal({
    name: 'Guthon 团队规则同步',
    cwd: tool.toolHome,
    env: tool.env,
    ...(platform === 'win32' ? { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] } : { shellPath: '/bin/sh' }),
  });
  terminal.show();
  terminal.sendText(terminalCommand([tool.toolPath, ...toolArguments(tool, 'setup', args)], platform));
}

module.exports = { checkRepository, publicKey, authorizationCommand, repositoryUrl, workspaceTeamSource, openTeamSyncTerminal };
