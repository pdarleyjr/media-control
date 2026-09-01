const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');

function cleanup(prefix) {
  db.prepare(`
    DELETE FROM playlist_items
    WHERE playlist_id IN (
      SELECT id FROM playlists
      WHERE id LIKE ? OR user_id LIKE ? OR workspace_id LIKE ?
    )
  `).run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM video_wall_devices WHERE wall_id LIKE ? OR device_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM video_walls WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM devices WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM content WHERE id LIKE ? OR user_id LIKE ? OR workspace_id LIKE ?')
    .run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM playlists WHERE id LIKE ? OR user_id LIKE ? OR workspace_id LIKE ?').run(`${prefix}%`, `${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspaces WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM organizations WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?').run(`${prefix}%`, `${prefix}%@example.test`);
}

function snapshotComputerSourceHealth() {
  return db.prepare(`
    SELECT id, enabled, availability, last_seen_at
    FROM live_sources
    WHERE id IN ('podium-computer', 'guest-computer')
  `).all();
}

function restoreComputerSourceHealth(rows) {
  const update = db.prepare(`
    UPDATE live_sources
    SET enabled = ?, availability = ?, last_seen_at = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    update.run(row.enabled, row.availability, row.last_seen_at, row.id);
  }
}

function setComputerSourceHealth(id, availability, lastSeenAt = Math.floor(Date.now() / 1000)) {
  db.prepare(`
    UPDATE live_sources
    SET enabled = 1, availability = ?, last_seen_at = ?
    WHERE id = ?
  `).run(availability, lastSeenAt, id);
}

function gridUrl(cells) {
  return `/player/grid.html?cells=${Buffer.from(JSON.stringify(cells), 'utf8').toString('base64url')}`;
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

test('the canonical Podium Computer player remains routable after another operator created its legacy private row', () => {
  const prefix = `test-podium-visibility-${Date.now()}-`;
  const ownerId = `${prefix}owner`;
  const operatorId = `${prefix}operator`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const deviceId = `${prefix}display`;
  const contentId = `${prefix}podium-content`;
  const gridContentId = `${prefix}grid-content`;
  const remoteUrl = `/player/live-source.html?source=podium-computer&test=${encodeURIComponent(prefix)}`;
  const gridRemoteUrl = gridUrl({
    C1: { u: remoteUrl, l: 'Podium', k: 'i' },
    C2: { l: 'Screen Share', k: 'share' },
    R1: { u: '/api/content/private-training/file', l: 'Private Training', k: 'i' },
  });
  const priorComputerHealth = snapshotComputerSourceHealth();

  cleanup(prefix);
  try {
    setComputerSourceHealth('podium-computer', 'available');
    const insertUser = db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')");
    insertUser.run(ownerId, `${prefix}owner@example.test`, 'Legacy Podium Owner');
    insertUser.run(operatorId, `${prefix}operator@example.test`, 'Current Classroom Operator');
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
      .run(orgId, 'Podium Visibility Org', ownerId);
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(workspaceId, orgId, 'Guest Visibility Workspace', ownerId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, ownerId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')")
      .run(workspaceId, operatorId);
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, 'Podium Computer', '', 'text/html', 0, ?, 'private')
    `).run(contentId, ownerId, workspaceId, remoteUrl);
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, status)
      VALUES (?, ?, ?, 'Guest Route Display', 'online')
    `).run(deviceId, ownerId, workspaceId);
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, 'Private Mixed Grid', '', 'text/html', 0, ?, 'private')
    `).run(gridContentId, operatorId, workspaceId, gridRemoteUrl);

    assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: remoteUrl }, {
      workspaceId,
      userId: operatorId,
      contentContext: {
        userId: operatorId,
        workspaceId,
        workspaceRole: 'workspace_editor',
      },
      targetDeviceIds: [deviceId],
    }), true);
    assert.equal(
      db.prepare('SELECT access_level FROM content WHERE id = ?').get(contentId).access_level,
      'workspace_shared'
    );
    assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: gridRemoteUrl }, {
      workspaceId,
      userId: operatorId,
      contentContext: {
        userId: operatorId,
        workspaceId,
        workspaceRole: 'workspace_editor',
      },
      targetDeviceIds: [deviceId],
    }), true);
    assert.equal(
      db.prepare('SELECT access_level FROM content WHERE id = ?').get(gridContentId).access_level,
      'private',
      'a composite is health-fenced but does not inherit the direct managed-source sharing exception',
    );
  } finally {
    restoreComputerSourceHealth(priorComputerHealth);
    cleanup(prefix);
  }
});

