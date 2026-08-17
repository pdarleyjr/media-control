'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

test('real device and dashboard sockets persist only confirmed screen state and reject late stale state', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-blank-socket-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.ROOM_ID = 'classroom-1';
  const { db } = require('../db/database');
  const { generateToken } = require('../middleware/auth');
  const deviceContract = require('../player/device-contract');
  const setupDashboardSocket = require('../ws/dashboardSocket');
  const setupDeviceSocket = require('../ws/deviceSocket');

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  setupDeviceSocket(io);
  setupDashboardSocket(io);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.disconnect();
    await new Promise((resolve) => io.close(resolve));
    // Device disconnect is intentionally debounced for five seconds. Keep the
    // isolated database open until that deferred offline snapshot completes.
    await new Promise((resolve) => setTimeout(resolve, 5500));
    await new Promise((resolve) => httpServer.close(resolve));
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  db.prepare(`INSERT INTO users (id, email, name, role, plan_id)
    VALUES ('operator', 'operator@example.test', 'Operator', 'platform_admin', 'enterprise')`).run();
  db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id)
    VALUES ('org-1', 'MBFD', 'operator', 'enterprise')`).run();
  db.prepare(`INSERT INTO workspaces (id, organization_id, name, slug, created_by)
    VALUES ('ws-1', 'org-1', 'Classroom', 'classroom', 'operator')`).run();
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES ('ws-1', 'operator', 'workspace_admin')`).run();
  db.prepare(`INSERT INTO devices
    (id, user_id, workspace_id, name, status, device_token, screen_on)
    VALUES ('screen-a', 'operator', 'ws-1', 'Screen A', 'online', 'device-test-token', 1)`).run();

  const token = generateToken({
    id: 'operator', email: 'operator@example.test', username: 'operator', role: 'platform_admin',
  }, 'ws-1');

  const device = connectClient(`${root}/device`, {
    transports: ['websocket'], forceNew: true, reconnection: false,
  });
  clients.push(device);
  await once(device, 'connect');
  const registered = once(device, 'device:registered');
  device.emit('device:register', {
    device_id: 'screen-a',
    device_token: 'device-test-token',
    device_info: { app_version: 'blank-socket-test' },
  });
  await registered;

  const dashboard = connectClient(`${root}/dashboard`, {
    auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false,
  });
  clients.push(dashboard);
  await once(dashboard, 'room:snapshot');

  async function send(type) {
    const commandPromise = once(device, 'device:command');
    const envelope = deviceContract.createCommand({
      device_id: 'screen-a', target_scope: 'display', payload: { action: type },
    });
    const delivery = await dashboard.timeout(5000).emitWithAck('dashboard:device-command', {
      device_id: 'screen-a', type, payload: {}, envelope,
    });
    const command = await commandPromise;
    assert.equal(delivery.delivered, true);
    assert.equal(command.command_id, delivery.command_id);
    assert.ok(Number.isInteger(command.target_revision));
    assert.equal(command.payload.target_revision, command.target_revision);
    return command;
  }

  async function acknowledge(command, screenOn, stateRevision) {
    const dashboardAck = once(dashboard, 'command:ack');
    device.emit('device:ack', {
      command_id: command.command_id,
      ok: true,
      state: {
        screen_on: screenOn,
        command_revision: command.command_id,
        state_revision: stateRevision,
        playback_status: 'ready',
      },
    });
    return dashboardAck;
  }

  const firstOff = await send('screen_off');
  const firstAck = await acknowledge(firstOff, false, 1);
  assert.equal(firstAck.state.screen_on, false);
  assert.equal(db.prepare(`SELECT screen_on FROM display_states WHERE target_id = 'screen-a'`).get().screen_on, 0);
  assert.equal(db.prepare(`SELECT screen_on FROM devices WHERE id = 'screen-a'`).get().screen_on, 1,
    'delivery must not mutate the legacy intent column');

  const duplicateOff = await send('screen_off');
  await acknowledge(duplicateOff, false, 2);
  assert.equal(db.prepare(`SELECT screen_on FROM display_states WHERE target_id = 'screen-a'`).get().screen_on, 0);

  const delayedOff = await send('screen_off');
  const newerOn = await send('screen_on');
  const onAck = await acknowledge(newerOn, true, 4);
  assert.equal(onAck.state.screen_on, true);
  await acknowledge(delayedOff, false, 3);

  const finalState = db.prepare(`
    SELECT screen_on, command_revision, state_revision
    FROM display_states WHERE target_type = 'display' AND target_id = 'screen-a'
  `).get();
  assert.equal(finalState.screen_on, 1);
  assert.equal(finalState.command_revision, newerOn.command_id);
  assert.equal(finalState.state_revision, 4);
});
