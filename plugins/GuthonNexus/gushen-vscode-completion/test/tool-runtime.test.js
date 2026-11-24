const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeExecutionMode, runtimeSelectionOptions, resolveDevelopmentRuntime, resolvePackagedTool, resolveScriptRuntime, packagedToolInDirectory,
  toolArguments, writeRuntimeDescriptor,
} = require('../src/tool-runtime');

test('installer workspace runtime changes remain in the effective setting scope', () => {
  const { runtimeConfigurationTarget } = require('../src/tool-runtime');
  const targets = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  assert.equal(runtimeConfigurationTarget({ inspect: () => ({ workspaceValue: '/suite/tool.exe' }) }, 'toolPath', targets), 2);
  assert.equal(runtimeConfigurationTarget({ inspect: () => ({ workspaceFolderValue: 'script', workspaceValue: 'packaged' }) }, 'executionMode', targets), 3);
  assert.equal(runtimeConfigurationTarget({ inspect: () => ({ globalValue: '/old/tool.exe' }) }, 'toolPath', targets), 1);
});

test('suite dependencies remain available to a pre-existing IDE without changing process PATH', () => {
  const { installedToolEnvironment } = require('../src/tool-runtime');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-environment-'));
  try {
    const git = path.join(home, 'Git', 'cmd', 'git.exe'), svn = path.join(home, 'SVN', 'bin', 'svn.exe');
    for (const file of [git, svn]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
    fs.mkdirSync(path.join(home, 'Git', 'usr', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'var', 'nexus'), { recursive: true });
    fs.writeFileSync(path.join(home, 'var', 'nexus', 'setup-result.json'), JSON.stringify({ state: 'environment-ready', programs: { git, svn } }));
    const environment = installedToolEnvironment(home, { PATH: '/old/parent' });
    assert.ok(environment.PATH.includes(path.dirname(git)));
    assert.equal(environment.PATH.includes(path.dirname(svn)),false);
    assert.ok(environment.PATH.endsWith('/old/parent'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolves the repository virtualenv and Python entry point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-runtime-'));
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'guthon_tool.py'), '');

  const runtime = resolveDevelopmentRuntime(root, 'darwin');

  assert.equal(runtime.mode, 'source-development');
  assert.equal(runtime.toolPath, path.join(root, '.venv', 'bin', 'python'));
  assert.equal(runtime.toolEntry, path.join(root, 'scripts', 'guthon_tool.py'));
});

test('builds matching packaged and development command arguments', () => {
  assert.deepEqual(
    toolArguments({ toolHome: '/data' }, 'export-view', ['--view-ids', 'V1'], 'products.demo'),
    ['export-view', '--home', '/data', '--workspace', 'products.demo', '--', '--view-ids', 'V1']
  );
  assert.deepEqual(
    toolArguments({ toolEntry: '/repo/scripts/guthon_tool.py', toolHome: '/data' }, 'pull'),
    ['/repo/scripts/guthon_tool.py', 'pull', '--home', '/data']
  );
});

test('writes packaged and development runtime descriptors for AI tools', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-runtime-home-'));

  const descriptorPath = writeRuntimeDescriptor({
    mode: 'packaged',
    toolPath: '/tool/GuthonCodeTool',
    toolHome: home,
  });
  // 描述符只写在 toolHome 下，与源码仓库（developmentRoot）无关。
  assert.equal(descriptorPath, path.join(home, 'var', 'nexus', 'tool-runtime.json'));
  assert.equal(descriptorPath.startsWith('/repo'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), {
    mode: 'packaged',
    protocolVersion: 1,
    command: ['/tool/GuthonCodeTool'],
    codeSource: '/tool/GuthonCodeTool',
    home,
    workspaceRoot: path.join(home, 'var'),
    workspaceResolveCommand: ['/tool/GuthonCodeTool', 'workspace-resolve', '--home', home],
    databaseTargetResolveCommand: ['/tool/GuthonCodeTool', 'database-target-resolve', '--home', home],
    databaseProbeCommand: ['/tool/GuthonCodeTool', 'database-probe', '--home', home],
    databaseDescribeCommand: ['/tool/GuthonCodeTool', 'database-describe', '--home', home],
    databaseQueryCommand: ['/tool/GuthonCodeTool', 'database-query-readonly', '--home', home],
    linterCommand: ['/tool/GuthonCodeTool', 'lint', '--home', home],
  });

  writeRuntimeDescriptor({
    mode: 'source-development',
    toolPath: '/repo/.venv/bin/python',
    toolEntry: '/repo/scripts/guthon_tool.py',
    toolHome: home,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), {
    mode: 'source-development',
    protocolVersion: 1,
    command: ['/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py'],
    codeSource: '/repo/scripts/guthon_tool.py',
    home,
    workspaceRoot: path.join(home, 'var'),
    workspaceResolveCommand: [
      '/repo/.venv/bin/python',
      '/repo/scripts/guthon_tool.py',
      'workspace-resolve',
      '--home',
      home,
    ],
    databaseTargetResolveCommand: [
      '/repo/.venv/bin/python',
      '/repo/scripts/guthon_tool.py',
      'database-target-resolve',
      '--home',
      home,
    ],
    databaseProbeCommand: [
      '/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py',
      'database-probe', '--home', home,
    ],
    databaseDescribeCommand: [
      '/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py',
      'database-describe', '--home', home,
    ],
    databaseQueryCommand: [
      '/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py',
      'database-query-readonly', '--home', home,
    ],
    linterCommand: ['/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py', 'lint', '--home', home],
  });

  fs.rmSync(home, { recursive: true });
});

test('selecting development mode always asks for the source directory', () => {
  assert.deepEqual(runtimeSelectionOptions('packaged'), {
    probePackaged: true,
    selectScript: false, selectPackaged: false, selectDevelopment: false,
  });
  for (const mode of ['source-development', 'development']) {
    assert.equal(runtimeSelectionOptions(mode).selectDevelopment, true, mode);
  }
  assert.equal(runtimeSelectionOptions('script').selectDevelopment, false);
  assert.equal(runtimeSelectionOptions('script').selectScript, true);
  assert.deepEqual(runtimeSelectionOptions('packaged', true), {
    probePackaged: true,
    selectScript: true, selectPackaged: true, selectDevelopment: true,
  });
  // 命令必须复用该选项，否则仍会沿用旧的 developmentRoot 而不弹目录选择。
  const extension = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  const command = /registerCommand\('gushenCompletion\.selectExecutionMode'[\s\S]*?\n    \}\),/.exec(extension);
  assert.ok(command, 'selectExecutionMode must stay registered');
  assert.match(command[0], /runtimeSelectionOptions\(selected\.value, selectEntry\)/);
});

