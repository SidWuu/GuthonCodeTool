const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {once} = require('node:events');
const {webcrypto,createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {consume} = require('../extension/event-client');

const root = path.resolve(__dirname, '../../..');
const nexus = '../../GuthonNexus/gushen-vscode-completion/src';
const {registerLegacyProjects} = require(nexus + '/legacy-project');
const {ToolProcessClient} = require(nexus + '/tool-process-client');
const entry = path.join(root, 'scripts/guthon_tool.py');
const fixture = path.join(root, 'tests/ci/fixtures/database_publication.py');
const envPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = fs.existsSync(envPython) ? envPython : process.platform === 'win32' ? 'python' : 'python3';

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function fixtureCommand(home, action) {
  const result = spawnSync(python, ['-B', fixture, action, home], {encoding:'utf8', timeout:10000});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('DATABASE explicit confirmation publishes one frozen Workcopy through Nexus, paired browser and precise mirror', {timeout:45000}, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'db-publish-e2e-')));
  const client = new ToolProcessClient();
  let server, worker;
  async function stopBridge() {
    if (worker) vm.runInContext('publishedTabs.clear(); clearTimeout(eventRetry); eventConnection?.abort()', worker);
    worker = undefined;
    if (server?.exitCode === null) {server.kill(); await once(server, 'exit');}
    server = undefined;
  }
  t.after(async () => {
    await stopBridge();
    await client.stop();
    fs.rmSync(home, {recursive:true, force:true});
  });
  const workspace = fixtureCommand(home, 'setup');
  const {workspaceKey:key} = workspace;
  const tool = {toolPath:python, toolEntry:entry, toolHome:home, mode:'packaged', env:{PYTHONDONTWRITEBYTECODE:'1'}};
  const call = (command, args, input) => client.request(tool, command, args, key, input);
  const {items:[record]} = await call('legacy-source', ['catalog','--type','procedure']);
  const {recordId, sourceId, sourcePath} = record;
  const source = {recordId, sourceId, sourcePath};
  const edit = (action, input) => call('legacy-source', [action], {...source, ...input});
  const readonly = path.join(workspace.readonlyDir, sourcePath);
  const workcopy = path.join(workspace.workcopyDir, sourcePath);
  const baseline = await edit('edit-read');
  const frozen = "#return('提交候选')\n" + '// GSS\n'.repeat(11000);
  const later = "#return('later')";
  const saved = await edit('edit-save', {sourceHash:baseline.sourceHash, content:frozen});

  let port, pairingToken, writes = 0, readbacks = 0, appliedOperationId, letReadProveOperation = false;
  let platform = {version:'native-v1', content:baseline.content};
  let browserContextId, simulateConfirm = false, confirmHook, choice = 'candidate';
  const preflightReceipts = [];
  const identity = 'a'.repeat(32);
  const origin = 'https://platform.test';
  const tab = {id:1,url:origin + '/guthon/'};
  const metadata = {mode:'procedure',systemId:'SYS-1',dataSourceId:'DS-1'};
  const messages = [], errors = [], subscriptions = [];
  t.after(() => subscriptions.forEach(item => item.dispose()));
  async function bridge(route, payload, extraHeaders) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method:payload === undefined ? 'GET' : 'POST', headers:{Authorization:`Bearer ${pairingToken}`,
        'Content-Type':'application/json', ...extraHeaders},
      body:payload === undefined ? undefined : JSON.stringify(payload), signal:AbortSignal.timeout(12000),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.message);
    return result;
  }

  async function startBridge(simulated, pair = true) {
    port = await freePort();
    const start = `const {spawnSync} = require('node:child_process');
      const {startBridge} = require('./server');
      startBridge({refreshDatabaseMirror(_target, evidence) {
        const r = spawnSync(process.env.GUTHON_TOOL_PATH, ['-B', ${JSON.stringify(fixture)}, 'refresh', process.env.GUTHON_TOOL_HOME],
          {encoding:'utf8', input:JSON.stringify(evidence), timeout:10000});
        if (r.status !== 0) throw new Error(r.stderr || String(r.error));
        return JSON.parse(r.stdout);
      }});`;
    server = spawn(process.execPath, simulated ? ['-e',start] : ['server.js'], {cwd:__dirname,
      env:{...process.env, GUTHON_TOOL_HOME:home, GUTHON_TOOL_PATH:python, GUTHON_TOOL_ENTRY:entry,
        GUTHON_TOOL_MODE:'packaged', GUTHON_BRIDGE_PORT:String(port), PYTHONDONTWRITEBYTECODE:'1'}, stdio:'ignore'});
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      if (Date.now() > deadline || server.exitCode !== null) assert.fail('Bridge startup failed');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    pairingToken = fs.readFileSync(path.join(workspace.spaceRoot, 'nexus/bridge/token'), 'utf8').trim();
    if (!pair) return;

    const native = vm.createContext({location:{origin,pathname:'/guthon/'}, URLSearchParams, AbortSignal,
      async fetch(url, request) {
        const {body} = request;
        const responses = {
          '/develop/procedure/admin/getProcTree.htm':{list:[{procedureId:'PR-1',procedureAliasId:'pkg.fixture'}]},
          '/develop/procedure/admin/getFunList.htm':{list:[{funId:'sample'}]},
          '/develop/procedure/admin/getFunInfo.htm':{bean:{procedureId:'PR-1',funId:'sample',versionMac:platform.version,funScript:platform.content}},
        };
        assert.ok(responses[url], url);
        assert.ok(body.get('dataSourceId') === 'DS-1' || body.get('procedureId') === 'PR-1');
        return {ok:true,text:async () => JSON.stringify({code:0,data:responses[url]})};
      }});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/native-metadata.js'), 'utf8'), native);

    let onMessage, ready;
    const readyPromise = new Promise(resolve => {ready = resolve;});
    worker = vm.createContext({importScripts() {}, URL, AbortController, setTimeout, clearTimeout, TextEncoder, crypto:webcrypto,
      fetch(url,options) {
        if (url.endsWith('/navigationResult') && options?.body) {
          const receipt=JSON.parse(options.body);
          if (receipt.data?.action === 'inspect-database-procedure') preflightReceipts.push(receipt.data);
        }
        return fetch(url,options);
      },
      GuthonBridgeHost:{isAllowed:url => url === tab.url}, GuthonBridgeEvents:{
        consume(response, callback) {
          ready();
          return consume(response, (event, command) => callback(event, command, async (action, target, evidence) => {
            assert.equal(target.procedureId, 'PR-1');
            assert.equal(target.sourceId, 'FN-ROW');
            assert.equal(command.target.evidence, undefined);
            await assert.rejects(bridge('/databaseProcedurePayload', {requestId:command.requestId,
              clientId:identity,tabId:2,workspaceKey:key}), /身份不匹配/);
            await assert.rejects(bridge(`/navigationResult?workspaceKey=${key}&requestId=${command.requestId}`), /定位请求/);
            if (action === 'read') {
              if (evidence) readbacks++;
              return {...target, ...platform, canSave:true,
                ...(letReadProveOperation ? {appliedOperationId} : {})};
            }
            writes++;
            assert.equal(evidence.expectedVersion, platform.version);
            assert.equal(evidence.content.trimEnd(), frozen.trimEnd());
            appliedOperationId = evidence.operationId;
            platform = {version:'native-v2', content:evidence.content};
            throw new Error('simulated response loss after saving');
          }));
        }},
      chrome:{runtime:{id:identity, getURL:name => `chrome-extension://${identity}/${name}`,
        onInstalled:{addListener() {}},onMessage:{addListener(fn) {onMessage = fn;}}},
      storage:{local:{get:async () => ({guthonBridgeToken:pairingToken,guthonBridgePort:port,guthonBridgeClientId:identity})}},
      tabs:{get:async () => tab,sendMessage:async () => ({ok:true,data:metadata})},
      scripting:{executeScript:async ({args}) => args ? [{result:await native.runNativeMetadata(args[0])}] : []}}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), worker);
    const published = await new Promise(resolve => onMessage({type:'publish-page-context', payload:{workspaceKey:key,metadata}},
      {id:identity,tab},resolve));
    assert.equal(published.ok, true, published.message);
    await readyPromise;
    const {contexts} = await bridge('/pageContext?workspaceKey=' + key);
    browserContextId = contexts[0].contextId;
  }

  let diff, sourceMode = 'database';
  const legacy = registerLegacyProjects({
    context:{subscriptions}, getTool:() => tool, getWorkspaces:async () => [{...workspace,sourceMode}],
    sourceTree:{refresh() {}}, processClient:client,
    databaseBridgeRequest:(_home, route, input) => bridge(route, input),
    databasePublicationRequest:(_home, route, input) => bridge(route, input),
    vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
      Uri:{from:value => value}, workspace:{textDocuments:[],registerTextDocumentContentProvider(scheme, provider) {
        if (scheme === 'guthon-database-review-diff') diff = provider;
        return {dispose() {}};
      }}, commands:{async executeCommand(command, left, right) {
        assert.equal(command, 'vscode.diff');
        assert.equal(diff.provideTextDocumentContent(left), baseline.content);
        assert.equal(diff.provideTextDocumentContent(right), (await edit('edit-read')).content);
      }}, window:{
        async showQuickPick(items) {
          if (typeof items[0] === 'string') return items[1];
          return items.find(item => choice === 'verify' && item.verify) || items[0];
        },
        async showInformationMessage(message, options, confirm) {
          messages.push(message);
          return options?.modal ? confirm : message.startsWith('本地候选检查通过') ? options : undefined;
        },
        async showWarningMessage(_message, _options, confirm) {
          await confirmHook?.();
          return simulateConfirm ? confirm : undefined;
        },
        showErrorMessage:message => errors.push(message),
      }},
  });
  const openChanges = () => legacy.action(workspace, 'changes');
  const list = () => bridge('/databaseProcedureOperations', {workspaceKey:key});
  const verify = operationId => bridge('/databaseProcedureVerify', {workspaceKey:key,contextId:browserContextId,operationId});
  await startBridge(false, false);
  for (const route of ['Publish','Verify','Operations','Payload']) {
    await assert.rejects(bridge('/databaseProcedure' + route, {workspaceKey:key}), /上传当前关闭/);
  }
  await stopBridge();
  await startBridge(true);

  await openChanges();
  assert.deepEqual(errors, []);
  assert.deepEqual((await list()).operations, []);
  assert.equal(writes, 0);
  const baselineHash = createHash('sha256').update(baseline.content.replaceAll('\r\n','\n')).digest('hex');
  assert.equal(preflightReceipts.at(-1).after.contentHash,baselineHash);
  assert.equal('sourceContent' in preflightReceipts.at(-1),false);

  platform.content = 'unreviewed platform source';
  await openChanges();
  assert.match(errors.pop(),/平台正文与 Workcopy 编辑基线不一致/);
  assert.equal(writes,0);
  assert.deepEqual((await list()).operations,[]);
  platform.content = baseline.content;
  simulateConfirm = true;
  confirmHook = () => edit('edit-save', {sourceHash:saved.sourceHash, content:later});
  await openChanges();
  assert.match(errors.pop(), /源码已发生变化/);
  assert.deepEqual((await list()).operations, []);
  assert.equal(writes, 0);
  confirmHook = () => {sourceMode = 'svn';};
  await openChanges();
  assert.match(errors.pop(), /项目来源已变化/);
  assert.deepEqual((await list()).operations, []);
  assert.equal(writes, 0);
  sourceMode = 'database';
  confirmHook = undefined;
  await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:frozen});
  const review = await edit('publish-preview');
  const approval = {...source, contextId:browserContextId, workspaceKey:key,
    sourceHash:review.sourceHash, reviewId:review.reviewId, native:{...metadata, origin,
      procedureId:'PR-1',procedureAlias:'pkg.fixture',funId:'sample',version:'native-v1'}};
  await assert.rejects(bridge('/databaseProcedurePublish', {...approval, native:{...approval.native, dataSourceId:'DS-OTHER'}}),
    /与本地审阅不一致/);

  await openChanges();
  assert.deepEqual(errors, []);
  assert.equal(writes, 1);
  assert.match(messages.at(-1), /保存结果未知/);
  const {operations:[operation]} = await list();
  assert.equal(operation.state, 'PLATFORM_UNKNOWN');
  assert.equal(JSON.stringify(operation).includes('提交候选'), false);
  assert.equal(fs.readFileSync(readonly, 'utf8'), baseline.content);
  assert.equal((await bridge('/databaseProcedurePublish', approval)).operationId, operation.operationId);
  assert.equal(writes, 1);

  await stopBridge();
  await startBridge(true);
  assert.equal((await verify(operation.operationId)).state, 'PLATFORM_UNKNOWN',
    'matching content alone cannot prove which request wrote it');
  letReadProveOperation = true;
  choice = 'verify';
  await openChanges();
  assert.deepEqual(errors, []);
  assert.match(messages.at(-1), /等待镜像回拉/);
  assert.equal((await list()).operations[0].state, 'MIRROR_PENDING');
  for (const [command, input] of [['workspace-source-mode', {expectedMode:'database',sourceMode:'api'}],['workspace-delete', {}]]) {
    await assert.rejects(call(command, [], {workspaceKey:key, checkOnly:true, ...input}), /待核验的过程函数发布/);
  }

  await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:later});
  const dbRowFile = path.join(home, 'database-fixture.json');
  const dbRow = JSON.parse(fs.readFileSync(dbRowFile, 'utf8'));
  fs.writeFileSync(dbRowFile, JSON.stringify({...dbRow, source_content:platform.content, version_mac:'db-v2'}));
  const readbacksBeforeMirror = readbacks;
  await stopBridge();
  await startBridge(true, false);
  const config = workspace.configuration.path;
  const originalConfig = fs.readFileSync(config, 'utf8');
  const changedConfig = JSON.parse(originalConfig);
  changedConfig.workspaces[key].systems.include.mappings.fixture.system_id = 'SYS-OTHER';
  fs.writeFileSync(config, JSON.stringify(changedConfig));
  await assert.rejects(bridge('/databaseProcedureVerify', {workspaceKey:key, operationId:operation.operationId}),
    /数据源配置已变化/);
  assert.equal(fs.readFileSync(readonly, 'utf8'), baseline.content);
  fs.writeFileSync(config, originalConfig);
  await openChanges();
  assert.deepEqual(errors, []);
  assert.match(messages.at(-1), /平台与镜像均已核验.*保留后续 Workcopy 编辑/);
  assert.equal(writes, 1);
  assert.equal(readbacks, readbacksBeforeMirror);
  assert.equal(fs.readFileSync(readonly, 'utf8'), platform.content);
  assert.equal(fs.readFileSync(workcopy, 'utf8'), later);
  const nextReview = await edit('publish-preview');
  assert.equal(nextReview.databaseBaseVersion, 'db-v2');
  assert.equal(nextReview.baseContent, platform.content);
  assert.equal(nextReview.content, later);
});
