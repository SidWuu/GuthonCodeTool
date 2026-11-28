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
  assert.ok(card.initialSize>tree.initialSize,'current project card gets priority over the source tree');
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

test('legacy project cards never query API or dispatch API actions',async()=>{
  const calls=[],registrations=[];
  const provider=new ProjectCardProvider({context:{extensionPath:path.resolve(__dirname,'..')},
    vscode:{commands:{executeCommand:async(...args)=>calls.push(args)}},
    getWorkspaces:async()=>[{workspaceKey:'projects.old',name:'旧项目',sourceMode:'svn',root:'/fixture/old'}],
    api:{run:async()=>{throw new Error('legacy must not invoke API');}}});
  const view={webview:{onDidReceiveMessage:callback=>{registrations.push(callback);return {dispose(){}};},postMessage:async()=>{}}};
  provider.resolveWebviewView(view);await provider.refresh();
  assert.match(view.webview.html,/SVN/);assert(!view.webview.html.includes('id="login-form"'));
  await registrations[0]({action:'pull',workspaceKey:'projects.old'});assert.equal(calls.length,0);
  await registrations[0]({action:'settings',workspaceKey:'projects.old'});
  assert.equal(calls.length,0);provider.dispose();
});

test('late card state cannot overwrite a newer selection or forward stale actions',async()=>{
  let selected='a',finish;
  const calls=[],callbacks=[];
  const status={settings:{serverUrl:'https://fixture.invalid',allSystems:true,systemIds:[]},summary:{sourceCount:1,changedCount:0}};
  const provider=new ProjectCardProvider({context:{extensionPath:path.resolve(__dirname,'..')},
    vscode:{commands:{executeCommand:async(...args)=>calls.push(args)}},getWorkspaces:async()=>[{workspaceKey:selected,name:selected}],
    api:{readProjectSummary:async key=>key==='a'?new Promise(resolve=>{finish=resolve;}):status,
      run:async()=>({authenticated:true})}});
  const view={webview:{onDidReceiveMessage:callback=>{callbacks.push(callback);return {dispose(){}};},postMessage:async()=>{}}};
  provider.resolveWebviewView(view);await new Promise(resolve=>setImmediate(resolve));
  selected='b';provider.invalidate();await provider.refresh();finish(status);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.currentKey,'b');
  await callbacks[0]({action:'pull',workspaceKey:'a'});assert.equal(calls.length,0);provider.dispose();
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
  for(const [action,command] of Object.entries({search:'searchCurrentApiWorkspace',history:'showProjectHistory',scope:'selectApiSystems',index:'showProjectIndex',doctor:'showProjectChecks'})) {
    await registrations[0]({action,workspaceKey:'projects.a'});
    assert.deepEqual(calls.at(-1),['gushenCompletion.'+command,'projects.a']);
  }
  await registrations[0]({action:'changes',workspaceKey:'projects.a'});
  assert.deepEqual(calls.at(-1),['workbench.view.scm']);
  provider.getWorkspaces=async()=>[{workspaceKey:'projects.a'},{workspaceKey:'projects.b'}];await provider.refresh();
  assert.equal(provider.currentKey,undefined);assert(view.webview.html.includes('选择当前窗口的工作区'));
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

test('project metadata and search render before slow saved-session restoration',async()=>{
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
  assert(html.includes('16000 源码'));assert(html.includes('正在核验登录状态'));
  assert(!html.includes('data-action="settings"'));assert(html.includes('data-action="search"'));
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
  let authentication={authenticated:false,error:{message:'本地自动登录未完成，请手动登录'}};
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{commands:{}},
    getWorkspaces:async()=>[{workspaceKey:'projects.a',name:'A'}],api:{
      readProjectSummary:async()=>({settings:{serverUrl:'https://project.invalid',systemIds:['S'],allSystems:false},files:[]}),
      run:async()=>authentication,
    }});
  const webview={onDidReceiveMessage:()=>({dispose(){}})};
  provider.resolveWebviewView({webview});await provider.refresh();
  assert(webview.html.includes('本地自动登录未完成'));
  provider.form.userId='earlier-account';provider.form.captcha='earlier-captcha';
  authentication={authenticated:true,session:{userName:'Test',mainVersion:'3.0.0',dateVersion:'202611120000'}};
  await provider.refresh();
  assert(webview.html.includes('更新源码'));assert(!webview.html.includes('本地自动登录未完成'));
  assert(!webview.html.includes('earlier-account'));assert.deepEqual(provider.form,{});provider.dispose();
});