test('migrates the old development setting and keeps script paths separate', () => {
  assert.equal(normalizeExecutionMode('development'), 'source-development');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-script-'));
  const python = path.join(root, 'python');
  const script = path.join(root, 'GuthonCodeTool-python.pyz');
  fs.writeFileSync(python, '');
  fs.writeFileSync(script, '');
  assert.deepEqual(resolveScriptRuntime(python, script), {
    mode: 'script', toolPath: python, toolEntry: script,
  });
  assert.throws(() => resolveScriptRuntime(python, path.join(root, 'other.zip')), /\.pyz/);
  fs.rmSync(root, { recursive: true });
});

test('requires the executable file on both platforms instead of accepting application folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-packaged-'));
  const launchDir = path.join(root, 'GuthonCodeTool');
  fs.mkdirSync(path.join(launchDir, '_internal'), { recursive: true });
  const launcher = path.join(launchDir, 'GuthonCodeTool');
  fs.writeFileSync(launcher, '');

  assert.equal(resolvePackagedTool(launchDir), '');
  assert.equal(resolvePackagedTool(launcher), launcher);
  const windows = path.join(root, 'GuthonCodeTool-windows-x64.exe');
  fs.writeFileSync(windows, '');
  assert.equal(resolvePackagedTool(windows), windows);
  assert.equal(resolvePackagedTool(path.join(root, 'missing')), '');
  assert.equal(resolvePackagedTool(path.join(launchDir, '_internal')), '');
  fs.rmSync(root, { recursive: true });
});

test('keeps the runtime descriptor untouched when its content is unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-descriptor-'));
  const tool = { mode: 'packaged', toolPath: '/tool/GuthonCodeTool', toolHome: home };
  const descriptorPath = writeRuntimeDescriptor(tool);
  fs.utimesSync(descriptorPath, new Date(0), new Date(0));

  writeRuntimeDescriptor(tool);

  assert.equal(fs.statSync(descriptorPath).mtimeMs, 0);
  // 内容变化时必须重新写入。
  writeRuntimeDescriptor({ ...tool, toolPath: '/tool/OtherGuthon' });
  assert.notEqual(fs.statSync(descriptorPath).mtimeMs, 0);
  assert.equal(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).command[0], '/tool/OtherGuthon');
  fs.rmSync(home, { recursive: true });
});

