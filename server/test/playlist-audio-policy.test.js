'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('playlist-audio-policy');

const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');
const deviceSocket = require('../ws/deviceSocket');

function seedClassroom(prefix) {
  const userId = `${prefix}user`;
  const organizationId = `${prefix}organization`;
  const workspaceId = `${prefix}workspace`;
  const contentId = `${prefix}video`;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Audio Policy User', 'platform_admin')")
    .run(userId, `${prefix}@example.test`);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Audio Policy Org', ?)")
    .run(organizationId, userId);
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Classroom 1', ?)")
    .run(workspaceId, organizationId, userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  db.prepare(`
    INSERT INTO content
      (id, user_id, workspace_id, filename, filepath, mime_type, file_size, access_level, version)
    VALUES (?, ?, ?, 'known-good-audio.mp4', 'known-good-audio.mp4', 'video/mp4', 1024, 'workspace_shared', 8)
  `).run(contentId, userId, workspaceId);
  const devices = [
    ['tv1', 'Classroom 1 - Front Left'],
    ['tv2', 'Classroom 1 - Front Center'],
    ['tv3', 'Classroom 1 - Front Right'],
    ['tv4', 'Classroom 1 - Side Left'],
    ['tv5', 'Classroom 1 - Side Right'],
  ].map(([suffix, name]) => ({ id: `${prefix}${suffix}`, name }));
  const insertDevice = db.prepare(`
    INSERT INTO devices (id, user_id, workspace_id, name, status)
    VALUES (?, ?, ?, ?, 'online')
  `);
  for (const device of devices) insertDevice.run(device.id, userId, workspaceId, device.name);
  return { userId, workspaceId, contentId, devices };
}

test('video broadcast persists one policy in every playlist and reconstructs it after a player restart', () => {
  const prefix = `test-playlist-audio-${Date.now()}-`;
  const { userId, workspaceId, contentId, devices } = seedClassroom(prefix);
  const outputId = devices[0].id;
  const ownerId = devices[1].id;
  const targetIds = devices.slice(0, 3).map((device) => device.id);
  const audioPolicy = {
    version: 1,
    output_device_id: outputId,
    owner_device_id: ownerId,
    content_instance_id: `${prefix}broadcast`,
    transaction_id: `${prefix}broadcast`,
    generation: 8,
    revision: 200,
  };
  const source = {
    content_id: contentId,
    content_instance_id: audioPolicy.content_instance_id,
    audio_policy: audioPolicy,
  };

  for (const deviceId of targetIds) {
    assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, source, {
      workspaceId,
      userId,
      targetDeviceIds: targetIds,
    }), true);
  }

  const payloads = targetIds.map((deviceId) => deviceSocket.buildPlaylistPayload(deviceId));
  for (const [index, payload] of payloads.entries()) {
    assert.equal(payload.assignments[0].content_instance_id, audioPolicy.content_instance_id);
    assert.deepEqual(payload.assignments[0].audio_policy, audioPolicy);
    assert.equal(payload.audio_policy.output_device_id, outputId);
    assert.equal(payload.audio_policy.owner_device_id, ownerId);
    assert.equal(payload.audio_policy.audio_allowed, index === 1);
    assert.equal(payload.audio_policy.force_muted, index !== 1);
    assert.equal(payload.audio_policy.playlist_revision, payload.playlist_revision);
  }

  const restartedOwnerPayload = deviceSocket.buildPlaylistPayload(ownerId);
  assert.equal(restartedOwnerPayload.audio_policy.audio_allowed, true);
  assert.equal(restartedOwnerPayload.audio_policy.transaction_id, audioPolicy.transaction_id);

  const latePolicy = {
    ...audioPolicy,
    owner_device_id: devices[2].id,
    content_instance_id: `${prefix}late-old-broadcast`,
    transaction_id: `${prefix}late-old-broadcast`,
    revision: 199,
  };
  assert.equal(sceneEngine.pushSourceToDevice(null, ownerId, {
    content_id: contentId,
    content_instance_id: latePolicy.content_instance_id,
    audio_policy: latePolicy,
  }, {
    workspaceId,
    userId,
    targetDeviceIds: targetIds,
  }), false, 'a late lower-revision route must not overwrite durable ownership');
  const afterLateRoute = deviceSocket.buildPlaylistPayload(ownerId);
  assert.equal(afterLateRoute.audio_policy.revision, 200);
  assert.equal(afterLateRoute.audio_policy.transaction_id, audioPolicy.transaction_id);
});

