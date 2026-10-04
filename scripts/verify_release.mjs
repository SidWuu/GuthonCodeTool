#!/usr/bin/env node
// Independently provisioned public trust verifies a downloaded release folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {readTrustFile,verifySignature,SIGNATURE_ASSET}=require('../plugins/GuthonNexus/gushen-vscode-completion/src/release-signature.js');
const options={};
for(let index=2;index<process.argv.length;index+=2) {
 const key=process.argv[index],value=process.argv[index+1];
 if(!['--release-dir','--trust-file','--version'].includes(key)||!value||Object.hasOwn(options,key))throw new Error('Use verify_release.mjs --release-dir DIR --trust-file FILE --version VERSION');
 options[key]=value;
}
if(Object.keys(options).length!==3)throw new Error('All verification arguments are required');
const root=fs.realpathSync(options['--release-dir']);
const trust=readTrustFile(path.resolve(options['--trust-file']));
if(!trust || !Object.keys(trust.keys).length)throw new Error('Independently provisioned public trust is required');
function read(name,limit) {
 const file=path.join(root,name),stat=fs.lstatSync(file);
 if(!stat.isFile() || stat.isSymbolicLink() || stat.size>limit)throw new Error('Invalid or oversized release metadata');
 return fs.readFileSync(file);
}
const checksums=read('GuthonCodeTool-checksums.txt',65536);
const signature=JSON.parse(read(SIGNATURE_ASSET,65536));
const evidence=verifySignature(options['--version'],checksums,signature,trust);
const files=[];
for(const line of checksums.toString('utf8').split(/\r?\n/).filter(Boolean)) {
 const match=/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9_.-]{0,199})$/.exec(line);
 if(!match || files.includes(match[2]))throw new Error('Checksum metadata contains unsafe, duplicate or malformed file names');
 const file=path.join(root,match[2]),stat=fs.lstatSync(file);
 if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Release asset is not a regular file');
 const hash=crypto.createHash('sha256');
 for await (const chunk of fs.createReadStream(file))hash.update(chunk);
 if(hash.digest('hex')!==match[1])throw new Error(`Release asset hash mismatch: ${match[2]}`);
 files.push(match[2]);
}
if(!files.length)throw new Error('Signed checksums contain no assets');
console.log(JSON.stringify({ok:true,version:options['--version'],signature:evidence,verifiedFiles:files}));
