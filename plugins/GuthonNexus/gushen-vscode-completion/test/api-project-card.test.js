const test=require('node:test');
const assert=require('node:assert/strict');
const {cardModel,projectCardHtml,ProjectCardProvider}=require('../src/api/project-card');

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
  provider.getWorkspaces=async()=>[{workspaceKey:'projects.a'},{workspaceKey:'projects.b'}];await provider.refresh();
  assert.equal(provider.currentKey,undefined);assert(view.webview.html.includes('添加项目并打开其源码目录'));
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
