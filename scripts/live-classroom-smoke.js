#!/usr/bin/env node
'use strict';

const { db } = require('../server/db/database');
const { generateToken } = require('../server/middleware/auth');
const contract = require('../server/player/device-contract');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function broadcast(token, contentId, deviceIds) {
  const response = await fetch('http://127.0.0.1:3001/api/broadcast', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_id: contentId, device_ids: deviceIds }),
  });
  const body = await response.json();
  if (!response.ok || body.sent !== deviceIds.length) {
    throw new Error(`broadcast failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function fetchDisplayStates(token) {
  const response = await fetch('http://127.0.0.1:3001/api/displays/state', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.displays)) {
    throw new Error(`display state fetch failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.displays;
}

function connectDashboard(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/socket.io/?EIO=4&transport=websocket');
    const pending = new Map();
    const handlers = new Map();
    let nextAckId = 1;
    const timer = setTimeout(() => reject(new Error('dashboard socket connect timeout')), 10000);
    ws.onerror = () => reject(new Error('dashboard websocket error'));
    ws.onmessage = (event) => {
      const message = String(event.data || '');
      if (message === '2') {
        ws.send('3');
        return;
      }
      if (message.startsWith('0')) {
        ws.send(`40/dashboard,${JSON.stringify({ token })}`);
        return;
      }
      if (message.startsWith('40/dashboard,')) {
        clearTimeout(timer);
        resolve({
          close: () => ws.close(),
          on(name, handler) {
            if (!handlers.has(name)) handlers.set(name, new Set());
            handlers.get(name).add(handler);
            return () => handlers.get(name)?.delete(handler);
          },
          emitWithAck(name, data) {
            return new Promise((ackResolve, ackReject) => {
              const id = nextAckId++;
              const ackTimer = setTimeout(() => {
                pending.delete(id);
                ackReject(new Error(`socket ack timeout: ${name}`));
              }, 10000);
              pending.set(id, { resolve: ackResolve, timer: ackTimer });
              ws.send(`42/dashboard,${id}${JSON.stringify([name, data])}`);
            });
          },
        });
        return;
      }
      const eventMatch = message.match(/^42\/dashboard,(?:\d+)?(\[.*\])$/s);
      if (eventMatch) {
        const [name, data] = JSON.parse(eventMatch[1]);
        for (const handler of handlers.get(name) || []) handler(data);
        return;
      }
      const ackMatch = message.match(/^43\/dashboard,(\d+)(.*)$/s);
      if (!ackMatch) return;
      const id = Number(ackMatch[1]);
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      clearTimeout(waiter.timer);
      const values = JSON.parse(ackMatch[2] || '[]');
      waiter.resolve(values[0]);
    };
  });
}

async function waitForControllerTruth(socketStates, token, deviceIds) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const apiStates = (await fetchDisplayStates(token)).filter((display) => deviceIds.includes(display.id));
    const socketReady = deviceIds.every((id) => {
      const state = socketStates.get(id);
      return state && state.slide_index === 2 && state.slide_count >= 2;
    });
    const apiReady = apiStates.length === deviceIds.length && apiStates.every((display) => (
      display.slide_index === 2
      && display.slide_count >= 2
      && display.now_playing?.slideIndex === 2
    ));
    if (socketReady && apiReady) return apiStates;
    await sleep(500);
  }
  throw new Error(`controller truth timeout: ${JSON.stringify({ socket: [...socketStates], api: await fetchDisplayStates(token) })}`);
}

function sendCommand(socket, deviceId, action, payload = {}) {
  const envelope = contract.createCommand({
    device_id: deviceId,
    target_scope: 'display',
    payload: { ...payload, action },
  });
  return socket.emitWithAck('dashboard:device-command', { device_id: deviceId, envelope }).then((ack) => {
    if (!ack || !ack.delivered) throw new Error(`delivery rejected: ${deviceId}/${action}/${ack?.reason || 'unknown'}`);
    return envelope.command_id;
  });
}

