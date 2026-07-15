const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');

function cleanup(prefix) {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE id LIKE ?)').run(`${prefix}%`);
  db.prepare('DELETE FROM video_wall_devices WHERE wall_id LIKE ? OR device_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM video_walls WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM devices WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM content WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM playlists WHERE id LIKE ? OR user_id LIKE ? OR workspace_id LIKE ?').run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspaces WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM organizations WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?').run(`${prefix}%`, `${prefix}%@example.test`);
}

test('a wall broadcast forks a playlist shared with another wall', () => {
  const prefix = `test-wall-isolation-${Date.now()}-`;
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const sharedPlaylistId = `${prefix}shared-playlist`;
  const primaryWallId = `${prefix}primary-wall`;
  const secondaryWallId = `${prefix}secondary-wall`;
  const primaryIds = [0, 1, 2].map((index) => `${prefix}primary-${index}`);
  const secondaryIds = [0, 1].map((index) => `${prefix}secondary-${index}`);
  const oldContentId = `${prefix}old-content`;
  const primaryContentId = `${prefix}primary-content`;
  const secondaryContentId = `${prefix}secondary-content`;

  cleanup(prefix);
  try {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Wall Isolation User', 'platform_admin')")
      .run(userId, `${prefix}@example.test`);
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
      .run(orgId, 'Wall Isolation Org', userId);
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(workspaceId, orgId, 'Wall Isolation Workspace', userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, userId);

    const insertContent = db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, 'image/png', 1)
    `);
    insertContent.run(oldContentId, userId, workspaceId, 'old.png', 'old.png');
    insertContent.run(primaryContentId, userId, workspaceId, 'primary.png', 'primary.png');
    insertContent.run(secondaryContentId, userId, workspaceId, 'secondary.png', 'secondary.png');

    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated, status, published_snapshot)
      VALUES (?, ?, ?, 'Shared all-displays playlist', 1, 'published', '[]')
    `).run(sharedPlaylistId, userId, workspaceId);
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, 10)')
      .run(sharedPlaylistId, oldContentId);

    const insertWall = db.prepare(`
      INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, playlist_id, layout_mode)
      VALUES (?, ?, ?, ?, ?, 1, ?, 'span')
    `);
    insertWall.run(primaryWallId, userId, workspaceId, 'Primary Wall', 3, sharedPlaylistId);
    insertWall.run(secondaryWallId, userId, workspaceId, 'Secondary Wall', 2, sharedPlaylistId);

    const insertDevice = db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, status, playlist_id, wall_id)
      VALUES (?, ?, ?, ?, 'online', ?, ?)
    `);
    const insertMember = db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, ?, 0)');
    primaryIds.forEach((id, index) => {
      insertDevice.run(id, userId, workspaceId, `Primary ${index}`, sharedPlaylistId, primaryWallId);
      insertMember.run(primaryWallId, id, index);
    });
    secondaryIds.forEach((id, index) => {
      insertDevice.run(id, userId, workspaceId, `Secondary ${index}`, sharedPlaylistId, secondaryWallId);
      insertMember.run(secondaryWallId, id, index);
    });

    for (const deviceId of primaryIds) {
      assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, { content_id: primaryContentId }, {
        workspaceId,
        userId,
        targetDeviceIds: primaryIds,
      }), true);
    }

    const primaryPlaylists = primaryIds.map((id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id);
    const secondaryPlaylists = secondaryIds.map((id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id);
    assert.equal(new Set(primaryPlaylists).size, 1, 'primary wall members share one new playback playlist');
    assert.notEqual(primaryPlaylists[0], sharedPlaylistId, 'primary wall forks away from the cross-wall playlist');
    assert.deepEqual(secondaryPlaylists, [sharedPlaylistId, sharedPlaylistId], 'secondary wall remains untouched');
    assert.equal(db.prepare('SELECT playlist_id FROM video_walls WHERE id = ?').get(primaryWallId).playlist_id, primaryPlaylists[0]);
    assert.deepEqual(
      db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(primaryPlaylists[0]).map((row) => row.content_id),
      [primaryContentId]
    );
    assert.deepEqual(
      db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(sharedPlaylistId).map((row) => row.content_id),
      [oldContentId],
      'the shared source playlist is never mutated'
    );

    for (const deviceId of secondaryIds) {
      assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, { content_id: secondaryContentId }, {
        workspaceId,
        userId,
        targetDeviceIds: secondaryIds,
      }), true);
    }
    const secondaryAfter = secondaryIds.map((id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id);
    assert.equal(new Set(secondaryAfter).size, 1);
    assert.deepEqual(primaryIds.map((id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id), primaryPlaylists);
    assert.deepEqual(
      db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(secondaryAfter[0]).map((row) => row.content_id),
      [secondaryContentId]
    );
  } finally {
    cleanup(prefix);
  }
});
