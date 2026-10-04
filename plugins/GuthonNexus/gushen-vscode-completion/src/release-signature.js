const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SIGNATURE_ASSET = 'GuthonCodeTool-checksums.signature.json';

function signingPayload(version, checksums) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid signed release version');
  return Buffer.from(JSON.stringify({version,checksumsSha256:crypto.createHash('sha256').update(checksums).digest('hex')}));
}
function readTrustFile(file) {
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Release trust file cannot be a symlink');
  if(fs.statSync(file).size>65536)throw new Error('Release trust file exceeds 64 KiB');
  const trust = JSON.parse(fs.readFileSync(file,'utf8'));
  return validateTrust(trust);
}
function validateTrust(trust) {
  if (!trust || typeof trust!=='object' || Array.isArray(trust) || trust.schemaVersion!==1 || typeof trust.requireSignature!=='boolean' || !trust.keys || typeof trust.keys!=='object' || Array.isArray(trust.keys)
      || Object.keys(trust).some(key=>!['schemaVersion','requireSignature','keys'].includes(key))) throw new Error('Invalid pinned release trust configuration');
  for (const [id,pem] of Object.entries(trust.keys)) {
    // createPublicKey also accepts private PEMs. Require a public SPKI envelope
    // before parsing so a misplaced CI private key is never accepted as trust.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || typeof pem!=='string'
        || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)
        || crypto.createPublicKey(pem).asymmetricKeyType!=='ed25519') throw new Error('Pinned release keys must be Ed25519 public keys');
  }
  if(trust.requireSignature && !Object.keys(trust.keys).length)throw new Error('Signature enforcement requires an independently provisioned public key');
  return trust;
}
function readTrust(storageRoot, bundledFile = path.join(__dirname,'../data/release-trust.json')) {
  const bundled = readTrustFile(bundledFile);
  const local = readTrustFile(path.join(storageRoot, 'release-trust.json'));
  const trust = {schemaVersion:1, requireSignature:Boolean(bundled?.requireSignature || local?.requireSignature),
    keys:{...(bundled?.keys || {})}};
  for (const [id,pem] of Object.entries(local?.keys || {})) {
    if (Object.hasOwn(trust.keys,id) && crypto.createPublicKey(trust.keys[id]).export({format:'der',type:'spki'}).compare(crypto.createPublicKey(pem).export({format:'der',type:'spki'})) !== 0) {
      throw new Error('Local release key conflicts with the bundled key ID');
    }
    trust.keys[id] = pem;
  }
  return trust;
}
function verifySignature(version, checksums, signature, trust) {
  if (!signature || signature.schemaVersion!==1 || signature.algorithm!=='ed25519'
      || signature.version!==version || typeof signature.keyId!=='string' || !Object.hasOwn(trust.keys,signature.keyId)
      || Object.keys(signature).some(key=>!['schemaVersion','algorithm','version','keyId','signature'].includes(key))) throw new Error('Untrusted release signature or version');
  if (typeof signature.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature)) throw new Error('Invalid Ed25519 signature encoding');
  const bytes=Buffer.from(signature.signature,'base64');
  if (!crypto.verify(null,signingPayload(version,checksums),trust.keys[signature.keyId],bytes)) throw new Error('Release signature verification failed');
  return {verified:true,keyId:signature.keyId,algorithm:'ed25519'};
}
module.exports={SIGNATURE_ASSET,readTrust,readTrustFile,validateTrust,signingPayload,verifySignature};
