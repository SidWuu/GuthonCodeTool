// Static platform snapshots shared by Nexus and the maintenance CLI.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {verifyAssets, instrument} = require('./platform-assets');

function platformEntry(value) {
  const entry = new URL(value);
  if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password)
    throw new Error('平台地址必须是 HTTP(S) 地址，不能包含凭据');
  if (entry.pathname === '/' || entry.pathname === '') entry.pathname = '/guthon/index.html';
  if (!entry.pathname.endsWith('/guthon/index.html')) throw new Error('需要平台 /guthon/index.html 地址');
  entry.hash = ''; entry.search = '';
  return entry;
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function fetchBytes(url, {fetchImpl = globalThis.fetch, maxBytes = 32 * 1024 * 1024, signal} = {}) {
  if (!fetchImpl) return new Promise((resolve,reject) => {
    const target=new URL(url),client=require(target.protocol==='https:'?'node:https':'node:http');
    const request=client.get(target,{signal},response=>{
      if(response.statusCode!==200) {response.resume();reject(new Error('静态资源下载失败 · HTTP '+response.statusCode));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)request.destroy(new Error('资源超过大小限制'));else chunks.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
    });
    request.setTimeout(30000,()=>request.destroy(new Error('静态资源请求超时')));request.on('error',reject);
  });
  const response = await fetchImpl(url, {redirect:'error', signal:signal || AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('静态资源下载失败：' + new URL(url).pathname + ' · HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('资源超过大小限制');
  const chunks=[];let size=0;
  for await (const chunk of response.body) {
    size+=chunk.length;if(size>maxBytes)throw new Error('资源超过大小限制');chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function entryResources(html,entry) {
  const prefix=entry.pathname.slice(0,-'index.html'.length),references=[];
  for(const tag of html.toString('utf8').match(/<(?:script|link)\b[^>]*>/g)||[]) {
    if(tag.startsWith('<link') && !/\brel=["']stylesheet["']/.test(tag))continue;
    const match=/\b(?:src|href)=["']([^"']+)["']/.exec(tag);if(!match)continue;
    const url=new URL(match[1],entry);url.hash='';url.search='';
    if(url.origin!==entry.origin || !url.pathname.startsWith(prefix) || url.username || url.password)
      throw new Error('入口脚本或样式超出同源静态资源范围');
    const name='guthon/'+url.pathname.slice(prefix.length);
    if(!/^guthon\/[\w./-]+\.(?:js|css)$/.test(name))throw new Error('入口资源路径无效');
    references.push({path:name,url:url.href});
  }
  const unique=[...new Map(references.map(item=>[item.path,item])).values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(unique.length>64)throw new Error('入口资源数量超过限制');
  return unique;
}
function buildIdentity(html, coreHashes) {
  return sha(JSON.stringify([sha(html),coreHashes]));
}
async function probe(platformUrl, options = {}) {
  const entry=platformEntry(platformUrl);
  options.onProgress?.('正在读取平台入口并识别构建');
  const html=await fetchBytes(entry.href, {...options,maxBytes:2*1024*1024});
  const resources=entryResources(html,entry),apps=resources.filter(item=>/^guthon\/js\/app\.[a-f0-9]+\.js$/.test(item.path));
  if(apps.length!==1)throw new Error('未找到唯一同源原版主程序，无法识别平台构建');
  const hashes=[];let total=0;
  for(const resource of resources){options.onProgress?.('探测入口资源：'+resource.path);const bytes=await fetchBytes(resource.url,options);total+=bytes.length;
    if(total>100*1024*1024)throw new Error('入口资源超过大小限制');hashes.push([resource.path,sha(bytes)]);}
  return {platformUrl:entry.href,app:apps[0].path,build:buildIdentity(html,hashes),entryHash:sha(html)};
}
async function localBuild(root) {
  const assets=await verifyAssets(root);
  const html=await fs.readFile(path.join(assets.root,'guthon/index.html'));
  const app=await fs.readFile(path.join(assets.root,assets.app));
  instrument(app.toString('utf8'),'local-assets/');
  const entry=platformEntry(assets.manifest.sourceEntry),hashes=[];
  for(const resource of entryResources(html,entry)) {
    if(!assets.names.has(resource.path))throw new Error('快照缺少入口资源：'+resource.path);
    hashes.push([resource.path,sha(await fs.readFile(path.join(assets.root,resource.path)))]);
  }
  return {...assets,build:buildIdentity(html,hashes)};
}

async function download(platformUrl, output, options = {}) {
  const entry = platformEntry(platformUrl);
  if (!output || !path.isAbsolute(output)) throw new Error('下载需要 --output 指定尚不存在的绝对目录');
  const prefix = entry.pathname.slice(0, -'index.html'.length);
  const queue = new Map(), files = [], seen = new Set(); let total = 0;
  const add = (reference, from) => {
    if (!reference || reference.startsWith('data:') || reference.startsWith('#')) return;
    const url = new URL(reference, from);
    if (url.origin !== entry.origin || !url.pathname.startsWith(prefix)) return;
    url.hash = '';
    if (url.search) url.search = ''; // Cache-busting queries do not change the local resource path.
    const relative = 'guthon/' + url.pathname.slice(prefix.length);
    if (!/^guthon\/[\w./-]+$/.test(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('资源引用路径无效');
    if (!seen.has(relative)) queue.set(relative, url.href);
  };
  const get = async url => fetchBytes(url, {...options,maxBytes:Math.min(32*1024*1024,100*1024*1024-total)});
  add(entry.href, entry);
  add('editor.worker.js', entry); add('ts.worker.js', entry);
  await fs.mkdir(output); // Fails on existing paths; never overwrites resources.
  let initialHtml;
  while (queue.size) {
    if (seen.size + queue.size > 1000) throw new Error('资源引用超过 1000 项');
    const [relative, url] = queue.entries().next().value; queue.delete(relative); seen.add(relative);
    options.onProgress?.(`正在下载 ${relative} · 已完成 ${files.length} 项，待处理 ${queue.size+1} 项`);
    const bytes = await get(url); total += bytes.length;
    if (relative.endsWith('.html')) {
      initialHtml = bytes;
      for (const match of bytes.toString('utf8').matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) add(match[1], url);
    }
    if (relative.endsWith('.css')) {
      for (const match of bytes.toString('utf8').matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) add(match[1], url);
    }
    const file = path.join(output, relative);
    await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes, {flag: 'wx'});
    files.push({path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
    options.onProgress?.(`已下载 ${relative} · 累计 ${files.length} 项 / ${(total/1024/1024).toFixed(2)} MB`);
  }
  if (!initialHtml || !initialHtml.equals(await get(entry.href))) throw new Error('下载过程中平台入口已变化，请重新准备完整快照');
  const manifest = {sourceEntry: entry.href, downloadedAtUtc: new Date().toISOString(),
    limitation: 'Static HTML/CSS dependency snapshot only; system styles, dictionary and custom component metadata require separate verification.',
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), fileCount: files.length, totalBytes: total};
  await fs.writeFile(path.join(output, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  options.onProgress?.('下载结束，正在校验资源清单与设计器兼容性');
  return prepare(output);
}

async function prepare(source, output) {
  const assets = await verifyAssets(source);
  instrument(await fs.readFile(path.join(assets.root, assets.app), 'utf8'), 'local-assets/');
  if (output) {
    if (!path.isAbsolute(output)) throw new Error('--output 必须是绝对路径');
    try { await fs.lstat(output); throw new Error('输出目录已存在，不覆盖'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (output.startsWith(assets.root + path.sep)) throw new Error('输出目录不能位于源资源内');
    await fs.mkdir(output); // Parent must already exist; explicit scope only.
    for (const entry of assets.manifest.files) {
      const target = path.join(output, entry.path);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.copyFile(path.join(assets.root, entry.path), target, fs.constants.COPYFILE_EXCL);
    }
    await fs.writeFile(path.join(output, 'snapshot.json'), JSON.stringify(assets.manifest, null, 2) + '\n', {flag: 'wx'});
    await verifyAssets(output);
  }
  const identity = await localBuild(output || source);
  return {ok: true, files: assets.names.size, bytes: assets.totalBytes, digest: assets.digest, build: identity.build,
    output: output || null, adapter: 'guthon-offline-v1'};
}

module.exports={platformEntry,probe,localBuild,download,prepare};
