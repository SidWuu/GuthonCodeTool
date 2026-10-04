const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('./host-config');

test('explicit IPv6 CIDRs accept compressed and mapped addresses without broadening default hosts', () => {
  assert.equal(host.matchesIpRange('[fd12:3456::1]', 'fd12:3456::/32'), true);
  assert.equal(host.matchesIpRange('fd12:3457::1', 'fd12:3456::/32'), false);
  assert.equal(host.matchesIpRange('::ffff:192.168.1.1', '::ffff:c0a8:0/112'), true);
  assert.equal(host.matchesIpRange('::1', '::1/128'), true);
  assert.equal(host.matchesIpRange('::2', '::1/128'), false);
  assert.equal(host.matchesIpRange('::1', '::/0'), true);
  assert.equal(host.isAllowed('https://[fd12:3456::1]/guthon/'), false);
  const rules = {...host.config, ipRanges: ['fd12:3456::/32']};
  assert.equal(host.isAllowed('https://[fd12:3456::1]/guthon/', rules), true);
  assert.equal(host.isAllowed('https://[fd12:3456::1]/elsewhere/', rules), false);
});

test('malformed CIDRs, zone identifiers and mixed protocol addresses are rejected', () => {
  for (const range of ['fd12::/129', 'fd12::/-1', 'fd12::/', 'fd12::/8/9', 'fd12:::1/32', 'fd12::abcd::1/32']) {
    assert.equal(host.matchesIpRange('fd12::1', range), false, range);
  }
  assert.equal(host.matchesIpRange('fe80::1%en0', 'fe80::/10'), false);
  assert.equal(host.matchesIpRange('192.168.1.1', '::/0'), false);
  assert.equal(host.matchesIpRange('::1', '192.168.0.0/16'), false);
  assert.equal(host.matchesIpRange('192.168.1.1', '192.168.0.0/16'), true);
  assert.equal(host.matchesIpRange('192.168.1.1', '192.168.0.0/'), false);
});
