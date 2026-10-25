const test = require('node:test');
const assert = require('node:assert/strict');
const {environmentReportMarkdown, showEnvironmentCheck} = require('../src/environment-check');
const report = (checks, workspaceKey = null) => ({ok: true, workspaceKey, coverage: 'LOCAL_DEPENDENCIES_ONLY', checks,
  health: checks.some(check => check.status === 'FAIL') ? 'FAIL' : checks.some(check => check.status === 'WARN') ? 'WARN' : 'PASS'});
const failure = {name: 'database-readonly', status: 'FAIL', required: true, message: 'missing driver', action: 'runtime'};

function fixture(value, select) {
  const calls = [];
  return {calls, options: {workspaceKey: value.workspaceKey || '', bridgePort: 17369,
    client: {async run(...args) {calls.push({request: args}); return value;}},
    vscode: {ProgressLocation: {Window: 1}, commands: {async executeCommand(...args) {calls.push({command: args});}},
      workspace: {async openTextDocument(document) {calls.push({document}); return document;}},
      window: {async withProgress(_options, action) {return action();}, async showQuickPick(items) {return select?.(items);},
        async showTextDocument(document) {return document;}}}}};
}

test('failed checks remain visible despite successful report execution and Markdown escapes active content', () => {
  const content = environmentReportMarkdown(report([{...failure, message: '<script> [execute](command:evil) | line\nnext'},
    {name: 'config', status: 'SKIP', message: 'unused', required: false}]));
  assert.match(content, /需处理 1/); assert.match(content, /本次未使用/);
  assert.equal(content.includes('<script>'), false); assert.equal(content.includes('](command:'), false);
});

test('a scoped report uses the same explicit workspace and configured Bridge port', async () => {
  const f = fixture(report([failure], 'products.demo'), items => items[0]); await showEnvironmentCheck(f.options);
  assert.deepEqual(f.calls[0].request, ['products.demo', 'doctor', ['--report', '--bridge-port', '17369']]);
  assert.match(f.calls[1].document.content, /products.demo/); assert.match(f.calls[1].document.content, /需处理/);
});

test('an actionable failure invokes only its owned command without automatically installing anything', async () => {
  const f = fixture(report([failure]), items => items[1]); await showEnvironmentCheck(f.options);
  assert.deepEqual(f.calls[1].command, ['gushenCompletion.selectExecutionMode']);
});

test('configuration actions restrict files to the public configuration allowlist', async () => {
  const f = fixture(report([{name: 'database-config', status: 'FAIL', message: 'bad target', action: 'config', configFile: 'database-testing.yaml'}]), items => items[1]);
  await showEnvironmentCheck(f.options); assert.deepEqual(f.calls[1].command, ['gushenCompletion.editConfig', 'database-testing.yaml']);
  const bad = fixture(report([{name: 'config', status: 'FAIL', message: 'bad', action: 'config', configFile: '../private'}]), items => typeof items[0] === 'string' ? undefined : items[1]);
  await showEnvironmentCheck(bad.options); assert.equal(bad.calls.some(call => call.command), false);
});

test('unknown or prototype command names remain report text and cannot execute', async () => {
  for (const action of ['command:evil', 'constructor', 'toString']) {
    const f = fixture(report([{...failure, action}]), items => items[1]); await showEnvironmentCheck(f.options);
    assert.equal(f.calls.some(call => call.command), false); assert.ok(f.calls.some(call => call.document));
  }
});

test('cancelling the result picker performs no further action', async () => {
  const f = fixture(report([failure])); await showEnvironmentCheck(f.options); assert.equal(f.calls.length, 1);
});

test('scope and summary mismatches fail without offering repair actions', async () => {
  const wrong = fixture(report([failure], 'projects.other'), items => items[1]); wrong.options.workspaceKey = 'products.demo';
  await assert.rejects(showEnvironmentCheck(wrong.options), /工作区不一致/); assert.equal(wrong.calls.length, 1);
  assert.throws(() => environmentReportMarkdown({...report([failure]), health: 'PASS'}), /总状态/);
  assert.throws(() => environmentReportMarkdown(report([{...failure, status: 'UNKNOWN'}])), /无效检查项/);
});

test('changing runtime while the picker is open requires a new check before actions', async () => {
  let current = true;
  const f = fixture(report([failure]), items => {current = false; return items[1];}); f.options.isCurrent = () => current;
  await assert.rejects(showEnvironmentCheck(f.options), /运行入口或数据目录已变化/);
  assert.equal(f.calls.some(call => call.command || call.document), false);
});

test('changing runtime during configuration selection cannot open a file in another data directory',async()=>{
  let current=true;
  const f=fixture(report([{...failure,name:'config',action:'config'}]),items=>{
    if(typeof items[0]==='string'){current=false;return 'datasource.yaml';}
    return items[1];
  });f.options.isCurrent=()=>current;
  await assert.rejects(showEnvironmentCheck(f.options),/运行入口或数据目录已变化/);
  assert.equal(f.calls.some(call=>call.command),false);
});
