'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('media-progress-socket-soak');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const rendererProgress = require('../services/renderer-progress');

function once(socket, event, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

async function eventually(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('repeated real Socket.IO renderer replacement and clear lifecycle stays bounded', async (t) => {
  rendererProgress._clearForTests();
  setupDeviceSocket._clearPendingOfflinesForTests();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('soak-user', 'soak@example.test', 'Soak', 'user')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('soak-org', 'Soak Org', 'soak-user')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('soak-workspace', 'soak-org', 'Soak Workspace', 'soak-user')").run();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, device_token) VALUES ('soak-display', 'soak-user', 'soak-workspace', 'Soak Display', 'online', 'soak-device-token')").run();

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  const deviceNamespace = setupDeviceSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/device`;
  const connectionListenerCount = deviceNamespace.listenerCount('connection');
  const iterations = 20;
  t.after(async () => {
    setupDeviceSocket._clearPendingOfflinesForTests();
    rendererProgress._clearForTests();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const client = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await once(client, 'connect');
    const registered = once(client, 'device:registered');
    client.emit('device:register', {
      device_id: 'soak-display', device_token: 'soak-device-token',
      device_info: { app_version: `soak-${iteration}` },
    });
    await registered;
    assert.equal(setupDeviceSocket._pendingOfflineCountForTests(), 0);

    const revision = iteration * 3;
    client.emit('device:state-report', { state: {
      state_revision: revision + 1,
      render_telemetry: {
        renderer_session_id: `renderer-${iteration}-a`, content_generation: `generation-${iteration}-a`,
        playback_state: 'PLAYING_PROGRESS', command_id: `command-${iteration}`,
        command_confirmation_at: 100, last_confirmed_render_progress_at: 100,
      },
    } });
    await eventually(() => rendererProgress.get('soak-display')?.content_generation === `generation-${iteration}-a`, 'initial renderer missing');

    client.emit('device:state-report', { state: {
      state_revision: revision + 2,
      render_telemetry: {
        renderer_session_id: `renderer-${iteration}-b`, content_generation: `generation-${iteration}-b`,
        playback_state: 'IDLE',
      },
    } });
    await eventually(() => rendererProgress.get('soak-display')?.content_generation === `generation-${iteration}-b`, 'replacement renderer missing');
    assert.equal(rendererProgress.get('soak-display').command_id, null);

    client.emit('device:state-report', { state: { state_revision: revision + 3, render_telemetry: null } });
    await eventually(() => rendererProgress.get('soak-display') === null, 'telemetry clear did not remove renderer');
    assert.equal(rendererProgress._sizeForTests(), 0);
    assert.equal(deviceNamespace.listenerCount('connection'), connectionListenerCount);

    client.disconnect();
    await eventually(() => deviceNamespace.sockets.size === 0, 'device socket did not disconnect');
    assert.equal(setupDeviceSocket._pendingOfflineCountForTests(), 1);
  }

  assert.equal(rendererProgress._sizeForTests(), 0);
  assert.equal(setupDeviceSocket._pendingOfflineCountForTests(), 1);
  assert.equal(deviceNamespace.listenerCount('connection'), connectionListenerCount);
  t.diagnostic(`iterations=${iterations} registry_entries=0 pending_offline_timers=1 connection_listeners=${connectionListenerCount}`);
});
