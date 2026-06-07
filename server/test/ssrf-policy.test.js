const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isBlockedIp,
  checkRemoteUrlShape,
  assertRemoteUrlSafe,
  REASONS,
} = require('../lib/ssrf-policy');

// ---------------------------------------------------------------------------
// isBlockedIp — IP literal classification
// ---------------------------------------------------------------------------

test('isBlockedIp blocks loopback / private / link-local / CGNAT(Tailscale) / metadata', () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('127.255.1.1'), true);
  assert.equal(isBlockedIp('10.0.0.5'), true);
  assert.equal(isBlockedIp('10.255.255.255'), true);
  assert.equal(isBlockedIp('192.168.1.1'), true);
  assert.equal(isBlockedIp('172.16.0.1'), true);
  assert.equal(isBlockedIp('172.31.255.255'), true);
  assert.equal(isBlockedIp('169.254.1.1'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true); // cloud metadata
  assert.equal(isBlockedIp('100.64.0.1'), true);      // Tailscale / CGNAT 100.64.0.0/10
  assert.equal(isBlockedIp('100.127.255.254'), true);
  assert.equal(isBlockedIp('0.0.0.0'), true);
});

test('isBlockedIp allows genuine public IPs', () => {
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('1.1.1.1'), false);
  assert.equal(isBlockedIp('93.184.216.34'), false); // example.com
  assert.equal(isBlockedIp('172.15.0.1'), false);    // just below the 172.16/12 block
  assert.equal(isBlockedIp('172.32.0.1'), false);    // just above the 172.16/12 block
  assert.equal(isBlockedIp('100.63.255.255'), false);// just below 100.64/10
  assert.equal(isBlockedIp('100.128.0.0'), false);   // just above 100.64/10
});

test('isBlockedIp blocks IPv6 loopback / link-local / ULA and IPv4-mapped private', () => {
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('fc00::1'), true);
  assert.equal(isBlockedIp('fd12:3456::1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:169.254.169.254'), true);
});

test('isBlockedIp fails closed on garbage / empty input', () => {
  assert.equal(isBlockedIp(''), true);
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp(null), true);
});

// ---------------------------------------------------------------------------
// checkRemoteUrlShape — sync shape + literal-host check
// ---------------------------------------------------------------------------

test('checkRemoteUrlShape rejects non-http(s) protocols', () => {
  for (const u of ['file:///etc/passwd', 'gopher://x', 'ftp://h/a', 'data:text/html,x']) {
    const r = checkRemoteUrlShape(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, REASONS.BAD_PROTOCOL, u);
  }
});

test('checkRemoteUrlShape rejects malformed / empty input', () => {
  for (const u of ['', '   ', 'http://', 'not a url', null]) {
    assert.equal(checkRemoteUrlShape(u).ok, false, String(u));
  }
});

test('checkRemoteUrlShape blocks internal hostnames and private IP literals', () => {
  const blocked = [
    'http://localhost/x',
    'http://foo.localhost/x',
    'http://printer.local/x',
    'http://svc.internal/x',
    'http://127.0.0.1:9000/x',
    'http://10.0.0.5/admin',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/x',
    'http://[::1]/x',
  ];
  for (const u of blocked) {
    const r = checkRemoteUrlShape(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, REASONS.PRIVATE_TARGET, u);
  }
});

test('checkRemoteUrlShape allows public http(s) URLs (literal check only)', () => {
  for (const u of ['https://example.com/page', 'http://1.1.1.1/', 'https://www.youtube.com/watch?v=x']) {
    assert.equal(checkRemoteUrlShape(u).ok, true, u);
  }
});

// ---------------------------------------------------------------------------
// assertRemoteUrlSafe — async shape + DNS resolution (rebinding defense)
// ---------------------------------------------------------------------------

test('assertRemoteUrlSafe blocks a public hostname that RESOLVES to a private IP (DNS rebinding)', async () => {
  // Inject a resolver that returns a private address for an otherwise-public host.
  const resolver = async () => [{ address: '10.1.2.3', family: 4 }];
  const r = await assertRemoteUrlSafe('https://evil-rebind.example.com/x', { resolver });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.PRIVATE_TARGET);
});

test('assertRemoteUrlSafe blocks when ANY resolved address is private', async () => {
  const resolver = async () => [
    { address: '93.184.216.34', family: 4 }, // public
    { address: '169.254.169.254', family: 4 }, // metadata — must trip the gate
  ];
  const r = await assertRemoteUrlSafe('https://mixed.example.com/x', { resolver });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.PRIVATE_TARGET);
});

test('assertRemoteUrlSafe allows a public hostname resolving to a public IP', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const r = await assertRemoteUrlSafe('https://example.com/page', { resolver });
  assert.equal(r.ok, true);
});

test('assertRemoteUrlSafe fails closed when DNS resolution errors', async () => {
  const resolver = async () => { throw new Error('ENOTFOUND'); };
  const r = await assertRemoteUrlSafe('https://nope.example.com/', { resolver });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.DNS_FAILED);
});

test('assertRemoteUrlSafe short-circuits on a private IP literal without resolving', async () => {
  let called = false;
  const resolver = async () => { called = true; return [{ address: '8.8.8.8' }]; };
  const r = await assertRemoteUrlSafe('http://127.0.0.1/x', { resolver });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.PRIVATE_TARGET);
  assert.equal(called, false, 'must not perform DNS for an IP literal');
});

test('assertRemoteUrlSafe accepts a public IP literal without resolving', async () => {
  let called = false;
  const resolver = async () => { called = true; return []; };
  const r = await assertRemoteUrlSafe('https://1.1.1.1/', { resolver });
  assert.equal(r.ok, true);
  assert.equal(called, false);
});
