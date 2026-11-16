const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {cardModel,projectCardHtml,ProjectCardProvider}=require('../src/api/project-card');

test('card layout keeps content inside the sidebar view without clipping rows',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../src/api/project-card.css'),'utf8');
  const views=require('../package.json').contributes.views.guthon;
  const card=views.find(view=>view.id==='gushenCompletion.projectDetails');
  const tree=views.find(view=>view.id==='gushenCompletion.sourceView');
  // 侧栏变窄时按钮文字必须收缩，否则横向滚动条会盖住最后一行按钮。
  assert.match(css,/html,body\{height:100%\}/);
  assert.match(css,/body\{[^}]*overflow-x:hidden/);
  assert.match(css,/\.project-tools button\{[^}]*overflow:hidden/);
  assert.match(css,/\.project-tools span\{[^}]*text-overflow:ellipsis/);
  // 卡片内容（元数据 + 操作 + 常用操作）比源码树的首屏需求高，初始份额不能是 1/4。
  assert.ok(card.initialSize>=2,'project card must reserve more than one share');
  assert.ok(tree.initialSize>=card.initialSize);
});

test('project card counts only current scope and escapes project data',()=>{
  const model=cardModel({workspaceKey:'projects.a',name:'<project>'},{settings:{serverUrl:'https://project.invalid',systemIds:['A'],allSystems:false},
    lastLogin:{userName:'<user>',mainVersion:'3.0.0',dateVersion:'202611120000'},files:[
      {state:'CLEAN',inScope:true},{state:'MODIFIED',inScope:true},{state:'MODIFIED',inScope:false}]});
  assert.equal(model.sourceCount,2);assert.equal(model.changed,1);assert(model.canUpload);
  const html=projectCardHtml(model,{css:'',nonce:'test'});
  assert(html.includes('&lt;project&gt;'));assert(html.includes('&lt;user&gt;'));
  assert(!html.includes('<user>'));assert(html.includes('202611120000'));
  assert(html.includes('data-action="pull"'));assert(html.includes('data-action="upload"'));
});

test('project card keeps full-project counts when status returns changes only',()=>{
  const model=cardModel({workspaceKey:'projects.a',name:'A'},
    {settings:{serverUrl:'https://project.invalid',allSystems:true,systemIds:[]},files:[],
      summary:{sourceCount:16000,changedCount:0,uploadableCount:0}});
  assert.equal(model.sourceCount,16000);assert.equal(model.changed,0);assert.equal(model.canUpload,false);
});

test('project card binds actions to its resolved project, ignoring forged workspace IDs',async()=>{
  const registrations=[],calls=[],messages=[];
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},
    vscode:{commands:{executeCommand:async(...args)=>calls.push(args)}},api:{run:async(_key,action)=>action==='session'?{authenticated:true,session:{userName:'Test'}}:({settings:{serverUrl:'https://project.invalid',systemIds:['A'],allSystems:false},files:[]})},
    getWorkspaces:async()=>[{workspaceKey:'projects.a',name:'A'}]});
  const view={webview:{onDidReceiveMessage:callback=>{registrations.push(callback);return {dispose(){}};},postMessage:async message=>messages.push(message)}};
  provider.resolveWebviewView(view);await provider.refresh();
  await registrations[0]({action:'pull',workspaceKey:'projects.other'});assert.equal(calls.length,0);
  await registrations[0]({action:'pull',workspaceKey:'projects.a'});
  assert.deepEqual(calls[0],['gushenCompletion.pullApiSource','projects.a']);
  await registrations[0]({action:'arbitrary-command'});assert.equal(calls.length,1);
  for(const [action,command] of Object.entries({search:'searchCurrentApiWorkspace',history:'showProjectHistory',scope:'selectApiSystems',settings:'configureProject',doctor:'showProjectChecks'})) {
    await registrations[0]({action,workspaceKey:'projects.a'});
    assert.deepEqual(calls.at(-1),['gushenCompletion.'+command,'projects.a']);
  }
  await registrations[0]({action:'changes',workspaceKey:'projects.a'});
  assert.deepEqual(calls.at(-1),['workbench.view.scm']);
  provider.getWorkspaces=async()=>[{workspaceKey:'projects.a'},{workspaceKey:'projects.b'}];await provider.refresh();
  assert.equal(provider.currentKey,undefined);assert(view.webview.html.includes('右上角“…”菜单'));
  provider.dispose();
});


test('unauthenticated card uses inline official-style login and no redundant controls',()=>{
  const model=cardModel({workspaceKey:'projects.a',name:'A'},{settings:{serverUrl:'https://project.invalid',systemIds:[],allSystems:false},files:[]},{authenticated:false});
  const html=projectCardHtml(model,{form:{userId:'test-user',remember:true}});
  assert(html.includes('id="server-url"'));assert(html.includes('id="account"'));assert(html.includes('type="password"'));
  assert(html.includes('保存密码'));assert(html.includes('id="login-form"'));
  assert(!html.includes('utility-actions'));assert(!html.includes('data-action="scope"'));assert(!html.includes('data-action="status"'));
  assert(!html.includes('data-action="pull"'));
});


