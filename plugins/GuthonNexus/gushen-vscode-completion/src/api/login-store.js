const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {isWorkspaceKey}=require('../workspace-identity');

function credentialScope({toolHome,workspaceKey,serverUrl}) {
  if(!path.isAbsolute(toolHome || '') || !isWorkspaceKey(workspaceKey)) throw new Error('登录信息缺少明确的本地目录或项目身份');
  const url=new URL(serverUrl);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('登录信息的平台地址无效');
  return crypto.createHash('sha256').update(JSON.stringify([path.resolve(toolHome),workspaceKey,url.href.replace(/\/$/,'')])).digest('hex');
}

class ApiLoginStore {
  constructor(storageRoot) {this.directory=storageRoot ? path.join(storageRoot,'api-login') : undefined;this.canRestore=!!storageRoot;}
  file(scope) {
    if(!this.directory) throw new Error('Nexus 本地登录存储不可用，请重新加载插件');
    return path.join(this.directory,credentialScope(scope)+'.json');
  }
  key(create=false) {
    const filename=path.join(this.directory,'encryption.key');
    if(create) {
      fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
      try {fs.writeFileSync(filename,crypto.randomBytes(32),{flag:'wx',mode:0o600});}
      catch(error) {if(error.code!=='EEXIST')throw error;}
    }
    const key=fs.readFileSync(filename);
    if(key.length!==32) throw new Error('本地登录加密密钥无效，请先保留存储文件并检查插件目录');
    return key;
  }
  read(scope) {
    if(!this.directory) return undefined;
    const filename=this.file(scope);
    let data;
    try {data=fs.readFileSync(filename,'utf8');} catch(error) {if(error.code==='ENOENT')return undefined;throw error;}
    try {
      const record=JSON.parse(data),id=credentialScope(scope);
      if(record.version!==1 || record.scope!==id || !/^[a-f0-9]{24}$/.test(record.iv) || !/^[a-f0-9]{32}$/.test(record.tag)
        || typeof record.content!=='string' || !/^[a-f0-9]+$/.test(record.content)) throw new Error('invalid envelope');
      const decipher=crypto.createDecipheriv('aes-256-gcm',this.key(),Buffer.from(record.iv,'hex'));
      decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(record.tag,'hex'));
      const plain=Buffer.concat([decipher.update(Buffer.from(record.content,'hex')),decipher.final()]);
      const value=JSON.parse(plain.toString('utf8'));
      if(typeof value.userId!=='string' || !value.userId.trim() || typeof value.password!=='string' || !value.password) throw new Error('invalid credentials');
      return {userId:value.userId,password:value.password};
    } catch {throw new Error('本地保存的登录信息无法解密，请重新输入账号密码并保存');}
  }
  save(scope,{userId,password}) {
    const filename=this.file(scope),id=credentialScope(scope);
    if(typeof userId!=='string' || !userId.trim() || typeof password!=='string' || !password) throw new Error('保存登录信息需要账号和密码');
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key(true),iv);
    cipher.setAAD(Buffer.from(id));
    const content=Buffer.concat([cipher.update(JSON.stringify({userId,password}),'utf8'),cipher.final()]);
    const value={version:1,scope:id,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),content:content.toString('hex')};
    const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
    try {fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,filename);}
    finally {fs.rmSync(temporary,{force:true});}
  }
  forget(scope) {if(this.directory)fs.rmSync(this.file(scope),{force:true});}
}
module.exports={ApiLoginStore,credentialScope};
