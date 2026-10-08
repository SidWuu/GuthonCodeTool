const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { managedChrome, updateRoot, saveJson, hostSettings } = require('./component-update');
const { withUpdateLock, compareVersions } = require('./tool-updater');
const { writeRuntimeDescriptor } = require('./tool-runtime');
const { checkRepository, publicKey, authorizationCommand } = require('./onboarding-team');

function readObject(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('安装配置记录无效');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('安装配置记录无效');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function readiness({ report, toolVersion, nexusVersion, hook, chrome, clients = [] }) {
  const versionReady = (current, required) => {
    try { return compareVersions(current, required) >= 0; } catch { return false; }
  };
  const tool = report.state === 'environment-ready' && versionReady(toolVersion, report.version)
    && versionReady(nexusVersion, report.nexusVersion);
  const team = Boolean(hook.schemaVersion === 1 && hook.ready === true && hook.event === 'SessionStart' && versionReady(hook.pluginVersion, report.guardMinimumVersion)
    && Number.isFinite(Date.parse(hook.observedAt)) && Date.parse(hook.observedAt) >= Date.parse(report.installedAt));
  const bridge = Boolean(chrome.installId && clients.some(item => item.installId === chrome.installId
    && item.version === chrome.version && item.protocolVersion === 2));
  return { tool, team, bridge, complete: tool && team && bridge };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function page(snapshot, nonce) {
  const cards = [
    ['tool', 'GuthonCodeTool 与 GuthonNexus', '运行入口已由安装器配置。检查当前后端和 Nexus 是否可用。', [['refresh', '检查运行环境']]],
    ['team', '安装内网 guthon-team 插件', '先连接公司网络。首次使用需在内网 Git 网站开通账号和仓库权限；SSH 来源将公钥添加到“用户设置 → SSH/GPG 公钥”，私钥留在本机。点击首次连接授权后，核对团队提供的服务器指纹再确认信任。检查仓库访问，再从 CodeBuddy 插件市场安装 guthon-guard。重载插件并开始一个新聊天，由 SessionStart 初始化和更新工作区规范。', [['gitweb', '打开内网 Git 网站'], ['key', '生成或复制 SSH 公钥'], ['authorize', '首次连接授权'], ['repository', '检查内网仓库'], ['team', '打开插件市场'], ['reload', '复制重载插件命令'], ['refresh', '检查 Hook 运行']]],
    ['bridge', '连接现有 Chrome 的 GuthonBridge', '首次加载：打开扩展管理页，启用开发者模式，点击“加载已解压的扩展”，选择向导提供的目录。然后在 GuthonBridge 的“本机 Bridge 配对”粘贴令牌，点击“保存并连接”。', [['hosts', '平台地址规则（按需）'], ['chrome', '打开 Chrome 扩展管理'], ['folder', '定位并复制扩展目录'], ['token', '复制配对令牌'], ['refresh', '检查浏览器连接']]],
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:900px;margin:30px auto;padding:0 24px;line-height:1.7}section{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:18px;margin:16px 0}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:9px 14px;margin:5px;border-radius:5px;cursor:pointer}h2{font-size:19px;margin:0}p{margin:12px 0}.error{color:var(--vscode-errorForeground)}.hint{opacity:.8}select{max-width:100%;padding:8px}</style></head><body>
<h1>完成 Guthon 工具与插件安装</h1><p>${snapshot.complete ? '工具、插件和环境检查已通过。后续在 CodeBuddy 中使用 GuthonNexus。' : '这是从零安装时的一次性确认。完成后关闭此助手，日常直接在 CodeBuddy 使用 GuthonNexus。'}</p>
${snapshot.report?.marketplaceUrl ? `<p class="hint">团队插件来源：${escapeHtml(snapshot.report.marketplaceUrl)}</p>` : ''}
${snapshot.error ? `<p class="error">${escapeHtml(snapshot.error)}</p>` : ''}
${cards.map(([id, title, help, buttons]) => `<section><h2>${snapshot[id] ? '✓' : '○'} ${title}</h2><p>${help}</p>${buttons.map(([action, label]) => `<button data-action="${action}">${label}</button>`).join('')}</section>`).join('')}
<button data-action="continue">${snapshot.complete ? '重新检查' : '继续下一步'}</button><button data-action="finish">完成配置</button><button data-action="tutorial">查看完整操作教程</button>
<script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('button').forEach(b=>b.disabled=true);api.postMessage({action:button.dataset.action});}));</script></body></html>`;
}

function chromeExecutable(env = process.env) {
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    if (!env[key]) continue;
    const file = path.join(env[key], 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

function nextAction(status) {
  if (!status.tool) return 'refresh';
  if (!status.team) return 'team';
  return status.bridge ? 'finish' : 'chrome';
}

function createOnboarding({ vscode, context, getTool, client, bridge, spawnProcess = spawn }) {
  let panel, timer, busy = false, last = {};
  const stateFile = home => path.join(home, 'var', 'nexus', 'onboarding.json');

  async function snapshot() {
    const tool = getTool();
    if (!tool) throw new Error('请先使用 GuthonCodeSetup 安装，或在 Nexus 设置运行入口');
    if (!vscode.workspace.isTrusted) throw new Error('请先确认工作区信任，再继续配置');
    writeRuntimeDescriptor(tool);
    const report = readObject(path.join(tool.toolHome, 'var', 'nexus', 'setup-result.json'));
    const version = await client.run('', 'version');
    const chrome = managedChrome(updateRoot(tool.toolHome));
    let clients = [];
    if (bridge.isRunning()) {
      try { clients = (await bridge.request(tool.toolHome, '/components')).clients || []; }
      catch { /* A running process alone does not prove connection. */ }
    }
    const hook = readObject(path.join(tool.toolHome, 'var', '.guthon', 'hook-runtime.json'));
    return { ...readiness({ report, toolVersion: version.version, nexusVersion: context.extension.packageJSON.version,
      hook, chrome, clients }), report, chrome };
  }

  async function refresh() {
    try { last = await snapshot(); }
    catch (error) { last = { ...last, complete: false, error: error.message }; }
    if (panel) panel.webview.html = page(last, crypto.randomBytes(16).toString('hex'));
    return last;
  }

  async function action(name) {
    if (busy) return;
    busy = true;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区');
      const tool = getTool();
      if (!tool) throw new Error('运行环境尚未配置');
      if (name === 'continue') {
        await refresh();
        name = nextAction(last);
      }
      if (name === 'tutorial') {
        const file = last.report?.tutorialPath;
        if (!file || path.basename(file) !== 'GuthonCodeTool_Windows安装步骤.html' || !fs.existsSync(file)) throw new Error('Windows 安装手册尚未就位，请重新运行安装器');
        await vscode.env.openExternal(vscode.Uri.file(file).with({ fragment: 'one-click' }));
      } else if (name === 'repository') {
        await checkRepository(last.report?.marketplaceUrl, undefined, tool.env);
        await vscode.window.showInformationMessage('内网仓库访问已通过，可以继续安装市场插件。');
      } else if (name === 'gitweb') {
        const file = stateFile(tool.toolHome), saved = readObject(file);
        const url = saved.gitWebUrl || await vscode.window.showInputBox({ title: '内网 Git 网站地址', prompt: '填写团队提供的 Git 网站地址，不要填写 SSH 克隆地址或密码' });
        if (url) {
          const address = new URL(url);
          if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('Git 网站地址无效或包含凭据');
          saveJson(file, { ...saved, schemaVersion: 1, gitWebUrl: address.href });
          await vscode.env.openExternal(vscode.Uri.parse(address.href));
        }
      } else if (name === 'key') {
        await vscode.env.clipboard.writeText(await publicKey());
        await vscode.window.showInformationMessage('仅 SSH 公钥已复制。到内网 Git 网站“用户设置 → SSH/GPG 公钥”粘贴保存；已有密钥会保留，私钥不会上传。');
      } else if (name === 'authorize') {
        const terminal = vscode.window.createTerminal({ name: 'Guthon 内网仓库首次连接', env: tool.env, ...(process.platform === 'win32' ? { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] } : {}) });
        terminal.show();
        terminal.sendText(authorizationCommand(last.report?.marketplaceUrl));
      } else if (name === 'team') {
        await vscode.commands.executeCommand('workbench.action.quickOpen', '>插件市场');
        await vscode.window.showInformationMessage('打开 CodeBuddy 插件市场，选择已配置的内网 guthon-team，确认安装 guthon-guard。重新加载插件并开始新聊天，再回到向导检查。');
      } else if (name === 'reload') {
        await vscode.env.clipboard.writeText('/reload-plugins');
        await vscode.window.showInformationMessage('已复制 /reload-plugins，在 CodeBuddy 聊天输入框粘贴执行。');
      } else if (['chrome', 'folder', 'token'].includes(name)) {
        bridge.start(tool);
        await bridge.waitForReady(tool.toolHome);
        const chrome = managedChrome(updateRoot(tool.toolHome));
        if (!chrome.installId) throw new Error('缺少托管浏览器扩展，请重新运行安装器');
        if (name === 'token') {
          await vscode.env.clipboard.writeText(bridge.pairingToken(tool.toolHome));
          await vscode.window.showInformationMessage('配对令牌已复制。打开 Chrome 的 GuthonBridge，在“本机 Bridge 配对”粘贴后点击“保存并连接”。');
        } else if (name === 'folder') {
          await vscode.env.clipboard.writeText(chrome.directory);
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(chrome.directory, 'manifest.json')));
        } else {
          const executable = chromeExecutable();
          if (!executable) throw new Error('未找到现有 Chrome，请安装 Chrome 后继续');
          const child = spawnProcess(executable, ['chrome://extensions/'], { shell: false, detached: true, stdio: 'ignore' });
          child.on('error', error => vscode.window.showErrorMessage(error.message));
          child.unref();
        }
      } else if (name === 'hosts') {
        const value = await vscode.window.showInputBox({ title: '输入谷神平台地址', prompt: '填写平时登录谷神的完整地址，不包含账号或密码',
          validateInput: input => { try { const url = new URL(input); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); return undefined; } catch { return '请输入不含账号或密码的 http/https 地址'; } } });
        if (value) {
          const url = new URL(value), root = updateRoot(tool.toolHome), file = path.join(managedChrome(root).directory, 'host-settings.js');
          url.search = ''; url.hash = '';
          await withUpdateLock(root, async () => {
            const settings = hostSettings(fs.readFileSync(file, 'utf8'));
            if (url.pathname !== '/' && !settings.pathPrefixes.some(prefix => url.pathname.startsWith(prefix) || url.pathname === prefix.replace(/\/$/, ''))) {
              throw new Error('此地址的路径不在现有谷神规则中，请核对平台地址；其他路径由维护者配置主机规则。');
            }
            const hostname = url.hostname.replace(/^\[|\]$/g, '');
            const key = net.isIP(hostname) ? 'ipRanges' : 'domainSuffixes';
            const host = net.isIP(hostname) ? hostname + (net.isIP(hostname) === 4 ? '/32' : '/128') : hostname;
            settings[key] = [...new Set([...settings[key], host])];
            const temporary = file + '.' + crypto.randomUUID() + '.tmp';
            try { fs.writeFileSync(temporary, 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify(settings, null, 2) + ';\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
            finally { fs.rmSync(temporary, { force: true }); }
          });
          const state = stateFile(tool.toolHome);
          saveJson(state, { ...readObject(state), schemaVersion: 1, platformUrl: url.href });
          await vscode.window.showInformationMessage('平台地址已配置。首次加载扩展即可生效；已经加载时请在 Chrome 扩展页点击重新加载。');
        }
      } else if (name === 'finish') {
        const current = await snapshot();
        if (!current.complete) throw new Error('仍有未通过的运行检查，请继续完成配置');
        const state = readObject(stateFile(tool.toolHome));
        delete state.workspaceKey; delete state.loginWorkspaceKey;
        saveJson(stateFile(tool.toolHome), { ...state, schemaVersion: 1,
          completedBundleId: current.report.bundleId, completedAt: new Date().toISOString() });
        panel?.dispose();
        await vscode.window.showInformationMessage('安装和基础环境配置已完成。后续打开 CodeBuddy，使用 GuthonNexus 添加产品或项目并开展开发。');
      } else if (name !== 'refresh') throw new Error('未知的安装配置操作');
      await refresh();
    } catch (error) {
      last = { ...last, complete: false, error: error.message };
      if (panel) panel.webview.html = page(last, crypto.randomBytes(16).toString('hex'));
    } finally {
      busy = false;
      if (panel) panel.webview.html = page(last, crypto.randomBytes(16).toString('hex'));
    }
  }

  async function open() {
    if (!vscode.workspace.isTrusted) return vscode.window.showInformationMessage('请先信任当前工作区，再打开首次配置向导。');
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('guthonOnboarding', 'Guthon 安装配置助手', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    panel.webview.onDidReceiveMessage(message => { if (typeof message?.action === 'string') void action(message.action); });
    panel.onDidDispose(() => { panel = undefined; clearInterval(timer); });
    await refresh();
    if (panel) timer = setInterval(() => { if (!busy && panel) void refresh(); }, 15000);
  }

  async function openIfNeeded() {
    const config = vscode.workspace.getConfiguration('gushenCompletion');
    const tool = getTool();
    if (!config.get('onboarding', false) || !tool || !vscode.workspace.isTrusted) return;
    const report = readObject(path.join(tool.toolHome, 'var', 'nexus', 'setup-result.json'));
    if (report.state !== 'environment-ready' || readObject(stateFile(tool.toolHome)).completedBundleId === report.bundleId) return;
    await open();
  }

  return { open, openIfNeeded, snapshot, action, dispose() { clearInterval(timer); panel?.dispose(); } };
}

module.exports = { createOnboarding, readiness, page, chromeExecutable, nextAction };
