'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

test('real dashboard socket dispatches one transaction to five displays and Live Program', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-transport-socket-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.ROOM_ID = 'classroom-1';
  const { db } = require('../db/database');
  const { generateToken } = require('../middleware/auth');
  const setupDashboardSocket = require('../ws/dashboardSocket');
  const {
    ensureLiveStreamDisplay,
    markLiveContentChanged,
  } = require('../lib/live-stream-display');

  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  db.prepare(`INSERT INTO users (id, email, name, role, plan_id)
    VALUES ('operator', 'operator@example.test', 'Operator', 'platform_admin', 'enterprise')`).run();
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id)
    VALUES ('org-1', 'MBFD', 'operator', 'enterprise')`).run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, slug, created_by)
    VALUES ('ws-1', 'org-1', 'Classroom', 'classroom', 'operator')`).run();

  const physical = [
    ['front-left', 'Front Left'],
    ['front-center', 'Front Center'],
    ['front-right', 'Front Right'],
    ['side-left', 'Side Left'],
    ['side-right', 'Side Right'],
  ];
  const insertDevice = db.prepare(`INSERT INTO devices
    (id, user_id, workspace_id, name, status, screen_width, screen_height)
    VALUES (?, 'operator', 'ws-1', ?, 'online', 1920, 1080)`);
  for (const [id, name] of physical) insertDevice.run(id, name);
  db.prepare(`INSERT INTO display_states
    (target_type, target_id, current_content_id, current_asset_id,
     slide_index, slide_count, paused, state_revision)
    VALUES ('display', 'front-left', 'deck-1', 'asset-1', 3, 10, 0, 17)`).run();

  const live = ensureLiveStreamDisplay({ workspaceId: 'ws-1', userId: 'operator' });
  db.prepare(`INSERT INTO playlists
    (id, user_id, workspace_id, name, status, published_snapshot, updated_at)
    VALUES ('live-playlist', 'operator', 'ws-1', 'Live Program', 'published', ?, strftime('%s','now'))`)
    .run(JSON.stringify([{ content_id: 'deck-1' }]));
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run('live-playlist', live.id);
  markLiveContentChanged(live.id);

  const token = generateToken({
    id: 'operator',
    email: 'operator@example.test',
    username: 'operator',
    role: 'platform_admin',
  }, 'ws-1');
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDashboardSocket(io);
  io.of('/device').on('connection', (socket) => {
    const deviceId = String(socket.handshake.auth?.deviceId || '');
    if (deviceId) socket.join(deviceId);
    socket.emit('test:ready', { deviceId });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const root = `http://127.0.0.1:${address.port}`;
  const clients = [];

  try {
    const received = new Map();
    for (const [deviceId] of [...physical, [live.id, 'Live Program']]) {
      const client = connectClient(`${root}/device`, {
        auth: { deviceId },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      clients.push(client);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Device ${deviceId} did not connect`)), 5000);
        client.once('test:ready', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      client.on('device:command', (envelope) => {
        received.set(deviceId, envelope);
      });
    }

    const dashboard = connectClient(`${root}/dashboard`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(dashboard);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard did not receive room snapshot')), 5000);
      dashboard.once('room:snapshot', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const ack = await dashboard.timeout(5000).emitWithAck('dashboard:transport-transaction', {
      device_ids: physical.map(([id]) => id),
      action: 'next',
      payload: {},
      room_id: 'classroom-1',
      idempotency_key: 'socket-transaction-1',
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.targets.length, 6);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.size, 6);
    assert.equal(new Set([...received.values()].map(
      envelope => envelope.payload.transport_transaction_id,
    )).size, 1);
    assert.deepEqual(new Set([...received.values()].map(
      envelope => envelope.payload.action,
    )), new Set(['go_to_slide']));
    assert.equal(received.get('front-left').payload.audio_allowed, true);
    assert.equal(received.get(live.id).payload.force_muted, true);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
