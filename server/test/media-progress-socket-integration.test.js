'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('media-progress-socket');
const setupDeviceSocket = require('../ws/deviceSocket');
const setupDashboardSocket = require('../ws/dashboardSocket');
const rendererProgress = require('../services/renderer-progress');
const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');

function once(socket, event, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

async function eventually(read, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('real state reports clear unobservable evidence and fence a replacement generation', async () => {
  rendererProgress._clearForTests();
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDeviceSocket(io);
  setupDashboardSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${httpServer.address().port}`;
  db.prepare(`INSERT INTO users (id, email, name, role, plan_id)
    VALUES ('telemetry-operator', 'telemetry@example.test', 'Telemetry Operator', 'platform_admin', 'enterprise')`).run();
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id)
    VALUES ('telemetry-org', 'Telemetry Org', 'telemetry-operator', 'enterprise')`).run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, slug, created_by)
    VALUES ('telemetry-workspace', 'telemetry-org', 'Telemetry Workspace', 'telemetry', 'telemetry-operator')`).run();
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES ('telemetry-workspace', 'telemetry-operator', 'workspace_admin')`).run();
  db.prepare(`INSERT INTO devices
    (id, user_id, workspace_id, name, status, device_token, screen_on)
    VALUES ('telemetry-display', 'telemetry-operator', 'telemetry-workspace', 'Telemetry Display', 'online', 'telemetry-device-token', 1)`).run();

  const client = connectClient(`${root}/device`, {
    transports: ['websocket'], reconnection: false,
  });
  const dashboard = connectClient(`${root}/dashboard`, {
    auth: { token: generateToken({
      id: 'telemetry-operator', email: 'telemetry@example.test', username: 'telemetry-operator', role: 'platform_admin',
    }, 'telemetry-workspace') },
    transports: ['websocket'], reconnection: false, autoConnect: false,
  });

  try {
    await once(client, 'connect');
    const registered = once(client, 'device:registered');
    client.emit('device:register', {
      device_id: 'telemetry-display',
      device_token: 'telemetry-device-token',
      device_info: { app_version: 'media-progress-integration' },
    });
    const { device_id: deviceId } = await registered;
    const initialSnapshot = once(dashboard, 'room:snapshot');
    dashboard.connect();
    await initialSnapshot;

    const firstStateSync = once(dashboard, 'dashboard:state-sync');
    client.emit('device:state-report', { state: {
      state_revision: 1,
      render_telemetry: {
        renderer_session_id: 'renderer-a', content_generation: 'generation-a',
        playback_state: 'PLAYING_PROGRESS', last_confirmed_render_progress_at: 100,
        command_id: 'command-a', command_confirmation_at: 100,
        error: {
          category: 'BUFFER', code: 'HLS_BUFFER_AUTHORIZATION_BEARER_SOCKET_SECRET',
          message: 'Authorization: Bearer socket-secret', active: true,
        },
      },
    } });
    const broadcastState = await firstStateSync;
    assert.equal(broadcastState.state.render_telemetry.error.code, 'PLAYBACK_BUFFER_ERROR');
    assert.equal(broadcastState.state.render_telemetry.error.message, 'Playback buffer could not advance.');
    assert.doesNotMatch(JSON.stringify(broadcastState), /BEARER_SOCKET_SECRET|socket-secret/i);
    const first = await eventually(
      () => rendererProgress.get(deviceId),
      'renderer progress was not recorded from the real state-report path',
    );
    assert.equal(first.command_id, 'command-a');

    client.emit('device:state-report', { state: { state_revision: 2, render_telemetry: null } });
    await eventually(
      () => rendererProgress.get(deviceId) === null && ({ cleared: true }),
      'video evidence survived an explicit unobservable state',
    );

    client.emit('device:state-report', { state: {
      state_revision: 3,
      render_telemetry: {
        renderer_session_id: 'renderer-a', content_generation: 'generation-a',
        playback_state: 'PLAYING_PROGRESS', last_confirmed_render_progress_at: 200,
        command_id: 'command-a', command_confirmation_at: 200,
      },
    } });
    client.emit('device:state-report', { state: {
      state_revision: 4,
      render_telemetry: {
        renderer_session_id: 'renderer-a', content_generation: 'generation-b', playback_state: 'IDLE',
      },
    } });
    const fresh = await eventually(
      () => rendererProgress.get(deviceId)?.content_generation === 'generation-b' && rendererProgress.get(deviceId),
      'replacement generation was not recorded',
    );
    assert.equal(fresh.content_generation, 'generation-b');
    assert.equal(fresh.last_confirmed_render_progress_at, null);
    assert.equal(fresh.command_id, null);

    const ackBroadcast = once(dashboard, 'command:ack');
    client.emit('device:ack', {
      command_id: 'untracked-command', ok: true,
      state: {
        state_revision: 5,
        render_telemetry: {
          playback_state: 'ERROR',
          error: {
            category: 'NETWORK', code: 'AUTHORIZATION_BEARER_ACK_SECRET',
            message: 'Bearer ack-secret', active: true,
          },
        },
      },
    });
    const ack = await ackBroadcast;
    assert.equal(ack.state.render_telemetry.error.code, 'PLAYBACK_SOURCE_ERROR');
    assert.equal(ack.state.render_telemetry.error.message, 'Playback source could not be reached.');
    assert.doesNotMatch(JSON.stringify(ack), /BEARER_ACK_SECRET|ack-secret/i);
  } finally {
    client.disconnect();
    dashboard.disconnect();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    rendererProgress._clearForTests();
  }
});
