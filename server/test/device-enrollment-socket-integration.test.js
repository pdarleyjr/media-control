'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('device-enrollment-socket');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const commandQueue = require('../lib/command-queue');

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function connect(port) {
  const client = connectClient(`http://127.0.0.1:${port}/device`, {
    transports: ['websocket'],
    reconnection: false,
  });
  await once(client, 'connect');
  return client;
}

function register(client, payload) {
  const registered = once(client, 'device:registered');
  client.emit('device:register', payload);
  return registered;
}

test('pending reconnect is idempotent and an identical new display keeps a distinct identity', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstCode = `first-${suffix}`;
  const secondCode = `second-${suffix}`;
  const fingerprint = `identical-browser-${suffix}`;
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDeviceSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  const clients = [];

  try {
    const first = await connect(port);
    clients.push(first);
    const firstRegistration = await register(first, {
      pairing_code: firstCode,
      fingerprint,
      device_info: { app_version: 'enrollment-test' },
    });

    first.disconnect();
    const resumed = await connect(port);
    clients.push(resumed);
    const resumedRegistration = await register(resumed, {
      pairing_code: firstCode,
      fingerprint,
      device_info: { app_version: 'enrollment-test' },
    });
    assert.equal(resumedRegistration.device_id, firstRegistration.device_id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM devices WHERE pairing_code = ?')
        .get(firstCode).count,
      1,
    );

    const additional = await connect(port);
    clients.push(additional);
    const additionalRegistration = await register(additional, {
      pairing_code: secondCode,
      fingerprint,
      device_info: { app_version: 'enrollment-test' },
    });
    assert.notEqual(additionalRegistration.device_id, firstRegistration.device_id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM devices WHERE pairing_code IN (?, ?)')
        .get(firstCode, secondCode).count,
      2,
    );
    assert.equal(
      db.prepare('SELECT device_id FROM device_fingerprints WHERE fingerprint = ?')
        .get(fingerprint).device_id,
      firstRegistration.device_id,
      'a colliding browser fingerprint must not take over the original display',
    );
  } finally {
    clients.forEach((client) => client.disconnect());
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    db.prepare('DELETE FROM device_fingerprints WHERE fingerprint = ?').run(fingerprint);
    db.prepare(`
      DELETE FROM device_status_log
      WHERE device_id IN (
        SELECT id FROM devices WHERE pairing_code IN (?, ?)
      )
    `).run(firstCode, secondCode);
    db.prepare('DELETE FROM devices WHERE pairing_code IN (?, ?)').run(firstCode, secondCode);
  }
});

test('reconnect recovery exceptions keep the renderer fail-muted without releasing queued or stale policy', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pairingCode = `audio-failure-${suffix}`;
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  let recoveryAttempts = 0;
  setupDeviceSocket(io, {
    ensureAudioOwnerAfterReconnect: async () => {
      recoveryAttempts += 1;
      throw new Error('injected audio recovery failure');
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  const clients = [];
  let deviceId = null;

  try {
    const provisional = await connect(port);
    clients.push(provisional);
    const firstRegistration = await register(provisional, {
      pairing_code: pairingCode,
      fingerprint: `audio-failure-browser-${suffix}`,
      device_info: { app_version: 'audio-recovery-failure-test' },
    });
    deviceId = firstRegistration.device_id;
    provisional.disconnect();

    commandQueue.queueCommand(deviceId, 'device:command', {
      type: 'device:command',
      payload: { command: 'play' },
    });

    const reconnect = await connect(port);
    clients.push(reconnect);
    const observed = [];
    reconnect.on('device:playlist-update', (payload) => observed.push(['playlist', payload]));
    reconnect.on('device:command', (payload) => observed.push(['command', payload]));
    reconnect.on('device:audio-policy-clamp', (payload) => observed.push(['clamp', payload]));

    const reconnectRegistration = await register(reconnect, {
      device_id: deviceId,
      device_token: firstRegistration.device_token,
      device_info: { app_version: 'audio-recovery-failure-test' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recoveryAttempts, 1, 'the injected reconnect recovery must run');
    assert.equal(reconnectRegistration.audio_ready, false);
    assert.equal(reconnect.connected, true, 'the handled recovery error must not crash the socket');
    assert.equal(commandQueue.getQueueDepth(deviceId), 1, 'queued work must remain pending');
    assert.equal(observed.some(([event]) => event === 'playlist'), false);
    assert.equal(observed.some(([event]) => event === 'command'), false);
    assert.deepEqual(
      observed.find(([event]) => event === 'clamp')?.[1],
      {
        version: 1,
        reason: 'audio_reconnect_recovery_failed',
        audio_policy: null,
      },
    );

    const heartbeatAck = await new Promise((resolve) => {
      reconnect.emit('device:heartbeat', { device_id: deviceId }, resolve);
    });
    assert.equal(heartbeatAck.ok, true);
    assert.equal(heartbeatAck.audio_policy, null);
    assert.deepEqual(heartbeatAck.audio_policy_decision, {
      clamp: true,
      reason: 'audio_reconnect_recovery_failed',
    });

    const syncAck = await new Promise((resolve) => {
      reconnect.emit('device:playlist-sync', { playlist_revision: 'stale' }, resolve);
    });
    assert.deepEqual(syncAck, {
      ok: false,
      fail_muted: true,
      error: 'audio_reconnect_recovery_failed',
    });
    assert.equal(observed.some(([event]) => event === 'playlist'), false);
    assert.equal(observed.some(([event]) => event === 'command'), false);
    assert.equal(commandQueue.getQueueDepth(deviceId), 1);
  } finally {
    clients.forEach((client) => client.disconnect());
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    commandQueue._resetForTests();
    if (deviceId) {
      db.prepare('DELETE FROM device_fingerprints WHERE device_id = ?').run(deviceId);
      db.prepare('DELETE FROM device_status_log WHERE device_id = ?').run(deviceId);
      db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
    }
  }
});
