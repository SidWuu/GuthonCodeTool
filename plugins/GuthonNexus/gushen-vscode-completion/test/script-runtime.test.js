const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyScriptChecksum } = require('../src/script-runtime');

test('requires a matching release checksum before launching a script runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-script-checksum-'));
  try {
    const script = path.join(dir, 'GuthonCodeTool-python.pyz');
    fs.writeFileSync(script, 'fixture');
    const hash = crypto.createHash('sha256').update('fixture').digest('hex');
    fs.writeFileSync(path.join(dir, 'GuthonCodeTool-checksums.txt'), `${hash}  GuthonCodeTool-python.pyz\n`);
    assert.doesNotThrow(() => verifyScriptChecksum(script));
    fs.writeFileSync(script, 'tampered');
    assert.throws(() => verifyScriptChecksum(script), /SHA-256/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
