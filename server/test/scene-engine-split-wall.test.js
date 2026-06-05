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
  db.prepare("DELETE FROM playlists WHERE user_id LIKE ? OR workspace_id LIKE ? OR name LIKE ?").run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM workspaces WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?").run(`${prefix}%`, `${prefix}%`);
  db.prepare("DELETE FROM organizations WHERE id LIKE ?").run(`${prefix}%`);
  db.prepare("DELETE FROM users WHERE id LIKE ? OR email LIKE ?").run(`${prefix}%`, `${prefix}%@example.test`);
}

test('split wall cell broadcast creates a private playlist and preserves sibling previews', () => {
  const prefix = `test-split-wall-${Date.now()}-`;
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const wallPlaylistId = `${prefix}wall-playlist`;
  const wallId = `${prefix}wall`;
  const d1 = `${prefix}display-a`;
  const d2 = `${prefix}display-b`;
  const oldContent = `${prefix}old-content`;
  const newContent = `${prefix}new-content`;

  cleanup(prefix);
  try {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')")
      .run(userId, `${prefix}user@example.test`, 'Split Wall Test User');
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
      .run(orgId, 'Split Wall Test Org', userId);
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(workspaceId, orgId, 'Split Wall Test Workspace', userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, userId);

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(oldContent, userId, workspaceId, 'old.png', 'old.png', 'image/png');
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(newContent, userId, workspaceId, 'new.png', 'new.png', 'image/png');

    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated, status, published_snapshot)
      VALUES (?, ?, ?, ?, 1, 'published', '[]')
    `).run(wallPlaylistId, userId, workspaceId, 'Shared wall playlist');
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, 10)')
      .run(wallPlaylistId, oldContent);

    db.prepare(`
      INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, playlist_id, leader_device_id, layout_mode)
      VALUES (?, ?, ?, ?, 2, 1, ?, ?, 'split')
    `).run(wallId, userId, workspaceId, 'Split Wall', wallPlaylistId, null);
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, status, playlist_id, wall_id)
      VALUES (?, ?, ?, ?, 'online', ?, ?)
    `).run(d1, userId, workspaceId, 'Wall Left', wallPlaylistId, wallId);
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, status, playlist_id, wall_id)
      VALUES (?, ?, ?, ?, 'online', ?, ?)
    `).run(d2, userId, workspaceId, 'Wall Right', wallPlaylistId, wallId);
    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(d1, wallId);
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 0, 0)')
      .run(wallId, d1);
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, 1, 0)')
      .run(wallId, d2);

    const ok = sceneEngine.pushSourceToDevice(null, d1, { content_id: newContent }, { workspaceId, userId });
    assert.equal(ok, true);

    const afterA = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(d1).playlist_id;
    const afterB = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(d2).playlist_id;
    assert.notEqual(afterA, wallPlaylistId, 'target display receives a private auto playlist');
    assert.equal(afterB, wallPlaylistId, 'sibling display remains on the shared wall playlist');

    const wallItems = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(wallPlaylistId);
    assert.deepEqual(wallItems.map(r => r.content_id), [oldContent], 'shared wall playlist is not mutated');

    const privateItems = db.prepare('SELECT content_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(afterA);
    assert.deepEqual(privateItems.map(r => r.content_id), [newContent], 'target private playlist receives only the dropped content');
  } finally {
    cleanup(prefix);
  }
});
