'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-room-socket-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.ROOM_ID = 'classroom-1';

const { db } = require('../db/database');
const { generateToken } = require('../middleware/auth');
const setupDashboardSocket = require('../ws/dashboardSocket');
const { publishRoomSnapshot } = require('../lib/room-state-broadcaster');

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function handler(value) {
      clearTimeout(timer);
      resolve(value);
    }
    socket.once(event, handler);
  });
}

test('five real dashboard clients converge on one persisted room revision and reconnect cleanly', async () => {
  db.prepare(`INSERT INTO users (id, email, name, role, plan_id)
    VALUES ('operator', 'operator@example.test', 'Operator', 'platform_admin', 'enterprise')`).run();
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id)
    VALUES ('org-1', 'MBFD', 'operator', 'enterprise')`).run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, slug, created_by)
    VALUES ('ws-1', 'org-1', 'Classroom', 'classroom', 'operator')`).run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, slug, created_by)
    VALUES ('ws-2', 'org-1', 'Other Room', 'other-room', 'operator')`).run();
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, status, screen_width, screen_height)
    VALUES ('display-a', 'operator', 'ws-1', 'Front Left', 'online', 1920, 1080)`).run();
  db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, status, screen_width, screen_height)
    VALUES ('display-b', 'operator', 'ws-2', 'Other Display', 'online', 1920, 1080)`).run();

  const token = generateToken({
    id: 'operator', email: 'operator@example.test', username: 'operator', role: 'platform_admin',
  }, 'ws-1');
  const otherToken = generateToken({
    id: 'operator', email: 'operator@example.test', username: 'operator', role: 'platform_admin',
  }, 'ws-2');
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDashboardSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}/dashboard`;
  const clients = [];

  try {
    const initialPromises = [];
    for (let index = 0; index < 5; index += 1) {
      const client = connectClient(url, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      clients.push(client);
      initialPromises.push(once(client, 'room:snapshot'));
    }
    const initial = await Promise.all(initialPromises);
    assert.deepEqual(initial.map((snapshot) => snapshot.revision), [0, 0, 0, 0, 0]);
    assert.ok(initial.every((snapshot) => snapshot.confirmedState.displays[0].id === 'display-a'));

    const otherClient = connectClient(url, {
      auth: { token: otherToken }, transports: ['websocket'], forceNew: true, reconnection: false,
    });
    clients.push(otherClient);
    const otherInitial = await once(otherClient, 'room:snapshot');
    assert.equal(otherInitial.workspaceId, 'ws-2');
    assert.deepEqual(otherInitial.confirmedState.displays.map((display) => display.id), ['display-b']);

    const rejected = once(clients[0], 'dashboard:target-rejected');
    clients[0].emit('dashboard:select-target', { target_type: 'display', target_id: 'display-b' });
    assert.equal((await rejected).reason, 'forbidden');

    let otherWorkspaceContaminated = false;
    const onOtherSnapshot = () => { otherWorkspaceContaminated = true; };
    otherClient.on('room:snapshot', onOtherSnapshot);
    const convergedPromises = clients.slice(0, 5).map((client) => once(client, 'room:snapshot'));
    const published = publishRoomSnapshot(io, {
      workspaceId: 'ws-1', roomId: 'classroom-1', reason: 'integration-test', bump: true,
    });
    const converged = await Promise.all(convergedPromises);
    assert.equal(published.revision, 1);
    assert.deepEqual(converged.map((snapshot) => snapshot.revision), [1, 1, 1, 1, 1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    otherClient.off('room:snapshot', onOtherSnapshot);
    assert.equal(otherWorkspaceContaminated, false);

    const resumed = once(clients[0], 'room:resumed');
    clients[0].emit('dashboard:room-resume', { revision: 1 });
    assert.deepEqual(await resumed, {
      schemaVersion: 1,
      workspaceId: 'ws-1',
      roomId: 'classroom-1',
      revision: 1,
    });

    clients[4].disconnect();
    const remainingPromises = clients.slice(0, 4).map((client) => once(client, 'room:snapshot'));
    publishRoomSnapshot(io, {
      workspaceId: 'ws-1', roomId: 'classroom-1', reason: 'reconnect-test', bump: true,
    });
    assert.deepEqual((await Promise.all(remainingPromises)).map((snapshot) => snapshot.revision), [2, 2, 2, 2]);

    const replacement = connectClient(url, {
      auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
    });
    clients[4] = replacement;
    const reconnectSnapshot = await once(replacement, 'room:snapshot');
    assert.equal(reconnectSnapshot.revision, 2);
  } finally {
    for (const client of clients) client?.disconnect();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