test('transport uncertainty preserves the proven user card while disabling actions',async()=>{
  let uncertain=false;const workspace={workspaceKey:'projects.A',name:'A'},state={settings:{serverUrl:'https://project.invalid',systemIds:['A'],allSystems:false},summary:{sourceCount:1,changedCount:0,uploadableCount:0}};
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{},getWorkspaces:async()=>[workspace],api:{readProjectSummary:async()=>state,run:async()=>uncertain?{authenticated:false,error:{code:'API_CONNECTION_FAILED',message:'network uncertain'}}:{authenticated:true,session:{userName:'proven'}}}});
  provider.view={webview:{html:''}};await provider.refresh();assert(provider.view.webview.html.includes('proven'));
  uncertain=true;await provider.refresh();assert(provider.view.webview.html.includes('proven'));assert(provider.view.webview.html.includes('network uncertain'));assert(!provider.view.webview.html.includes('id="login-form"'));assert.match(provider.view.webview.html,/data-action="pull" disabled/);
});
test('an explicit expired session removes the authenticated card instead of trusting lastLogin',async()=>{
  let expired=false;const state={settings:{serverUrl:'https://project.invalid',systemIds:['A'],allSystems:false},lastLogin:{userName:'old'}};
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{},getWorkspaces:async()=>[{workspaceKey:'projects.A',name:'A'}],api:{readProjectSummary:async()=>state,run:async()=>expired?{authenticated:false}:{authenticated:true,session:{userName:'old'}}}});
  provider.view={webview:{html:''}};await provider.refresh();expired=true;await provider.refresh();assert(provider.view.webview.html.includes('id="login-form"'));assert(!provider.view.webview.html.includes('data-action="pull"'));
  assert.match(provider.view.webview.html,/id="account"[^>]*value=""/);
  assert.doesNotMatch(provider.view.webview.html,/value="old"/);
});

test('the API login form fills the submitted account after logout and refreshes a changed account',async()=>{
  const workspace={workspaceKey:'projects.A',name:'A'};
  const state={settings:{serverUrl:'https://project.invalid',systemIds:['A'],allSystems:false},lastLogin:{userName:'测试用户'}};
  let authentication={authenticated:true,session:{userName:'测试用户'}};
  const provider=new ProjectCardProvider({context:{extensionPath:path.resolve(__dirname,'..')},vscode:{},
    getWorkspaces:async()=>[workspace],api:{readProjectSummary:async()=>state,run:async()=>authentication}});
  provider.view={webview:{html:''}};
  await provider.refresh();
  assert.match(provider.view.webview.html,/<dt>用户<\/dt><dd title="测试用户">测试用户<\/dd>/);

  authentication={authenticated:false};
  state.loginId='00100000000';
  await provider.refresh();
  assert.match(provider.view.webview.html,/id="account"[^>]*value="00100000000"/);
  assert.doesNotMatch(provider.view.webview.html,/value="测试用户"/);
  state.loginId='00200000000';
  await provider.refresh();
  assert.match(provider.view.webview.html,/id="account"[^>]*value="00200000000"/);
  provider.dispose();
});


test('switch invalidation prevents late old workspace status from replacing the new card',async()=>{
  let finish,key='a';const slow=new Promise(resolve=>{finish=resolve;});
  const status={settings:{serverUrl:'https://example.invalid',systemIds:[],allSystems:true},files:[]};
  const provider=new ProjectCardProvider({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{},
    getWorkspaces:async()=>[{workspaceKey:key,name:key}],api:{readProjectSummary:async value=>value==='a'?slow:status,run:async()=>({authenticated:true})}});
  provider.view={webview:{html:''}};const old=provider.refresh();await new Promise(resolve=>setImmediate(resolve));
  key='b';provider.invalidate();await provider.refresh();finish(status);await old;
  assert.equal(provider.currentKey,'b');assert.match(provider.view.webview.html,/b/);provider.dispose();
});

test('wired legacy card sends project-bound actions without API login or source requests', async () => {
  const received = [];
  const workspace = {workspaceKey:'products.db',name:'旧项目',sourceMode:'database',root:'/fixture',executionReady:true,datasourceReady:true};
  const provider = new ProjectCardProvider({
    context:{extensionPath:path.resolve(__dirname,'..')},
    vscode:{commands:{}}, api:{run(){throw new Error('unexpected API call');}},
    getWorkspaces:async () => [workspace],
    onLegacyAction:async (selected, action) => received.push([selected.workspaceKey,action]),
  });
  let send;
  const view={webview:{onDidReceiveMessage(callback){send=callback;return {dispose(){}};}}};
  provider.resolveWebviewView(view);
  await provider.refresh();
  assert.match(view.webview.html,/上传源码/);
  assert.doesNotMatch(view.webview.html,/id="login-form"/);
  await send({action:'pull',workspaceKey:'ws-other'});
  await send({action:'pull',workspaceKey:'products.db'});
  await send({action:'history',workspaceKey:'products.db'});
  assert.deepEqual(received,[['products.db','pull'],['products.db','history']]);
  provider.dispose();
});

