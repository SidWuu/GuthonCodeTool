#!/usr/bin/env node
// Sign an exact checksum file using an externally managed CI private key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {signingPayload,readTrustFile}=require('../plugins/GuthonNexus/gushen-vscode-completion/src/release-signature.js');
const options={};
for(let index=2;index<process.argv.length;index+=2){
 const key=process.argv[index];const value=process.argv[index+1];
 if(!['--checksums','--version','--out','--trust-file'].includes(key)||!value||Object.hasOwn(options,key))throw new Error('Usage: sign_release.mjs --checksums FILE --version VERSION --out FILE [--trust-file FILE]');
 options[key]=value;
}
if(['--checksums','--version','--out'].some(key=>!options[key]))throw new Error('All signing arguments are required');
const keyId=process.env.GUTHON_RELEASE_SIGNING_KEY_ID;
const pem=process.env.GUTHON_RELEASE_SIGNING_PRIVATE_KEY;
if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(keyId||'')||!pem)throw new Error('External signing key ID and private key environment variables are required');
const privateKey=crypto.createPrivateKey(pem);
if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Only Ed25519 release keys are supported');
const trust=readTrustFile(options['--trust-file'] || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../plugins/GuthonNexus/gushen-vscode-completion/data/release-trust.json'));
if(options['--trust-file'] && !trust)throw new Error('Explicit trust file is missing');
if (trust) {
 const pinned=trust.keys[keyId];
 if (!pinned || !crypto.createPublicKey(privateKey).export({format:'der',type:'spki'}).equals(crypto.createPublicKey(pinned).export({format:'der',type:'spki'}))) {
  throw new Error('CI signing key does not match the public key pinned in Nexus');
 }
}
const signature=crypto.sign(null,signingPayload(options['--version'],fs.readFileSync(options['--checksums'])),privateKey).toString('base64');
fs.writeFileSync(options['--out'],JSON.stringify({schemaVersion:1,algorithm:'ed25519',version:options['--version'],keyId,signature},null,2)+'\n',{flag:'wx',mode:0o644});
console.log('Signed release checksum metadata');
