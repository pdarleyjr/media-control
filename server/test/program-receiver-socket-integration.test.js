'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');
installIsolatedTestDatabase('program-receiver-socket');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const { ensureLiveStreamDisplay } = require('../lib/live-stream-display');

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function cleanup(prefix) {
  db.prepare('DELETE FROM device_status_log WHERE device_id IN (SELECT id FROM devices WHERE workspace_id = ?)').run(`${prefix}workspace`);
  db.prepare('DELETE FROM devices WHERE workspace_id = ?').run(`${prefix}workspace`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(`${prefix}workspace`);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(`${prefix}workspace`);
  db.prepare('DELETE FROM organization_members WHERE organization_id = ? OR user_id = ?').run(`${prefix}org`, `${prefix}user`);
  db.prepare('DELETE FROM organizations WHERE id = ?').run(`${prefix}org`);
  db.prepare('DELETE FROM users WHERE id = ?').run(`${prefix}user`);
}

test('authenticated program receiver gets a complete authoritative room snapshot', async () => {
  const prefix = `test-receiver-socket-${Date.now()}-`;
  const userId = `${prefix}user`;
  const organizationId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  cleanup(prefix);
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Receiver Test', 'platform_admin')")
    .run(userId, `${prefix}@example.test`);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(organizationId, 'Receiver Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, organizationId, 'Receiver Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  const display = ensureLiveStreamDisplay({ workspaceId, userId });

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDeviceSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const client = connectClient(`http://127.0.0.1:${httpServer.address().port}/device`, {
    transports: ['websocket'],
    reconnection: false,
  });

  try {
    await once(client, 'connect');
    const registered = once(client, 'device:registered');
    client.emit('device:register', {
      device_id: display.id,
      device_token: display.device_token,
      device_info: { app_version: 'test-program-receiver' },
    });
    assert.equal((await registered).device_id, display.id);

    const snapshotEvent = once(client, 'device:room-snapshot');
    const acknowledgement = new Promise((resolve) => {
      client.emit('device:room-snapshot', {
        workspace_id: workspaceId,
        room_id: 'classroom-1',
      }, resolve);
    });
    const [snapshot, ack] = await Promise.all([snapshotEvent, acknowledgement]);
    assert.equal(ack.ok, true);
    assert.equal(snapshot.workspaceId, workspaceId);
    assert.equal(snapshot.roomId, 'classroom-1');
    for (const field of [
      'schemaVersion', 'revision', 'serverTimestamp', 'confirmedState',
      'pendingCommands', 'lastCommandId', 'deviceStates', 'layoutState',
      'classroomProgram', 'livestreamProgram', 'recordingState', 'streamState',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(snapshot, field), true, field);
    }

  } finally {
    client.disconnect();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    cleanup(prefix);
  }
});