test('all three source modes have exactly six common card actions with index management fifth',()=>{
  for(const sourceMode of ['api','database','svn']) {
    const workspace={workspaceKey:'ws-fixture',sourceMode,root:'/fixture',executionReady:true,
      configuration:{schemaVersion:3},checkoutLayout:'manifest-working-copies',
      capabilities:{'svn.initialize':true},datasourceReady:true,sourceSummary:{systemCount:7,sourceCount:3219,changedCount:0}};
    const html=projectCardHtml(cardModel(workspace,{settings:{allSystems:false,systemIds:['A','B','C','D','E','F','G']},
      summary:{sourceCount:3219,changedCount:0}}));
    assert.match(html,/class="source-summary"/);
    assert.match(html,/7 个子系统/);
    assert.match(html,/3219 源码/);
    assert.match(html,/0 修改/);
    assert.match(html,/<nav class="project-tools"/);
    assert.doesNotMatch(html,/data-action="settings"/);
    const grid=/<nav class="project-tools"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
    assert.deepEqual([...grid.matchAll(/data-action="([^"]+)"/g)].map(match=>match[1]),
      ['search','changes','history','scope','index','doctor']);
    assert.match(grid,/索引管理/);
  }
});

test('late SVN status cannot replace another source binding and fresh changes fill the current summary',async()=>{
  const workspace={workspaceKey:'ws-svn',name:'SVN fixture',sourceMode:'svn',root:'/checkout',
    executionReady:true,workspaceBinding:{digest:'current'},sourceSummary:{wholeRepository:true,sourceCount:20,changedCount:null}};
  const provider=new ProjectCardProvider({context:{extensionPath:path.resolve(__dirname,'..')},
    vscode:{},api:{},getWorkspaces:async()=>[workspace]});
  provider.view={webview:{html:''}};
  await provider.refresh();
  assert.match(provider.view.webview.html,/修改待检查/);
  provider.updateLegacyStatus({...workspace,workspaceBinding:{digest:'previous'}},{changes:[{},{}]});
  assert.match(provider.view.webview.html,/修改待检查/);
  provider.updateLegacyStatus(workspace,{changes:[{}]});
  assert.match(provider.view.webview.html,/1 修改/);
  provider.dispose();
});

test('new DATABASE and SVN projects log in from the card and reveal scope and source actions',async()=>{
  for(const mode of ['database','svn']) {
    const name='fixture '+mode,key='ws-'+mode,calls=[];
    let workspace={workspaceKey:key,name,sourceMode:mode,executionReady:true,configuration:{schemaVersion:3},
      checkoutLayout:'manifest-working-copies',sourceConnection:{ready:false}};
    const provider=new ProjectCardProvider({context:{extensionPath:path.resolve(__dirname,'..')},vscode:{},api:{
      run:()=>assert.fail('legacy login must not call API'),
    },getWorkspaces:async()=>[workspace],onLegacyAction:()=>assert.fail('login must not run a source pull'),
    onLegacyLogin:async (project,credentials)=>{
      calls.push([project.workspaceKey,credentials.userId]);
      assert.equal(credentials.password,'isolated-test-password');
      workspace={...workspace,sourceConnection:{ready:true},datasourceReady:true};
    }});
    let send;
    const view={webview:{onDidReceiveMessage(callback){send=callback;return {dispose(){}};}}};
    provider.resolveWebviewView(view);
    await provider.refresh();
    assert.match(view.webview.html,/id="login-form"/);
    assert.match(view.webview.html,mode==='database'?/数据库连接地址/:/SVN 仓库地址/);
    assert.match(view.webview.html,/用户名/);
    assert.match(view.webview.html,/type="password"/);
    assert.doesNotMatch(view.webview.html,/data-action="pull"/);
    const credentials={action:'submitLogin',workspaceKey:key,serverUrl:'https://fixture.invalid/repo',
      userId:'fixture-user',password:'isolated-test-password'};
    await send({...credentials,workspaceKey:'different-project'});
    assert.deepEqual(calls,[]);
    await send(credentials);
    assert.deepEqual(calls,[[key,'fixture-user']]);
    assert.equal(credentials.password,'');
    assert.doesNotMatch(view.webview.html,/id="login-form"|isolated-test-password/);
    assert.match(view.webview.html,/data-action="scope"/);
    assert.match(view.webview.html,/data-action="pull"/);
    provider.dispose();
  }
});
