'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('managed-computer-broadcast-preflight');

const { db } = require('../db/database');
const broadcastRouter = require('../routes/broadcast');
const commandQueue = require('../lib/command-queue');

function setComputerHealth(sourceId, available) {
  db.prepare(`
    UPDATE live_sources
    SET availability = ?, last_seen_at = strftime('%s','now')
    WHERE id = ?
  `).run(available ? 'available' : 'unavailable', sourceId);
}

function seed(prefix) {
  const userId = `${prefix}user`;
  const organizationId = `${prefix}organization`;
  const workspaceId = `${prefix}workspace`;
  const podiumContentId = `${prefix}podium-content`;
  const guestPlaylistId = `${prefix}guest-playlist`;
  const deviceId = `${prefix}device`;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Broadcast Fence User', 'platform_admin')")
    .run(userId, `${prefix}user@example.test`);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Broadcast Fence Org', ?)")
    .run(organizationId, userId);
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Broadcast Fence Workspace', ?)")
    .run(workspaceId, organizationId, userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  db.prepare(`
    INSERT INTO content
      (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
    VALUES (?, ?, ?, 'podium.html', '', 'text/html', 1, '/player/live-source.html?source=podium-computer', 'workspace_shared')
  `).run(podiumContentId, userId, workspaceId);
  db.prepare(`
    INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot)
    VALUES (?, ?, ?, 'Guest source playlist', 'published', ?)
  `).run(guestPlaylistId, userId, workspaceId, JSON.stringify([{
    remote_url: '/player/live-source.html?source=guest-computer',
    sort_order: 0,
  }]));
  db.prepare(`
    INSERT INTO devices (id, user_id, workspace_id, name, status)
    VALUES (?, ?, ?, 'Broadcast Fence Display', 'online')
  `).run(deviceId, userId, workspaceId);
  return { userId, organizationId, workspaceId, podiumContentId, guestPlaylistId, deviceId };
}

test('broadcast blocks unavailable managed content, direct URLs, and persisted playlists before request or audio side effects', async (t) => {
  const seeded = seed(`broadcast-fence-${Date.now()}-`);
  const emitted = [];
  const deviceNamespace = {
    adapter: { rooms: new Map([[seeded.deviceId, new Set(['display'])]]) },
    to(deviceId) {
      const target = {
        timeout() { return target; },
        emit(event, payload, acknowledge) {
          emitted.push({ deviceId, event, payload });
          if (typeof acknowledge === 'function') acknowledge(null, []);
        },
      };
      return target;
    },
  };
  const app = express();
  app.use(express.json());
  app.set('io', { of: () => deviceNamespace });
  app.use((req, _res, next) => {
    req.workspaceId = seeded.workspaceId;
    req.organizationId = seeded.organizationId;
    req.workspaceRole = 'workspace_admin';
    req.orgRole = 'org_owner';
    req.user = { id: seeded.userId, role: 'platform_admin' };
    req.isPlatformAdmin = true;
    next();
  });
  app.use('/api/broadcast', broadcastRouter);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/broadcast`;

  for (const [sourceId, source] of [
    ['podium-computer', { content_id: seeded.podiumContentId }],
    ['guest-computer', { remote_url: '/player/live-source.html?source=guest-computer' }],
    ['guest-computer', { playlist_id: seeded.guestPlaylistId }],
  ]) {
    setComputerHealth(sourceId, false);
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...source,
        device_ids: [seeded.deviceId],
        confirm_all: true,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'MANAGED_COMPUTER_SOURCE_UNAVAILABLE');
    assert.equal(body.source_id, sourceId);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM broadcast_requests WHERE workspace_id = ?').get(seeded.workspaceId).count,
      0,
      'no blocked source creates a delivery request',
    );
    assert.equal(emitted.length, 0, 'no blocked source reaches audio or display delivery');
  }
});

test('broadcast records a health loss at the final payload boundary as a failed delivery', async (t) => {
  const seeded = seed(`broadcast-final-fence-${Date.now()}-`);
  const emitted = [];
  const deviceNamespace = {
    adapter: { rooms: new Map([[seeded.deviceId, new Set(['display'])]]) },
    to(deviceId) {
      const target = {
        timeout() { return target; },
        emit(event, payload, acknowledge) {
          emitted.push({ deviceId, event, payload });
          if (typeof acknowledge === 'function') acknowledge(null, []);
        },
      };
      return target;
    },
  };
  const app = express();
  app.use(express.json());
  app.set('io', { of: () => deviceNamespace });
  app.use((req, _res, next) => {
    req.workspaceId = seeded.workspaceId;
    req.organizationId = seeded.organizationId;
    req.workspaceRole = 'workspace_admin';
    req.orgRole = 'org_owner';
    req.user = { id: seeded.userId, role: 'platform_admin' };
    req.isPlatformAdmin = true;
    next();
  });
  app.use('/api/broadcast', broadcastRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const originalQueueOrEmit = commandQueue.queueOrEmitPlaylistUpdate;
  try {
    setComputerHealth('podium-computer', true);
    commandQueue.queueOrEmitPlaylistUpdate = (...args) => {
      setComputerHealth('podium-computer', false);
      return originalQueueOrEmit(...args);
    };

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content_id: seeded.podiumContentId,
        device_ids: [seeded.deviceId],
        confirm_all: true,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.sent, 0);
    assert.deepEqual(body.failed, [seeded.deviceId]);
    assert.equal(body.delivery.status, 'failed');
    assert.equal(body.delivery.devices[0].state, 'failed');
    assert.match(body.delivery.devices[0].failure_reason, /unavailable: podium-computer/);
    const playlistUpdates = emitted.filter((entry) => entry.event === 'device:playlist-update');
    assert.equal(playlistUpdates.length, 1);
    assert.equal(playlistUpdates[0].payload.delivery_blocked, true);
  } finally {
    commandQueue.queueOrEmitPlaylistUpdate = originalQueueOrEmit;
    commandQueue._resetForTests();
    await new Promise((resolve) => server.close(resolve));
  }
});
