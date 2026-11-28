const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {formatSourceDatabaseUrl}=require('../project-source-settings');

const actions=Object.freeze({pull:'gushenCompletion.pullApiSource',upload:'gushenCompletion.uploadApiSource',
  search:'gushenCompletion.searchCurrentApiWorkspace',changes:'workbench.view.scm',history:'gushenCompletion.showProjectHistory',
  scope:'gushenCompletion.selectApiSystems',index:'gushenCompletion.showProjectIndex',doctor:'gushenCompletion.showProjectChecks'});
function escapeHtml(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function needsSourceLogin(workspace) {
  return workspace.executionReady===true && workspace.sourceConnection?.ready===false;
}
function cardModel(workspace,status={},authentication={authenticated:true,session:status.lastLogin}) {
  const sourceMode=workspace.sourceMode || 'api';
  if(sourceMode!=='api') {
    const summary=workspace.sourceSummary || {};
    const connection=workspace.sourceConnection;
    const scope=summary.allSystems ? '全部子系统'
      : Number.isInteger(summary.systemCount) ? `${summary.systemCount} 个子系统`
      : summary.wholeRepository ? '整个授权仓库'
      : summary.directoryCount ? `${summary.directoryCount} 个目录` : '同步范围待配置';
    return {key:workspace.workspaceKey,project:workspace.name || workspace.displayName || workspace.workspaceKey,
      sourceMode,root:workspace.root,index:workspace.index,executionReady:workspace.executionReady===true,
      needsLogin:needsSourceLogin(workspace),
      address:sourceMode==='database' ? formatSourceDatabaseUrl(connection?.connection) : connection?.repositoryUrl,
      user:sourceMode==='database' ? connection?.connection?.username : connection?.username,
      scope,sourceCount:summary.sourceCount ?? null,changed:status.changedCount ?? summary.changedCount ?? null,
      canPull:sourceMode==='svn'
        ? !!(workspace.capabilities?.['svn.refresh'] || workspace.capabilities?.['svn.initialize'])
          && (workspace.checkoutLayout!=='manifest-working-copies' || workspace.scopeConfigReady!==false || workspace.scopeManifestReady)
        : !!workspace.datasourceReady && workspace.databaseScopeReady!==false,
      canConfigureScope:workspace.configuration?.schemaVersion===3
        && (sourceMode==='database' || workspace.checkoutLayout==='manifest-working-copies'),
      canUpload:sourceMode==='database' || (workspace.checkoutLayout==='manifest-working-copies' && workspace.capabilities?.['svn.platform_save']===true)};
  }
  const files=(status.files||[]).filter(file=>file.inScope!==false);
  const session=authentication.session||status.lastLogin;
  const scope=status.pendingScope || status.settings;
  const scopeLabel=scope.allSystems?'全部子系统':`${scope.systemIds.length} 个子系统`;
  return {sourceMode,authenticated:authentication.authenticated,pending:authentication.pending===true,key:workspace.workspaceKey,project:workspace.name||workspace.displayName||workspace.workspaceKey,
    version:session?.mainVersion?`${session.mainVersion}@${session.dateVersion}`:'登录后显示',
    address:status.settings.serverUrl||'',user:session?.userName||'',loginId:status.loginId,
    scope:status.pendingScope?`${scopeLabel}（待更新）`:scopeLabel,
    sourceCount:status.summary?.sourceCount ?? files.length,changed:status.summaryComplete===false ? null : status.summary?.changedCount ?? files.filter(file=>file.state!=='CLEAN').length,
    canPull:!!status.settings.serverUrl&&(scope.allSystems||scope.systemIds.length>0),
    canUpload:status.summaryComplete===false || (status.summary ? status.summary.uploadableCount>0 : files.some(file=>file.state==='MODIFIED'&&!file.readonly))};
}
function projectCardHtml(model,{nonce=crypto.randomBytes(18).toString('base64'),css='',form={}}={}) {
  const e=escapeHtml;
  const row=(label,value)=>`<div class="metadata-row"><dt>${label}</dt><dd title="${e(value)}">${e(value)}</dd></div>`;
  const tool=(action,label,icon,enabled=true)=>`<button data-action="${action}"${enabled?'':' disabled'}><svg aria-hidden="true" focusable="false" viewBox="0 0 16 16">${icon}</svg><span>${label}</span></button>`;
  let content='<div class="empty">请从项目总览选择当前窗口的工作区；尚未添加时可先添加工作区。</div>';
  if(model?.kind==='setup') {
    content=`<section class="project-card diagnostic-card" aria-label="设置谷神工作区"><h2>${e(model.title)}</h2><p>${e(model.message)}</p>${model.workspaceRoot ? `<p title="${e(model.workspaceRoot)}"><strong>开发目录</strong><br>${e(model.workspaceRoot)}</p>` : ''}${model.directory ? `<p title="${e(model.directory)}">${model.workspaceRoot ? '数据目录<br>' : ''}${e(model.directory)}</p>` : ''}</section><div class="primary-actions${model.action ? '' : ' single-action'}">${model.action ? `<button data-action="setupCurrent">${e(model.action)}</button>` : ''}<button ${model.action?'class="secondary" ':''}data-action="setupBrowse">${model.action?'连接已有数据目录':'选择数据目录'}</button></div>`;
  } else if(model?.kind==='diagnostic') {
    content=`<section class="project-card diagnostic-card" aria-label="配置诊断"><h2>${e(model.project)}</h2><p>${e(model.message)}</p>${model.directory ? `<p title="${e(model.directory)}">${e(model.directory)}</p>` : ''}<p class="diagnostic-code">${e(model.code)}</p></section><div class="primary-actions"><button data-action="configuration">检查配置文件</button><button class="secondary" data-action="refresh">刷新项目</button></div>`;
  } else if(model && !model.needsLogin && (model.sourceMode!=='api' || model.authenticated || model.pending)) {
    const mode=model.sourceMode.toUpperCase(),legacy=mode!=='API';
    const ready=!legacy || model.executionReady;
    const details=legacy ? (model.address ? row('地址',model.address) : '')+(model.user ? row('用户',model.user) : '')+row('目录',model.root)
      : row('版本',model.version)+row('地址',model.address)+row('用户',model.user);
    const sourceLabel=model.sourceCount==null ? (model.index?.ready?'源码待检查':'索引待建立') : model.sourceCount+' 源码';
    const uploadLabel=mode==='SVN'?'提交 SVN':mode==='DATABASE'?'上传源码':'上传代码';
    const pullHint=model.pending?'正在核验登录状态':model.canPull?'拉取当前范围源码':'请检查项目连接和同步范围';
    content=`<section aria-label="当前项目详情" class="project-card"><dl>${row('项目',model.project)}${row('同步',mode)}${details}</dl></section>
<div class="primary-actions"><button data-action="pull" ${ready&&model.canPull&&!model.pending?'':'disabled'} title="${pullHint}">更新源码</button><button class="secondary" data-action="upload" ${ready&&model.canUpload&&!model.pending?'':'disabled'}>${uploadLabel}</button></div>
<div class="source-summary" aria-label="当前拉取范围"><span>${e(model.scope)}</span><span>${e(sourceLabel)}</span><span title="最近一次源码状态检查结果" class="${model.changed?'has-changes':''}">${model.changed==null?'修改待检查':e(model.changed)+' 修改'}</span></div>
<nav class="project-tools" aria-label="项目常用操作">
${tool('search','搜索源码','<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',ready)}
${tool('changes','本地修改','<path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v4h3M5.5 8h5m-5 3h5"/>',ready)}
${tool('history','操作记录','<path d="M2 3.5v4h4M2.2 7A6 6 0 1 1 3.5 12M8 4.5V8l2.5 1.5"/>',ready)}
${tool('scope','同步范围','<path d="m1.5 3 1 1 2-2m-3 6 1 1 2-2m-3 6 1 1 2-2M7 3h7M7 8h7m-7 5h7"/>',!legacy || (ready && model.canConfigureScope))}
${tool('index','索引管理','<ellipse cx="8" cy="3.5" rx="5" ry="2"/><path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',ready)}
${tool('doctor','环境检查','<path d="M1 8h3l2-5 4 10 2-5h3"/>')}
</nav>${ready?'':`<p class="provider-notice">此版本尚未接入 ${e(mode)} 源码操作</p>`}`;
  } else if(model) {
    const api=model.sourceMode==='api';
    const addressLabel=api?'谷神开发平台地址':model.sourceMode==='database'?'数据库连接地址':'SVN 仓库地址';
    const addressHint=model.sourceMode==='database'?'mysql://服务器:3306/数据库名':addressLabel;
    const userLabel=api?'账号':'用户名';
    const captcha=api&&typeof form.captcha==='string'&&/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(form.captcha)?form.captcha:'';
    content=`<section class="project-card login-card"><h2>登录到项目 [${e(model.project)}]</h2><form id="login-form">
<label class="field-label" for="server-url">${addressLabel}</label><input id="server-url" name="serverUrl" type="url" placeholder="${addressHint}" value="${e(form.serverUrl??model.address)}" autocomplete="url" required>
<label class="field-label" for="account">${userLabel}</label><input id="account" name="userId" placeholder="${userLabel}" value="${e(form.userId??(api?model.loginId:model.user)??'')}" autocomplete="username" required>
<div class="password-row"><label class="field-label" for="password">密码</label><input id="password" name="password" type="password" placeholder="密码" autocomplete="current-password" required>${api?`<label class="remember"><input id="remember" type="checkbox" ${form.remember?'checked':''}>保存密码</label>`:''}</div>
${captcha?`<div class="captcha-row"><input id="captcha" placeholder="验证码" aria-label="验证码" required><img alt="登录验证码" src="${e(captcha)}"></div>`:''}
<button class="login-submit" type="submit"${api?'':' title="验证连接并将密码保存到系统凭据库"'}>登录</button></form></section>`;
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; script-src 'nonce-${nonce}'"><style nonce="${nonce}">${css}</style></head><body>${content}
<div id="status" class="status" role="status" aria-live="polite">${e(form.error||(model?.pending?'正在核验登录状态…':''))}</div><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),workspaceKey=${JSON.stringify(model?.key||'').replace(/</g,'\\u003c')};
for(const button of document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>vscode.postMessage({action:button.dataset.action,workspaceKey}));
document.getElementById('login-form')?.addEventListener('submit',event=>{
 event.preventDefault();const form=event.currentTarget;
 vscode.postMessage({action:'submitLogin',workspaceKey,serverUrl:document.getElementById('server-url').value,userId:document.getElementById('account').value,password:document.getElementById('password').value,remember:document.getElementById('remember')?.checked===true,randCode:document.getElementById('captcha')?.value||''});
 for(const input of form.querySelectorAll('input,button'))input.disabled=true;
 document.getElementById('status').textContent='正在登录…';
});
window.addEventListener('message',event=>{if(event.data?.type==='status')document.getElementById('status').textContent=event.data.message||'';});
</script></body></html>`;
}
class ProjectCardProvider {
  constructor({vscode,context,api,getWorkspaces,getDiagnostic=()=>undefined,getSetup=()=>undefined,onSummary,onLegacyAction,onLegacyLogin}) {
    Object.assign(this,{vscode,context,api,getWorkspaces,getDiagnostic,getSetup,onSummary,onLegacyAction,onLegacyLogin});this.generation=0;this.disposables=[];this.form={};this.authentication=new Map();
    this.legacyStatus=new Map();
    this.css=fs.readFileSync(path.join(context.extensionPath,'src/api/project-card.css'),'utf8');
  }
  resolveWebviewView(view) {
    this.view=view;this.lastSignature=undefined;view.webview.options={enableScripts:true};
    this.disposables.push(view.webview.onDidReceiveMessage(async message=>{
      if(this.setup) {
        const action=message?.action;
        if(action==='setupBrowse' || action==='setupCurrent' && this.setup.directory) {
          await this.vscode.commands.executeCommand('gushenCompletion.setupTool',action==='setupCurrent'?'current':'browse');
        }
        return;
      }
      if(this.diagnostic) {
        if(message?.workspaceKey!==(this.diagnostic.workspaceKey || ''))return;
        const command={configuration:'gushenCompletion.openProjectConfiguration',refresh:'gushenCompletion.refreshProjects'}[message.action];
        if(command)await this.vscode.commands.executeCommand(command,this.diagnostic.workspaceKey || '');
        return;
      }
      if(!this.currentKey||message?.workspaceKey!==this.currentKey)return;
      const key=this.currentKey;
      const workspace=this.currentWorkspace, legacy=workspace?.sourceMode && workspace.sourceMode!=='api';
      if(message?.action==='submitLogin') {
        if(this.loginPending===key || (legacy && (!this.onLegacyLogin || !needsSourceLogin(workspace))))return;
        this.loginPending=key;this.generation++;this.form={serverUrl:message.serverUrl,userId:message.userId,remember:message.remember};
        try {
          if(legacy) await this.onLegacyLogin(workspace,{serverUrl:message.serverUrl,userId:message.userId,password:message.password});
          else {
            await this.api.run(key,'configure',{serverUrl:message.serverUrl});
            const result=await this.api.run(key,'login',{userId:message.userId,password:message.password,randCode:message.randCode,remember:message.remember});
            this.authentication.set(key,{authenticated:true,session:result.session});
            void this.api.refreshWorkspace?.(key).catch(error=>this.vscode.window.showErrorMessage?.(`源码状态刷新失败：${error.message}`));
          }
          if(this.currentKey===key)this.form={};
        } catch(error) {
          if(this.currentKey===key) {
            this.form.error=error.message;
            if(!legacy && /验证码|captcha|randCode/i.test(error.message)) {
              try {const captcha=(await this.api.run(key,'captcha')).dataURL;if(this.currentKey===key)this.form.captcha=captcha;} catch(captchaError) {if(this.currentKey===key)this.form.error=captchaError.message;}
            }
          }
        } finally {message.password='';if(this.loginPending===key)this.loginPending=undefined;this.lastSignature=undefined;await this.refresh();}
        return;
      }
      if(legacy && message.action!=='index') {
        if(needsSourceLogin(workspace)) return;
        if(workspace.executionReady===true && this.onLegacyAction && Object.hasOwn(actions,message.action)) {
          return this.onLegacyAction(workspace,message.action);
        }
        const command=message.action==='doctor'?'gushenCompletion.runDoctor':undefined;
        if(command)await this.vscode.commands.executeCommand(command,key);
        return;
      }
      if(!Object.hasOwn(actions,message?.action))return;
      const command=actions[message.action];
      try {await this.vscode.commands.executeCommand(command,...(command.startsWith('gushenCompletion.')?[key]:[]));await this.refresh();}
      catch(error) {if(this.currentKey===key)await view.webview.postMessage({type:'status',message:error.message});}
    }));
    if(view.onDidChangeVisibility)this.disposables.push(view.onDidChangeVisibility(()=>{if(view.visible)void this.refresh();}));
    if(view.onDidDispose)this.disposables.push(view.onDidDispose(()=>{if(this.view===view)this.view=null;}));
    void this.refresh();
  }
  async refresh() {
    if(!this.view)return;
    const generation=++this.generation;
    let workspace,state;
    try {
      this.setup=this.getSetup();
      if(this.setup) {this.currentKey=undefined;this.currentWorkspace=undefined;this.diagnostic=undefined;this.form={};this.render();return;}
      this.diagnostic=await this.getDiagnostic();
      if(generation!==this.generation || !this.view)return;
      if(this.diagnostic) {this.currentKey=undefined;this.currentWorkspace=undefined;this.form={};this.render();return;}
      const workspaces=await this.getWorkspaces();
      if(generation!==this.generation)return;
      workspace=workspaces.length===1?workspaces[0]:undefined;
      if(workspace?.workspaceKey!==this.currentKey){this.form={};this.lastSignature=undefined;}
      this.currentKey=workspace?.workspaceKey;
      this.currentWorkspace=workspace;
      if(workspace?.sourceMode && workspace.sourceMode!=='api') {this.render(workspace,{});return;}
      state=workspace?await (this.api.readProjectSummary ? this.api.readProjectSummary(workspace.workspaceKey) : this.api.run(workspace.workspaceKey,'status')):undefined;
      if(generation!==this.generation||!this.view)return;
      this.currentKey=workspace?.workspaceKey;
      if(workspace)this.onSummary?.(workspace.workspaceKey,state);
      this.render(workspace,state,workspace ? this.authentication.get(workspace.workspaceKey)||{authenticated:false,pending:true} : undefined);
      if(this.api.sourceUpdateInProgress?.())return;
      let authentication=workspace?await this.api.run(workspace.workspaceKey,'session'):undefined;
      if(generation!==this.generation||!this.view)return;
      const cached=workspace&&this.authentication.get(workspace.workspaceKey);
      if(authentication?.error && cached?.authenticated && ['API_CONNECTION_FAILED','API_HTTP_ERROR','API_TLS_CERTIFICATE_ERROR'].includes(authentication.error.code)) {
        this.form={...this.form,error:authentication.error.message};authentication={...cached,pending:true,error:authentication.error};
      }
      if(workspace)this.authentication.set(workspace.workspaceKey,authentication);
      if(authentication?.authenticated&&!authentication.pending)this.form={};
      else if(authentication?.error)this.form={...this.form,error:authentication.error.message};
      this.render(workspace,state,authentication);
    } catch(error) {
      if(generation!==this.generation||!this.view)return;
      this.form={...this.form,error:error.message};
      this.currentKey=state?workspace?.workspaceKey:undefined;
      const cached=workspace&&this.authentication.get(workspace.workspaceKey);
      const pending=cached?.authenticated && ['API_SOURCE_UPDATE_RUNNING','TOOLHOST_QUEUE_TIMEOUT','API_CONNECTION_FAILED','TOOLHOST_TIMEOUT'].includes(error.code);
      this.render(state?workspace:undefined,state,pending?{...cached,pending:true}:{authenticated:false});
    }
  }
  updateLegacyStatus(workspace,status) {
    if(!workspace || !Array.isArray(status?.changes))return;
    const binding=workspace.workspaceBinding?.digest || workspace.root;
    this.legacyStatus.set(workspace.workspaceKey,{binding,changedCount:status.changes.length});
    if(this.view && this.currentWorkspace?.workspaceKey===workspace.workspaceKey) this.render(this.currentWorkspace);
  }
  render(workspace,state,authentication) {
    if(workspace?.sourceMode==='svn') {
      const current=this.legacyStatus.get(workspace.workspaceKey);
      if(current && current.binding===(workspace.workspaceBinding?.digest || workspace.root)) state={changedCount:current.changedCount};
    }
    const model=this.setup?{kind:'setup',...this.setup}:this.diagnostic?{kind:'diagnostic',key:this.diagnostic.workspaceKey || '',project:this.diagnostic.name || this.diagnostic.workspaceKey || '配置异常',message:this.diagnostic.message,directory:this.diagnostic.directory,code:this.diagnostic.code}:workspace?cardModel(workspace,state,authentication):undefined;
    const signature=JSON.stringify({model:model?.kind==='diagnostic'||model?.sourceMode!=='api'||model?.authenticated||model?.pending?model:model?{authenticated:false,key:model.key,project:model.project,address:model.address,loginId:model.loginId}:null,form:this.form});
    if(signature===this.lastSignature)return;
    this.lastSignature=signature;
    this.view.webview.html=projectCardHtml(model,{css:this.css,form:this.form});
  }
  invalidate(){this.generation++;this.currentKey=undefined;this.currentWorkspace=undefined;this.diagnostic=undefined;this.setup=undefined;this.form={};this.lastSignature=undefined;}
  clearSelection(){this.invalidate();if(this.view)this.render();}
  dispose(){this.generation++;for(const disposable of this.disposables)disposable.dispose();this.disposables=[];this.view=null;this.form={};this.authentication.clear();this.legacyStatus.clear();}
}
function registerProjectCard(options) {
  const provider=new ProjectCardProvider(options);
  const registration=options.vscode.window.registerWebviewViewProvider('gushenCompletion.projectDetails',provider);
  return {refresh:()=>provider.refresh(),invalidate:()=>provider.invalidate(),clearSelection:()=>provider.clearSelection(),
    updateLegacyStatus:(workspace,status)=>provider.updateLegacyStatus(workspace,status),
    dispose:()=>{provider.dispose();registration.dispose();}};
}
module.exports={registerProjectCard,ProjectCardProvider,cardModel,projectCardHtml,escapeHtml};
