'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class SvnExecutableError extends Error {
  constructor(message, candidates = []) {
    super(message);
    this.name = 'SvnExecutableError';
    this.code = 'SVN_EXECUTABLE_NOT_FOUND';
    this.candidates = candidates;
  }
}

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function expandConfiguredPath(
  value,
  env = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform
) {
  const pathApi = platformPath(platform);
  let result = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!result) return '';
  result = result
    .replace(/%([^%]+)%/g, (match, name) => env[name] || env[name.toUpperCase()] || match)
    .replace(/\$\{([^}]+)\}/g, (match, name) => env[name] || match);
  if (result === '~') return homeDirectory;
  if (result.startsWith('~/') || result.startsWith('~\\')) {
    return pathApi.join(homeDirectory, result.slice(2));
  }
  return pathApi.resolve(result);
}

function pathExecutableNames(platform, env) {
  if (platform !== 'win32') return ['svn'];
  const extensions = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return [...new Set(['svn.exe', 'svn', ...extensions.map((extension) => `svn${extension}`)])];
}

function knownSvnPaths(platform, env, homeDirectory) {
  const pathApi = platformPath(platform);
  if (platform === 'darwin') {
    return [
      '/usr/bin/svn',
      '/opt/homebrew/bin/svn',
      '/usr/local/bin/svn',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/svn'
    ];
  }
  if (platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    return [
      ...programFiles.flatMap((root) => [
        pathApi.join(root, 'TortoiseSVN', 'bin', 'svn.exe'),
        pathApi.join(root, 'SlikSvn', 'bin', 'svn.exe'),
        pathApi.join(root, 'VisualSVN Server', 'bin', 'svn.exe')
      ]),
      env.ProgramData && pathApi.join(env.ProgramData, 'chocolatey', 'bin', 'svn.exe'),
      homeDirectory && pathApi.join(homeDirectory, 'scoop', 'apps', 'subversion', 'current', 'bin', 'svn.exe'),
      env.LOCALAPPDATA && pathApi.join(env.LOCALAPPDATA, 'Programs', 'Subversion', 'bin', 'svn.exe')
    ].filter(Boolean);
  }
  return ['/usr/bin/svn', '/usr/local/bin/svn', '/snap/bin/svn'];
}

function svnExecutableCandidates({
  configuredPath = '',
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir()
} = {}) {
  const pathApi = platformPath(platform);
  const configured = expandConfiguredPath(configuredPath, env, homeDirectory, platform);
  if (configured) return [configured];

  const delimiter = platform === 'win32' ? ';' : ':';
  const pathEntries = String(env.PATH || '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const pathCandidates = pathEntries.flatMap((directory) => (
    pathExecutableNames(platform, env).map((name) => pathApi.join(directory, name))
  ));
  return [...new Set([...pathCandidates, ...knownSvnPaths(platform, env, homeDirectory)]
    .map((candidate) => pathApi.resolve(candidate)))];
}

function defaultIsExecutable(candidate, platform = process.platform) {
  try {
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveSvnExecutable(options = {}) {
  const candidates = svnExecutableCandidates(options);
  const isExecutable = options.isExecutable || ((candidate) => defaultIsExecutable(candidate, options.platform));
  const executable = candidates.find(isExecutable);
  if (executable) return executable;

  if (String(options.configuredPath || '').trim()) {
    throw new SvnExecutableError(
      `配置的 SVN 可执行文件不存在或不可执行：${candidates[0] || options.configuredPath}`,
      candidates
    );
  }
  throw new SvnExecutableError(
    '找不到 SVN 命令行。请安装 Subversion，或配置 guthonSvnNavigator.svnExecutable。',
    candidates
  );
}

module.exports = {
  SvnExecutableError,
  expandConfiguredPath,
  knownSvnPaths,
  resolveSvnExecutable,
  svnExecutableCandidates
};
