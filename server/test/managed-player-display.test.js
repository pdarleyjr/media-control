const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');
installIsolatedTestDatabase('managed-player-display');
const { db } = require('../db/database');
const {
  authorizeManagedDisplayAudio,
  buildManagedPlayerUrl,
  isClassroomAudioAuthority,
  loadManagedDisplay,
} = require('../lib/managed-player-display');
const { normalizePlayerAccessQuery } = require('../lib/player-access');

function cleanup(prefix) {
  db.prepare('DELETE FROM devices WHERE id LIKE ? OR workspace_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspaces WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM organizations WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?').run(`${prefix}%`, `${prefix}%@example.test`);
}

function seedWorkspace(prefix) {
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  cleanup(prefix);
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')")
    .run(userId, `${prefix}user@example.test`, 'Managed Player Test User');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(orgId, 'Managed Player Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, orgId, 'Managed Player Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  return { userId, workspaceId };
}

test('loadManagedDisplay requires an assigned device and matching token', () => {
  const prefix = `test-managed-player-${Date.now()}-`;
  const { userId, workspaceId } = seedWorkspace(prefix);
  const deviceId = `${prefix}device`;
  const token = `${prefix}token`;
  try {
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token)
      VALUES (?, ?, ?, ?, NULL, 'offline', ?)
    `).run(deviceId, userId, workspaceId, 'Managed Classroom Display', token);

    assert.equal(loadManagedDisplay(deviceId, 'wrong-token'), null);
    const display = loadManagedDisplay(deviceId, token);
    assert.equal(display.id, deviceId);
    assert.equal(display.name, 'Managed Classroom Display');
  } finally {
    cleanup(prefix);
  }
});

test('loadManagedDisplay rejects unassigned pairing rows', () => {
  const prefix = `test-managed-player-unassigned-${Date.now()}-`;
  const deviceId = `${prefix}device`;
  const token = `${prefix}token`;
  try {
    db.prepare(`
      INSERT INTO devices (id, name, pairing_code, status, device_token)
      VALUES (?, 'Unassigned Display', '123456', 'provisioning', ?)
    `).run(deviceId, token);

    assert.equal(loadManagedDisplay(deviceId, token), null);
  } finally {
    cleanup(prefix);
  }
});

test('buildManagedPlayerUrl points at the tokenized managed player route', () => {
  const display = { id: 'classroom-display-test', device_token: 'secret-token' };
  const url = buildManagedPlayerUrl({ baseUrl: 'https://media-control.example.test/', display });
  assert.equal(url, 'https://media-control.example.test/player/managed?device_id=classroom-display-test&token=secret-token');
});

test('normalizePlayerAccessQuery accepts canonical and legacy parameter names', () => {
  assert.deepEqual(
    normalizePlayerAccessQuery({ device_id: 'display-a', token: 'tok-a', audio_enabled: '1' }),
    { deviceId: 'display-a', token: 'tok-a', audioEnabled: true }
  );
  assert.deepEqual(
    normalizePlayerAccessQuery({ deviceId: 'display-b', deviceToken: 'tok-b', audioEnabled: 1 }),
    { deviceId: 'display-b', token: 'tok-b', audioEnabled: true }
  );
});

test('managed-player audio is fail-muted except for the authenticated Front Left eARC display', () => {
  const frontLeft = { id: 'fl', name: 'Classroom 1 - Front Left' };
  const frontCenter = { id: 'fc', name: 'Classroom 1 - Front Center' };
  assert.equal(isClassroomAudioAuthority(frontLeft), true);
  assert.equal(isClassroomAudioAuthority(frontCenter), false);
  assert.equal(authorizeManagedDisplayAudio(frontLeft, true), true);
  assert.equal(authorizeManagedDisplayAudio(frontLeft, false), false);
  assert.equal(authorizeManagedDisplayAudio(frontCenter, true), false);
  assert.equal(authorizeManagedDisplayAudio(null, true), false);
});

test('managed-player route applies server-side audio authorization after token lookup', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'),
    'utf8',
  );
  const start = source.indexOf("app.get('/player/managed'");
  const end = source.indexOf("app.get('/api/live-stream/local/program-state'", start);
  const route = source.slice(start, end);
  assert.match(route, /authorizeManagedDisplayAudio\(display,\s*audioEnabled\)/);
  assert.doesNotMatch(route, /\baudioEnabled,\s*\n\s*}/);
});

test('P3 launcher requests audio only for the named Front Left display and otherwise fails muted', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'appliance', 'p3', 'kiosk-launcher.ps1'),
    'utf8',
  );
  assert.match(source, /\$displayName\s*=\s*\[string\]\$d\.name/);
  assert.match(source, /'classroom 1 - front left'/);
  assert.match(source, /if \(\$isAudioAuthority\) \{ \$playerUrl \+= '&audio_enabled=1' \}/);
  assert.match(source, /if \(-not \$isAudioAuthority\) \{ \$launchArgs \+= '--mute-audio' \}/);
  assert.doesNotMatch(source, /\$isTv1|\$d\.wall\s*-eq\s*1\s*-and\s*\$d\.label\s*-eq\s*'TV1'/);
});