test('unavailable or stale Podium/Guest computer content fails closed before a scene or direct route can mutate a display', () => {
  const prefix = `test-computer-route-health-${Date.now()}-`;
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const deviceId = `${prefix}display`;
  const podiumContentId = `${prefix}podium-content`;
  const absolutePodiumContentId = `${prefix}absolute-podium-content`;
  const foreignPodiumContentId = `${prefix}foreign-podium-content`;
  const playlistId = `${prefix}podium-playlist`;
  const podiumUrl = `/player/live-source.html?source=podium-computer&test=${encodeURIComponent(prefix)}`;
  const absolutePodiumUrl = `https://media.mbfdhub.com/player/live-source.html?source=podium-computer&test=${encodeURIComponent(prefix)}`;
  const foreignPodiumUrl = `https://example.invalid/player/live-source.html?source=podium-computer&test=${encodeURIComponent(prefix)}`;
  const guestUrl = `/player/live-source.html?source=guest-computer&test=${encodeURIComponent(prefix)}`;
  const priorComputerHealth = snapshotComputerSourceHealth();

  cleanup(prefix);
  try {
    db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Computer Route User', 'platform_admin')")
      .run(userId, `${prefix}@example.test`);
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
      .run(orgId, 'Computer Route Org', userId);
    db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
      .run(workspaceId, orgId, 'Computer Route Workspace', userId);
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
      .run(workspaceId, userId);
    db.prepare(`
      INSERT INTO devices (id, user_id, workspace_id, name, status)
      VALUES (?, ?, ?, 'Computer Route Display', 'online')
    `).run(deviceId, userId, workspaceId);
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, 'Podium Computer', '', 'text/html', 0, ?, 'workspace_shared')
    `).run(podiumContentId, userId, workspaceId, podiumUrl);
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, 'Absolute Podium Computer', '', 'text/html', 0, ?, 'workspace_shared')
    `).run(absolutePodiumContentId, userId, workspaceId, absolutePodiumUrl);
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, 'Foreign Podium Computer', '', 'text/html', 0, ?, 'workspace_shared')
    `).run(foreignPodiumContentId, userId, workspaceId, foreignPodiumUrl);
    db.prepare(`
      INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated, status, published_snapshot)
      VALUES (?, ?, ?, 'Podium Health Playlist', 0, 'published', '[]')
    `).run(playlistId, userId, workspaceId);
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, 0, 10)')
      .run(playlistId, podiumContentId);

    setComputerSourceHealth('podium-computer', 'unavailable');
    setComputerSourceHealth('guest-computer', 'available');
    const common = {
      workspaceId,
      userId,
      contentContext: { userId, workspaceId, workspaceRole: 'workspace_admin' },
      targetDeviceIds: [deviceId],
    };

    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: podiumUrl }, common),
      false,
      'a direct offline Podium URL is rejected before a content row can be created',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: absolutePodiumUrl }, common),
      false,
      'a canonical absolute Podium player URL is health-fenced like its root-relative form',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: foreignPodiumUrl }, common),
      false,
      'a foreign host cannot impersonate an app-owned Podium player URL',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { content_id: podiumContentId }, common),
      false,
      'a persisted offline Podium content item is rejected',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { content_id: absolutePodiumContentId }, common),
      false,
      'a persisted canonical absolute Podium player row cannot bypass health',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { content_id: foreignPodiumContentId }, common),
      false,
      'a persisted foreign-host player row cannot bypass the canonical source allowlist',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { playlist_id: playlistId }, common),
      false,
      'a scene/playlist cannot bypass the managed-computer health fence',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, {
        remote_url: gridUrl({
          C1: { u: podiumUrl, l: 'Podium', k: 'i' },
          C2: { l: 'Screen Share', k: 'share' },
          R1: { u: '/player/hls.html?station=mbtv', l: 'News', k: 'i' },
        }),
      }, common),
      false,
      'a Multiview grid cannot bypass an unavailable nested Podium source while Screen Share/news remain non-computer cells',
    );
    assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(deviceId).playlist_id, null);

    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: guestUrl }, common),
      true,
      'the separately healthy Guest publisher remains routable',
    );

    setComputerSourceHealth('guest-computer', 'available', Math.floor(Date.now() / 1000) - 61);
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, { remote_url: guestUrl }, common),
      false,
      'a stale health record is not evidence that a computer remains routable',
    );
    assert.equal(
      sceneEngine.pushSourceToDevice(null, deviceId, {
        remote_url: gridUrl({ C1: { u: guestUrl, l: 'Guest', k: 'i' } }),
      }, common),
      false,
      'a Multiview grid cannot bypass a stale nested Guest source',
    );
  } finally {
    restoreComputerSourceHealth(priorComputerHealth);
    cleanup(prefix);
  }
});
