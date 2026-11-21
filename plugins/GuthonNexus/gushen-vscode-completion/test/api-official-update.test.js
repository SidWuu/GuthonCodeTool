const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {extractCatalog}=require('../src/api/official-catalog');
const {checkOfficialUpdate,rollbackOfficialUpdate,getOfficialCatalogPath}=require('../src/official-update');
function zip(files) {
  const locals=[],central=[];let offset=0;
  for(const [name,text] of Object.entries(files)) {
    const n=Buffer.from(name),data=Buffer.from(text),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    locals.push(l,n,data);central.push(c,n);offset+=l.length+n.length+data.length;
  }
  const d=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(d.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,d,end]);
}
const bundle=label=>`var catalog={util:{fullName:"$vs.util",description:"Utility",functions:[{label:"${label}",name:"trim",params:[{text:"$a:string",varName:"a"}],doc:\`text\`}]}};`;
function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-official-')),reports=[];
  const context={globalStorageUri:{fsPath:dir},extensionPath:path.join(__dirname,'..')};
  const vscode={workspace:{openTextDocument:async x=>(reports.push(x.content),x)},window:{showTextDocument:async()=>{}}};
  const io={version:'1.0.0',payload:null,async request(url){
    if(url.endsWith('guthon-language-support')) return Buffer.from(JSON.stringify({namespace:'guthon',name:'guthon-language-support',version:this.version,files:{sha256:'https://open-vsx.org/hash',changelog:'https://open-vsx.org/changelog',download:'https://open-vsx.org/file'}}));
    if(url.endsWith('/hash')) return Buffer.from(crypto.createHash('sha256').update(this.payload).digest('hex'));
    return Buffer.from('官方更新内容');
  },async downloadAsset(_url,target){fs.writeFileSync(target,this.payload);}};
  const prepare=(version,code=bundle(version))=>{io.version=version;io.payload=zip({'extension/package.json':JSON.stringify({name:'guthon-language-support',publisher:'guthon',version,license:'Apache-2.0'}),'extension/dist/extension.js':code});};
  return {dir,context,vscode,io,prepare,reports};
}
test('static parser rejects executable expressions and extracts only literals',()=>{
  assert.equal(extractCatalog(bundle('trim()'),{}).modules.util.functions[0].label,'trim()');
  assert.throws(()=>extractCatalog(bundle('x').replace('doc:`text`','doc:`${bad()}`'),{}),/表达式|非字面量|唯一/);
  assert.throws(()=>extractCatalog(bundle('x').replace('doc:`text`','doc:process.exit()'),{}),/非字面量/);
});
test('verified catalog can update and roll back without running bundle',async t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  f.prepare('1.0.0');const one=await checkOfficialUpdate(f);
  assert.equal(JSON.parse(fs.readFileSync(getOfficialCatalogPath(f.context,''))).source.version,'1.0.0');
  f.prepare('1.0.1');await checkOfficialUpdate(f);
  assert.equal(JSON.parse(fs.readFileSync(getOfficialCatalogPath(f.context,''))).source.version,'1.0.1');
  await rollbackOfficialUpdate(f);
  assert.equal(JSON.parse(fs.readFileSync(getOfficialCatalogPath(f.context,''))).source.version,one.version);
  assert.match(f.reports.at(-1),/回退会切换至前一版补全与悬停资源/);
});
test('unknown catalog format keeps previous compatible data; bad hash leaves it untouched',async t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  f.prepare('1.0.0');await checkOfficialUpdate(f);
  f.prepare('1.0.1','var noCatalog = 1;');await checkOfficialUpdate(f);
  assert.equal(JSON.parse(fs.readFileSync(getOfficialCatalogPath(f.context,''))).source.version,'1.0.0');
  assert.match(f.reports.at(-1),/静态资源未切换/);
  f.prepare('1.0.2');const download=f.io.downloadAsset;f.io.downloadAsset=async function(url,target){await download.call(this,url,target);fs.appendFileSync(target,'x');};
  await assert.rejects(checkOfficialUpdate(f),/SHA-256 不匹配/);
  assert.equal(JSON.parse(fs.readFileSync(getOfficialCatalogPath(f.context,''))).source.version,'1.0.0');
});

test('first update can roll back to bundled completion data',async t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  f.prepare('1.0.0');await checkOfficialUpdate(f);await rollbackOfficialUpdate(f);
  assert.equal(getOfficialCatalogPath(f.context,'bundled.json'),'bundled.json');
  assert.match(f.reports.at(-1),/同步和设计器协议仍由当前 Nexus 版本决定/);
});
test('failed upstream request reports the still-active completion version',async t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));f.prepare('1.0.0');await checkOfficialUpdate(f);
  f.io.request=async()=>{throw Error('offline');};await assert.rejects(checkOfficialUpdate(f),/offline/);
  assert.match(f.reports.at(-1),/当前补全与悬停数据：1\.0\.0/);assert.match(f.reports.at(-1),/操作未完成：offline/);
});
