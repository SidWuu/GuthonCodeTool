const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const signingModule=require('../src/release-signature');
const {signingPayload,verifySignature}=signingModule;
const readTrust=directory=>signingModule.readTrust(directory,require('node:path').join(directory,'no-bundle-fixture.json'));

test('bundled public trust needs no per-user provisioning and local settings cannot weaken it',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-bundle-trust-'));
 try {
  const keys=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519');
  const bundle=path.join(directory,'bundle.json');
  fs.writeFileSync(bundle,JSON.stringify({schemaVersion:1,requireSignature:true,keys:{release:keys.publicKey.export({format:'pem',type:'spki'})}}));
  assert.equal(signingModule.readTrust(directory,bundle).requireSignature,true);
  fs.writeFileSync(path.join(directory,'release-trust.json'),JSON.stringify({schemaVersion:1,requireSignature:false,keys:{}}));
  assert.equal(signingModule.readTrust(directory,bundle).requireSignature,true);
  fs.writeFileSync(path.join(directory,'release-trust.json'),JSON.stringify({schemaVersion:1,requireSignature:false,keys:{release:other.publicKey.export({format:'pem',type:'spki'})}}));
  assert.throws(()=>signingModule.readTrust(directory,bundle),/conflicts/);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('trust loading accepts only public Ed25519 PEM and object key registries',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-public-trust-'));
 try {
  const file=path.join(directory,'release-trust.json');
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  for(const keys of [17,[],{fixture:privateKey.export({format:'pem',type:'pkcs8'})}]) {
   fs.writeFileSync(file,JSON.stringify({schemaVersion:1,requireSignature:true,keys}));
   assert.throws(()=>readTrust(directory));
  }
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,requireSignature:true,keys:{fixture:publicKey.export({format:'pem',type:'spki'})}}));
  assert.equal(readTrust(directory).requireSignature,true);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('pinned signatures reject checksum/version/key substitution',()=>{
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');const pem=publicKey.export({format:'pem',type:'spki'});
 const checksum=Buffer.from('a'.repeat(64)+'  app.exe\n');const trust={schemaVersion:1,requireSignature:true,keys:{fixture:pem}};
 const sig={schemaVersion:1,algorithm:'ed25519',version:'1.2.3',keyId:'fixture',signature:crypto.sign(null,signingPayload('1.2.3',checksum),privateKey).toString('base64')};
 assert.equal(verifySignature('1.2.3',checksum,sig,trust).verified,true);
 assert.throws(()=>verifySignature('1.2.3',Buffer.from('tampered'),sig,trust),/verification failed/);
 assert.throws(()=>verifySignature('1.2.4',checksum,sig,trust),/version/);
 assert.throws(()=>verifySignature('1.2.3',checksum,{...sig,keyId:'untrusted'},trust),/Untrusted/);
});
test('maintainer provisions private keys outside the repository and verifies exact downloaded assets',()=>{
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'guthon-release-provision-')));
 try {
  const script=path.resolve(__dirname,'../../../../scripts/manage_release_signing.mjs');
  const keys=path.join(directory,'keys'),trust=path.join(directory,'trust.json');
  const args=[script,'generate','--key-dir',keys,'--key-id','fixture','--trust-out',trust];
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes('PRIVATE KEY'));
  assert.equal(fs.statSync(path.join(keys,'release-private.pem')).mode&0o777,0o600);
  assert.equal(fs.statSync(keys).mode&0o777,0o700);
  assert.equal(signingModule.readTrustFile(trust).requireSignature,true);
  assert.notEqual(spawnSync(process.execPath,args).status,0);
  const app=path.join(directory,'app.exe');fs.writeFileSync(app,'fixture application');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(app)).digest('hex');
  const checksum=path.join(directory,'GuthonCodeTool-checksums.txt');fs.writeFileSync(checksum,hash+'  app.exe\n');
  const sign=path.resolve(__dirname,'../../../../scripts/sign_release.mjs');
  const signed=spawnSync(process.execPath,[sign,'--checksums',checksum,'--version','1.2.3','--out',path.join(directory,signingModule.SIGNATURE_ASSET),'--trust-file',trust],
   {encoding:'utf8',env:{...process.env,GUTHON_RELEASE_SIGNING_PRIVATE_KEY:fs.readFileSync(path.join(keys,'release-private.pem'),'utf8'),GUTHON_RELEASE_SIGNING_KEY_ID:'fixture'}});
  assert.equal(signed.status,0,signed.stderr);
  const verify=path.resolve(__dirname,'../../../../scripts/verify_release.mjs');const verifyArgs=[verify,'--release-dir',directory,'--trust-file',trust,'--version','1.2.3'];
  assert.equal(spawnSync(process.execPath,verifyArgs).status,0);
  fs.writeFileSync(app,'tampered');assert.notEqual(spawnSync(process.execPath,verifyArgs).status,0);
  const repo=path.resolve(__dirname,'../../../..');
  assert.notEqual(spawnSync(process.execPath,[script,'generate','--key-dir',path.join(repo,'forbidden-signing-fixture'),'--key-id','fixture','--trust-out',path.join(directory,'new-trust.json')]).status,0);
  assert.equal(fs.existsSync(path.join(repo,'forbidden-signing-fixture')),false);
  const mistaken=path.join(directory,'mistaken-private-as-public.json');
  const rejected=spawnSync(process.execPath,[script,'pin-public','--public-key',path.join(keys,'release-private.pem'),'--key-id','fixture','--trust-out',mistaken]);
  assert.notEqual(rejected.status,0);assert.equal(fs.existsSync(mistaken),false);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('release signer reads only an external private key and does not overwrite output',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-signature-'));try{
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');const pem=privateKey.export({format:'pem',type:'pkcs8'});
 const checksums=path.join(directory,'checksums');fs.writeFileSync(checksums,'fixture checksum\n');const out=path.join(directory,'signature.json');
 const publicTrust=path.join(directory,'signer-trust.json');fs.writeFileSync(publicTrust,JSON.stringify({schemaVersion:1,requireSignature:true,keys:{fixture:publicKey.export({format:'pem',type:'spki'})}}));
 const script=path.resolve(__dirname,'../../../../scripts/sign_release.mjs');const args=[script,'--checksums',checksums,'--version','1.2.3','--out',out,'--trust-file',publicTrust];
 const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,GUTHON_RELEASE_SIGNING_PRIVATE_KEY:pem,GUTHON_RELEASE_SIGNING_KEY_ID:'fixture'}});
 assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(pem));
 const trust={keys:{fixture:publicKey.export({format:'pem',type:'spki'})}};
 assert.equal(verifySignature('1.2.3',fs.readFileSync(checksums),JSON.parse(fs.readFileSync(out)),trust).verified,true);
 const duplicate=spawnSync(process.execPath,args,{env:{...process.env,GUTHON_RELEASE_SIGNING_PRIVATE_KEY:pem,GUTHON_RELEASE_SIGNING_KEY_ID:'fixture'}});assert.notEqual(duplicate.status,0);
 fs.writeFileSync(path.join(directory,'release-trust.json'),JSON.stringify({schemaVersion:1,requireSignature:true,keys:{}}));
 assert.throws(()=>readTrust(directory),/independently provisioned/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
