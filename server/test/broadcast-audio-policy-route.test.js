'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('broadcast-audio-policy-route');

const { db } = require('../db/database');
const broadcastRouter = require('../routes/broadcast');
const { buildPlaylistPayload } = require('../ws/deviceSocket');

function seedClassroom() {
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('audio-user', 'audio-route@example.test', 'Audio Route User', 'platform_admin')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('audio-org', 'Audio Route Org', 'audio-user')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('audio-workspace', 'audio-org', 'Classroom 1', 'audio-user')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('audio-workspace', 'audio-user', 'workspace_admin')").run();
  db.prepare(`
    INSERT INTO content
      (id, user_id, workspace_id, filename, filepath, mime_type, file_size, access_level, version)
    VALUES ('audio-image', 'audio-user', 'audio-workspace', 'audio-policy.png', 'audio-policy.png', 'image/png', 1024, 'workspace_shared', 8)
  `).run();
  const insert = db.prepare(`
    INSERT INTO devices (id, user_id, workspace_id, name, status)
    VALUES (?, 'audio-user', 'audio-workspace', ?, 'online')
  `);
  for (const [id, name] of [
    ['tv1', 'Classroom 1 - Front Left'],
    ['tv2', 'Classroom 1 - Front Center'],
    ['tv3', 'Classroom 1 - Front Right'],
    ['tv4', 'Classroom 1 - Side Left'],
    ['tv5', 'Classroom 1 - Side Right'],
  ]) insert.run(id, name);
}

test('broadcast route persists one authoritative policy and emits the muted renderer before its owner', async (t) => {
  seedClassroom();
  const emitted = [];
  const fences = [];
  const rooms = new Map([
    ['tv2', new Set(['socket-tv2'])],
    ['tv3', new Set(['socket-tv3'])],
  ]);
  const deviceNamespace = {
    adapter: { rooms },
    to(deviceId) {
      const operator = {
        timeout() { return operator; },
        emit(event, payload, acknowledge) {
          if (event === 'device:audio-policy-fence') {
            fences.push({ deviceId, payload });
            acknowledge(null, [{
              ok: true,
              muted: true,
              host_muted: true,
              phase: 'muted',
              device_id: deviceId,
              renderer_session_id: `session-${deviceId}`,
              transaction_id: payload.audio_policy.transaction_id,
              revision: payload.audio_policy.revision,
              generation: payload.audio_policy.generation,
            }]);
          }
          if (event === 'device:playlist-update') emitted.push({ deviceId, payload });
        },
      };
      return operator;
    },
  };
  const io = { of: () => deviceNamespace };
  const app = express();
  app.set('io', io);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = 'audio-workspace';
    req.organizationId = 'audio-org';
    req.workspaceRole = 'workspace_admin';
    req.orgRole = 'org_owner';
    req.user = { id: 'audio-user', role: 'platform_admin' };
    req.isPlatformAdmin = true;
    next();
  });
  app.use('/api/broadcast', broadcastRouter);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_ids: ['tv3', 'tv2'],
      content_id: 'audio-image',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.deepEqual(fences.map((entry) => entry.deviceId).sort(), ['tv2', 'tv3']);
  assert.ok(fences.every((entry) => entry.payload.audio_policy.owner_device_id === null));
  assert.equal(body.audio_ownership.barrier_acknowledged, true);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((entry) => entry.deviceId), ['tv3', 'tv2']);

  const follower = buildPlaylistPayload('tv3');
  const owner = buildPlaylistPayload('tv2');
  assert.equal(owner.audio_policy.transaction_id, body.request_id);
  assert.equal(owner.audio_policy.content_instance_id, body.request_id);
  assert.equal(owner.audio_policy.generation, 8);
  assert.equal(owner.audio_policy.audio_allowed, true);
  assert.equal(follower.audio_policy.audio_allowed, false);
  assert.equal(owner.audio_policy.owner_device_id, 'tv2');
  assert.equal(owner.audio_policy.output_device_id, 'tv1');
  assert.equal(owner.assignments[0].content_generation, 8);
});

test('all abortable presentation publication checks finish before the audio mute fence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'broadcast.js'), 'utf8');
  const publicationGuard = source.indexOf("if (presentationForBroadcast\n      && (presentationForBroadcast.status !== 'published'");
  const audioFence = source.indexOf('await fenceAudioOwnershipTargets');
  assert.notEqual(publicationGuard, -1);
  assert.notEqual(audioFence, -1);
  assert.ok(
    publicationGuard < audioFence,
    'a concurrent presentation change must abort before renderers enter a newer mute fence',
  );
});
