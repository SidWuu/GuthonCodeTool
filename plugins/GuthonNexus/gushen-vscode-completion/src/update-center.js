const { runtimeConfigurationTarget } = require('./tool-runtime');
const fs = require('node:fs');
const path = require('node:path');
const { fetchLatestRelease, detectCurrentVersion, runProcess, writeUpdateState, readUpdateState, sha256Stream } = require('./tool-updater');
const { verifiedRelease, verifyReleaseBytes, ASSETS, ReleaseCatalogUnavailable } = require('./release-catalog');
const { updateRoot, readJson, saveJson, managedChrome, updatePlan, hostSettings,
  prepareUpdate, applyUpdate, interruptedUpdate, withUpdateLock } = require('./component-update');
const { localRelease, prepareLocalUpdate } = require('./local-update');
const { chromeFiles, packageFingerprint } = require('./extension-package');

function localDay(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function needsDailyCheck(state, source, now = new Date()) {
  if (state?.source !== source) return true;
  if (state.day === localDay(now)) return false;
  return !state.lastAttempt || now.getTime() < state.lastAttempt || now.getTime() - state.lastAttempt >= 30 * 60000;
}
function supportsEditor(engine, version) {
  const match = /^(\^|>=)?(\d+\.\d+\.\d+)$/.exec(engine || '');
  if (!match) return false;
  const compare = require('./tool-updater').compareVersions;
  if (compare(version, match[2]) < 0) return false;
  return match[1] !== '^' || version.split('.')[0] === match[2].split('.')[0];
}

function createUpdateCenter({ vscode, context, bridge, processClient, getTool,
  isBusy, setBusy, refresh, treeView, loadedVersion, loadedBuildId, log = () => {},
  fetchRelease = fetchLatestRelease, verify = verifiedRelease, processRunner = runProcess,
  readLocal = localRelease, prepareLocal = prepareLocalUpdate } = {}) {
  let snapshot = { rows: [], count: 0 };
  let checking, updating = false, disposed = false;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  status.command = 'gushenCompletion.checkToolUpdate';
  const config = () => vscode.workspace.getConfiguration('gushenCompletion');
  const root = () => config().get('toolHome', '') ? updateRoot(config().get('toolHome')) : path.join(context.globalStorageUri.fsPath, 'component-updates');
  const source = () => mode() === 'source-development' ? 'local' : config().get('updateSource', 'gitee');
  const nexusStateFile = path.join(context.globalStorageUri.fsPath, 'nexus-install.json');
  const mode = () => require('./tool-runtime').normalizeExecutionMode(config().get('executionMode', 'packaged'));
  const configurationIdentity = () => JSON.stringify(['executionMode', 'toolHome', 'toolPath', 'scriptToolPath', 'scriptPythonPath', 'developmentRoot', 'updateSource'].map(key => config().get(key, '')));
  function display() {
    snapshot.count = snapshot.rows.filter(item => item.update).length;
    if (treeView) treeView.badge = snapshot.count ? { value: snapshot.count, tooltip: snapshot.count + '项组件可更新' } : undefined;
    status.text = snapshot.count ? '$(cloud-download) Guthon ' + snapshot.count + '项更新'
      : snapshot.pending ? '$(debug-restart) Guthon 更新待生效' : '$(extensions) Guthon 更新';
    status.tooltip = snapshot.error || snapshot.info || snapshot.rows.map(item => item.label + '：' + (item.current || '未确认') + ' → ' + (item.target || '更新源未提供') + (item.status ? ' · ' + item.status : '')).join('\n') || '检查后端、Nexus 与 Chrome 扩展更新';
    status.show(); refresh();
  }
  async function current() {
    let tool;
    try { tool = getTool(); } catch { /* Unconfigured components are explicitly unknown. */ }
    let toolVersion;
    try {
      if (tool?.mode === 'packaged') toolVersion = await detectCurrentVersion(context.extensionPath, context.globalStorageUri.fsPath, tool.toolPath, processRunner);
      else if (tool?.mode === 'script') toolVersion = await detectCurrentVersion(context.extensionPath, context.globalStorageUri.fsPath,
        tool.toolEntry, () => processRunner(tool.toolPath, [tool.toolEntry, 'version']));
      else if (tool) toolVersion = fs.readFileSync(path.join(config().get('developmentRoot'), 'VERSION'), 'utf8').trim();
    } catch (error) { log('当前工具版本未确认：' + error.message); }
    let chrome;
    try { chrome = managedChrome(root()); } catch (error) { log(error.message); chrome = { status: error.message }; }
    let clients = [];
    if (bridge.isRunning() && config().get('toolHome')) {
      try { clients = (await bridge.request(config().get('toolHome'), '/components')).clients || []; }
      catch { /* Pre-bootstrap services do not implement the component protocol. */ }
    }
    const chromeBuildId = source() === 'local' && chrome.version ? packageFingerprint(chromeFiles(chrome.directory), new Set(['host-settings.js'])) : undefined;
    return { tool, toolVersion, mode: mode(), nexusVersion: loadedVersion, nexusBuildId: loadedBuildId,
      chromeVersion: chrome.version, chromeBuildId, chrome, clients };
  }
  async function refreshSnapshot(signed, checkedAt) {
    const actual = await current();
    // Quiet checks observe progress only; recovery runs under the installation lock.
    const operation = readJson(nexusStateFile);
    const rows = updatePlan(signed.catalog, actual);
    if (operation?.phase === 'INSTALLED'
        && operation.version === signed.catalog.components.nexus.version
        && (!signed.catalog.local || operation.buildId === signed.catalog.components.nexus.buildId)
        && (loadedVersion !== operation.version || (signed.catalog.local && loadedBuildId !== operation.buildId))) {
      const row = rows.find(item => item.id === 'nexus'); row.update = false; row.status = '已安装，待重新加载窗口';
    }
    const browser = rows.find(item => item.id === 'bridge');
    const relevant = actual.clients.filter(item => item.installId && item.installId === actual.chrome?.installId);
    browser.status = browser.codeChanged ? '本地源码有改动' : browser.bootstrap ? '首次托管需在 Chrome 加载固定目录'
      : relevant.length ? relevant.every(item => item.version === browser.current) ? '运行版本已核对' : '运行版本与托管版本不同，等待核对'
        : '已托管，运行版本未连接';
    snapshot = { rows, current: { toolVersion: actual.toolVersion }, source: source(),
      releaseVersion: signed.release.version, checkedAt: new Date(checkedAt).toISOString(),
      info: signed.origin === 'local' ? '开发模式使用本地源码：' + signed.sourceRoot : undefined,
      pending: rows.some(item => item.status?.includes('待重新') || item.status?.includes('等待核对')),
      error: undefined };
    display();
    return snapshot;
  }
  async function check(force = false) {
    if (checking) return checking;
    checking = (async () => {
      let cacheFile, selectedSource, selectedConfiguration;
      try {
        if (mode() === 'source-development') {
          const identity = configurationIdentity();
          const local = readLocal(config().get('developmentRoot', ''));
          await refreshSnapshot(local, Date.now());
          if (identity !== configurationIdentity()) throw new Error('本地源码配置已改变，请重新检查');
          return snapshot;
        }
        const directory = root();
        cacheFile = path.join(directory, 'check.json'); selectedSource = source(); selectedConfiguration = configurationIdentity();
        let state = readJson(cacheFile) || {};
        await withUpdateLock(path.join(directory, 'check-lock'), async () => {
          state = readJson(cacheFile) || {};
          let signed, fetched = false;
          if (!force && !needsDailyCheck(state, source()) && state.bytes && state.release) {
            const bytes = Object.fromEntries(Object.entries(state.bytes).map(([key, value]) => [key, Buffer.from(value, 'base64')]));
            signed = verifyReleaseBytes(state.release, context.globalStorageUri.fsPath, bytes);
          } else {
            if (!force && !needsDailyCheck(state, source())) return;
            saveJson(cacheFile, { ...state, source: source(), lastAttempt: Date.now() });
            signed = await verify(await fetchRelease(source()), context.globalStorageUri.fsPath);
            fetched = true;
          }
          if (selectedSource !== source() || selectedConfiguration !== configurationIdentity()) throw new Error('更新配置已改变，请重新检查');
          await refreshSnapshot(signed, fetched ? Date.now() : state.checkedAt);
          if (selectedSource !== source() || selectedConfiguration !== configurationIdentity()) throw new Error('更新配置已改变，请重新检查');
          if (fetched) {
            const bytes = Object.fromEntries(['checksumsBytes', 'signatureBytes', 'catalogBytes'].map(key => [key, signed[key].toString('base64')]));
            saveJson(cacheFile, { source: source(), day: localDay(), checkedAt: Date.now(), lastAttempt: Date.now(), release: signed.release, bytes });
          }
        });
        display(); return snapshot;
      } catch (error) {
        if (error instanceof ReleaseCatalogUnavailable && selectedSource === source() && selectedConfiguration === configurationIdentity()) {
          const actual = await current();
          snapshot = { rows: [
            { id: 'tool', label: 'GuthonCodeTool', current: actual.toolVersion, update: false,
              status: actual.mode === 'source-development' ? '工具源码由开发者管理' : '更新源未提供组件清单' },
            { id: 'nexus', label: 'Guthon Nexus', current: actual.nexusVersion, update: false },
            { id: 'bridge', label: 'Chrome Guthon Bridge', current: actual.chromeVersion, update: false },
          ], current: { toolVersion: actual.toolVersion }, source: selectedSource, releaseVersion: error.release.version,
          info: error.message, unavailable: true, error: undefined, pending: false };
          if (cacheFile) {
            const bytes = Object.fromEntries(Object.entries(error.bytes).map(([key, value]) => [key, value.toString('base64')]));
            saveJson(cacheFile, { source: selectedSource, day: localDay(), checkedAt: Date.now(),
              lastAttempt: Date.now(), release: error.release, bytes });
          }
          display(); return snapshot;
        }
        if (cacheFile && selectedSource === source() && selectedConfiguration === configurationIdentity()) {
          try {
            const previous = readJson(cacheFile) || {};
            saveJson(cacheFile, { ...previous, day: undefined, lastAttempt: Date.now(), lastError: error.message });
          } catch { /* Preserve unreadable cache evidence rather than overwriting it. */ }
        }
        snapshot.error = '更新检查未完成：' + error.message; display();
        if (force) throw error;
        log(snapshot.error); return snapshot;
      }
    })();
    try { return await checking; } finally { checking = undefined; }
  }
  async function browserGuide(directory) {
    const choice = await vscode.window.showInformationMessage('Chrome 扩展文件已托管。首次使用请在 chrome://extensions 加载此目录并完成配对；已托管扩展会在空闲心跳时自动重载。',
      { modal: true, detail: directory + '\n请先保存平台编辑内容。必要时手动重新加载扩展，再刷新平台页面。' }, '打开托管目录', '复制管理页地址');
    if (choice === '打开托管目录') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(directory));
    if (choice === '复制管理页地址') await vscode.env.clipboard.writeText('chrome://extensions');
  }
  async function update() {
    if (updating) return vscode.window.showInformationMessage('组件更新正在执行，请稍候');
    updating = true;
    let wasRunning = false, busyClaimed = false, guard;
    let prepared;
    try {
      const home = config().get('toolHome', ''); const directory = updateRoot(home);
      const initialIdentity = configurationIdentity();
      const native = readJson(nexusStateFile);
      if (native?.phase === 'INSTALLING' && native.startedAt > Date.now() - 10 * 60000
          && (loadedVersion !== native.version || (native.buildId && loadedBuildId !== native.buildId))) {
        let alive = true;
        try { process.kill(native.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Nexus 安装正在执行或等待核验，请先重新加载窗口');
      }
      const result = await withUpdateLock(directory, () => withUpdateLock(context.globalStorageUri.fsPath, async () => {
        const record = interruptedUpdate(directory, loadedVersion);
        const local = mode() === 'source-development' ? readLocal(config().get('developmentRoot', '')) : undefined;
        let release = local ? local.release : await fetchRelease(source());
        if (!local && record && ['PARTIAL', 'APPLYING', 'INSTALLING_NEXUS', 'READY_NEXUS'].includes(record.phase) && record.release?.version
            && native?.phase !== 'ACTIVE' && native?.phase !== 'INSTALLED') {
          const resume = await vscode.window.showInformationMessage('上次 ' + record.release.version + ' 更新尚未完成，已完成部分会重新核对。',
            { modal: true }, '继续上次更新', '检查最新版本');
          if (!resume) return;
          if (resume === '继续上次更新') release = record.release;
        }
        const verified = local || await verify(release, context.globalStorageUri.fsPath);
        if (initialIdentity !== configurationIdentity()) throw new Error('更新配置已改变，请重新检查');
        if (!supportsEditor(verified.catalog.components.nexus.vscodeEngine, vscode.version)) throw new Error('当前编辑器版本不满足 Nexus 更新要求，请先升级编辑器');
        const actual = await current(), plan = updatePlan(verified.catalog, actual);
        if (native?.phase === 'INSTALLED' && native.version === verified.catalog.components.nexus.version
            && (!local || native.buildId === verified.catalog.components.nexus.buildId)) {
          const row = plan.find(item => item.id === 'nexus');
          if (loadedVersion !== row.target || (local && loadedBuildId !== native.buildId)) { row.update = false; row.status = '已安装，待重新加载窗口'; }
        }
        const identity = configurationIdentity();
        const selected = plan.filter(item => item.update || item.bootstrap);
        if (plan.find(item => item.id === 'nexus')?.update) {
          const available = await vscode.commands.getCommands(true);
          if (!available.includes('workbench.extensions.installExtension')) throw new Error('编辑器不支持自动安装 VSIX，请先手动升级 Nexus');
        }
        if (!selected.length) {
          const message = record?.pendingReload && actual.nexusVersion !== verified.catalog.components.nexus.version ? '更新已安装，等待重新加载窗口' : '三项组件已是当前发行版本';
          const choice = await vscode.window.showInformationMessage(message, '重新加载窗口', 'Chrome 管理指引');
          if (choice === '重新加载窗口') await vscode.commands.executeCommand('workbench.action.reloadWindow');
          if (choice === 'Chrome 管理指引') await browserGuide(actual.chrome.directory);
          return;
        }
        const detail = plan.map(item => item.label + '：' + (item.current || '未确认/未托管') + ' → ' + item.target
          + (item.update || item.bootstrap ? '（更新）' : '（保留）')).join('\n');
        const action = local ? '从本地构建并更新' : '下载并更新';
        const confirm = await vscode.window.showInformationMessage('确认更新 Guthon 三项组件？',
          { modal: true, detail: detail + '\n来源：' + release.sourceLabel
            + (local ? '\n源码目录：' + local.sourceRoot + '\n从独立源码快照构建，不修改工具后端和仓库文件。' : '\n先下载并验签全部所需附件。')
            + '\n请先保存平台编辑，Chrome 页面可稍后手动刷新。' }, action);
        if (confirm !== action) return;
        let importedHosts;
        if (plan.find(item => item.id === 'bridge')?.bootstrap) {
          const migration = await vscode.window.showQuickPick(['使用默认主机规则', '导入旧扩展主机规则'], { title: 'Chrome 首次托管：配对信息需在新目录加载后配置' });
          if (!migration) return;
          if (migration === '导入旧扩展主机规则') {
            const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
              title: '选择旧扩展的 host-config.js 或 host-settings.js', filters: { '主机规则': ['js'] } });
            if (!picked) return;
            if (fs.statSync(picked[0].fsPath).size > 65536) throw new Error('原主机配置过大');
            importedHosts = hostSettings(fs.readFileSync(picked[0].fsPath, 'utf8'));
          }
        }
        prepared = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '准备 Guthon 组件更新', cancellable: false },
          progress => local ? prepareLocal(local, plan, directory, { pythonPath: actual.tool?.toolPath, importedHosts,
            onProgress: message => progress.report({ message }) }) : prepareUpdate(verified, plan, directory, { mode: mode(), pythonPath: actual.tool?.toolPath,
            importedHosts, onProgress: message => progress.report({ message }) }));
        if (prepared.missingProviders.length) {
          const choice = await vscode.window.showWarningMessage('Python 缺少可选数据库依赖：' + prepared.missingProviders.join('；'),
            { modal: true, detail: '同批 requirements 已保存；当前可继续使用核心功能。请在所选 Python 环境中按需安装依赖，不会自动修改全局环境。' }, '继续使用核心功能');
          if (choice !== '继续使用核心功能') return;
        }
        if (identity !== configurationIdentity()) throw new Error('运行配置已改变，请重新检查更新');
        if (isBusy()) throw new Error('当前工具或 SVN 操作正在执行，附件已缓存，请完成后再更新');
        setBusy(true); busyClaimed = true;
        wasRunning = bridge.isRunning();
        if (wasRunning) {
          if (bridge.isShared?.()) throw new Error('Bridge 由其他窗口管理，请先在该窗口停止服务');
          guard = await bridge.request(home, '/updateGuard', { action: 'acquire' });
          await bridge.stop();
        }
        await processClient.stop();
        const result = await applyUpdate(prepared, directory, {
          mode: mode(),
          previousBackend: { mode: mode(), toolPath: config().get('toolPath', ''), scriptToolPath: config().get('scriptToolPath', ''), version: actual.toolVersion },
          deferNexus: true,
          trustStorageRoot: context.globalStorageUri.fsPath,
          installNexus: file => vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file)),
          switchBackend: async backend => {
            const previous = { mode: mode(), toolPath: config().get('toolPath', ''), scriptToolPath: config().get('scriptToolPath', ''), version: actual.toolVersion };
            const state = readUpdateState(context.globalStorageUri.fsPath);
            if (mode() === 'script') await config().update('scriptToolPath', backend.toolEntry, runtimeConfigurationTarget(config(), 'scriptToolPath', vscode.ConfigurationTarget));
            else {
              writeUpdateState(context.globalStorageUri.fsPath, { activeVersion: backend.version, activePath: backend.toolPath,
                previousVersion: actual.toolVersion, previousPath: previous.toolPath, source: source(), sha256: backend.sha256, updatedAt: new Date().toISOString() });
              try { await config().update('toolPath', backend.toolPath, runtimeConfigurationTarget(config(), 'toolPath', vscode.ConfigurationTarget)); }
              catch (error) { writeUpdateState(context.globalStorageUri.fsPath, state); throw error; }
            }
            const updatedTool = getTool();
            if (updatedTool) require('./tool-runtime').writeRuntimeDescriptor(updatedTool);
            return previous;
          },
        });
        return result;
      }));
      if (!result) return;
      if (result.phase === 'READY_NEXUS') {
        const file = prepared.files[ASSETS.nexus], expected = prepared.verified.catalog.assets[ASSETS.nexus].sha256;
        if (await sha256Stream(file) !== expected) throw new Error('Nexus 安装前缓存哈希不一致');
        saveJson(nexusStateFile, { version: result.nexusVersion, phase: 'INSTALLING', startedAt: Date.now(),
          buildId: prepared.verified.catalog.components.nexus.buildId,
          pid: process.pid, home, bridgeWasRunning: wasRunning });
        // Never hold filesystem locks across editor self-install/reload.
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        if (disposed) return result;
        saveJson(nexusStateFile, { version: result.nexusVersion, phase: 'INSTALLED', startedAt: Date.now(),
          buildId: prepared.verified.catalog.components.nexus.buildId,
          home, bridgeWasRunning: wasRunning });
        result.phase = 'INSTALLED'; result.pendingReload = true; result.completed.push('nexus');
        await withUpdateLock(directory, async () => {
          if (readJson(path.join(directory, 'operation.json'))?.operationId === result.operationId) saveJson(path.join(directory, 'operation.json'), result);
        });
      }
      if (disposed) return result;
      if (wasRunning) { bridge.start(getTool()); await bridge.waitForReady(home); }
      // Installation completion must not depend on another network request.
      await refreshSnapshot(prepared.verified, Date.now());
      const choice = await vscode.window.showInformationMessage('组件更新已安装，是否重新加载窗口？',
        { modal: true, detail: 'Nexus：' + (result.pendingReload ? '重新加载后生效' : '无需重载')
          + '\nChrome：已托管的扩展空闲时自动重载；首次加载或未连接时请按管理指引操作。' },
        '立即重新加载', '稍后', 'Chrome 管理指引');
      if (choice === 'Chrome 管理指引') await browserGuide(managedChrome(directory).directory);
      if (choice === '立即重新加载') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return result;
    } catch (error) {
      log('组件更新未完成：' + error.message);
      const native = readJson(nexusStateFile);
      if (native?.phase === 'INSTALLING') saveJson(nexusStateFile, { ...native, phase: 'FAILED', error: error.message });
      if (disposed) return;
      return vscode.window.showErrorMessage('组件更新未完成：' + error.message + '。已验证附件保留，可再次点击继续。');
    } finally {
      if (prepared?.chromeStage && fs.existsSync(prepared.chromeStage)) fs.rmSync(prepared.chromeStage, { recursive: true, force: true });
      if (guard && bridge.isRunning()) await bridge.request(config().get('toolHome'), '/updateGuard', { action: 'release', id: guard.id }).catch(() => {});
      if (!disposed && wasRunning && !bridge.isRunning()) {
        try { bridge.start(getTool()); } catch (error) { log('Bridge 需手动重启：' + error.message); }
      }
      if (busyClaimed) setBusy(false);
      updating = false;
    }
  }
  async function open() {
    if (vscode.env.remoteName) return vscode.window.showWarningMessage('请在本地 Windows 或 Apple Silicon 编辑器窗口更新三组件');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '检查 Guthon 三组件更新', cancellable: false }, () => check(true));
      if (snapshot.unavailable) return vscode.window.showInformationMessage(snapshot.info);
      return await update();
    } catch (error) { return vscode.window.showErrorMessage('检查更新失败：' + error.message); }
  }
  const timer = setTimeout(() => { if (!disposed && config().get('autoCheckUpdates', true)) void check(); }, 3000);
  const restore = setTimeout(() => {
    try {
      const prior = readJson(nexusStateFile);
      if (prior && ['INSTALLING', 'INSTALLED'].includes(prior.phase)
          && require('./tool-updater').compareVersions(loadedVersion, prior.version) >= 0
          && (!prior.buildId || loadedBuildId === prior.buildId || require('./tool-updater').compareVersions(loadedVersion, prior.version) > 0)) {
        saveJson(nexusStateFile, { ...prior, phase: 'ACTIVE' });
        if (prior.home === config().get('toolHome') && prior.bridgeWasRunning && !bridge.isRunning()) bridge.start(getTool());
      }
    } catch (error) { log('更新状态需核验：' + error.message); }
  }, 0);
  const periodic = setInterval(() => { if (!disposed && config().get('autoCheckUpdates', true)) void check(); }, 30 * 60000);
  const focus = vscode.window.onDidChangeWindowState?.(event => { if (event.focused && config().get('autoCheckUpdates', true)) void check(); });
  const configuration = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (['updateSource', 'toolHome', 'executionMode', 'toolPath', 'scriptToolPath', 'scriptPythonPath', 'developmentRoot'].some(key => event.affectsConfiguration('gushenCompletion.' + key))) {
      snapshot = { rows: [], count: 0 }; display();
      if (config().get('autoCheckUpdates', true) && !updating) {
        if (checking) void check().then(() => { if (!disposed) void check(); });
        else void check();
      }
    }
  });
  return { check, open, get snapshot() { return snapshot; },
    dispose() { disposed = true; clearTimeout(timer); clearTimeout(restore); clearInterval(periodic); focus?.dispose(); configuration?.dispose(); status.dispose(); } };
}

module.exports = { createUpdateCenter, localDay, needsDailyCheck, supportsEditor };
