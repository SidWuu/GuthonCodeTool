// Private runtime cache: one binding per workspace, immutable snapshots per platform/build.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const snapshot = require('./asset-snapshot');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const ADAPTER = 'guthon-offline-v1';
const validWorkspace = key => typeof key === 'string' && /^(products|projects)\.[A-Za-z0-9_-]+$/.test(key);
const validBuild = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

class DesignerResources {
  constructor({getTool, now = Date.now, remoteProbe = snapshot.probe, download = snapshot.download} = {}) {
    Object.assign(this, {getTool, now, remoteProbe, download});
    this.jobs = new Map(); this.failedChecks = new Map();
  }
  async location(workspaceKey) {
    if (!validWorkspace(workspaceKey)) throw new Error('原版资源需要明确 workspaceKey');
    const tool = await this.getTool?.();
    if (!tool?.toolHome || !path.isAbsolute(tool.toolHome)) throw new Error('请先配置有效的本地数据目录');
    const root = path.join(tool.toolHome, 'var', 'nexus', 'page-designer');
    return {root, binding: path.join(root, 'workspaces', sha(workspaceKey) + '.json')};
  }
  async readBinding(workspaceKey) {
    const location = await this.location(workspaceKey);
    try {
      const binding = JSON.parse(await fs.readFile(location.binding, 'utf8'));
      if (binding.version !== 1 || binding.workspaceKey !== workspaceKey || !validBuild(binding.platformKey)
        || binding.platformKey !== sha(snapshot.platformEntry(binding.platformUrl).href)
        || !validBuild(binding.selectedBuild) || !Number.isFinite(binding.lastCheckedAt)) throw new Error('身份或版本记录无效');
      return {...location, binding};
    } catch (error) {
      if (error.code === 'ENOENT') return {...location, binding: null};
      throw new Error('工作区原版资源绑定损坏：' + error.message);
    }
  }
  async writeBinding(location, binding) {
    await fs.mkdir(path.dirname(location.binding), {recursive:true});
    const temporary = location.binding + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(binding, null, 2) + '\n', {flag:'wx',mode:0o600});
      await fs.rename(temporary, location.binding);
    } finally { await fs.unlink(temporary).catch(error => {if(error.code!=='ENOENT')throw error;}); }
  }
  async locked(file, action) {
    await fs.mkdir(path.dirname(file), {recursive:true});
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('原版资源正在由其他窗口准备，请稍后重试；若进程已退出，请核对锁文件：' + file);
      throw error;
    }
    try { return await action(); }
    finally { await handle.close(); await fs.unlink(file); }
  }
  async exclusive(workspaceKey, action) {
    const location = await this.location(workspaceKey);
    const key = location.binding;
    if (this.jobs.has(key)) throw new Error('此工作区正在处理原版资源，请等待完成');
    const operation = this.locked(key + '.lock', () => action(location));
    this.jobs.set(key, operation);
    try { return await operation; } finally { this.jobs.delete(key); }
  }
  async selected(root, binding) {
    const directory = path.join(root, 'platforms', binding.platformKey, binding.selectedBuild);
    const assets = await snapshot.localBuild(directory);
    if (assets.build !== binding.selectedBuild || assets.digest !== binding.selectedDigest) throw new Error('缓存构建身份或资源摘要不匹配，已停止加载');
    if (snapshot.platformEntry(assets.manifest.sourceEntry).href !== binding.platformUrl) throw new Error('缓存资源来源与当前工作区平台不同，已停止加载');
    return assets;
  }
  summary(binding, assets, state = 'cached', message = '') {
    return {workspaceKey:binding.workspaceKey,platformUrl:binding.platformUrl,platformKey:binding.platformKey,
      build:binding.selectedBuild,digest:assets.digest,app:assets.app,root:assets.root,adapter:ADAPTER,
      observedBuild:binding.observedBuild || null,lastCheckedAt:binding.lastCheckedAt,state,message,
      updateAvailable:!!binding.observedBuild && binding.observedBuild !== binding.selectedBuild,
      upgradeAcknowledged:binding.pinnedBuild===binding.selectedBuild && binding.pinnedAgainst===binding.observedBuild,
      offlineMetadata:'系统样式、字典与自定义组件按工作区独立，当前未采集',assets};
  }
  async cached(workspaceKey) {
    const location = await this.readBinding(workspaceKey);
    if (!location.binding) return null;
    return this.summary(location.binding, await this.selected(location.root, location.binding));
  }
  async resolve(workspaceKey, {forceCheck = false, onProgress} = {}) {
    // Avoid a write lock for an unchanged cache hit. Offline use never downloads.
    const location = await this.readBinding(workspaceKey), binding = location.binding;
    if (!binding) return null;
    const assets = await this.selected(location.root, binding);
    if (!forceCheck && binding.lastCheckedAt && this.now() - binding.lastCheckedAt < CHECK_INTERVAL)
      return this.summary(binding, assets, 'cached', '使用已校验缓存；上次版本检查结果仍有效');
    const failureKey=location.root+'|'+binding.platformKey,failure=this.failedChecks.get(failureKey);
    if(!forceCheck && failure && this.now()-failure.time<5*60*1000)
      return this.summary(binding,assets,'offline',failure.message);
    return this.exclusive(workspaceKey, async location => {
      const latest = (await this.readBinding(workspaceKey)).binding;
      if (latest.selectedBuild !== binding.selectedBuild || latest.platformUrl !== binding.platformUrl)
        throw new Error('资源绑定已变化，请重新打开');
      let observed;
      try { observed = await this.remoteProbe(binding.platformUrl,{onProgress}); }
      catch (error) {
        const message='平台版本检查失败，使用已校验缓存：' + error.message;
        this.failedChecks.set(failureKey,{time:this.now(),message});return this.summary(binding, assets, 'offline', message);
      }
      this.failedChecks.delete(failureKey);
      if(!validBuild(observed.build))throw new Error('平台返回的构建标识无效');
      const next = {...binding, observedBuild:observed.build, lastCheckedAt:this.now()};
      await this.writeBinding(location, next);
      return this.summary(next, assets, observed.build === binding.selectedBuild ? 'current' : 'update-available',
        observed.build === binding.selectedBuild ? '本地设计器构建与平台检查结果一致；页面效果仍需验收' : '检测到平台构建变化；尚未下载或切换');
    });
  }
  async connect(workspaceKey, platformUrl, {onProgress} = {}) {
    const entry = snapshot.platformEntry(platformUrl).href;
    return this.exclusive(workspaceKey, async location => {
      const observed = await this.remoteProbe(entry,{onProgress});
      if(!validBuild(observed.build))throw new Error('平台返回的构建标识无效');
      const platformKey = sha(entry), parent = path.join(location.root, 'platforms', platformKey);
      return this.locked(path.join(parent, '.prepare.lock'), async () => {
        const directory = path.join(parent, observed.build);
        let assets;
        try { assets = await snapshot.localBuild(directory); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error; // Never overwrite or hide corrupt caches.
          try { await fs.lstat(directory); throw new Error('缓存目录不完整，请先核对；不会覆盖：' + directory); }
          catch (exists) { if (exists.code !== 'ENOENT') throw exists; }
          const staging = path.join(parent, '.pending-' + crypto.randomUUID());
          try {
            await this.download(entry, staging,{onProgress});
            onProgress?.('正在校验下载文件、资源摘要与平台构建');
            assets = await snapshot.localBuild(staging);
            if (assets.build !== observed.build) throw new Error('下载期间平台构建变化，原绑定已保留，请重试');
            await fs.rename(staging, directory);
          } finally { await fs.rm(staging, {recursive:true,force:true}); } // Only this operation's fresh staging path.
          assets = await snapshot.localBuild(directory);
        }
        if (assets.build !== observed.build || snapshot.platformEntry(assets.manifest.sourceEntry).href !== entry)
          throw new Error('缓存来源或构建与平台不一致');
        onProgress?.(`资源已校验 · ${assets.names.size} 项 · ${(assets.totalBytes/1024/1024).toFixed(2)} MB，正在绑定当前工作区`);
        const binding = {version:1,workspaceKey,platformUrl:entry,platformKey,selectedBuild:assets.build,
          selectedDigest:assets.digest,observedBuild:observed.build,lastCheckedAt:this.now(),selectedAt:this.now()};
        await this.writeBinding(location,binding);
        return this.summary(binding,assets,'current','已准备并绑定此工作区的原版资源');
      });
    });
  }
  async importLocal(workspaceKey, directory, platformUrl) {
    const source = await snapshot.localBuild(directory);
    const entry = snapshot.platformEntry(platformUrl || source.manifest.sourceEntry).href;
    if (snapshot.platformEntry(source.manifest.sourceEntry).href !== entry) throw new Error('本地资源来源与所填平台不一致');
    return this.exclusive(workspaceKey, location => {
      const platformKey = sha(entry), parent = path.join(location.root,'platforms',platformKey);
      return this.locked(path.join(parent,'.prepare.lock'),async()=>{
        const target = path.join(parent,source.build);
        try {
          await fs.lstat(target);
          const existing = await snapshot.localBuild(target);
          if (existing.digest !== source.digest) throw new Error('相同构建的本地资源摘要不同，不能覆盖缓存');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const staging = path.join(parent,'.pending-'+crypto.randomUUID());
          try { await snapshot.prepare(source.root,staging); await fs.rename(staging,target); }
          finally { await fs.rm(staging,{recursive:true,force:true}); }
        }
        const assets = await snapshot.localBuild(target);
        const binding={version:1,workspaceKey,platformUrl:entry,platformKey,selectedBuild:assets.build,
          selectedDigest:assets.digest,observedBuild:null,lastCheckedAt:0,selectedAt:this.now()};
        await this.writeBinding(location,binding);
        return this.summary(binding,assets,'imported','已导入此工作区；与在线平台构建尚未核验');
      });
    });
  }
  async versions(workspaceKey) {
    const location = await this.readBinding(workspaceKey);
    if(!location.binding)return [];
    const parent=path.join(location.root,'platforms',location.binding.platformKey);
    const names=await fs.readdir(parent);const result=[];
    for(const build of names.filter(validBuild)) {
      const assets=await snapshot.localBuild(path.join(parent,build));
      if(assets.build!==build || snapshot.platformEntry(assets.manifest.sourceEntry).href!==location.binding.platformUrl)throw new Error('资源版本身份无效');
      result.push({build,digest:assets.digest,app:assets.app,selected:build===location.binding.selectedBuild,
        downloadedAt:assets.manifest.downloadedAtUtc || null});
    }
    return result.sort((a,b)=>String(b.downloadedAt).localeCompare(String(a.downloadedAt)));
  }
  async select(workspaceKey, build) {
    if(!validBuild(build))throw new Error('资源构建标识无效');
    return this.exclusive(workspaceKey,async location=>{
      const binding=(await this.readBinding(workspaceKey)).binding;
      if(!binding)throw new Error('工作区尚未绑定平台');
      const assets=await snapshot.localBuild(path.join(location.root,'platforms',binding.platformKey,build));
      if(assets.build!==build || snapshot.platformEntry(assets.manifest.sourceEntry).href!==binding.platformUrl)throw new Error('资源来源或构建身份无效');
      const next={...binding,selectedBuild:build,selectedDigest:assets.digest,selectedAt:this.now(),
        pinnedBuild:build,pinnedAgainst:binding.observedBuild || null};
      await this.writeBinding(location,next);
      return this.summary(next,assets,'pinned','已选择缓存版本；与当前平台版本可能不同');
    });
  }
}
module.exports={DesignerResources,CHECK_INTERVAL};
