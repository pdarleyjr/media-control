const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

// Isolated temp DB so this test never touches the real one. Must be set BEFORE
// requiring anything that opens the database. Mirrors upload-policy.test.js.
const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-audit-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { audit, getAuditLog, redact, serializeDetails } = require('../lib/audit');
const { db } = require('../db/database');

process.on('exit', () => {
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('migration created the audit_log table', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
  ).get();
  assert.ok(row, 'audit_log table exists');
});

test('clean databases install durable display-topology guards at boot', () => {
  const requiredObjects = [
    ['index', 'ux_device_group_members_one_group'],
    ['index', 'ux_video_wall_devices_one_wall'],
    ['index', 'ux_device_groups_workspace_name'],
    ['trigger', 'trg_wall_membership_valid_insert'],
    ['trigger', 'trg_group_membership_valid_insert'],
    ['trigger', 'trg_wall_leader_valid_insert'],
    ['trigger', 'trg_wall_leader_valid_update'],
  ];

  for (const [type, name] of requiredObjects) {
    const row = db.prepare(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
    ).get(type, name);
    assert.ok(row, `${type} ${name} exists`);
  }
});

test('audit() writes a row for a display-control action with who/what/when/where', () => {
  audit({
    actorType: 'user',
    actorId: 'user-42',
    action: 'display.command',
    targetType: 'device',
    targetId: 'device-7',
    workspaceId: 'ws-1',
    sourceIp: '203.0.113.9',
    details: { type: 'screen_off', delivered: true },
  });

  const rows = getAuditLog({ targetId: 'device-7' });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.actor_type, 'user');
  assert.equal(r.actor_id, 'user-42');
  assert.equal(r.action, 'display.command');
  assert.equal(r.target_type, 'device');
  assert.equal(r.target_id, 'device-7');
  assert.equal(r.workspace_id, 'ws-1');
  assert.equal(r.source_ip, '203.0.113.9');
  assert.ok(r.created_at > 0, 'timestamp recorded');
  const details = JSON.parse(r.details);
  assert.equal(details.type, 'screen_off');
  assert.equal(details.delivered, true);
});

test('audit() REDACTS secret-named fields before persisting', () => {
  audit({
    actorType: 'user',
    actorId: 'user-99',
    action: 'device.pair',
    targetType: 'device',
    targetId: 'device-secret',
    workspaceId: 'ws-2',
    sourceIp: '198.51.100.5',
    details: {
      name: 'Lobby TV',
      pairing_code: 'SUPER-SECRET-1234',
      device_token: 'eyJhbGciOi.tok.en',
      authorization: 'Bearer abc.def.ghi',
      nested: { api_key: 'sk-live-zzz', ok: 'visible' },
    },
  });

  const rows = getAuditLog({ targetId: 'device-secret' });
  assert.equal(rows.length, 1);
  const raw = rows[0].details;
  // No secret VALUE should appear anywhere in the stored JSON.
  assert.ok(!raw.includes('SUPER-SECRET-1234'), 'pairing_code value redacted');
  assert.ok(!raw.includes('eyJhbGciOi.tok.en'), 'device_token value redacted');
  assert.ok(!raw.includes('abc.def.ghi'), 'authorization value redacted');
  assert.ok(!raw.includes('sk-live-zzz'), 'nested api_key value redacted');
  // Non-secret fields survive.
  const details = JSON.parse(raw);
  assert.equal(details.name, 'Lobby TV');
  assert.equal(details.nested.ok, 'visible');
  assert.equal(details.pairing_code, '[redacted]');
  assert.equal(details.nested.api_key, '[redacted]');
});

test('redact() scrubs token-shaped values embedded in free-text strings', () => {
  const out = redact({
    url: 'https://cam.example.com/play?token=abcdef123456&id=7',
    note: 'Authorization: Bearer eyJsuperSecretToken',
  });
  assert.ok(!out.url.includes('abcdef123456'), 'token query param value scrubbed');
  assert.ok(out.url.includes('id=7'), 'non-secret query param preserved');
  assert.ok(!out.note.includes('eyJsuperSecretToken'), 'inline bearer token scrubbed');
});

test('serializeDetails caps oversized payloads and never throws', () => {
  const big = { blob: 'x'.repeat(10000) };
  const json = serializeDetails(big);
  assert.ok(typeof json === 'string');
  assert.ok(json.length <= 4100, 'bounded length');
  // Circular structure must not throw — the depth bound truncates it safely and
  // still yields valid, parseable JSON (never crashes the audit path).
  const circ = {}; circ.self = circ;
  const circJson = serializeDetails(circ);
  assert.ok(typeof circJson === 'string', 'circular structure serialized without throwing');
  assert.doesNotThrow(() => JSON.parse(circJson), 'output is valid JSON');
  assert.ok(circJson.includes('[truncated]'), 'depth bound applied');
});

test('audit() is best-effort: a missing action is a no-op (no row, no throw)', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
  audit({ actorId: 'x' }); // no action
  const after = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
  assert.equal(after, before);
});
