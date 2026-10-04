#!/usr/bin/env node
// Maintainer-only provisioning. Never writes a private key into the repository,
// stdout, command arguments, or the public trust file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateTrust,signingPayload,verifySignature}=require('../plugins/GuthonNexus/gushen-vscode-completion/src/release-signature.js');
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const action=process.argv[2],options={};
for(let index=3;index<process.argv.length;index+=2) {
 const flag=process.argv[index],value=process.argv[index+1];
 if(!['--key-dir','--key-id','--public-key','--trust-out'].includes(flag)||!value||Object.hasOwn(options,flag))throw new Error('Invalid provisioning arguments');
 options[flag]=value;
}
if(!['generate','pin-public'].includes(action) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options['--key-id']||'') || !options['--trust-out'])throw new Error('Use generate --key-dir DIR --key-id ID --trust-out FILE, or pin-public --public-key FILE --key-id ID --trust-out FILE');
function assertPath(value) {
 if(!path.isAbsolute(value))throw new Error('Provisioning paths must be absolute');
 let cursor=path.resolve(value);
 while(cursor!==path.dirname(cursor)) {
  if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('Provisioning paths cannot contain symlinks');
  cursor=path.dirname(cursor);
 }
 return path.resolve(value);
}
const trustOut=assertPath(options['--trust-out']);
if(fs.existsSync(trustOut))throw new Error('Trust output already exists; use a new reviewed trust file for rotation');
let publicPem,privateKey,created=[];
try {
 if(action==='generate') {
  if(!options['--key-dir'] || options['--public-key'])throw new Error('generate requires key-dir only');
  const directory=assertPath(options['--key-dir']);
  if(directory===root || directory.startsWith(root+path.sep))throw new Error('Private release keys cannot be generated inside the public repository');
  fs.mkdirSync(directory,{mode:0o700,recursive:false});created.push(directory);
  if(process.platform!=='win32' && (fs.statSync(directory).mode & 0o077)!==0)throw new Error('Private key directory permissions must be 0700');
  const keys=crypto.generateKeyPairSync('ed25519');privateKey=keys.privateKey;
  publicPem=keys.publicKey.export({format:'pem',type:'spki'});
  const privateFile=path.join(directory,'release-private.pem'),publicFile=path.join(directory,'release-public.pem');
  fs.writeFileSync(privateFile,privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});created.push(privateFile);
  fs.writeFileSync(publicFile,publicPem,{flag:'wx',mode:0o644});created.push(publicFile);
 } else {
  if(!options['--public-key'] || options['--key-dir'])throw new Error('pin-public requires public-key only');
  const file=assertPath(options['--public-key']);
  if(fs.statSync(file).size>16384)throw new Error('Public key file exceeds 16 KiB');
  publicPem=fs.readFileSync(file,'utf8');
 }
 const trust={schemaVersion:1,requireSignature:true,keys:{[options['--key-id']]:publicPem}};
 validateTrust(trust);
 fs.writeFileSync(trustOut,JSON.stringify(trust,null,2)+'\n',{flag:'wx',mode:0o644});created.push(trustOut);
 if(privateKey) {
  const checksum=Buffer.from('self-test checksum\n'),version='0.0.0';
  verifySignature(version,checksum,{schemaVersion:1,algorithm:'ed25519',version,keyId:options['--key-id'],signature:crypto.sign(null,signingPayload(version,checksum),privateKey).toString('base64')},trust);
 }
 console.log(JSON.stringify({ok:true,keyId:options['--key-id'],publicKeySha256:crypto.createHash('sha256').update(crypto.createPublicKey(publicPem).export({format:'der',type:'spki'})).digest('hex'),trustPath:trustOut,privateKeyGenerated:action==='generate'}));
} catch(error) {
 for(const file of created.reverse()) {
  if(fs.statSync(file).isDirectory())fs.rmdirSync(file);else fs.unlinkSync(file);
 }
 throw error;
}
