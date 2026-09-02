'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('media-progress-socket');
const setupDeviceSocket = require('../ws/deviceSocket');
const rendererProgress = require('../services/renderer-progress');
const { generatePairingCode } = require('../lib/device-enrollment');

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
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const client = connectClient(`http://127.0.0.1:${httpServer.address().port}/device`, {
    transports: ['websocket'], reconnection: false,
  });

  try {
    await once(client, 'connect');
    const registered = once(client, 'device:registered');
    client.emit('device:register', {
      pairing_code: generatePairingCode(),
      fingerprint: `media-progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      device_info: { app_version: 'media-progress-integration' },
    });
    const { device_id: deviceId } = await registered;

    client.emit('device:state-report', { state: {
      state_revision: 1,
      render_telemetry: {
        renderer_session_id: 'renderer-a', content_generation: 'generation-a',
        playback_state: 'PLAYING_PROGRESS', last_confirmed_render_progress_at: 100,
        command_id: 'command-a', command_confirmation_at: 100,
      },
    } });
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
  } finally {
    client.disconnect();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    rendererProgress._clearForTests();
  }
});
