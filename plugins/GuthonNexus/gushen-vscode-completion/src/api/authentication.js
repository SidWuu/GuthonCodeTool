const {credentialScope}=require('./login-store');

class ApiAuthentication {
  constructor({invoke,scopeFor,store,onWarning=()=>{}}) {
    Object.assign(this,{invoke,scopeFor,store,onWarning});this.pending=new Map();this.restoreFailures=new Map();
  }
  serial(key,action) {
    const previous=this.pending.get(key) || Promise.resolve();
    const request=previous.catch(()=>{}).then(action);this.pending.set(key,request);
    void request.then(()=>{if(this.pending.get(key)===request)this.pending.delete(key);},()=>{if(this.pending.get(key)===request)this.pending.delete(key);});
    return request;
  }
  async restoreSession(key) {
    const result=await this.invoke(key,'session',{localOnly:true});
    if(result.authenticated || result.error)return result;
    const scope=await this.scopeFor(key);if(!scope.serverUrl)return result;
    const id=credentialScope(scope);
    const failure=this.restoreFailures.get(id);if(failure)return {...result,error:failure};
    try {
      const saved=this.store.read(scope);if(!saved)return result;
      // Passwords only cross the local process boundary over stdin, never logs or config.
      const logged=await this.invoke(key,'login',saved);
      return {...result,authenticated:true,session:logged.session};
    } catch {
      const failure={code:'API_LOGIN_RESTORE_FAILED',message:'本地登录信息不可用或自动登录未完成，请手动重新登录并保存密码'};
      this.restoreFailures.set(id,failure);return {...result,error:failure};
    }
  }
  async session(key,input) {
    const result=await this.invoke(key,'session',input);
    if(result.authenticated || result.error || this.store.canRestore===false)return result;
    return this.serial(key,()=>this.restoreSession(key));
  }
  async ensure(key) {
    const result=await this.session(key,{localOnly:true});
    if(!result.authenticated) {
      const error=new Error(result.error?.message || '请在当前项目登录后再操作');error.code=result.error?.code || 'API_LOGIN_REQUIRED';throw error;
    }
  }
  login(key,input) {
    return this.serial(key,async()=>{
      const {remember,...credentials}=input;
      if(remember!==undefined && typeof remember!=='boolean')throw new Error('保存密码选项必须为布尔值');
      const scope=await this.scopeFor(key),id=credentialScope(scope);
      this.restoreFailures.set(id,{code:'API_LOGIN_RESTORE_FAILED',message:'请在当前项目手动完成登录'});
      const result=await this.invoke(key,'login',credentials);
      this.restoreFailures.delete(id);
      try {
        if(remember===true)this.store.save(scope,credentials);
        else this.store.forget(scope);
      } catch(error) {await this.onWarning('已登录，但本地保存密码设置未完成：'+error.message);}
      return result;
    });
  }
  logout(key) {
    return this.serial(key,async()=>{
      const scope=await this.scopeFor(key);
      const id=scope.serverUrl ? credentialScope(scope) : undefined;
      if(id)this.restoreFailures.set(id,{code:'API_LOGIN_RESTORE_FAILED',message:'已请求退出登录，请手动登录后再操作'});
      let storageError,sessionError,result;
      try {if(id)this.store.forget(scope);} catch(error) {storageError=error;}
      try {result=await this.invoke(key,'logout');} catch(error) {sessionError=error;}
      if(storageError || sessionError) throw new Error(`退出登录未全部完成：${storageError?'本地保存的登录信息未能删除':'本地保存的登录信息已清除'}；${sessionError?'当前会话清理结果未确认':'当前运行会话已清理'}`);
      if(id)this.restoreFailures.delete(id);
      return result;
    });
  }
}
module.exports={ApiAuthentication};
