const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const {
  generateEndpointToken,
  hashToken,
  normalizeSceneLayers,
  normalizeTopology,
} = require('../lib/advanced-canvas');

function cleanup(prefix) {
  db.prepare('DELETE FROM advanced_canvas_layers WHERE endpoint_id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM advanced_canvas_endpoints WHERE id LIKE ? OR workspace_id LIKE ?')
    .run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM playlist_items WHERE playlist_id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM playlists WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM content WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?')
    .run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspaces WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?')
    .run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM organizations WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?')
    .run(`${prefix}%`, `${prefix}%@example.test`);
}

function seedWorkspace(prefix) {
  const userId = `${prefix}user`;
  const organizationId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')")
    .run(userId, `${prefix}user@example.test`, 'Canvas Test User');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(organizationId, 'Canvas Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, organizationId, 'Canvas Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  return { userId, workspaceId };
}

test('advanced canvas tokens are random and stored as one-way hashes', () => {
  const first = generateEndpointToken();
  const second = generateEndpointToken();
  assert.notEqual(first, second);
  assert.equal(first.length, 64);
  assert.equal(hashToken(first).length, 64);
  assert.notEqual(hashToken(first), first);
});

test('normalizeTopology derives a five-output union without changing output identity', () => {
  const topology = normalizeTopology({
    outputs: Array.from({ length: 5 }, (_unused, index) => ({
      id: `tv-${index + 1}`,
      slug: `tv-${index + 1}`,
      x: index * 1920,
      y: 0,
      width: 1920,
      height: 1080,
    })),
  });
  assert.equal(topology.width, 9600);
  assert.equal(topology.height, 1080);
  assert.deepEqual(topology.outputs.map((output) => output.id), ['tv-1', 'tv-2', 'tv-3', 'tv-4', 'tv-5']);
});

test('normalizeSceneLayers clamps coordinates and resolves local media and playlists', async () => {
  const prefix = `test-advanced-canvas-${Date.now()}-`;
  cleanup(prefix);
  const { userId, workspaceId } = seedWorkspace(prefix);
  const imageId = `${prefix}image`;
  const playlistId = `${prefix}playlist`;
  try {
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size)
      VALUES (?, ?, ?, 'test.png', 'test.png', 'image/png', 10)
    `).run(imageId, userId, workspaceId);
    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, status)
      VALUES (?, ?, ?, 'Canvas Playlist', 'published')
    `).run(playlistId, userId, workspaceId);
    db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec)
      VALUES (?, ?, 0, 12)
    `).run(playlistId, imageId);

    const layers = await normalizeSceneLayers({
      layers: [
        {
          id: `${prefix}layer-image`,
          x: -200,
          y: 0,
          width: 12000,
          height: 1080,
          source: { content_id: imageId },
        },
        {
          id: `${prefix}layer-playlist`,
          x: 1920,
          y: 0,
          width: 1920,
          height: 1080,
          source: { playlist_id: playlistId },
        },
      ],
      workspaceId,
      canvasWidth: 9600,
      canvasHeight: 1080,
      publicBase: 'https://media-control.example.test',
      endpointId: `${prefix}endpoint`,
      canvasAssetSecret: 'test-canvas-secret',
      assertRemoteUrlSafe: async () => ({ ok: true }),
    });

    assert.equal(layers[0].x, 0);
    assert.equal(layers[0].width, 9600);
    assert.equal(layers[0].render.kind, 'image');
    assert.match(
      layers[0].render.url,
      new RegExp(`^https://media-control\\.example\\.test/player/canvas-asset/${prefix}endpoint/${imageId}/7680/1080/[A-Za-z0-9_-]+$`)
    );
    assert.equal(layers[1].render.kind, 'playlist');
    assert.equal(layers[1].render.items[0].duration_sec, 12);
  } finally {
    cleanup(prefix);
  }
});
