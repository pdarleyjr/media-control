const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');
installIsolatedTestDatabase('managed-player-display');
const { db } = require('../db/database');
const {
  buildManagedPlayerUrl,
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
