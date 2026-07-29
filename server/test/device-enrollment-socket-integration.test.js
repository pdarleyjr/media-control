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
