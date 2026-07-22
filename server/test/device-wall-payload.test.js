const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { db } = require('../db/database');
const deviceSocket = require('../ws/deviceSocket');

function cleanup(prefix) {
  db.prepare("DELETE FROM display_states WHERE target_id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM video_wall_devices WHERE wall_id LIKE ? OR device_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM video_walls WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM devices WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM content WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM workspaces WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM organizations WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM users WHERE id LIKE ? OR email LIKE ?").run(`${prefix}%`, `${prefix}%@example.test`);
}

test('device playlist payload exposes universal geometry and backward-compatible rects from real mixed panel sizes', () => {
  const prefix = `test-device-wall-payload-${Date.now()}-`;
  const userId = `${prefix}user`;
  const organizationId = `${prefix}organization`;
  const workspaceId = `${prefix}workspace`;
  const wallId = `${prefix}wall`;
  const contentId = `${prefix}content`;
  const leftId = `${prefix}left`;
  const rightId = `${prefix}right`;

  cleanup(prefix);
  try {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Payload User', 'platform_admin')")
      .run(userId, `${prefix}user@example.test`);
    db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Payload Org', ?)")
      .run(organizationId, userId);
    db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Payload Workspace', ?)")
      .run(workspaceId, organizationId, userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, userId);
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
      VALUES (?, ?, ?, 'program.mp4', 'program.mp4', 'video/mp4', 1)
    `).run(contentId, userId, workspaceId);
    db.prepare(`
      INSERT INTO video_walls
        (id, user_id, workspace_id, name, grid_cols, grid_rows, screen_w_mm, screen_h_mm,
         bezel_h_mm, bezel_v_mm, layout_mode, layout_revision, content_id)
      VALUES (?, ?, ?, 'Mixed wall', 2, 1, 1000, 600, 10, 0, 'span', 3, ?)
    `).run(wallId, userId, workspaceId, contentId);

    for (const [id, name, width, height] of [
      [leftId, 'Left', 1920, 1080],
      [rightId, 'Right', 3840, 2160],
    ]) {
      db.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, status, screen_width, screen_height, wall_id)
        VALUES (?, ?, ?, ?, 'online', ?, ?, ?)
      `).run(id, userId, workspaceId, name, width, height, wallId);
    }
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0)')
      .run(wallId, leftId);
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 1, 0)')
      .run(wallId, rightId);
    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(leftId, wallId);

    assert.equal(typeof deviceSocket.buildPlaylistPayload, 'function');
    const payload = deviceSocket.buildPlaylistPayload(rightId);

    assert.equal(payload.layout_assignment.layout_id, `${wallId}:layout:3`);
    assert.equal(payload.layout_assignment.layout_revision, 3);
    assert.equal(payload.layout_assignment.content_id, contentId);
    assert.deepEqual(payload.layout_assignment.logical_canvas, { width: 5789, height: 2160 });
    assert.deepEqual(payload.layout_assignment.viewport, { x: 1949, y: 0, w: 3840, h: 2160 });
    assert.equal(payload.layout_assignment.fit_mode, null);
    assert.equal(payload.layout_assignment.synchronized_start_at, null);
    assert.deepEqual(payload.wall_config.screen_rect, { x: 1949, y: 0, w: 3840, h: 2160 });
    assert.deepEqual(payload.wall_config.player_rect, { x: 0, y: 0, w: 5789, h: 2160 });
    assert.deepEqual(payload.wall_config.logical_canvas, payload.layout_assignment.logical_canvas);
    assert.deepEqual(payload.wall_config.viewport, payload.layout_assignment.viewport);
  } finally {
    cleanup(prefix);
  }
});

test('device transitions schedule coalesced authoritative room snapshots without making heartbeats revision events', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(source, /scheduleRoomSnapshot/);
  assert.match(source, /scheduleDeviceRoomSnapshot\(io, existing\.device_id, 'device:online'\)/);
  assert.match(source, /scheduleDeviceRoomSnapshot\(io, device_id, 'device:online'\)/);
  assert.match(source, /scheduleDeviceRoomSnapshot\(io, currentDeviceId, 'device:state-report'\)/);
  assert.match(source, /scheduleDeviceRoomSnapshot\(io, deviceId, 'device:offline'\)/);
  const heartbeatBlock = source.slice(source.indexOf("socket.on('device:heartbeat'"), source.indexOf("socket.on('device:playlist-sync'"));
  assert.doesNotMatch(heartbeatBlock, /scheduleDeviceRoomSnapshot/);
});
