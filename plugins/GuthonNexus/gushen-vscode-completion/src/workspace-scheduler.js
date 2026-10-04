class WorkspaceQueue {
  constructor({limit=32, concurrency=4}={}) {
    this.limit=limit;this.concurrency=concurrency;this.size=0;this.active=0;
    this.tails=new Map();this.waiters=[];this.activeKeys=new Set();
  }
  enqueue(key, action) {
    if(this.size>=this.limit)return Promise.reject(new Error('Bridge 命令队列已满，请等待当前任务完成'));
    this.size++;
    const previous=this.tails.get(key)||Promise.resolve();
    const execute=async()=>{
      if(this.active>=this.concurrency)await new Promise(resolve=>this.waiters.push(resolve));
      else this.active++;
      this.activeKeys.add(key);
      try{return await action();}
      finally {
        this.activeKeys.delete(key);this.active--;
        const next=this.waiters.shift();if(next){this.active++;next();}
      }
    };
    const result=previous.then(execute,execute).finally(()=>{this.size--;});
    const tail=result.catch(()=>{});this.tails.set(key,tail);
    void tail.then(()=>{if(this.tails.get(key)===tail)this.tails.delete(key);});
    return result;
  }
}

class WorkspaceToolPool {
  constructor({createClient, limit=8}) {this.createClient=createClient;this.limit=limit;this.clients=new Map();this.closed=false;}
  async request(tool,command,args=[],workspaceKey='',input,options) {
    if(this.closed)throw new Error('ToolHost 池已停止');
    const key=workspaceKey||'__routing__';
    let entry=this.clients.get(key);
    if(!entry) {
      let ready=Promise.resolve();
      if(this.clients.size>=this.limit) {
        const idle=[...this.clients].find(([,value])=>value.inUse===0);
        if(!idle)throw new Error('ToolHost 工作区容量已满，请等待原任务完成');
        this.clients.delete(idle[0]);ready=idle[1].client.stop();
      }
      entry={client:this.createClient(),inUse:0,ready};this.clients.set(key,entry);
    }
    entry.inUse++;
    // Touch insertion order so only the least recently used idle host is evicted.
    this.clients.delete(key);this.clients.set(key,entry);
    try {await entry.ready;if(this.closed)throw new Error("ToolHost 池已停止");return await entry.client.request(tool,command,args,workspaceKey,input,options);}
    catch(error){if(!entry.client.child && this.clients.get(key)===entry)this.clients.delete(key);throw error;}
    finally {entry.inUse--;}
  }
  async stop() {
    this.closed=true;
    const entries=[...this.clients.values()];this.clients.clear();
    const results=await Promise.allSettled(entries.map(async entry=>{try{await entry.ready;}finally{await entry.client.stop();}}));
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }
}
module.exports={WorkspaceQueue,WorkspaceToolPool};
