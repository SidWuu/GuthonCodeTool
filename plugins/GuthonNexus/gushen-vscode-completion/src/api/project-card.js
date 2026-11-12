const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const actions=Object.freeze({pull:'pullApiSource',upload:'uploadApiSource'});
function escapeHtml(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function cardModel(workspace,status,authentication={authenticated:true,session:status.lastLogin}) {
  const files=(status.files||[]).filter(file=>file.inScope!==false);
  const session=authentication.session||status.lastLogin;
  return {authenticated:authentication.authenticated,key:workspace.workspaceKey,project:workspace.name||workspace.displayName||workspace.workspaceKey,
    version:session?.mainVersion?`${session.mainVersion}@${session.dateVersion}`:'登录后显示',
    address:status.settings.serverUrl||'',user:session?.userName||'',
    scope:status.settings.allSystems?'全部子系统':`${status.settings.systemIds.length} 个子系统`,
    sourceCount:files.length,changed:files.filter(file=>file.state!=='CLEAN').length,
    canPull:!!status.settings.serverUrl&&(status.settings.allSystems||status.settings.systemIds.length>0),
    canUpload:files.some(file=>file.state==='MODIFIED'&&!file.readonly)};
}
function projectCardHtml(model,{nonce=crypto.randomBytes(18).toString('base64'),css='',form={}}={}) {
  const e=escapeHtml;
  const row=(label,value)=>`<div class="metadata-row"><dt>${label}</dt><dd title="${e(value)}">${e(value)}</dd></div>`;
  let content='<div class="empty">添加项目并打开其源码目录后，显示当前项目详情。</div>';
  if(model?.authenticated) {
    content=`<section aria-label="当前项目详情" class="project-card"><dl>${row('项目',model.project)}${row('版本',model.version)}${row('地址',model.address)}${row('用户',model.user)}</dl></section>
<div class="primary-actions"><button data-action="pull" ${model.canPull?'':'disabled'} title="${model.canPull?'拉取当前范围源码':'请先从项目节点选择需要拉取的子系统'}">更新源码</button><button class="secondary" data-action="upload" ${model.canUpload?'':'disabled'}>上传代码</button></div>
<div class="source-summary" aria-label="当前拉取范围"><span>${e(model.scope)}</span><span>${model.sourceCount} 源码</span><span class="${model.changed?'has-changes':''}">${model.changed} 修改</span></div>`;
  } else if(model) {
    const captcha=typeof form.captcha==='string'&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(form.captcha)?form.captcha:'';
    content=`<section class="project-card login-card"><h2>登录到项目 [${e(model.project)}]</h2><form id="login-form">
<label class="field-label" for="server-url">谷神开发平台地址</label><input id="server-url" name="serverUrl" type="url" placeholder="谷神开发平台地址" value="${e(form.serverUrl??model.address)}" autocomplete="url" required>
<label class="field-label" for="account">账号</label><input id="account" name="userId" placeholder="账号" value="${e(form.userId||'')}" autocomplete="username" required>
<div class="password-row"><label class="field-label" for="password">密码</label><input id="password" name="password" type="password" placeholder="密码" autocomplete="current-password" required><label class="remember"><input id="remember" type="checkbox" ${form.remember?'checked':''}>保存密码</label></div>
${captcha?`<div class="captcha-row"><input id="captcha" placeholder="验证码" aria-label="验证码" required><img alt="登录验证码" src="${e(captcha)}"></div>`:''}
<button class="login-submit" type="submit">登录</button></form></section>`;
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; script-src 'nonce-${nonce}'"><style nonce="${nonce}">${css}</style></head><body>${content}
<div id="status" class="status" role="status" aria-live="polite">${e(form.error||'')}</div><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),workspaceKey=${JSON.stringify(model?.key||'').replace(/</g,'\\u003c')};
for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>vscode.postMessage({action:button.dataset.action,workspaceKey}));
document.getElementById('login-form')?.addEventListener('submit',event=>{
 event.preventDefault();const form=event.currentTarget;
 vscode.postMessage({action:'submitLogin',workspaceKey,serverUrl:document.getElementById('server-url').value,userId:document.getElementById('account').value,password:document.getElementById('password').value,remember:document.getElementById('remember').checked,randCode:document.getElementById('captcha')?.value||''});
 for(const input of form.querySelectorAll('input,button'))input.disabled=true;
 document.getElementById('status').textContent='正在登录…';
});
window.addEventListener('message',event=>{if(event.data?.type==='status')document.getElementById('status').textContent=event.data.message||'';});
</script></body></html>`;
}
class ProjectCardProvider {
  constructor({vscode,context,api,getWorkspaces}) {
    Object.assign(this,{vscode,context,api,getWorkspaces});this.generation=0;this.disposables=[];this.form={};
    this.css=fs.readFileSync(path.join(context.extensionPath,'src/api/project-card.css'),'utf8');
  }
  resolveWebviewView(view) {
    this.view=view;this.lastSignature=undefined;view.webview.options={enableScripts:true};
    this.disposables.push(view.webview.onDidReceiveMessage(async message=>{
      if(!this.currentKey||message?.workspaceKey!==this.currentKey)return;
      const key=this.currentKey;
      if(message?.action==='submitLogin') {
        if(this.loginPending)return;
        this.loginPending=true;this.form={serverUrl:message.serverUrl,userId:message.userId,remember:message.remember};
        try {
          await this.api.run(key,'configure',{serverUrl:message.serverUrl});
          await this.api.run(key,'login',{userId:message.userId,password:message.password,randCode:message.randCode,remember:message.remember});
          this.form={};await this.api.refreshWorkspace?.(key);
        } catch(error) {
          this.form.error=error.message;
          if(/验证码|captcha|randCode/i.test(error.message)) {
            try {this.form.captcha=(await this.api.run(key,'captcha')).dataURL;} catch(captchaError) {this.form.error=captchaError.message;}
          }
        } finally {message.password='';this.loginPending=false;this.lastSignature=undefined;await this.refresh();}
        return;
      }
      if(!Object.hasOwn(actions,message?.action))return;
      try {await this.vscode.commands.executeCommand('gushenCompletion.'+actions[message.action],key);await this.refresh();}
      catch(error) {await view.webview.postMessage({type:'status',message:error.message});}
    }));
    if(view.onDidChangeVisibility)this.disposables.push(view.onDidChangeVisibility(()=>{if(view.visible)void this.refresh();}));
    if(view.onDidDispose)this.disposables.push(view.onDidDispose(()=>{if(this.view===view)this.view=null;}));
    void this.refresh();
  }
  async refresh() {
    if(!this.view||this.loginPending)return;
    const generation=++this.generation;
    try {
      const workspaces=await this.getWorkspaces();
      if(generation!==this.generation)return;
      const workspace=workspaces.length===1?workspaces[0]:undefined;
      if(workspace?.workspaceKey!==this.currentKey){this.form={};this.lastSignature=undefined;}
      const state=workspace?await this.api.run(workspace.workspaceKey,'status'):undefined;
      const authentication=workspace?await this.api.run(workspace.workspaceKey,'session'):undefined;
      if(authentication?.error)this.form={...this.form,error:authentication.error.message};
      if(generation!==this.generation||!this.view)return;
      this.currentKey=workspace?.workspaceKey;
      const model=workspace?cardModel(workspace,state,authentication):undefined;
      const signature=JSON.stringify({model:model?.authenticated?model:model?{authenticated:false,key:model.key,project:model.project,address:model.address}:null,form:this.form});
      if(signature===this.lastSignature)return;
      this.lastSignature=signature;
      this.view.webview.html=projectCardHtml(model,{css:this.css,form:this.form});
    } catch(error) {
      if(generation!==this.generation||!this.view)return;
      this.currentKey=undefined;this.view.webview.html=projectCardHtml(undefined,{css:this.css,form:{error:error.message}});
    }
  }
  dispose(){this.generation++;for(const disposable of this.disposables)disposable.dispose();this.disposables=[];this.view=null;this.form={};}
}
function registerProjectCard(options) {
  const provider=new ProjectCardProvider(options);
  const registration=options.vscode.window.registerWebviewViewProvider('gushenCompletion.projectDetails',provider);
  return {refresh:()=>provider.refresh(),dispose:()=>{provider.dispose();registration.dispose();}};
}
module.exports={registerProjectCard,ProjectCardProvider,cardModel,projectCardHtml,escapeHtml};
