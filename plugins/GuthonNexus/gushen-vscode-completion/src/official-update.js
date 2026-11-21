const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {request,downloadAsset,sha256,normalizeVersion,withUpdateLock}=require('./tool-updater');
const {readArchive,archiveJson}=require('./update-archive');
const {extractCatalog}=require('./api/official-catalog');
const {contract,assessOfficial,assessmentMarkdown}=require('./official-assessment');
const API='https://open-vsx.org/api/guthon/guthon-language-support';
function sourceUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:' || u.hostname!=='open-vsx.org' || u.username || u.password) throw new Error('Open VSX 文件地址无效');
  return u.toString();
}
function readState(root) {
  try {return JSON.parse(fs.readFileSync(path.join(root,'official-state.json'),'utf8'));}
  catch(error) {if(error.code==='ENOENT') return {};throw new Error('官方更新状态无法读取，请先检查本地文件');}
}
function saveState(root,state) {
  const target=path.join(root,'official-state.json'), temp=path.join(root,`.state-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,target);
}
function formatReport({before,after,downloaded,effectiveBefore,effectiveAfter,notes='',error='',catalogError='',bundled,assessment}) {
  const item=x=>x ? `${x.version}（SHA-256 ${x.sha256}）` : '无';
  const resource=x=>x===undefined ? '无法确认' : item(x || bundled);
  return `# 谷神官方能力更新\n\n来源：[Open VSX](${API})\n\n## 更新前\n\n已选择来源包：${item(before)}\n\n补全与悬停数据：${resource(effectiveBefore)}\n\n## 官方说明\n\n${notes || '未取得说明。'}\n\n${assessment ? assessmentMarkdown(assessment) : ''}\n## Nexus 影响\n\n官方可执行代码未运行。兼容的静态 API 签名和文档用于 Nexus 补全与悬停；源码同步、在线设计器、命令和语法机制由当前 Nexus 版本提供，需要兼容实现后才能更新。语法 JSON 仅供适配。${catalogError ? `\n\n静态资源未切换：${catalogError}` : ''}\n\n## 实际结果\n\n本次校验来源包：${item(downloaded)}\n\n已选择来源包：${item(after)}\n\n当前补全与悬停数据：${resource(effectiveAfter)}\n\n${error ? `操作未完成：${error}\n\n` : ''}回退会切换至前一版补全与悬停资源；如果前一版使用内置数据，则恢复内置数据。同步和设计器协议仍由当前 Nexus 版本决定。SHA-256 来自同一 Open VSX 来源，仅验证下载完整性，不代表签名验证。\n`;
}
function effective(state) {return Object.hasOwn(state,'effectiveCatalog') ? state.effectiveCatalog : (state.current?.catalog ? state.current : null);}
function bundledInfo(context) {
  try {const source=JSON.parse(fs.readFileSync(path.join(context.extensionPath,'data','official-api.json'),'utf8')).source;return {version:source.version,sha256:source.sha256};} catch {return undefined;}
}
async function showReport(vscode,report) {
  const doc=await vscode.workspace.openTextDocument({language:'markdown',content:report});
  await vscode.window.showTextDocument(doc,{preview:true});
}
async function checkOfficialUpdate({vscode,context,io={request,downloadAsset}}) {
  const root=path.join(context.globalStorageUri.fsPath,'official-updates');let before,after,downloaded,effectiveBefore,effectiveAfter,notes='',catalogError='',failure,assessment;
  try {
    await withUpdateLock(root,async()=>{
      const state=readState(root);before=state.current;after=before;effectiveBefore=effective(state);effectiveAfter=effectiveBefore;
      const metadata=JSON.parse((await io.request(API)).toString('utf8'));
      if(metadata.name!=='guthon-language-support' || metadata.namespace!=='guthon') throw new Error('Open VSX 扩展身份不匹配');
      const version=normalizeVersion(metadata.version), files=metadata.files || {};
      const digestText=(await io.request(sourceUrl(files.sha256))).toString('utf8').trim();
      const match=/^([a-f0-9]{64})(?:\s+\*?[^\r\n]+)?$/i.exec(digestText);
      if(!match) throw new Error('Open VSX SHA-256 格式无效');
      const digest=match[1].toLowerCase();
      notes=(await io.request(sourceUrl(files.changelog))).toString('utf8').slice(0,65536);
      const name=`${version}-${digest}.vsix`, archive=path.join(root,name);
      if(!fs.existsSync(archive)) {
        const temp=path.join(root,`.download-${crypto.randomUUID()}.vsix`);
        try {
          await io.downloadAsset(sourceUrl(files.download),temp,{maxBytes:64*1024*1024});
          if(sha256(temp)!==digest) throw new Error('官方来源包 SHA-256 不匹配');
          const entries=readArchive(temp);const manifest=archiveJson(entries,'extension/package.json');
          if(manifest.publisher!=='guthon' || manifest.name!=='guthon-language-support' || manifest.version!==version) throw new Error('官方来源包身份或版本不匹配');
          fs.renameSync(temp,archive);
        } finally {try {fs.unlinkSync(temp);} catch(e) {if(e.code!=='ENOENT') throw e;}}
      } else if(sha256(archive)!==digest) throw new Error('本地官方来源包校验失败');
      const entries=readArchive(archive);const manifest=archiveJson(entries,'extension/package.json');
      if(manifest.publisher!=='guthon' || manifest.name!=='guthon-language-support' || manifest.version!==version) throw new Error('官方来源包身份或版本不匹配');
      const grammar=entries.get('extension/src/guthon-script/syntaxes/guthonscript.tmLanguage.json');
      if(grammar && !grammar.directory) {
        try {
          const data=grammar.data(), parsed=JSON.parse(data.toString('utf8'));
          if(parsed.scopeName!=='source.guthonscript' || !Array.isArray(parsed.patterns)) throw new Error('官方语法 JSON 结构变化');
          const resource=path.join(root,`${version}-${digest}.grammar.json`);
          if(!fs.existsSync(resource)) fs.writeFileSync(resource,data,{flag:'wx',mode:0o600});
        } catch(error) {catalogError=`语法资料未提取：${error.message}`;}
      }
      downloaded={version,sha256:digest,archive:name};
      const next={...downloaded};
      try {
        const bundle=entries.get('extension/dist/extension.js');
        if(!bundle || bundle.directory) throw new Error('来源包缺少静态数据');
        const catalog=extractCatalog(bundle.data().toString('utf8'),{extension:'guthon.guthon-language-support',version,registry:API,sha256:digest,license:manifest.license || ''});
        const bundledContract=JSON.parse(fs.readFileSync(path.join(context.extensionPath,'data','official-compatibility.json'),'utf8'));
        const previous=effectiveBefore?.catalog ? JSON.parse(fs.readFileSync(path.join(root,effectiveBefore.catalog),'utf8'))
          : JSON.parse(fs.readFileSync(path.join(context.extensionPath,'data','official-api.json'),'utf8'));
        const currentContract=contract(manifest,bundle.data().toString('utf8'));
        assessment=assessOfficial(before?.upstreamContract || bundledContract,currentContract,previous,catalog);
        next.upstreamContract=currentContract;next.assessment=assessment;
        const data=Buffer.from(JSON.stringify(catalog,null,2)+'\n');
        const catalogName=`${version}-${digest}.catalog.json`, catalogPath=path.join(root,catalogName);
        const temp=path.join(root,`.catalog-${crypto.randomUUID()}.tmp`);
        try {fs.writeFileSync(temp,data,{flag:'wx',mode:0o600});fs.renameSync(temp,catalogPath);} finally {try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT') throw e;}}
        next.catalog=catalogName;next.catalogSha256=crypto.createHash('sha256').update(data).digest('hex');
      } catch(error) {catalogError=[catalogError,error.message].filter(Boolean).join('；');}
      const changed=!!next.catalog && effectiveBefore?.catalogSha256!==next.catalogSha256;
      const nextState={current:next,previous:before && before.sha256!==digest ? before : state.previous,
        effectiveCatalog:next.catalog ? next : effectiveBefore,previousEffectiveCatalog:changed ? effectiveBefore : state.previousEffectiveCatalog};
      saveState(root,nextState);after=next;effectiveAfter=effective(nextState);
    });
  } catch(error) {failure=error;
    if(before===undefined) {try {const state=readState(root);before=after=state.current;effectiveBefore=effectiveAfter=effective(state);} catch {}}
  }
  await showReport(vscode,formatReport({before,after,downloaded,effectiveBefore,effectiveAfter,notes,catalogError,assessment,bundled:bundledInfo(context),error:failure?.message}));
  if(failure) throw failure;
  return after;
}
async function rollbackOfficialUpdate({vscode,context}) {
  const root=path.join(context.globalStorageUri.fsPath,'official-updates');let before,after,effectiveBefore,effectiveAfter,failure;
  try {await withUpdateLock(root,async()=>{
    const state=readState(root);before=state.current;after=before;effectiveBefore=effective(state);effectiveAfter=effectiveBefore;
    if(!Object.hasOwn(state,'previousEffectiveCatalog')) throw new Error('没有可回退的补全资源');
    const previousEffective=state.previousEffectiveCatalog;
    if(previousEffective) {
      const prefix=`${normalizeVersion(previousEffective.version)}-${previousEffective.sha256}`;
      if(!/^[a-f0-9]{64}$/.test(previousEffective.sha256) || previousEffective.catalog!==`${prefix}.catalog.json` || !/^[a-f0-9]{64}$/.test(previousEffective.catalogSha256)
        || sha256(path.join(root,previousEffective.catalog))!==previousEffective.catalogSha256) throw new Error('上一次补全资源校验失败');
    }
    const previous=state.previous;
    if(previous) {
      if(!/^[a-f0-9]{64}$/.test(previous.sha256) || previous.archive!==`${normalizeVersion(previous.version)}-${previous.sha256}.vsix` || sha256(path.join(root,previous.archive))!==previous.sha256) throw new Error('上一次来源包校验失败');
    }
    const nextState={current:previous || before,previous:previous ? before : undefined,effectiveCatalog:previousEffective,previousEffectiveCatalog:effectiveBefore};
    saveState(root,nextState);after=nextState.current;effectiveAfter=effective(nextState);
  });} catch(error) {failure=error;
    if(before===undefined) {try {const state=readState(root);before=after=state.current;effectiveBefore=effectiveAfter=effective(state);} catch {}}
  }
  await showReport(vscode,formatReport({before,after,effectiveBefore,effectiveAfter,bundled:bundledInfo(context),error:failure?.message}));
  if(failure) throw failure;return after;
}
// The host may use this path in its existing completion-data cache signature.
function getOfficialCatalogPath(context, fallbackPath) {
  const root=path.join(context.globalStorageUri.fsPath,'official-updates');
  const state=readState(root);
  const current=effective(state);
  if(!current?.catalog) return fallbackPath;
  const prefix=`${normalizeVersion(current.version)}-${current.sha256}`;
  if(!/^[a-f0-9]{64}$/.test(current.sha256) || current.catalog!==`${prefix}.catalog.json` || !/^[a-f0-9]{64}$/.test(current.catalogSha256)) throw new Error('官方 API 资源状态无效');
  const file=path.join(root,current.catalog);
  if(sha256(file)!==current.catalogSha256) throw new Error('官方 API 资源校验失败');
  return file;
}
module.exports={checkOfficialUpdate,rollbackOfficialUpdate,formatReport,readState,getOfficialCatalogPath};
