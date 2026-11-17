const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ACTIONS=new Set(['systems','data-sources','system-menu','create-function','sync-database','platform-request','module-upload']);
const descriptorName=key=>'session-'+crypto.createHash('sha256').update(key).digest('hex')+'.json';

class McpSessionHost {
  constructor({run}) {this.run=run;this.keys=new Set();this.files=new Map();this.token=crypto.randomBytes(32).toString('hex');}
  sync(home,keys) {
    this.tail=(this.tail || Promise.resolve()).catch(()=>{}).then(()=>this.synchronize(home,keys));
    return this.tail;
  }
  async synchronize(home,keys) {
    if(this.closed)return;
    const nextHome=path.resolve(home);
    if(this.home && this.home!==nextHome)throw new Error('MCP 会话需要先关闭旧数据目录');
    this.home=nextHome;
    if(!this.server) {
      this.server=http.createServer((request,response)=>{void this.handle(request,response);});
      await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
      this.server.unref();
    }
    const selected=new Set(keys);
    for(const [key,file] of this.files)if(!selected.has(key)){this.remove(file);this.files.delete(key);}
    this.keys=selected;
    const directory=path.join(this.home,'var','nexus','mcp');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    for(const key of selected)if(!this.files.has(key)) {
      const file=path.join(directory,descriptorName(key));
      const value={schemaVersion:1,workspaceKey:key,url:`http://127.0.0.1:${this.server.address().port}/mcp-api`,token:this.token,pid:process.pid};
      const temporary=file+'.'+crypto.randomUUID()+'.tmp';
      fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});
      fs.renameSync(temporary,file);this.files.set(key,file);
    }
  }
  async handle(request,response) {
    const send=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    if(request.method!=='POST' || request.url!=='/mcp-api' || request.headers.origin || request.headers.authorization!==`Bearer ${this.token}`) {
      request.resume();send(403,{error:{code:'API_MCP_SESSION_REJECTED',message:'MCP 会话请求未授权'}});return;
    }
    try {
      const chunks=[];let size=0;
      for await(const chunk of request) {size+=chunk.length;if(size>1048576)throw new Error('MCP 请求过大');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!this.keys.has(body.workspaceKey) || !ACTIONS.has(body.action) || !body.input || typeof body.input!=='object' || Array.isArray(body.input))throw new Error('MCP 项目、动作或参数无效');
      const result=await this.run(body.workspaceKey,body.action,body.input);
      send(200,{result});
    } catch(error) {send(400,{error:{code:error.code || 'API_MCP_SESSION_FAILED',message:error.message}});}
  }
  remove(file) {
    try {const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.token===this.token)fs.unlinkSync(file);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async close() {
    this.closed=true;await this.tail;this.keys.clear();for(const file of this.files.values())this.remove(file);this.files.clear();
    if(this.server){const server=this.server;this.server=undefined;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }
}
module.exports={McpSessionHost,descriptorName,ACTIONS};
