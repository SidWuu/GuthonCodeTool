// Local platform resources are provided by the user, never bundled or fetched implicitly.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function verifyAssets(root) {
  if (!path.isAbsolute(root)) throw new Error('设计器资源目录必须是绝对路径');
  const realRoot = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(realRoot, 'snapshot.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1000) throw new Error('资源清单无效');
  const names = new Set(); let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^guthon\/[\w./-]+$/.test(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(entry.path)
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('资源清单含重复、越界或无效记录');
    names.add(entry.path);
    const file = path.join(realRoot, entry.path), resolved = await fs.realpath(file);
    if (resolved !== file) throw new Error('设计器资源不允许符号链接');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== entry.bytes || stat.size > 32 * 1024 * 1024) throw new Error('资源大小不匹配：' + entry.path);
    totalBytes += stat.size; if (totalBytes > 100 * 1024 * 1024) throw new Error('资源包超过 100 MB');
    const bytes = await fs.readFile(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('资源哈希不匹配：' + entry.path);
  }
  const apps = [...names].filter(name => /^guthon\/js\/app\.[a-f0-9]+\.js$/.test(name));
  if (apps.length !== 1 || !['guthon/index.html', 'guthon/editor.worker.js', 'guthon/ts.worker.js'].every(name => names.has(name))) throw new Error('资源缺少唯一主程序、HTML 或 Monaco worker');
  return {root: realRoot, manifest, names, app: apps[0], totalBytes,
    digest: crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')};
}

function instrument(source, assetBase) {
  const match = /([\w$]+)\.a\.prototype\.\$api=([\w$]+),\1\.a\.prototype\.\$config=([\w$]+),\1\.a\.prototype\.\$gScript=([\w$]+)/.exec(source);
  const paths = [...source.matchAll(/\b([\w$]+)\.p="\/guthon\/"/g)];
  if (!match || paths.length !== 1) throw new Error('平台启动结构不兼容，请保留原资源并更新适配器');
  const vueName = match[1].replace(/[$]/g, '\\$');
  const boot = new RegExp('var [\\w$]+=new ' + vueName + '\\.a\\(').exec(source.slice(match.index));
  if (!boot) throw new Error('未找到支持的 Vue 启动入口');
  const offset = match.index + boot.index;
  const validators = [...source.matchAll(/([\w$]+)=\{checkGdpaasScript:function\(/g)].map(item => item[1]);
  const injected = `window.GuthonOfflineDesigner({Vue:${match[1]}.a,api:${match[2]},config:${match[3]},script:${match[4]},validators:[${validators.join(',')}]});`;
  return (source.slice(0, offset) + injected + source.slice(offset))
    .replace(/\b([\w$]+)\.p="\/guthon\/"/g, (_, name) => `${name}.p=${JSON.stringify(assetBase)}`)
    .replace(/<\/script/gi, '<\\/script');
}

async function nativeHtml(assets, webview, vscode, extensionPath, nonce) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const resource = name => {
    if (!assets.names.has(name)) throw new Error('HTML 引用未校验资源：' + name);
    return escape(webview.asWebviewUri(vscode.Uri.file(path.join(assets.root, name))).toString());
  };
  const original = await fs.readFile(path.join(assets.root, 'guthon/index.html'), 'utf8');
  const scripts = [...original.matchAll(/<script[^>]+src="([^"]+)"/g)].map(item => item[1].replace(/^\//, '')).filter(name => name !== assets.app);
  const css = [...original.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*rel="stylesheet"/g)].map(item => item[1].replace(/^\//, ''));
  const base = webview.asWebviewUri(vscode.Uri.file(path.join(assets.root, 'guthon'))).toString() + '/';
  const workerSources = {};
  for (const name of ['editor.worker.js', 'ts.worker.js']) workerSources[name] = await fs.readFile(path.join(assets.root, 'guthon', name), 'utf8');
  const bridge = escape(webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'src/page-editor/native.js'))).toString());
  const shellCss = escape(webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'src/page-editor/native.css'))).toString());
  const app = instrument(await fs.readFile(path.join(assets.root, assets.app), 'utf8'), base);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:; worker-src blob:; connect-src 'none'; frame-src 'none';">
    ${css.map(name => `<link rel="stylesheet" href="${resource(name)}">`).join('')}<link rel="stylesheet" href="${shellCss}"></head><body>
    <header id="native-toolbar"><div><strong id="native-title">谷神原版设计视图</strong><span id="native-mode">当前草稿</span></div>
      <div class="native-actions"><button id="native-save">保存到本地</button><button id="native-compare">查看修改前</button><button id="native-platform">去平台对照</button><button id="native-resources">平台资源</button><button id="native-manager">草稿与代码</button><label>窗口宽度<input id="native-width" type="number" min="640" max="7680" placeholder="自适应" aria-label="原版视图窗口宽度"></label></div></header>
    <div id="native-evidence">资源清单已校验 · 与在线平台的一致性尚未验收 · 不执行业务脚本</div><div id="offline-status" role="status">正在启动本地设计器</div><div id="native-stage"><div id="app"></div></div>
    <script nonce="${nonce}" type="application/json" id="workers">${JSON.stringify(workerSources).replace(/</g, '\\u003c')}</script>
    <script nonce="${nonce}" src="${bridge}"></script>
    ${scripts.map(name => `<script nonce="${nonce}" src="${resource(name)}"></script>`).join('')}
    <script nonce="${nonce}">${app}</script></body></html>`;
}
module.exports = {verifyAssets, instrument, nativeHtml};
