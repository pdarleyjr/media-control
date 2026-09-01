'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  generatePairingCode,
  pairingCodeExpiresAt,
  isPairingCodeActive,
} = require('../lib/device-enrollment');

test('pairing codes use a cryptographically generated six-digit operator code', () => {
  const codes = new Set();
  for (let index = 0; index < 500; index += 1) {
    const code = generatePairingCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 490);
});

test('pairing authorization has a short explicit expiry boundary', () => {
  const issuedAt = 1_700_000_000;
  const expiresAt = pairingCodeExpiresAt(issuedAt);
  assert.equal(expiresAt, issuedAt + 600);
  assert.equal(isPairingCodeActive({ pairing_code: '123456', pairing_expires_at: expiresAt }, expiresAt - 1), true);
  assert.equal(isPairingCodeActive({ pairing_code: '123456', pairing_expires_at: expiresAt }, expiresAt), false);
  assert.equal(isPairingCodeActive({ pairing_code: null, pairing_expires_at: expiresAt }, issuedAt), false);
  assert.equal(isPairingCodeActive({ pairing_code: '123456', pairing_expires_at: null }, issuedAt), false);
});

test('active source does not log pairing codes or use Math.random for enrollment', () => {
  const root = path.join(__dirname, '..', '..');
  const socket = fs.readFileSync(path.join(root, 'server', 'ws', 'deviceSocket.js'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'server', 'player', 'index.html'), 'utf8');
  const android = fs.readFileSync(
    path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'remotedisplay', 'player', 'service', 'WebSocketService.kt'),
    'utf8',
  );
  assert.doesNotMatch(socket, /with pairing code:\s*\$\{pairing_code\}/);
  assert.doesNotMatch(player, /Math\.random\(\).*900000/);
  assert.doesNotMatch(player, /pairing_code=\$\{data\.pairing_code/);
  assert.doesNotMatch(android, /\(100000\.\.999999\)\.random\(\)/);
});

test('legacy Hub password sync receiver is absent from the active server', () => {
  const root = path.join(__dirname, '..', '..');
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /routes\/admin-sync|\/api\/admin.*users\/sync/);
  assert.equal(fs.existsSync(path.join(root, 'server', 'routes', 'admin-sync.js')), false);
});

test('pairing claim is an atomic single-use update', () => {
  const root = path.join(__dirname, '..', '..');
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  assert.match(server, /WHERE id = \? AND pairing_code = \? AND pairing_expires_at > strftime/);
  assert.match(server, /claimed\.changes !== 1/);
});
