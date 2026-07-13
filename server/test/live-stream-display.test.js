const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const {
  DEFAULT_LIVE_STREAM_DISPLAY_NAME,
  buildLiveStreamPlayerUrl,
  ensureLiveStreamDisplay,
  LIVE_CONTENT_MAX_AGE_SECONDS,
  liveStreamDeviceId,
  liveStreamProgramState,
  loadLiveStreamDisplay,
  markLiveContentChanged,
} = require('../lib/live-stream-display');

function cleanup(prefix) {
  db.prepare('DELETE FROM devices WHERE id LIKE ? OR workspace_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM playlists WHERE id LIKE ? OR workspace_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
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
    .run(userId, `${prefix}user@example.test`, 'Live Stream Test User');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(orgId, 'Live Stream Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, orgId, 'Live Stream Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  return { userId, workspaceId };
}

test('ensureLiveStreamDisplay creates a stable managed display target', () => {
  const prefix = `test-live-display-${Date.now()}-`;
  const { userId, workspaceId } = seedWorkspace(prefix);
  try {
    const display = ensureLiveStreamDisplay({ workspaceId, userId });
    assert.equal(display.id, liveStreamDeviceId(workspaceId));
    assert.equal(display.name, DEFAULT_LIVE_STREAM_DISPLAY_NAME);
    assert.equal(display.workspace_id, workspaceId);
    assert.equal(display.user_id, userId);
    assert.equal(display.status, 'offline');
    assert.equal(display.screen_width, 1920);
    assert.equal(display.screen_height, 1080);
    assert.ok(display.device_token && display.device_token.length >= 32);
  } finally {
    cleanup(prefix);
  }
});

test('ensureLiveStreamDisplay is idempotent and preserves device token', () => {
  const prefix = `test-live-display-idem-${Date.now()}-`;
  const { userId, workspaceId } = seedWorkspace(prefix);
  try {
    const first = ensureLiveStreamDisplay({ workspaceId, userId });
    const second = ensureLiveStreamDisplay({ workspaceId, userId });
    assert.equal(second.id, first.id);
    assert.equal(second.device_token, first.device_token);
    const rows = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE id = ?').get(first.id);
    assert.equal(rows.count, 1);
  } finally {
    cleanup(prefix);
  }
});

test('loadLiveStreamDisplay requires the matching device token', () => {
  const prefix = `test-live-display-auth-${Date.now()}-`;
  const { userId, workspaceId } = seedWorkspace(prefix);
  try {
    const display = ensureLiveStreamDisplay({ workspaceId, userId });
    assert.equal(loadLiveStreamDisplay(display.id, 'wrong-token'), null);
    assert.equal(loadLiveStreamDisplay(display.id, display.device_token).id, display.id);
  } finally {
    cleanup(prefix);
  }
});

test('buildLiveStreamPlayerUrl points at the tokenized live stream player route', () => {
  const display = { id: 'live-stream-program-test', device_token: 'secret-token' };
  const url = buildLiveStreamPlayerUrl({ baseUrl: 'https://media-control.example.test/', display });
  assert.equal(url, 'https://media-control.example.test/player/live-stream?device_id=live-stream-program-test&token=secret-token');
});

test('abandoned live content expires and becomes active again when freshly routed', () => {
  const prefix = `test-live-stale-${Date.now()}-`;
  const { userId, workspaceId } = seedWorkspace(prefix);
  try {
    const display = ensureLiveStreamDisplay({ workspaceId, userId });
    const playlistId = `${prefix}playlist`;
    const oldTimestamp = Math.floor(Date.now() / 1000) - LIVE_CONTENT_MAX_AGE_SECONDS - 60;
    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, updated_at)
      VALUES (?, ?, ?, 'Old live program', 'published', ?, ?)
    `).run(playlistId, userId, workspaceId, JSON.stringify([{ remote_url: 'https://example.test/old' }]), oldTimestamp);
    db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, display.id);

    const stale = liveStreamProgramState(workspaceId);
    assert.equal(stale.content_available, true);
    assert.equal(stale.content_stale, true);
    assert.equal(stale.content_active, false);

    markLiveContentChanged(display.id);
    const fresh = liveStreamProgramState(workspaceId);
    assert.equal(fresh.content_stale, false);
    assert.equal(fresh.content_active, true);
  } finally {
    cleanup(prefix);
  }
});
