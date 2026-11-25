const test=require('node:test'),assert=require('node:assert/strict');
const {ApiAuthentication}=require('../src/api/authentication');
const scope={toolHome:'/data',workspaceKey:'projects.demo',serverUrl:'https://fixture.invalid'};
function fixture() {
  const calls=[],warnings=[];let saved={userId:'fixture-account',password:'fixture-secret'},logged=false,fail=false;
  const store={read:()=>saved,save:(_scope,value)=>{saved={userId:value.userId,password:value.password};},forget:()=>{saved=undefined;}};
  const auth=new ApiAuthentication({store,scopeFor:async()=>scope,onWarning:message=>warnings.push(message),invoke:async(key,action,input)=>{
    calls.push({key,action,input});
    if(action==='session')return {authenticated:logged,session:logged?{userName:'fixture'}:null};
    if(action==='logout'){logged=false;return {authenticated:false,session:null};}
    if(action==='login'){if(fail)throw new Error('secret error fixture-secret');logged=true;return {session:{userName:'fixture'}};}
    throw Error(action);
  }});
  return {auth,store,calls,warnings,setFail:value=>{fail=value;},restart:()=>{logged=false;},saved:()=>saved};
}
test('parallel restore requests log in once and use only local session probes for operations',async()=>{
  const f=fixture();const values=await Promise.all([f.auth.session('projects.demo'),f.auth.session('projects.demo'),f.auth.ensure('projects.demo')]);
  assert(values[0].authenticated);assert(values[1].authenticated);assert.equal(f.calls.filter(x=>x.action==='login').length,1);assert.deepEqual(f.calls.at(-1).input,{localOnly:true});
});
test('failed automatic login is suppressed until an explicit successful login',async()=>{
  const f=fixture();f.setFail(true);const first=await f.auth.session('projects.demo'),second=await f.auth.session('projects.demo');
  assert.equal(first.error.code,'API_LOGIN_RESTORE_FAILED');assert.deepEqual(second,first);assert(!JSON.stringify(first).includes('fixture-secret'));assert.equal(f.calls.filter(x=>x.action==='login').length,1);
  f.setFail(false);await f.auth.login('projects.demo',{userId:'fresh',password:'fresh-secret',remember:true});assert.equal((await f.auth.session('projects.demo')).authenticated,true);assert.deepEqual(f.saved(),{userId:'fresh',password:'fresh-secret'});
  assert.equal(f.calls.filter(x=>x.action==='login').at(-1).input.remember,undefined);
});
test('certificate failure during auto login preserves the connection diagnostic without retrying', async () => {
  const f = fixture();
  const invoke = f.auth.invoke;
  const message = '谷神登录服务的证书校验失败，请更新后端或检查系统受信任证书';
  let attempts = 0;
  f.auth.invoke = async (key, action, input) => {
    if (action !== 'login') return invoke(key, action, input);
    attempts++;
    throw Object.assign(new Error(message), { code: 'API_TLS_CERTIFICATE_ERROR' });
  };
  const first = await f.auth.session('projects.demo');
  assert.deepEqual(first.error, { code: 'API_TLS_CERTIFICATE_ERROR', message });
  assert.deepEqual(await f.auth.session('projects.demo'), first);
  assert.equal(attempts, 1);
});
test('logout queues behind an in-flight restore then prevents future automatic login',async()=>{
  const f=fixture(),invoke=f.auth.invoke;let started,release;
  const loginStarted=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.auth.invoke=async(key,action,input)=>{if(action==='login'){started();await gate;}return invoke(key,action,input);};
  const restoring=f.auth.session('projects.demo');await loginStarted;
  const logout=f.auth.logout('projects.demo');release();await Promise.all([restoring,logout]);
  assert.equal(f.calls.at(-1).action,'logout');assert.equal(f.saved(),undefined);assert.equal((await f.auth.session('projects.demo')).authenticated,false);
  await assert.rejects(f.auth.ensure('projects.demo'),error=>error.code==='API_LOGIN_REQUIRED');assert.equal(f.calls.filter(x=>x.action==='login').length,1);
});
test('session-only login removes a previously remembered password',async()=>{
  const f=fixture();await f.auth.login('projects.demo',{userId:'current',password:'new-secret',remember:false});assert.equal(f.saved(),undefined);f.restart();assert.equal((await f.auth.session('projects.demo')).authenticated,false);
});
test('failed manual account change never silently restores the earlier saved account',async()=>{
  const f=fixture();f.setFail(true);
  await assert.rejects(f.auth.login('projects.demo',{userId:'other-account',password:'wrong',remember:true}));
  f.setFail(false);const value=await f.auth.session('projects.demo');
  assert.equal(value.authenticated,false);assert.equal(f.calls.filter(x=>x.action==='login').length,1);
  assert.equal(value.error,undefined,'manual failure must not be replaced by a restore notice');
  assert.equal(f.saved().userId,'fixture-account');
});
test('credential-save failure reports a warning while preserving the successful in-memory login',async()=>{
  const f=fixture();f.store.save=()=>{throw Error('disk unavailable');};await f.auth.login('projects.demo',{userId:'a',password:'secret',remember:true});assert.equal(f.warnings.length,1);assert.match(f.warnings[0],/已登录.*未完成/);assert.equal((await f.auth.session('projects.demo')).authenticated,true);
});
test('logout still clears the running session when removing saved credentials fails',async()=>{
  const f=fixture();await f.auth.session('projects.demo');f.store.forget=()=>{throw Error('disk denied');};
  await assert.rejects(f.auth.logout('projects.demo'),/本地.*未能删除.*当前运行会话已清理/);
  assert.equal(f.calls.at(-1).action,'logout');assert.equal((await f.auth.session('projects.demo')).authenticated,false);
  assert.equal(f.calls.filter(x=>x.action==='login').length,1);
});
