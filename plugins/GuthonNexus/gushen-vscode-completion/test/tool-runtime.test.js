const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveDevelopmentRuntime, toolArguments, writeRuntimeDescriptor } = require('../src/tool-runtime');

test('resolves the repository virtualenv and Python entry point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-runtime-'));
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'guthon_tool.py'), '');

  const runtime = resolveDevelopmentRuntime(root, 'darwin');

  assert.equal(runtime.mode, 'development');
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
    command: ['/tool/GuthonCodeTool'],
    home,
    workspaceResolveCommand: ['/tool/GuthonCodeTool', 'workspace-resolve', '--home', home],
    databaseTargetResolveCommand: ['/tool/GuthonCodeTool', 'database-target-resolve', '--home', home],
    databaseProbeCommand: ['/tool/GuthonCodeTool', 'database-probe', '--home', home],
    databaseDescribeCommand: ['/tool/GuthonCodeTool', 'database-describe', '--home', home],
    databaseQueryCommand: ['/tool/GuthonCodeTool', 'database-query-readonly', '--home', home],
    linterCommand: [path.join(home, 'var', 'tools', 'guthon-lint')],
  });

  writeRuntimeDescriptor({
    mode: 'development',
    toolPath: '/repo/.venv/bin/python',
    toolEntry: '/repo/scripts/guthon_tool.py',
    toolHome: home,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), {
    mode: 'development',
    command: ['/repo/.venv/bin/python', '/repo/scripts/guthon_tool.py'],
    home,
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
    linterCommand: [path.join(home, 'var', 'tools', 'guthon-lint')],
  });

  fs.rmSync(home, { recursive: true });
});

test('Nexus lists every configured workspace and binds commands to workspaceKey', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  const manifest = require('../package.json');

  assert.equal(extension.includes("readWorkspaces(tool)"), true);
  assert.equal(extension.includes("item.displayName"), true);
  assert.equal(extension.includes("[item.workspaceKey]"), true);
  assert.equal(extension.includes("gushenCompletion.selectWorkspaceSourceMode"), true);
  assert.equal(extension.includes("sourceModeView"), false);
  assert.equal(extension.includes("syncActive"), false);
  assert.deepEqual(
    manifest.contributes.views.guthon.map(({ id, name }) => ({ id, name })),
    [
      { id: 'gushenCompletion.toolView', name: '谷神工作区' },
      { id: 'gushenCompletion.svnSourceView', name: '谷神源码' },
    ]
  );
  assert.equal((extension.match(/toolItem\(\s*'添加产品或项目'/g) || []).length, 1);
  assert.equal(extension.includes("new vscode.TreeItem('运行模式', vscode.TreeItemCollapsibleState.Collapsed)"), true);
  assert.equal(extension.includes('`切换模式：${executionMode'), true);
  assert.equal(extension.includes('`当前版本：${applicationVersion}`'), true);
  assert.equal(extension.includes('`更新源：${UPDATE_SOURCES[updateSource]'), true);
  assert.equal(extension.includes("toolItem('检查更新'"), true);
  assert.equal(extension.includes("'回退到上一版本'"), true);
  assert.equal(manifest.contributes.configuration.properties['gushenCompletion.updateSource'].default, 'gitee');
  assert.equal(manifest.contributes.commands.some(({ command }) => command === 'gushenCompletion.checkToolUpdate'), true);
});
