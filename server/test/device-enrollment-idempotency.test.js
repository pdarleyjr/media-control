const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  bindEnrollmentFingerprint,
  findReusablePendingEnrollment,
} = require('../lib/device-enrollment');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      workspace_id TEXT,
      pairing_code TEXT UNIQUE,
      retired INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE device_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      device_id TEXT,
      first_seen INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_seen INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

test('a reconnect with the same pending pairing code reuses one enrollment row', () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO devices (id, pairing_code)
      VALUES ('pending-display', '123456')
    `).run();
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, pairing_code)
      VALUES ('claimed-display', 'user-1', 'ws-1', '654321')
    `).run();
    db.prepare(`
      INSERT INTO devices (id, pairing_code, retired)
      VALUES ('retired-display', '111111', 1)
    `).run();

    assert.equal(
      findReusablePendingEnrollment(db, '123456').id,
      'pending-display',
    );
    assert.equal(findReusablePendingEnrollment(db, '654321'), null);
    assert.equal(findReusablePendingEnrollment(db, '111111'), null);
  } finally {
    db.close();
  }
});

test('fingerprint binding repairs null rows without stealing another display identity', () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO device_fingerprints (fingerprint, device_id)
      VALUES ('shared-browser-fingerprint', NULL)
    `).run();

    assert.equal(
      bindEnrollmentFingerprint(db, 'shared-browser-fingerprint', 'display-a'),
      true,
    );
    assert.equal(
      db.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?')
        .get('shared-browser-fingerprint').device_id,
      'display-a',
    );

    assert.equal(
      bindEnrollmentFingerprint(db, 'shared-browser-fingerprint', 'display-b'),
      false,
      'an identical browser fingerprint must not collapse an additional physical display',
    );
    assert.equal(
      db.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?')
        .get('shared-browser-fingerprint').device_id,
      'display-a',
    );
  } finally {
    db.close();
  }
});

test('web player reconnects with provisional credentials instead of creating a fresh display', () => {
  const player = fs.readFileSync(
    path.join(__dirname, '..', 'player', 'index.html'),
    'utf8',
  );
  const socket = fs.readFileSync(
    path.join(__dirname, '..', 'ws', 'deviceSocket.js'),
    'utf8',
  );

  assert.match(player, /config\.deviceId && \(config\.paired \|\| config\.deviceToken\)/);
  assert.match(player, /const code = config\.pairingCode \|\| String\(/);
  assert.match(socket, /findReusablePendingEnrollment\(db, pairing_code\)/);
  assert.match(socket, /bindEnrollmentFingerprint\(db, fingerprint, id\)/);
  assert.doesNotMatch(
    socket,
    /Fingerprint match: linking reinstalled app/,
    'a browser fingerprint must never reclaim another physical display identity',
  );
  assert.doesNotMatch(
    socket,
    /DELETE FROM device_fingerprints/,
    'adding an identical display must not detach the existing display fingerprint',
  );
});
