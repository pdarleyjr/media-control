const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');

function cleanup(prefix) {
  db.prepare("DELETE FROM playlist_items WHERE playlist_id LIKE ?").run(`${prefix}%`);
  db.prepare(`
    DELETE FROM playlist_items
    WHERE playlist_id IN (
      SELECT id FROM playlists WHERE user_id LIKE ? OR workspace_id LIKE ? OR name LIKE ?
    )
  `).run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM video_wall_devices WHERE wall_id LIKE ? OR device_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM video_walls WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM devices WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM content WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM playlists WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM playlists WHERE user_id LIKE ? OR workspace_id LIKE ? OR name LIKE ?")
    .run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM workspaces WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM organizations WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM users WHERE id LIKE ? OR email LIKE ?").run(`${prefix}%`, `${prefix}%@example.test`);
}

test('hybrid wall broadcast fans out only inside the selected spanned subgroup', () => {
  const prefix = `test-hybrid-wall-${Date.now()}-`;
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const wallPlaylistId = `${prefix}wall-playlist`;
  const wallId = `${prefix}wall`;
  const d1 = `${prefix}display-1`;
  const d2 = `${prefix}display-2`;
  const d3 = `${prefix}display-3`;
  const oldContent = `${prefix}old-content`;
  const newContent = `${prefix}new-content`;

  cleanup(prefix);
  try {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')")
      .run(userId, `${prefix}user@example.test`, 'Hybrid Wall Test User');
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
      .run(orgId, 'Hybrid Wall Test Org', userId);
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(workspaceId, orgId, 'Hybrid Wall Test Workspace', userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, userId);

    for (const [id, filename] of [[oldContent, 'old.png'], [newContent, 'new.png']]) {
      db.prepare(`
        INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
        VALUES (?, ?, ?, ?, ?, 'image/png', 1)
      `).run(id, userId, workspaceId, filename, filename);
    }
    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated, status, published_snapshot)
      VALUES (?, ?, ?, ?, 1, 'published', '[]')
    `).run(wallPlaylistId, userId, workspaceId, 'Hybrid shared playlist');
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, 10)')
      .run(wallPlaylistId, oldContent);

    const groups = [
      {
        id: `${wallId}:solo`,
        name: 'Display 1',
        layout: 'solo',
        member_ids: [d1],
        leader_device_id: d1,
        geometry: { columns: 1, rows: 1 },
        playlist_id: wallPlaylistId,
        audio_policy: { mode: 'managed-display' },
      },
      {
        id: `${wallId}:span`,
        name: 'Displays 2+3',
        layout: 'span',
        member_ids: [d2, d3],
        leader_device_id: d2,
        geometry: { columns: 2, rows: 1 },
        playlist_id: wallPlaylistId,
        audio_policy: { mode: 'managed-display' },
      },
    ];
    const layout = { version: 1, id: `${wallId}:layout:1`, wall_id: wallId, mode: 'groups', revision: 1, groups };
    db.prepare(`
      INSERT INTO video_walls
        (id, user_id, workspace_id, name, grid_cols, grid_rows, playlist_id, leader_device_id,
         layout_mode, layout_json, layout_revision)
      VALUES (?, ?, ?, ?, 3, 1, ?, ?, 'groups', ?, 1)
    `).run(wallId, userId, workspaceId, 'Hybrid Wall', wallPlaylistId, null, JSON.stringify(layout));

    for (const [index, deviceId] of [d1, d2, d3].entries()) {
      db.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, status, playlist_id, wall_id)
        VALUES (?, ?, ?, ?, 'online', ?, ?)
      `).run(deviceId, userId, workspaceId, `Display ${index + 1}`, wallPlaylistId, wallId);
      db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, ?, 0)')
        .run(wallId, deviceId, index);
    }
    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(d1, wallId);

    const ok = sceneEngine.pushSourceToDevice(null, d2, { content_id: newContent }, {
      workspaceId,
      userId,
      targetDeviceIds: [d2, d3],
    });
    assert.equal(ok, true);

    const playlists = [d1, d2, d3].map((id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id);
    assert.equal(playlists[0], wallPlaylistId, 'solo subgroup retains its prior playlist');
    assert.notEqual(playlists[1], wallPlaylistId, 'spanned subgroup receives a private playlist');
    assert.equal(playlists[2], playlists[1], 'only the selected span follower receives the new playlist');

    const stored = JSON.parse(db.prepare('SELECT layout_json FROM video_walls WHERE id = ?').get(wallId).layout_json);
    assert.equal(stored.groups[0].playlist_id, wallPlaylistId, 'solo subgroup authority remains unchanged');
    assert.equal(stored.groups[1].playlist_id, playlists[1], 'span subgroup authority tracks its new playlist');

    const oldItems = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(wallPlaylistId);
    const newItems = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ?').all(playlists[1]);
    assert.deepEqual(oldItems.map((row) => row.content_id), [oldContent]);
    assert.deepEqual(newItems.map((row) => row.content_id), [newContent]);
  } finally {
    cleanup(prefix);
  }
});