test('failed inline logins reset enabled form and do not carry fields to another project',async()=>{
  let key='projects.a',receive,html='',renders=0;
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{}},
    getWorkspaces:async()=>[{workspaceKey:key,name:key}],api:{run:async(workspace,action)=>{
      if(action==='status')return {settings:{serverUrl:'https://'+workspace+'.invalid',systemIds:[],allSystems:false},files:[]};
      if(action==='session')return {authenticated:false};
      if(action==='login')throw new Error('登录失败');
      return {};
    }}});
  const webview={onDidReceiveMessage:callback=>{receive=callback;return {dispose(){}};},postMessage:async()=>{}};
  Object.defineProperty(webview,'html',{get:()=>html,set:value=>{html=value;renders++;}});
  provider.resolveWebviewView({webview});await provider.refresh();
  for(let i=0;i<2;i++)await receive({action:'submitLogin',workspaceKey:'projects.a',serverUrl:'https://old.invalid',userId:'old-account',password:'synthetic',remember:false,randCode:''});
  assert(renders>=3);assert(!/<(?:input|button)[^>]*\sdisabled(?:\s|=|>)/.test(html));assert(html.includes('old-account'));
  key='projects.b';await provider.refresh();
  assert(!html.includes('old-account'));assert(!html.includes('https://old.invalid'));
  const count=renders;await receive({action:'submitLogin',workspaceKey:'projects.a',password:'synthetic'});assert.equal(renders,count);
  provider.dispose();
});

test('login result is rendered without waiting for the background source scan',async()=>{
  let receive,logged=false,renders=0;
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{},window:{showErrorMessage:async()=>{}}},getWorkspaces:async()=>[{workspaceKey:'products.A',name:'A'}],api:{
    readProjectSummary:async()=>({settings:{serverUrl:'https://project.invalid',systemIds:['S'],allSystems:false},summaryComplete:false,summary:{sourceCount:16000,changedCount:null,uploadableCount:null}}),
    run:async(_key,action)=>action==='session'?{authenticated:logged,session:{userName:'Test'}}:action==='login'?(logged=true,{}):{},
    refreshWorkspace:()=>new Promise(()=>{}),
  }});
  const webview={onDidReceiveMessage:callback=>(receive=callback,{dispose(){}})};let html='';Object.defineProperty(webview,'html',{get:()=>html,set:value=>{html=value;renders++;}});
  provider.resolveWebviewView({webview});await provider.refresh();
  await receive({action:'submitLogin',workspaceKey:'products.A',serverUrl:'https://project.invalid',userId:'fixture',password:'synthetic',remember:false});
  assert(html.includes('更新源码'));assert(html.includes('16000 源码'));assert(html.includes('修改待检查'));assert(!html.includes('0 修改'));assert(renders>=2);provider.dispose();
});

test('project metadata and settings render before slow saved-session restoration',async()=>{
  let finish,html='';
  const session=new Promise(resolve=>{finish=resolve;});
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{}},
    getWorkspaces:async()=>[{workspaceKey:'projects.a',name:'A'}],api:{
      readProjectSummary:async()=>({settings:{serverUrl:'https://project.invalid',systemIds:['S'],allSystems:false},summaryComplete:false,summary:{sourceCount:16000}}),
      run:async()=>session,
    }});
  const webview={onDidReceiveMessage:()=>({dispose(){}})};
  Object.defineProperty(webview,'html',{get:()=>html,set:value=>{html=value;}});
  provider.resolveWebviewView({webview});
  await new Promise(resolve=>setImmediate(resolve));
  assert(html.includes('16000 源码'));assert(html.includes('正在恢复登录'));
  assert(html.includes('data-action="settings"'));assert(html.includes('data-action="search"'));
  assert.match(html,/<button data-action="pull" disabled/);
  finish({authenticated:false});await new Promise(resolve=>setImmediate(resolve));
  assert(html.includes('id="login-form"'));provider.dispose();
});

test('session transport failure retains an actionable project login card',async()=>{
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{}},
    getWorkspaces:async()=>[{workspaceKey:'projects.a',name:'A'}],api:{
      readProjectSummary:async()=>({settings:{serverUrl:'https://project.invalid',systemIds:['S'],allSystems:false},files:[]}),
      run:async()=>{throw Error('连接超时');},
    }});
  const webview={onDidReceiveMessage:()=>({dispose(){}})};
  provider.resolveWebviewView({webview});await provider.refresh();
  assert(webview.html.includes('id="login-form"'));assert(webview.html.includes('连接超时'));
  assert.equal(provider.currentKey,'projects.a');provider.dispose();
});

test('a restored session clears earlier credential errors and login form data',async()=>{
  let authentication={authenticated:false,error:{message:'系统凭据库读取超时，请手动登录'}};
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{}},
    getWorkspaces:async()=>[{workspaceKey:'projects.a',name:'A'}],api:{
      readProjectSummary:async()=>({settings:{serverUrl:'https://project.invalid',systemIds:['S'],allSystems:false},files:[]}),
      run:async()=>authentication,
    }});
  const webview={onDidReceiveMessage:()=>({dispose(){}})};
  provider.resolveWebviewView({webview});await provider.refresh();
  assert(webview.html.includes('系统凭据库读取超时'));
  provider.form.userId='earlier-account';provider.form.captcha='earlier-captcha';
  authentication={authenticated:true,session:{userName:'Test',mainVersion:'3.0.0',dateVersion:'202611120000'}};
  await provider.refresh();
  assert(webview.html.includes('更新源码'));assert(!webview.html.includes('系统凭据库读取超时'));
  assert(!webview.html.includes('earlier-account'));assert.deepEqual(provider.form,{});provider.dispose();
});
