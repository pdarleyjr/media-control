'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('managed-computer-delivery-fence');

const { db } = require('../db/database');
const playlistsRouter = require('../routes/playlists');
const deviceSocket = require('../ws/deviceSocket');
const commandQueue = require('../lib/command-queue');
const sceneEngine = require('../services/scene-engine');
const {
  managedComputerRouteFailure,
  managedComputerRouteFailureInPlaylistItems,
} = require('../lib/managed-computer-routing');

function computerUrl(sourceId) {
  return `/player/live-source.html?source=${sourceId}`;
}

function setComputerHealth(sourceId, available) {
  db.prepare(`
    UPDATE live_sources
    SET availability = ?, last_seen_at = strftime('%s','now')
    WHERE id = ?
  `).run(available ? 'available' : 'unavailable', sourceId);
}

function seed(prefix, sourceId) {
  const userId = `${prefix}user`;
  const organizationId = `${prefix}organization`;
  const workspaceId = `${prefix}workspace`;
  const contentId = `${prefix}content`;
  const playlistId = `${prefix}playlist`;
  const oldPlaylistId = `${prefix}old-playlist`;
  const deviceId = `${prefix}device`;
  const originalSnapshot = JSON.stringify([{ remote_url: 'https://example.test/known-good' }]);
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Fence User', 'platform_admin')")
    .run(userId, `${prefix}user@example.test`);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Fence Org', ?)")
    .run(organizationId, userId);
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Fence Workspace', ?)")
    .run(workspaceId, organizationId, userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  db.prepare(`
    INSERT INTO content
      (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
    VALUES (?, ?, ?, 'managed-computer.html', '', 'text/html', 1, ?, 'workspace_shared')
  `).run(contentId, userId, workspaceId, computerUrl(sourceId));
  db.prepare(`
    INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot)
    VALUES (?, ?, ?, 'Managed computer playlist', 'published', ?)
  `).run(playlistId, userId, workspaceId, originalSnapshot);
  db.prepare(`
    INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec)
    VALUES (?, ?, 0, 10)
  `).run(playlistId, contentId);
  db.prepare(`
    INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot)
    VALUES (?, ?, ?, 'Existing device playlist', 'published', ?)
  `).run(oldPlaylistId, userId, workspaceId, JSON.stringify([]));
  db.prepare(`
    INSERT INTO devices (id, user_id, workspace_id, name, status, playlist_id)
    VALUES (?, ?, ?, 'Fence display', 'online', ?)
  `).run(deviceId, userId, workspaceId, oldPlaylistId);
  return {
    userId,
    organizationId,
    workspaceId,
    contentId,
    playlistId,
    oldPlaylistId,
    deviceId,
    originalSnapshot,
  };
}

async function makePlaylistApp(seedData, emitted) {
  const deviceNamespace = {
    adapter: { rooms: new Map([[seedData.deviceId, new Set(['online-display'])]]) },
    to(deviceId) {
      return {
        emit(event, payload) { emitted.push({ deviceId, event, payload }); },
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.set('io', { of: () => deviceNamespace });
  app.use((req, _res, next) => {
    req.workspaceId = seedData.workspaceId;
    req.organizationId = seedData.organizationId;
    req.workspaceRole = 'workspace_admin';
    req.orgRole = 'org_owner';
    req.user = { id: seedData.userId, role: 'platform_admin' };
    req.isPlatformAdmin = true;
    next();
  });
  app.use('/api/playlists', playlistsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: server.address().port };
}

test('both computer identities require current healthy state, including a Multiview cell, while Anpviz remains unchanged', () => {
  for (const sourceId of ['podium-computer', 'guest-computer']) {
    setComputerHealth(sourceId, true);
    assert.equal(managedComputerRouteFailure(computerUrl(sourceId)), null, `${sourceId} is allowed while healthy`);
    setComputerHealth(sourceId, false);
    assert.match(managedComputerRouteFailure(computerUrl(sourceId)), new RegExp(`unavailable: ${sourceId}`));
  }
  const grid = `/player/grid.html?cells=${Buffer.from(JSON.stringify({
    A1: { u: computerUrl('guest-computer') },
  })).toString('base64url')}`;
  assert.match(managedComputerRouteFailure(grid), /unavailable: guest-computer/);
  assert.equal(managedComputerRouteFailure('/player/live-source.html?source=anpviz'), null);
  assert.equal(managedComputerRouteFailure('https://example.test/ordinary-content'), null);
  assert.match(
    managedComputerRouteFailure('https://example.test/player/live-source.html?source=podium-computer'),
    /not a canonical app URL: podium-computer/,
  );
});

test('device payload and command queue turn a persisted unhealthy computer source into a safe blocked payload', () => {
  const prefix = `delivery-fence-${Date.now()}-`;
  const seeded = seed(prefix, 'podium-computer');
  const emitted = [];
  const deviceNamespace = {
    adapter: { rooms: new Map([[seeded.deviceId, new Set(['online-display'])]]) },
    to(deviceId) {
      return { emit(event, payload) { emitted.push({ deviceId, event, payload }); } };
    },
  };
  try {
    db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(
      JSON.stringify([{ remote_url: computerUrl('podium-computer'), sort_order: 0 }]),
      seeded.playlistId,
    );
    setComputerHealth('podium-computer', true);
    db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(seeded.playlistId, seeded.deviceId);
    const healthy = deviceSocket.buildPlaylistPayload(seeded.deviceId);
    assert.equal(healthy.delivery_blocked, undefined);
    assert.equal(healthy.assignments.length, 1);

    setComputerHealth('podium-computer', false);
    const blocked = deviceSocket.buildPlaylistPayload(seeded.deviceId);
    assert.equal(blocked.delivery_blocked, true);
    assert.equal(blocked.suspended, undefined, 'the player must use its normal empty-playlist teardown path');
    assert.deepEqual(blocked.assignments, []);
    assert.match(blocked.delivery_block_reason, /unavailable: podium-computer/);

    const result = commandQueue.queueOrEmitPlaylistUpdate(
      deviceNamespace,
      seeded.deviceId,
      deviceSocket.buildPlaylistPayload,
    );
    assert.equal(result.delivered, false);
    assert.equal(result.blocked, true);
    assert.equal(emitted.length, 1, 'an online renderer receives only the safe empty-playlist payload');
    assert.equal(emitted[0].payload.delivery_blocked, true);
  } finally {
    commandQueue._resetForTests();
  }
});

test('the blocked-payload contract selects the player normal empty-playlist audio and media teardown', () => {
  const playerSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'player', 'index.html'),
    'utf8',
  );
  const applyAudioAt = playerSource.indexOf('applyPlaylistAudioPolicy(data, newItems);');
  const emptyPlaylistAt = playerSource.indexOf('if (playlist.length === 0)');
  const teardownAt = playerSource.indexOf('teardownCurrentMedia();', emptyPlaylistAt);
  assert.ok(applyAudioAt >= 0 && emptyPlaylistAt > applyAudioAt);
  assert.ok(teardownAt > emptyPlaylistAt, 'a normal empty playlist tears down existing media');
});

test('a health loss at the final device-payload boundary is reported as a blocked scene delivery', () => {
  const prefix = `delivery-fence-race-${Date.now()}-`;
  const seeded = seed(prefix, 'podium-computer');
  const emitted = [];
  const deviceNamespace = {
    adapter: { rooms: new Map([[seeded.deviceId, new Set(['online-display'])]]) },
    to(deviceId) {
      return { emit(event, payload) { emitted.push({ deviceId, event, payload }); } };
    },
  };
  const originalQueueOrEmit = commandQueue.queueOrEmitPlaylistUpdate;
  let flippedAtFinalBoundary = false;
  try {
    setComputerHealth('podium-computer', true);
    commandQueue.queueOrEmitPlaylistUpdate = (...args) => {
      flippedAtFinalBoundary = true;
      setComputerHealth('podium-computer', false);
      return originalQueueOrEmit(...args);
    };

    const result = sceneEngine.pushSourceToDevice(
      { of: () => deviceNamespace },
      seeded.deviceId,
      { content_id: seeded.contentId },
      {
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        contentContext: {
          userId: seeded.userId,
          workspaceId: seeded.workspaceId,
          workspaceRole: 'workspace_admin',
        },
        targetDeviceIds: [seeded.deviceId],
        returnDetails: true,
      },
    );

    assert.equal(flippedAtFinalBoundary, true);
    assert.equal(result.ok, false, 'a safe blocked payload cannot be reported as a successful delivery');
    assert.equal(result.delivered, false);
    assert.equal(result.queued, false);
    assert.match(result.failureReason, /unavailable: podium-computer/);
    const playlistUpdates = emitted.filter((entry) => entry.event === 'device:playlist-update');
    assert.equal(playlistUpdates.length, 1);
    assert.equal(playlistUpdates[0].payload.delivery_blocked, true);
    assert.deepEqual(playlistUpdates[0].payload.assignments, []);
  } finally {
    commandQueue.queueOrEmitPlaylistUpdate = originalQueueOrEmit;
    commandQueue._resetForTests();
  }
});

test('publish and assign reject unavailable Podium and Guest before durable playlist/device mutation', async () => {
  for (const sourceId of ['podium-computer', 'guest-computer']) {
    const prefix = `playlist-fence-${sourceId}-${Date.now()}-`;
    const seeded = seed(prefix, sourceId);
    const emitted = [];
    const { server, port } = await makePlaylistApp(seeded, emitted);
    try {
      setComputerHealth(sourceId, false);
      const publishResponse = await fetch(`http://127.0.0.1:${port}/api/playlists/${seeded.playlistId}/publish`, {
        method: 'POST',
      });
      const publishBody = await publishResponse.json();
      assert.equal(publishResponse.status, 409, JSON.stringify(publishBody));
      assert.equal(publishBody.code, 'MANAGED_COMPUTER_SOURCE_UNAVAILABLE');
      assert.equal(
        db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(seeded.playlistId).published_snapshot,
        seeded.originalSnapshot,
        'publish must not replace a durable snapshot while the computer source is unavailable',
      );

      setComputerHealth(sourceId, true);
      const healthyPublish = await fetch(`http://127.0.0.1:${port}/api/playlists/${seeded.playlistId}/publish`, {
        method: 'POST',
      });
      assert.equal(healthyPublish.status, 200, `${sourceId} should publish once current health is healthy`);
      const publishedItems = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(seeded.playlistId).published_snapshot);
      assert.equal(managedComputerRouteFailureInPlaylistItems(publishedItems), null);

      setComputerHealth(sourceId, false);
      const assignResponse = await fetch(`http://127.0.0.1:${port}/api/playlists/${seeded.playlistId}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_id: seeded.deviceId }),
      });
      const assignBody = await assignResponse.json();
      assert.equal(assignResponse.status, 409, JSON.stringify(assignBody));
      assert.equal(assignBody.code, 'MANAGED_COMPUTER_SOURCE_UNAVAILABLE');
      assert.equal(
        db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(seeded.deviceId).playlist_id,
        seeded.oldPlaylistId,
        'assign must not change durable device state while the published source is unavailable',
      );
      assert.equal(emitted.length, 0, 'blocked operations cannot emit because the device remains on its old playlist');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      commandQueue._resetForTests();
    }
  }
});

test('draft assignment CRUD remains unfenced because it does not deliver a playlist', () => {
  const assignmentsSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'assignments.js'),
    'utf8',
  );
  assert.doesNotMatch(assignmentsSource, /queueOrEmitPlaylistUpdate|buildPlaylistPayload/);
  assert.doesNotMatch(assignmentsSource, /UPDATE devices SET playlist_id/);
});
