import crypto from 'node:crypto';import fs from 'node:fs';
try {
 const input=fs.readFileSync(0);if(input.length>1048576)throw new Error('input too large');
 const request=JSON.parse(input.toString('utf8'));
 if(typeof request.passphrase!=='string'||[...request.passphrase].length<12||[...request.passphrase].length>4096)throw new Error('invalid passphrase');
 const derive=salt=>crypto.scryptSync(request.passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 if(request.operation==='encrypt'){
  const plain=Buffer.from(JSON.stringify(request.payload));if(plain.length>524288)throw new Error('payload too large');
  const salt=crypto.randomBytes(16);const iv=crypto.randomBytes(12);
  const header={schemaVersion:1,algorithm:'aes-256-gcm',kdf:'scrypt-N32768-r8-p1',salt:salt.toString('base64'),iv:iv.toString('base64')};
  const key=derive(salt);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);plain.fill(0);key.fill(0);
  process.stdout.write(JSON.stringify({...header,tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
 }else if(request.operation==='decrypt'){
  const data=request.payload;
  if(!data||Object.keys(data).sort().join(',')!==['schemaVersion','algorithm','kdf','salt','iv','tag','ciphertext'].sort().join(',')
    ||data.schemaVersion!==1||data.algorithm!=='aes-256-gcm'||data.kdf!=='scrypt-N32768-r8-p1')throw new Error('invalid vault');
  const decode=(value,length)=>{if(typeof value!=='string'||value.length>700000)throw new Error('invalid encoding');const buffer=Buffer.from(value,'base64');if(buffer.toString('base64')!==value||(length&&buffer.length!==length))throw new Error('invalid encoding');return buffer;};
  const salt=decode(data.salt,16);const iv=decode(data.iv,12);const tag=decode(data.tag,16);const ciphertext=decode(data.ciphertext);if(ciphertext.length>524288)throw new Error('payload too large');
  const header={schemaVersion:1,algorithm:data.algorithm,kdf:data.kdf,salt:data.salt,iv:data.iv};const key=derive(salt);
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(JSON.stringify(header)));decipher.setAuthTag(tag);
  const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);key.fill(0);const payload=JSON.parse(plaintext.toString('utf8'));plaintext.fill(0);process.stdout.write(JSON.stringify(payload));
 }else throw new Error('invalid operation');
}catch{process.stderr.write('Credential vault operation failed; invalid data or passphrase\n');process.exitCode=1;}
