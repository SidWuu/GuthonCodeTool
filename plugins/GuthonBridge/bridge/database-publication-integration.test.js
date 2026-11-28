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

for (const sourceType of ['procedure', 'form', 'service', 'form-with-differences', 'form-merge', 'form-merge-later-edit']) {
test(`DATABASE ${sourceType} publishes one frozen Workcopy through Nexus, paired browser and precise mirror`, {timeout:45000}, async t => {
  const isPage = sourceType !== 'procedure';
  const isService = sourceType === 'service';
  const differs = sourceType === 'form-with-differences';
  const merges = sourceType.startsWith('form-merge');
  const laterDuringMerge = sourceType === 'form-merge-later-edit';
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
  const {items} = await call('legacy-source', ['catalog','--type',isPage ? 'page' : 'procedure']);
  const record = isPage ? items.find(item => item.sourceId === (isService ? 'PG-SERVICE' : 'PG-FORM')) : items[0];
  const {recordId, sourceId, sourcePath} = record;
  const source = {recordId, sourceId, sourcePath};
  const edit = (action, input) => call('legacy-source', [action], {...source, ...input});
  const readonly = path.join(workspace.readonlyDir, sourcePath);
  const workcopy = path.join(workspace.workcopyDir, sourcePath);
  const baseline = await edit('edit-read');
  const editPage = (model, value) => {
    if (isService) model.compScript = value;
    else model.buttons[0].name = value;
    return JSON.stringify(model);
  };
  const frozen = isPage ? editPage(JSON.parse(baseline.content), '提交候选')
    : "#return('提交候选')\n" + '// GSS\n'.repeat(11000);
  const persisted = differs ? editPage(JSON.parse(frozen), '实际保存的内容') : frozen;
  const later = isPage ? editPage(JSON.parse(frozen), 'later') : "#return('later')";
  let saved;
  if (sourceType === 'form') {
    // An untracked Workcopy can be reviewed against the mirror and uploaded.
    fs.mkdirSync(path.dirname(workcopy), {recursive:true});
    fs.writeFileSync(workcopy, JSON.stringify(JSON.parse(frozen), null, 4));
    const {items:[untracked]} = await call('legacy-source', ['review-workcopies']);
    assert.equal(untracked.trustedBaseline, false);
    assert.equal(untracked.needsReview, true);
  } else {
    saved = await edit('edit-save', {sourceHash:baseline.sourceHash, content:frozen});
  }

  let port, pairingToken, writes = 0, readbacks = 0, appliedOperationId, letReadProveOperation = false;
  const oldVersion = isPage ? 'page-v1' : 'native-v1';
  const newVersion = isPage ? 'page-v2' : 'native-v2';
  let platform = {version:oldVersion, content:baseline.content};
  let browserContextId, simulateConfirm = false, confirmHook, choice = 'candidate';
  const preflightReceipts = [];
  const identity = 'a'.repeat(32);
  const origin = 'https://platform.test';
  const tab = {id:1,url:origin + '/guthon/'};
  const metadata = {mode:isPage ? 'platform' : 'procedure',systemId:isPage ? 'SYS-OTHER' : '',dataSourceId:isPage ? '' : 'DS-1'};
  const messages = [], errors = [], reports = [], subscriptions = [];
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

  async function startBridge(simulated, pair = true, mode = 'packaged') {
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
        GUTHON_TOOL_MODE:mode, GUTHON_DATABASE_MANUAL_UPLOAD_ORIGIN:'',
        GUTHON_BRIDGE_PORT:String(port), PYTHONDONTWRITEBYTECODE:'1'}, stdio:'ignore'});
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      if (Date.now() > deadline || server.exitCode !== null) assert.fail('Bridge startup failed');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    pairingToken = fs.readFileSync(path.join(workspace.spaceRoot, 'nexus/bridge/token'), 'utf8').trim();
    if (!pair) return;

    const native = vm.createContext({location:{origin,pathname:'/guthon/'}, URLSearchParams, AbortSignal, TextEncoder, btoa,
      document:{querySelectorAll:()=>[{__vue__:{$store:{state:{modeDev:{systemId:'SYS-1'}}}}}]},
      async fetch(url, request) {
        const {body} = request;
        if (isPage) {
          let data;
          if (url.endsWith('/models/list.htm')) {
            assert.equal(body.get('systemId'), 'SYS-1');
            data = {list:[{pages:[{pageId:sourceId, pageType:isService ? 0 : 1, pageAliasId:isService ? sourceId : null}]}]};
          } else if (url.endsWith('getPageModuleXml.htm')) {
            if (writes) readbacks++;
            const bean = {isProduct:0, pageAliasId:sourceId, ...JSON.parse(platform.content)};
            if (!isService) {
                const row = bean.views.rows[0];
                row.style.showBorder = 0;
                Object.assign(row.component.fields[0], {isDefaultLike:1, sortable:1, isDisAdvSearch:0});
                Object.assign(row.component.datasource.fields[0], {isPk:0, isJoinTable:0});
            }
            data = {bean,version:platform.version};
          } else {
            assert.equal(url, '/develop/dev/models/savePageModuleXml.htm');
            assert.equal(body.get('pageId'), sourceId);
            assert.equal(body.get('pageVersion'), platform.version);
            assert.equal(body.get('flag'), '0');
            assert.equal(body.get('isAutoCompile'), isService ? null : '1');
            assert.equal(body.has('isBase64'), false);
            const content = body.get('json');
            const submitted = JSON.parse(frozen);
            if (merges) {
              const {sourceHash} = require('./database-source-publish');
              const target = {pageId:sourceId, pageAlias:sourceId};
              assert.equal(sourceHash(target, content), sourceHash(target, JSON.stringify({...submitted, title:'Platform title'})));
            } else {
              assert.deepEqual(JSON.parse(content), isService ? {isProduct:0, ...submitted} : submitted);
            }
            writes++;
            platform = {version:newVersion, content:differs ? persisted : content};
            data = {version:newVersion};
          }
          return {ok:true,text:async () => JSON.stringify({code:0,data})};
        }
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
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/page-lifecycle.js'), 'utf8'), native);

    let onMessage, ready;
    const readyPromise = new Promise(resolve => {ready = resolve;});
    worker = vm.createContext({importScripts() {}, runPageLifecycle:native.runPageLifecycle,
      URL, AbortController, setTimeout, clearTimeout, TextEncoder, crypto:webcrypto,
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
          return consume(response, (event, command) => {
            if (isPage) {
              if (event === 'database-page') assert.equal(command.target.evidence, undefined);
              return callback(event, command);
            }
            return callback(event, command, async (action, target, evidence) => {
            if (target.procedureId || evidence || action === 'save') assert.equal(target.procedureId, 'PR-1');
            assert.equal(target.sourceId, 'FN-ROW');
            assert.equal(command.target.evidence, undefined);
            await assert.rejects(bridge('/databaseProcedurePayload', {requestId:command.requestId,
              clientId:identity,tabId:2,workspaceKey:key}), /身份不匹配/);
            await assert.rejects(bridge(`/navigationResult?workspaceKey=${key}&requestId=${command.requestId}`), /定位请求/);
            if (action === 'read') {
              if (evidence) readbacks++;
              return {...target, ...platform, procedureId:'PR-1', canSave:true,
                ...(letReadProveOperation ? {appliedOperationId} : {})};
            }
            writes++;
            assert.equal(evidence.expectedVersion, platform.version);
            assert.equal(evidence.content.trimEnd(), frozen.trimEnd());
            appliedOperationId = evidence.operationId;
            platform = {version:'native-v2', content:evidence.content};
            throw new Error('simulated response loss after saving');
            });
          });
        }},
      chrome:{runtime:{id:identity, getURL:name => `chrome-extension://${identity}/${name}`,
        onInstalled:{addListener() {}},onMessage:{addListener(fn) {onMessage = fn;}}},
      storage:{local:{get:async () => ({guthonBridgeToken:pairingToken,guthonBridgePort:port,guthonBridgeClientId:identity})}},
      tabs:{get:async () => tab,sendMessage:async () => ({ok:true,data:metadata})},
      scripting:{executeScript:async ({args}) => args
        ? [{result:await (isPage ? native.runPageLifecycle(args[0]) : native.runNativeMetadata(args[0]))}] : []}}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), worker);
    const published = await new Promise(resolve => onMessage({type:'publish-page-context', payload:{workspaceKey:key,metadata}},
      {id:identity,tab},resolve));
    assert.equal(published.ok, true, published.message);
    await readyPromise;
    const {contexts} = await bridge('/pageContext?workspaceKey=' + key);
    browserContextId = contexts[0].contextId;
    if (!isPage) {
      assert.equal(contexts[0].systemId, '');
      assert.deepEqual(contexts[0].databaseProcedureSystemIds, ['SYS-1']);
    }
  }

  let diff, sourceMode = 'database', submittedApproval, reviewHook;
  const legacy = registerLegacyProjects({
    async reviewDatabaseUpload(_vscode, entries, openDiff) {
      const paths = entries.map(({path}) => path);
      await reviewHook?.(paths, openDiff);
      return paths;
    },
    context:{subscriptions}, getTool:() => tool, getWorkspaces:async () => [{...workspace,sourceMode}],
    sourceTree:{refresh() {}}, processClient:client,
    async databaseBridgeRequest(_home, route, input) {
      const result = await bridge(route, input);
      if (route === '/databaseSourcePreflight') preflightReceipts.push(result.native);
      return result;
    },
    databasePublicationRequest:(_home, route, input) => {
      if (route === '/databaseProcedurePublish') submittedApproval = input;
      return bridge(route, input);
    },
    vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
      Uri:{from:value => value}, workspace:{textDocuments:[],openTextDocument:async doc => doc,
        registerFileSystemProvider() {return {dispose() {}};},
        registerTextDocumentContentProvider(scheme, provider) {
        if (scheme === 'guthon-database-review-diff') diff = provider;
        return {dispose() {}};
      }}, commands:{async executeCommand(command, left, right, title) {
        assert.equal(command, 'vscode.diff');
        if (right.scheme === 'guthon-database-edit') {
          const actual = diff.provideTextDocumentContent(left);
          if (isService) assert.equal(actual, JSON.parse(platform.content).compScript);
          else if (isPage) assert.equal(JSON.parse(actual).buttons[0].name, JSON.parse(platform.content).buttons[0].name);
          else assert.equal(actual, platform.content);
          return;
        }
        const actual = [left,right].map(uri => diff.provideTextDocumentContent(uri));
        if (title.includes('三方合并候选')) {
          assert.equal(JSON.parse(actual[0]).title, 'Platform title');
          assert.equal(JSON.parse(actual[1]).title, 'Platform title');
          assert.equal(JSON.parse(actual[1]).buttons[0].name, '提交候选');
          return;
        }
        const expected = [baseline.content,(await edit('edit-read')).content];
        if (isService) assert.deepEqual(actual, expected.map(content => JSON.parse(content).compScript));
        else if (isPage) assert.deepEqual(actual.map(JSON.parse), expected.map(JSON.parse));
        else assert.deepEqual(actual, expected);
      }}, window:{
        async showTextDocument(doc) {reports.push(doc.content);},
        async showQuickPick(items, options) {
          if (typeof items[0] === 'string') return items[1];
          return options?.canPickMany ? [items[0]] : items.find(item => choice === 'verify' && item.verify) || items[0];
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
  const openChanges = () => legacy.action(workspace, choice === 'verify' ? 'changes' : 'upload');
  const list = () => bridge('/databaseProcedureOperations', {workspaceKey:key});
  const verify = operationId => bridge('/databaseProcedureVerify', {workspaceKey:key,contextId:browserContextId,operationId});
  await startBridge(false, false);
  assert.equal((await bridge('/databaseProcedureCapabilities')).mode, 'closed');
  for (const route of ['Publish','Verify','Operations','Payload']) {
    await assert.rejects(bridge('/databaseProcedure' + route, {workspaceKey:key}), /上传当前关闭/);
  }
  await stopBridge();
  if (sourceType === 'form') {
    await startBridge(false, true, 'source-development');
    assert.equal((await bridge('/databaseProcedureCapabilities')).mode, 'manual');
    assert.deepEqual((await list()).operations, []);
    const review = await edit('publish-preview', {compareMirror:true});
    const configFile = workspace.configuration.path;
    const original = fs.readFileSync(configFile, 'utf8');
    const document = JSON.parse(original);
    delete document.workspaces[key].page_origins;
    fs.writeFileSync(configFile, JSON.stringify(document));
    try {
      await assert.rejects(bridge('/databaseProcedurePublish', {...source, workspaceKey:key, contextId:browserContextId,
        reviewId:review.reviewId, sourceHash:review.sourceHash, compareMirror:true}), /基线或候选已变化/);
      const unbound = await edit('publish-preview', {compareMirror:true});
      await assert.rejects(bridge('/databaseProcedurePublish', {...source, workspaceKey:key, contextId:browserContextId,
        reviewId:unbound.reviewId, sourceHash:unbound.sourceHash, compareMirror:true,
        native:{origin, systemId:'SYS-1', pageId:sourceId, pageAlias:sourceId, pageType:'1', version:oldVersion}}),
      /谷神地址或源码范围与项目登记不一致/);
      assert.equal(writes, 0);
    } finally {
      fs.writeFileSync(configFile, original);
    }
    await stopBridge();
  }
  await startBridge(true);

  if (!isPage) {
    const configPath = workspace.configuration.path;
    const cachePath = path.join(home, 'config/system-data.json');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const originalCache = fs.readFileSync(cachePath, 'utf8');
    const config = JSON.parse(originalConfig);
    const cache = JSON.parse(originalCache);
    config.workspaces[key].systems.include.mappings.shared = {system_id:'SYS-2', data_source_id:'DS-1'};
    cache.datasources[''].systems.push({SYSTEM_ID:'SYS-2', SYSTEM_NAME:'Other', SYSTEM_ALIAS_ID:'shared', DATA_SOURCE_ID:'DS-1'});
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    try {
      const current = await bridge('/routeWorkspace', {...metadata, pageOrigin:origin, workspaceKey:key});
      assert.deepEqual(current.databaseProcedureSystemIds, ['SYS-1','SYS-2']);
      await assert.rejects(bridge('/databaseProcedurePreflight', {workspaceKey:key, contextId:browserContextId,
        target:{action:'inspect-database-procedure', systemId:'SYS-1', dataSourceId:'DS-1',
          procedureAlias:'pkg.fixture', funId:'sample', includeSourceHash:true}}), /无法唯一对应目标子系统/);
      assert.equal(writes, 0);
    } finally {
      fs.writeFileSync(configPath, originalConfig);
      fs.writeFileSync(cachePath, originalCache);
    }
  }
  await openChanges();
  assert.deepEqual(errors, []);
  assert.deepEqual((await list()).operations, []);
  assert.equal(writes, 0);
  if (merges) {
    platform = {version:'page-v1-remote', content:JSON.stringify({...JSON.parse(baseline.content), title:'Platform title'})};
    const draftBefore = fs.readFileSync(workcopy, 'utf8');
    await openChanges();
    assert.match(preflightReceipts.at(-1).merge.reviewId, /^[a-f0-9]{64}$/);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(workcopy, 'utf8'), draftBefore);
    const readyPlatform = platform;
    simulateConfirm = true;
    confirmHook = () => {
      platform = {version:'page-raced', content:JSON.stringify({...JSON.parse(readyPlatform.content), title:'Changed again'})};
    };
    await openChanges();
    assert.match(reports.pop(), /合并结果已变化/);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(workcopy, 'utf8'), draftBefore);
    confirmHook = undefined;
    platform = readyPlatform;
    await openChanges();
    assert.deepEqual(errors, []);
    assert.equal(writes, 1);
    assert.equal(fs.readFileSync(workcopy, 'utf8'), draftBefore);
    const {operations:[operation]} = await list();
    assert.equal(operation.state, 'MIRROR_PENDING');
    assert.equal((await bridge('/databaseProcedurePublish', submittedApproval)).operationId, operation.operationId);
    if (laterDuringMerge) await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:later});
    const dbRowFile = path.join(home, `${sourceId}.json`);
    const dbRow = JSON.parse(fs.readFileSync(dbRowFile,'utf8'));
    fs.writeFileSync(dbRowFile, JSON.stringify({...dbRow, source_content:platform.content, version_mac:newVersion}));
    await stopBridge();
    await startBridge(true, false);
    choice = 'verify';
    await openChanges();
    assert.deepEqual(errors, []);
    assert.match(messages.at(-1), /谷神与本地只读源码均已更新/);
    const {operations:[verified]} = await list();
    if (laterDuringMerge) {
      assert.deepEqual(JSON.parse(fs.readFileSync(workcopy,'utf8')), JSON.parse(later));
      assert.equal(verified.workcopyState, 'CONFLICT');
      assert.equal(JSON.parse(fs.readFileSync(readonly,'utf8')).title, 'Platform title');
    } else {
      assert.equal(fs.readFileSync(workcopy,'utf8'), fs.readFileSync(readonly,'utf8'));
      assert.equal(verified.workcopyState, 'CLEAN');
    }
    assert.equal(writes, 1);
    return;
  }
  if (isPage) {
    assert.equal(readbacks, 0);
    simulateConfirm = true;
    platform.content = editPage(JSON.parse(baseline.content), 'Changed in the designer');
    await openChanges();
    if (sourceType === 'form') assert.match(errors.pop(), /已打开与谷神最新源码的比较/);
    else assert.match(reports.pop(), /三方合并冲突/);
    assert.equal(writes, 0);
    platform.content = baseline.content;
    confirmHook = () => {
      platform.version = 'page-stale';
      platform.content = editPage(JSON.parse(baseline.content), 'Changed after review');
    };
    await openChanges();
    assert.deepEqual(errors, []);
    assert.match(messages.at(-1), /未保存到谷神/);
    assert.equal(writes, 0);
    platform.content = baseline.content;
    confirmHook = () => {platform.version = 'page-v1-current';};
    await openChanges();
    confirmHook = undefined;
    assert.deepEqual(errors, []);
    assert.equal(writes, 1);
    assert.ok(readbacks > 0);
    assert.match(messages.at(-1), /本地只读源码待更新.*继续检查上传结果/);
    const {operations} = await list();
    const operation = operations.find(item => item.state === 'MIRROR_PENDING');
    assert.equal(operation.state, 'MIRROR_PENDING');
    assert.equal(operation.saveBaseVersion, 'page-v1-current');
    assert.equal(operation.target.pageId, sourceId);
    assert.equal(operation.target.pageAlias, sourceId);
    assert.equal(JSON.stringify(operation).includes('提交候选'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(readonly, 'utf8')), JSON.parse(baseline.content));
    if (isService) await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:later});
    const dbRowFile = path.join(home, `${sourceId}.json`);
    const dbRow = JSON.parse(fs.readFileSync(dbRowFile,'utf8'));
    fs.writeFileSync(dbRowFile, JSON.stringify({...dbRow, source_content:persisted, version_mac:newVersion}));
    const priorReadbacks = readbacks;
    await stopBridge();
    await startBridge(true, false);
    choice = 'verify';
    await openChanges();
    assert.deepEqual(errors, []);
    assert.match(messages.at(-1), differs ? /保存结果与上传候选不同.*比较实际保存源码和保留的 Workcopy/
        : isService ? /谷神与本地只读源码均已更新.*上传后新增的本地修改已保留/ : /谷神与本地只读源码均已更新/);
    const verified = (await list()).operations.find(item => item.operationId === operation.operationId);
    assert.equal(verified.state, differs ? 'SAVED_WITH_DIFFERENCES' : 'VERIFIED');
    assert.equal(verified.workcopyState, isService || differs ? 'EDITED' : 'CLEAN');
    assert.deepEqual(JSON.parse(fs.readFileSync(readonly,'utf8')), JSON.parse(persisted));
    assert.deepEqual(JSON.parse(fs.readFileSync(workcopy,'utf8')), JSON.parse(isService ? later : frozen));
    assert.equal(writes, 1);
    assert.equal(readbacks, priorReadbacks);
    if (isService || differs) {
      const next = await edit('publish-preview');
      assert.equal(next.databaseBaseVersion,newVersion);
      assert.deepEqual(JSON.parse(next.baseContent),JSON.parse(persisted));
    }
    return;
  }
  assert.equal(preflightReceipts.at(-1).procedureId,'PR-1');
  assert.equal('content' in preflightReceipts.at(-1),false);

  platform.content = 'unreviewed platform source';
  await openChanges();
  assert.match(reports.pop(), /三方合并冲突/);
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
  const review = await edit('publish-preview', {compareMirror:true});
  const approval = {...source, contextId:browserContextId, workspaceKey:key,
    sourceHash:review.sourceHash, reviewId:review.reviewId, compareMirror:true, native:{...metadata, origin, systemId:'SYS-1',
      procedureId:'PR-1',procedureAlias:'pkg.fixture',funId:'sample',version:'native-v1'}};
  await assert.rejects(bridge('/databaseProcedurePublish', {...approval, native:{...approval.native, dataSourceId:'DS-OTHER'}}),
    /与本地审阅不一致/);

  await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:later});
  if (!platform.content.endsWith('\n')) platform.content += '\r\n';
  reviewHook = async ([sourcePath], openDiff) => {
    await openDiff(sourcePath);
    await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:frozen});
    reviewHook = undefined;
  };
  await openChanges();
  assert.deepEqual(errors, []);
  assert.equal(writes, 1);
  assert.match(messages.at(-1), /尚未确认谷神是否保存成功.*继续检查上传结果/);
  const {operations:[operation]} = await list();
  assert.equal(operation.state, 'PLATFORM_UNKNOWN');
  assert.equal(JSON.stringify(operation).includes('提交候选'), false);
  assert.equal(fs.readFileSync(readonly, 'utf8'), baseline.content);
  assert.match(submittedApproval.confirmationId, /^[a-z0-9-]{36}$/);
  assert.equal((await bridge('/databaseProcedurePublish', submittedApproval)).operationId, operation.operationId);
  assert.equal(writes, 1);

  await stopBridge();
  await startBridge(true);
  assert.equal((await verify(operation.operationId)).state, 'PLATFORM_UNKNOWN',
    'matching content alone cannot prove which request wrote it');
  letReadProveOperation = true;
  choice = 'verify';
  await openChanges();
  assert.deepEqual(errors, []);
  assert.match(messages.at(-1), /本地只读源码待更新.*继续检查上传结果/);
  assert.equal((await list()).operations[0].state, 'MIRROR_PENDING');
  for (const [command, input] of [['workspace-source-mode', {expectedMode:'database',sourceMode:'api'}],['workspace-delete', {}]]) {
    await assert.rejects(call(command, [], {workspaceKey:key, checkOnly:true, ...input}), /待核验的源码上传/);
  }

  await edit('edit-save', {sourceHash:(await edit('edit-read')).sourceHash,content:later});
  const dbRowFile = path.join(home, 'database-fixture.json');
  const dbRow = JSON.parse(fs.readFileSync(dbRowFile, 'utf8'));
  const storedSource = platform.content.endsWith('\n') ? platform.content.slice(0,-1) : platform.content + '\n';
  fs.writeFileSync(dbRowFile, JSON.stringify({...dbRow, source_content:storedSource, version_mac:'db-v2'}));
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
  assert.match(messages.at(-1), /谷神与本地只读源码均已更新.*上传后新增的本地修改已保留/);
  assert.equal(writes, 1);
  assert.equal(readbacks, readbacksBeforeMirror);
  assert.equal(fs.readFileSync(readonly, 'utf8'), storedSource);
  assert.equal(fs.readFileSync(workcopy, 'utf8'), later);
  const nextReview = await edit('publish-preview');
  assert.equal(nextReview.databaseBaseVersion, 'db-v2');
  assert.equal(nextReview.baseContent, storedSource);
  assert.equal(nextReview.content, later);
});
}
