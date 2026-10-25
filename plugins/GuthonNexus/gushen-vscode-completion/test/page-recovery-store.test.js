const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {PageRecoveryStore}=require('../src/page-editor/recovery-store');

test('immutable recovery records deduplicate content and expand the complete history on demand',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new PageRecoveryStore({storageUri:{fsPath:root}}),key='guthon.pageDraft.'+'a'.repeat(64);
  const original={sourceHash:'first',operations:[{value:'large'.repeat(10000)}],previous:null};
  const first=await store.save(key,original);assert.deepEqual(await store.save(key,original),first);
  let reference=first;
  for(let i=0;i<20;i++)reference=await store.save(key,{sourceHash:String(i),operations:[{value:i}],previous:reference});
  assert.ok(JSON.stringify(reference).length<150);
  const head=await store.head(key,reference);assert.equal(head.sourceHash,'19');assert.equal(head.previous.kind,'page-recovery-v1');
  const full=await store.expand(key,reference);let count=0,current=full;
  while(current.previous){count++;current=current.previous;}assert.equal(count,20);assert.deepEqual(current,original);
  await fs.writeFile(path.join(store.directory(key),reference.id+'.json'),'corrupt');
  await assert.rejects(store.head(key,reference),/校验失败/);
  assert.equal(await fs.readFile(path.join(store.directory(key),reference.id+'.json'),'utf8'),'corrupt');
  await assert.rejects(store.head('guthon.pageDraft.'+'b'.repeat(64),first),/ENOENT/);
});

test('legacy nested history becomes referenced records and invalid page identities cannot escape storage',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new PageRecoveryStore({storageUri:{fsPath:root}}),key='guthon.pageDraft.'+'a'.repeat(64);
  const legacy={sourceHash:'new',previous:{sourceHash:'old',previous:null}};
  assert.deepEqual(await store.expand(key,await store.save(key,legacy)),legacy);
  await assert.rejects(store.save('../escape',legacy),/页面身份/);
});

test('an interrupted temporary record never publishes a partial recovery file and a retry succeeds',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new PageRecoveryStore({storageUri:{fsPath:root}}),key='guthon.pageDraft.'+'a'.repeat(64);
  const record={sourceHash:'original',operations:[{value:'keep'}],previous:null},open=fs.open;
  fs.open=async(file,...args)=>{
    const handle=await open(file,...args);
    if(!String(file).endsWith('.tmp'))return handle;
    return new Proxy(handle,{get(target,name){
      if(name==='sync')return async()=>{throw new Error('interrupted write');};
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
    }});
  };
  try {await assert.rejects(store.save(key,record),/interrupted write/);} finally {fs.open=open;}
  assert.deepEqual(await fs.readdir(store.directory(key)),[]);
  const saved=await store.save(key,record);assert.deepEqual(await store.head(key,saved),record);
});

test('concurrent publication deduplicates complete records without replacing corrupt files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new PageRecoveryStore({storageUri:{fsPath:root}}),key='guthon.pageDraft.'+'a'.repeat(64);
  const record={sourceHash:'same',operations:[{value:'x'.repeat(10000)}],previous:null};
  const [left,right]=await Promise.all([store.save(key,record),store.save(key,record)]);
  assert.deepEqual(left,right);assert.deepEqual(await store.head(key,left),record);
  assert.deepEqual(await fs.readdir(store.directory(key)),[left.id+'.json']);
  const target=path.join(store.directory(key),left.id+'.json');await fs.writeFile(target,'corrupt');
  await assert.rejects(store.save(key,record),/校验失败/);assert.equal(await fs.readFile(target,'utf8'),'corrupt');
  assert.deepEqual(await fs.readdir(store.directory(key)),[left.id+'.json']);
});

test('invalid nested references and cyclic legacy history fail explicitly',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'page-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new PageRecoveryStore({storageUri:{fsPath:root}}),key='guthon.pageDraft.'+'a'.repeat(64);
  const invalid={sourceHash:'old',previous:{kind:'page-recovery-v1',id:'../invalid'}};
  await assert.rejects(store.save(key,invalid),/引用无效/);await assert.rejects(store.expand(key,invalid),/引用无效/);
  const cyclic={sourceHash:'cycle'};cyclic.previous=cyclic;
  await assert.rejects(store.save(key,cyclic),/循环引用/);await assert.rejects(store.expand(key,cyclic),/循环引用/);
});