test('Nexus presents project overview, current card and current source in order', () => {
  const extension=fs.readFileSync(path.join(__dirname,'../src/extension.js'),'utf8');
  const manifest=require('../package.json');
  assert.deepEqual(manifest.contributes.views.guthon.map(({id,name})=>({id,name})),[
    {id:'gushenCompletion.projectOverview',name:'项目总览'},
    {id:'gushenCompletion.projectDetails',name:'当前项目'},
    {id:'gushenCompletion.sourceView',name:'项目源码'}]);
  assert(!extension.includes('ToolTreeDataProvider'));assert(!extension.includes('gushenCompletion.toolView'));
  assert(manifest.contributes.commands.some(x=>x.command==='gushenCompletion.showProjectActions'));
  const commands=new Map(manifest.contributes.commands.map(x=>[x.command,x]));
  for(const entry of manifest.contributes.menus['view/title'].filter(x=>x.group.startsWith('navigation')))assert(commands.get(entry.command).icon,entry.command+' must render as an icon');
});

test('packaged application picker selects files only on Windows and macOS', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  const optionsSource = /if \(selectPackaged\) \{\s*const selected = await vscode\.window\.showOpenDialog\((\{[\s\S]*?\})\);/.exec(source);
  assert.ok(optionsSource, 'packaged picker must be present');
  for (const platform of ['win32', 'darwin']) {
    const options = vm.runInNewContext(`(${optionsSource[1]})`, { process: { platform } });
    assert.equal(options.canSelectFiles, true);
    assert.equal(options.canSelectFolders, false);
    assert.equal(options.canSelectMany, false);
    assert.match(options.title, /可执行文件/);
    if (platform === 'win32') assert.equal(options.filters['可执行文件'][0], 'exe');
    else assert.equal(options.filters, undefined);
  }
});


test('lint descriptor preserves runtime and special characters as argument array', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime & % space-'));
  try {
    for (const tool of [
      {mode:'packaged', toolPath:'/tool & %/GuthonCodeTool.exe'},
      {mode:'script', toolPath:'/python & %/python.exe', toolEntry:'/tool & %/GuthonCodeTool.pyz'},
      {mode:'source-development', toolPath:'/python & %/python', toolEntry:'/source & %/scripts/guthon_tool.py'},
    ]) {
      const descriptor = JSON.parse(fs.readFileSync(writeRuntimeDescriptor({...tool,toolHome:home}), 'utf8'));
      assert.deepEqual(descriptor.linterCommand, [...descriptor.command, 'lint', '--home', home]);
      assert.deepEqual([...descriptor.linterCommand, '--scope-from', '/scope & %/项目'],
        [tool.toolPath, ...(tool.toolEntry ? [tool.toolEntry] : []), 'lint', '--home', home, '--scope-from', '/scope & %/项目']);
    }
  } finally { fs.rmSync(home, {recursive:true, force:true}); }
});


test('finds the platform application in a runtime directory including the older Mac folder', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-neighbor-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const longExe = path.join(root, 'GuthonCodeTool-windows-x64.exe');
  const shortExe = path.join(root, 'GuthonCodeTool.exe');
  const launcher = path.join(root, 'GuthonCodeTool');
  assert.equal(packagedToolInDirectory(root, 'win32'), '');
  fs.writeFileSync(shortExe, 'fixture');
  assert.equal(packagedToolInDirectory(root, 'win32'), shortExe);
  fs.writeFileSync(longExe, 'fixture');
  assert.equal(packagedToolInDirectory(root, 'win32'), longExe);
  fs.writeFileSync(launcher, 'fixture');
  assert.equal(packagedToolInDirectory(root, 'darwin'), launcher);

  const legacyDir = path.join(root, 'old', 'GuthonCodeTool');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyLauncher = path.join(legacyDir, 'GuthonCodeTool');
  fs.writeFileSync(legacyLauncher, 'fixture');
  assert.equal(packagedToolInDirectory(path.dirname(legacyDir), 'darwin'), legacyLauncher);
});
