const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ApiLoginStore,credentialScope}=require('../src/api/login-store');
const scope={toolHome:'/data/fixture',workspaceKey:'projects.demo',serverUrl:'https://fixture.invalid/project'};
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-login-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:new ApiLoginStore(root)};}
test('saved account and password survive store recreation as authenticated ciphertext',t=>{
  const {root,store}=fixture(t),login={userId:'fixture-account',password:'fixture-secret'};
  store.save(scope,login);assert.deepEqual(new ApiLoginStore(root).read(scope),login);
  const file=path.join(root,'api-login',credentialScope(scope)+'.json'),cipher=fs.readFileSync(file,'utf8');
  assert(!cipher.includes(login.userId));assert(!cipher.includes(login.password));assert.equal(JSON.parse(cipher).version,1);
  if(process.platform!=='win32'){assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.join(root,'api-login/encryption.key')).mode&0o777,0o600);}
});
test('credentials are isolated by home, exact project, and platform URL',t=>{
  const {store}=fixture(t);store.save(scope,{userId:'a',password:'one'});
  assert.equal(store.read({...scope,toolHome:'/other'}),undefined);assert.equal(store.read({...scope,workspaceKey:'products.demo'}),undefined);assert.equal(store.read({...scope,serverUrl:'https://other.invalid'}),undefined);
  assert.deepEqual(store.read({...scope,serverUrl:scope.serverUrl+'/'}),{userId:'a',password:'one'});
  assert.throws(()=>credentialScope({...scope,serverUrl:'https://name:secret@fixture.invalid'}),/地址无效/);
});
test('tampered ciphertext cannot be read or mistaken for missing credentials',t=>{
  const {root,store}=fixture(t);store.save(scope,{userId:'a',password:'one'});
  const file=path.join(root,'api-login',credentialScope(scope)+'.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));data.content='00'+data.content.slice(2);fs.writeFileSync(file,JSON.stringify(data));
  assert.throws(()=>store.read(scope),/无法解密/);
});
test('separate instances reuse one key and logout forgets only the selected project',t=>{
  const {root,store}=fixture(t),other={...scope,workspaceKey:'projects.other'};
  store.save(scope,{userId:'a',password:'one'});new ApiLoginStore(root).save(other,{userId:'b',password:'two'});
  store.forget(scope);assert.equal(store.read(scope),undefined);assert.deepEqual(store.read(other),{userId:'b',password:'two'});
  store.forget(scope);
});
test('reading empty storage creates no key or configuration file',t=>{
  const {root,store}=fixture(t);assert.equal(store.read(scope),undefined);assert.deepEqual(fs.readdirSync(root),[]);
  assert.equal(new ApiLoginStore().read(scope),undefined);assert.throws(()=>new ApiLoginStore().save(scope,{userId:'a',password:'x'}),/不可用/);
});
