const path=require('node:path');
const RECOVERY_KEY='guthon.api.indexRecovery';
function sourcePathAllowed(p) {
  if(typeof p!=='string' || p.includes('\\')) return false;
  const parts=p.split('/');if(parts.some(part=>!part || part==='.' || part==='..' || part.startsWith('.')) || /^agents\.md$/i.test(parts.at(-1))) return false;
  if(parts[0]==='systems') return (parts[2]==='pages' && parts.length>=6) || (['system-script','module-parameters'].includes(parts[2]) && parts.length===4);
  if(parts[0]==='datasources') return ['procedures','tables','views'].includes(parts[2]) && parts.length>=4;
  return ['otherconfig','skills'].includes(parts[0]) && parts.length>=2;
}

// Disk events are coalesced per project; only backend-controlled paths are indexed.
class ApiSourceWatcher {
  constructor({run,onChanged,onError,workspaceState,delay=300,retryDelays=[1000,3000,10000],batchSize=100}) {
    Object.assign(this,{run,onChanged,onError,workspaceState,delay,retryDelays,batchSize});
    this.projects=new Map();this.disposed=false;this.persistTail=Promise.resolve();
    this.recovered=workspaceState?.get(RECOVERY_KEY) || {};
  }
  register(key,root) {
    if(this.projects.has(key)) return;
    const absolute=path.resolve(root),saved=this.recovered[key];
    const pending=saved?.root===absolute ? [...(saved.paths || []),...(saved.unchecked || [])].filter(sourcePathAllowed) : [];
    const state={root:absolute,paths:new Set(),unchecked:new Set(pending),running:false,waiters:[],attempts:0};
    this.projects.set(key,state);delete this.recovered[key];
    if(saved) void this.persist().catch(error=>this.onError(key,error));
    if(state.unchecked.size) state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},this.delay);
  }
  persist() {
    if(!this.workspaceState) return Promise.resolve();
    this.persistTail=this.persistTail.catch(()=>{}).then(()=>{
      const data={...this.recovered};for(const [key,state] of this.projects) if(state.root) {
        const paths=[...new Set([...(state.inflight || []),...state.paths])],unchecked=[...new Set([...(state.checking || []),...state.unchecked])];
        if(paths.length || unchecked.length) data[key]={root:state.root,paths,...(unchecked.length ? {unchecked} : {})};else delete data[key];
      }
      return Promise.resolve(this.workspaceState.update(RECOVERY_KEY,data)).then(()=>{this.recovered=data;});
    });
    return this.persistTail;
  }
  enqueue(key,sourcePath) {
    if(this.disposed || !sourcePathAllowed(sourcePath)) return;
    let state=this.projects.get(key);if(!state) {state={paths:new Set(),unchecked:new Set(),running:false,waiters:[],attempts:0};this.projects.set(key,state);}
    state.unchecked.add(sourcePath);void this.persist().catch(error=>this.onError(key,error));
    if(state.attempts>=this.retryDelays.length+1) return;
    clearTimeout(state.timer);state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},this.delay);
  }
  async flush(key) {
    const state=this.projects.get(key);if(!state || state.running || this.disposed) return;
    clearTimeout(state.timer);state.timer=undefined;state.running=true;
    let failed=false,updated=0;
    try {
      const checking=[...state.unchecked].slice(0,this.batchSize);for(const p of checking) state.unchecked.delete(p);state.checking=checking;
      if(checking.length) {
        const result=await this.run(key,'index',{paths:checking,checkOnly:true});
        if(!Array.isArray(result.updatedPaths)) throw new Error('源码路径核查结果无效');
        const requested=new Set(checking);for(const p of result.updatedPaths) if(requested.has(p)) state.paths.add(p);
      }
      state.checking=undefined;await this.persist();
      const paths=[...state.paths].slice(0,this.batchSize);for(const p of paths) state.paths.delete(p);state.inflight=paths;
      if(paths.length) {const result=await this.run(key,'index',{paths});
        if(!Array.isArray(result.updatedPaths)) throw new Error('源码索引更新结果无效');updated=result.updatedPaths.length;
        const generationChanged=!!result.indexGeneration && result.indexGeneration!==state.indexGeneration;
        if(result.updatedPaths.length || (result.unchanged && generationChanged)) try {await this.onChanged(key,result.updatedPaths,result);} catch(error) {this.onError(key,error);}
        if(result.indexGeneration) state.indexGeneration=result.indexGeneration;}
      state.attempts=0;
    } catch(error) {
      failed=true;for(const p of state.checking || []) state.unchecked.add(p);for(const p of state.inflight || []) state.paths.add(p);state.attempts++;
      if(state.attempts===1 || state.attempts>this.retryDelays.length) this.onError(key,error);
    } finally {
      state.checking=undefined;state.inflight=undefined;state.running=false;for(const resolve of state.waiters.splice(0)) resolve();
      await this.persist().catch(error=>this.onError(key,error));
      if(!this.disposed && (state.paths.size || state.unchecked.size) && !state.timer) {
        const wait=failed ? this.retryDelays[state.attempts-1] : this.delay;
        if(wait!==undefined) state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},wait);
      } else if(!state.root && !state.paths.size && !state.unchecked.size && !state.timer) this.projects.delete(key);
    }
    return updated;
  }
  recovery(key) {
    const state=this.projects.get(key);return state ? {paths:[...new Set([...(state.inflight || []),...state.paths])],running:state.running,attempts:state.attempts} : {paths:[],running:false,attempts:0};
  }
  async retry(key) {
    const state=this.projects.get(key);if(!state) return {attempted:0};
    clearTimeout(state.timer);state.timer=undefined;
    if(state.running) await new Promise(resolve=>state.waiters.push(resolve));
    let attempted=0;state.attempts=0;
    while(state.paths.size || state.unchecked.size) {
      const before=state.paths.size+state.unchecked.size;attempted+=(await this.flush(key)) || 0;
      if(state.paths.size+state.unchecked.size>=before) throw new Error('待更新索引仍未完成，请检查源码和索引状态');
    }
    return {attempted};
  }
  async drain() {
    for(const [key,state] of this.projects) {
      clearTimeout(state.timer);state.timer=undefined;
      if(state.running) await new Promise(resolve=>state.waiters.push(resolve));
      while(state.paths.size || state.unchecked.size) {
        const before=state.paths.size+state.unchecked.size;await this.flush(key);
        if(state.paths.size+state.unchecked.size>=before) throw new Error(`项目 ${key} 的源码索引更新尚未完成`);
      }
    }
    await this.persistTail;
  }
  async markIndexed(key) {
    const state=this.projects.get(key);if(!state || state.running) return;
    clearTimeout(state.timer);state.timer=undefined;state.paths.clear();state.attempts=0;await this.persist();
    if(state.unchecked.size) state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},this.delay);
  }
  async reset() {await this.drain();this.projects.clear();await this.persist();}
  async close() {
    if(this.closing) return this.closing;
    this.disposed=true;for(const state of this.projects.values()) clearTimeout(state.timer);
    this.closing=(async()=>{await Promise.all([...this.projects.values()].filter(state=>state.running).map(state=>new Promise(resolve=>state.waiters.push(resolve))));await this.persist();})();
    return this.closing;
  }
  dispose(){void this.close().catch(error=>this.onError('',error));}
}
module.exports={ApiSourceWatcher,RECOVERY_KEY,sourcePathAllowed};