async function waitForDeviceAcks(commandIds) {
  const placeholders = commandIds.map(() => '?').join(',');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = db.prepare(`SELECT command_id, status, ack_error FROM command_logs WHERE command_id IN (${placeholders})`).all(...commandIds);
    if (rows.length === commandIds.length && rows.every((row) => row.status === 'acked')) return rows;
    const failed = rows.find((row) => ['failed', 'timeout'].includes(row.status));
    if (failed) throw new Error(`device command failed: ${failed.command_id}/${failed.status}/${failed.ack_error || ''}`);
    await sleep(500);
  }
  throw new Error('device ack timeout');
}

function states(deviceIds) {
  const placeholders = deviceIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT target_id, content_type, slide_index, slide_count, state_revision,
           render_state, error_state, updated_at
    FROM display_states WHERE target_id IN (${placeholders}) ORDER BY target_id
  `).all(...deviceIds);
}

async function main() {
  const userId = required('SMOKE_USER_ID');
  const contentId = required('SMOKE_CONTENT_ID');
  const restoreContentId = required('SMOKE_RESTORE_CONTENT_ID');
  const deviceIds = required('SMOKE_DEVICE_IDS').split(',').map((value) => value.trim()).filter(Boolean);
  const workspaceId = required('SMOKE_WORKSPACE_ID');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`user not found: ${userId}`);
  const token = generateToken(user, workspaceId);
  let socket;
  let smokeError;
  try {
    await broadcast(token, contentId, deviceIds);
    await sleep(12000);
    socket = await connectDashboard(token);
    const socketStates = new Map();
    socket.on('dashboard:state-sync', (event) => {
      const id = event && (event.target_id || event.device_id || event.id);
      const state = event && event.state && typeof event.state === 'object' ? event.state : event;
      if (id && state) socketStates.set(id, state);
    });
    const before = states(deviceIds);
    const goToTwo = await Promise.all(deviceIds.map((id) => sendCommand(socket, id, 'go_to_slide', { slide: 2 })));
    await waitForDeviceAcks(goToTwo);
    await sleep(1500);
    const next = await Promise.all(deviceIds.map((id) => sendCommand(socket, id, 'next')));
    await waitForDeviceAcks(next);
    await sleep(1500);
    const previous = await Promise.all(deviceIds.map((id) => sendCommand(socket, id, 'prev')));
    await waitForDeviceAcks(previous);
    await sleep(1500);
    const after = states(deviceIds);
    const valid = after.length === deviceIds.length && after.every((state) => (
      state.slide_index === 2
      && state.slide_count >= 2
      && state.render_state !== 'failed'
      && !state.error_state
      && state.state_revision > (before.find((item) => item.target_id === state.target_id)?.state_revision || 0)
    ));
    if (!valid) throw new Error(`authoritative state mismatch: ${JSON.stringify({ before, after })}`);
    const controllerStates = await waitForControllerTruth(socketStates, token, deviceIds);
    const holdMs = Math.max(0, Math.min(120000, Number(process.env.SMOKE_HOLD_MS) || 0));
    console.log(JSON.stringify({
      ok: true,
      commands: [...goToTwo, ...next, ...previous],
      before,
      after,
      socket: [...socketStates].map(([target_id, state]) => ({
        target_id,
        slide_index: state.slide_index,
        slide_count: state.slide_count,
        state_revision: state.state_revision,
      })),
      controller: controllerStates.map((display) => ({
        id: display.id,
        slide_index: display.slide_index,
        slide_count: display.slide_count,
        now_playing_slide_index: display.now_playing?.slideIndex,
      })),
      hold_ms: holdMs,
    }, null, 2));
    if (holdMs) await sleep(holdMs);
  } catch (error) {
    smokeError = error;
  } finally {
    if (socket) socket.close();
    try {
      await broadcast(token, restoreContentId, deviceIds);
      await sleep(3000);
    } catch (restoreError) {
      if (!smokeError) smokeError = restoreError;
      else console.error(`restore also failed: ${restoreError.message}`);
    }
  }
  if (smokeError) throw smokeError;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
