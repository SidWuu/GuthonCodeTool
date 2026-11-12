const path=require('node:path');
const RECOVERY_KEY='guthon.api.indexRecovery';

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
    const state={root:absolute,paths:new Set(saved?.root===absolute && Array.isArray(saved.paths) ? saved.paths.filter(p=>typeof p==='string' && p) : []),running:false,waiters:[],attempts:0};
    this.projects.set(key,state);delete this.recovered[key];
    if(state.paths.size) state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},this.delay);
  }
  persist() {
    if(!this.workspaceState) return Promise.resolve();
    this.persistTail=this.persistTail.catch(()=>{}).then(()=>{
      const data={...this.recovered};for(const [key,state] of this.projects) if(state.root) {
        if(state.paths.size || state.inflight?.length) data[key]={root:state.root,paths:[...new Set([...(state.inflight || []),...state.paths])]};else delete data[key];
      }
      return Promise.resolve(this.workspaceState.update(RECOVERY_KEY,data)).then(()=>{this.recovered=data;});
    });
    return this.persistTail;
  }
  enqueue(key,sourcePath) {
    if(this.disposed) return;
    let state=this.projects.get(key);if(!state) {state={paths:new Set(),running:false,waiters:[],attempts:0};this.projects.set(key,state);}
    state.paths.add(sourcePath);void this.persist().catch(error=>this.onError(key,error));
    if(state.attempts>=this.retryDelays.length+1) return;
    clearTimeout(state.timer);state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},this.delay);
  }
  async flush(key) {
    const state=this.projects.get(key);if(!state || state.running || this.disposed) return;
    clearTimeout(state.timer);state.timer=undefined;state.running=true;
    const paths=[...state.paths].slice(0,this.batchSize);for(const p of paths) state.paths.delete(p);state.inflight=paths;
    let failed=false;
    try {
      const status=await this.run(key,'status');const known=new Set((status.files || []).filter(item=>item.inScope!==false).map(item=>item.path));
      const selected=paths.filter(p=>known.has(p));
      if(selected.length) {const result=await this.run(key,'index',{paths:selected});try {await this.onChanged(key,selected,result);} catch(error) {this.onError(key,error);}}
      state.attempts=0;
    } catch(error) {
      failed=true;for(const p of paths) state.paths.add(p);state.attempts++;
      if(state.attempts===1 || state.attempts>this.retryDelays.length) this.onError(key,error);
    } finally {
      state.inflight=undefined;state.running=false;for(const resolve of state.waiters.splice(0)) resolve();
      await this.persist().catch(error=>this.onError(key,error));
      if(!this.disposed && state.paths.size && !state.timer) {
        const wait=failed ? this.retryDelays[state.attempts-1] : this.delay;
        if(wait!==undefined) state.timer=setTimeout(()=>{state.timer=undefined;void this.flush(key);},wait);
      } else if(!state.root && !state.paths.size && !state.timer) this.projects.delete(key);
    }
  }
  recovery(key) {
    const state=this.projects.get(key);return state ? {paths:[...new Set([...(state.inflight || []),...state.paths])],running:state.running,attempts:state.attempts} : {paths:[],running:false,attempts:0};
  }
  async retry(key) {
    const state=this.projects.get(key);if(!state) return {attempted:0};
    clearTimeout(state.timer);state.timer=undefined;
    if(state.running) await new Promise(resolve=>state.waiters.push(resolve));
    const attempted=state.paths.size;state.attempts=0;
    while(state.paths.size) {
      const before=state.paths.size;await this.flush(key);
      if(state.paths.size>=before) throw new Error('待更新索引仍未完成，请检查源码和索引状态');
    }
    return {attempted};
  }
  async drain() {
    for(const [key,state] of this.projects) {
      clearTimeout(state.timer);state.timer=undefined;
      if(state.running) await new Promise(resolve=>state.waiters.push(resolve));
      while(state.paths.size) {
        const before=state.paths.size;await this.flush(key);
        if(state.paths.size>=before) throw new Error(`项目 ${key} 的源码索引更新尚未完成`);
      }
    }
    await this.persistTail;
  }
  async markIndexed(key) {
    const state=this.projects.get(key);if(!state || state.running) return;
    clearTimeout(state.timer);state.timer=undefined;state.paths.clear();state.attempts=0;await this.persist();
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
module.exports={ApiSourceWatcher,RECOVERY_KEY};