test('presentation player broadcast carries the same durable single-owner policy as local video', () => {
  const prefix = `test-presentation-audio-${Date.now()}-`;
  const { userId, workspaceId, devices } = seedClassroom(prefix);
  const targetIds = [devices[3].id, devices[4].id];
  const audioPolicy = {
    version: 1,
    output_device_id: devices[0].id,
    owner_device_id: devices[3].id,
    content_instance_id: `${prefix}presentation-broadcast`,
    transaction_id: `${prefix}presentation-broadcast`,
    generation: 1,
    revision: 300,
  };
  const source = {
    remote_url: `/player/deck/${prefix}deck`,
    content_instance_id: audioPolicy.content_instance_id,
    audio_policy: audioPolicy,
  };
  for (const deviceId of targetIds) {
    assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, source, {
      workspaceId,
      userId,
      targetDeviceIds: targetIds,
    }), true);
  }
  const owner = deviceSocket.buildPlaylistPayload(targetIds[0]);
  const follower = deviceSocket.buildPlaylistPayload(targetIds[1]);
  assert.equal(owner.assignments[0].mime_type, 'text/html');
  assert.equal(owner.audio_policy.audio_allowed, true);
  assert.equal(follower.audio_policy.audio_allowed, false);
  assert.equal(owner.audio_policy.output_device_id, devices[0].id);
});

test('existing playlist source is stamped with one durable policy for every target and restart', () => {
  const prefix = `test-existing-playlist-audio-${Date.now()}-`;
  const { userId, workspaceId, contentId, devices } = seedClassroom(prefix);
  const playlistId = `${prefix}playlist`;
  db.prepare(`
    INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot)
    VALUES (?, ?, ?, 'Known audio playlist', 'published', ?)
  `).run(playlistId, userId, workspaceId, JSON.stringify([{
    id: `${prefix}item`, content_id: contentId, filename: 'known-good-audio.mp4',
    mime_type: 'video/mp4', content_generation: 8, sort_order: 0,
  }]));
  db.prepare(`
    INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec)
    VALUES (?, ?, 0, 10)
  `).run(playlistId, contentId);

  const targetIds = [devices[1].id, devices[2].id, devices[3].id];
  const audioPolicy = {
    version: 1,
    output_device_id: devices[0].id,
    owner_device_id: devices[1].id,
    content_instance_id: `${prefix}transaction`,
    transaction_id: `${prefix}transaction`,
    generation: 8,
    revision: 400,
    source_key: `playlist:${playlistId}`,
  };
  for (const deviceId of targetIds) {
    assert.equal(sceneEngine.pushSourceToDevice(null, deviceId, {
      playlist_id: playlistId,
      content_instance_id: audioPolicy.content_instance_id,
      audio_policy: audioPolicy,
    }, {
      workspaceId,
      userId,
      targetDeviceIds: targetIds,
    }), true);
  }

  const stored = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId).published_snapshot);
  assert.ok(stored.every((item) => item.content_instance_id === audioPolicy.content_instance_id));
  assert.ok(stored.every((item) => item.audio_policy.transaction_id === audioPolicy.transaction_id));
  const payloads = targetIds.map((deviceId) => deviceSocket.buildPlaylistPayload(deviceId));
  assert.deepEqual(payloads.map((payload) => payload.audio_policy.audio_allowed), [true, false, false]);
  assert.equal(deviceSocket.buildPlaylistPayload(targetIds[0]).audio_policy.source_key, `playlist:${playlistId}`);

  const stalePolicy = {
    ...audioPolicy,
    owner_device_id: targetIds[1],
    transaction_id: `${prefix}stale-transaction`,
    content_instance_id: `${prefix}stale-transaction`,
    revision: 399,
  };
  assert.equal(sceneEngine.pushSourceToDevice(null, targetIds[0], {
    playlist_id: playlistId,
    content_instance_id: stalePolicy.content_instance_id,
    audio_policy: stalePolicy,
  }, {
    workspaceId,
    userId,
    targetDeviceIds: targetIds,
  }), false, 'a stale playlist assignment must fail closed');
  assert.equal(deviceSocket.buildPlaylistPayload(targetIds[0]).audio_policy.revision, 400);
  assert.equal(deviceSocket.buildPlaylistPayload(targetIds[0]).audio_policy.transaction_id, audioPolicy.transaction_id);
});
