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
}

function connectDashboard(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/socket.io/?EIO=4&transport=websocket');
    const pending = new Map();
    let nextAckId = 1;
    const timer = setTimeout(() => reject(new Error('dashboard socket connect timeout')), 10000);
    ws.onerror = () => reject(new Error('dashboard websocket error'));
    ws.onmessage = (event) => {
      const message = String(event.data || '');
      if (message === '2') return ws.send('3');
      if (message.startsWith('0')) return ws.send(`40/dashboard,${JSON.stringify({ token })}`);
      if (message.startsWith('40/dashboard,')) {
        clearTimeout(timer);
        return resolve({
          close: () => ws.close(),
          emitWithAck(name, data, timeoutMs = 10000) {
            return new Promise((ackResolve, ackReject) => {
              const id = nextAckId++;
              const ackTimer = setTimeout(() => {
                pending.delete(id);
                ackReject(new Error(`socket ack timeout: ${name}`));
              }, timeoutMs);
              pending.set(id, { resolve: ackResolve, timer: ackTimer });
              ws.send(`42/dashboard,${id}${JSON.stringify([name, data])}`);
            });
          },
        });
      }
      const ackMatch = message.match(/^43\/dashboard,(\d+)(.*)$/s);
      if (!ackMatch) return;
      const waiter = pending.get(Number(ackMatch[1]));
      if (!waiter) return;
      pending.delete(Number(ackMatch[1]));
      clearTimeout(waiter.timer);
      waiter.resolve(JSON.parse(ackMatch[2] || '[]')[0]);
    };
  });
}

function playbackStates(deviceIds) {
  const placeholders = deviceIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT target_id, current_content_id, content_type, "current_time" AS current_time, duration,
           paused, CASE WHEN render_state = 'ended' THEN 1 ELSE 0 END AS ended,
           render_state, error_state, state_revision
    FROM display_states
    WHERE target_type = 'display' AND target_id IN (${placeholders})
    ORDER BY target_id
  `).all(...deviceIds);
}

async function waitForStates(deviceIds, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = playbackStates(deviceIds);
    if (rows.length === deviceIds.length && rows.every((row) => !row.error_state && predicate(row))) return rows;
    await sleep(250);
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(rows)}`);
}

async function sendCommand(socket, deviceIds, action, payload = {}) {
  const startedAt = Date.now();
  const commandIds = [];
  for (const deviceId of deviceIds) {
    const envelope = contract.createCommand({
      device_id: deviceId,
      target_scope: 'display',
      payload: { ...payload, action },
    });
    const ack = await socket.emitWithAck('dashboard:device-command', { device_id: deviceId, envelope });
    if (!ack?.delivered) throw new Error(`${action} delivery rejected for ${deviceId}: ${ack?.reason || 'unknown'}`);
    commandIds.push(envelope.command_id);
  }
  const placeholders = commandIds.map(() => '?').join(',');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = db.prepare(`SELECT command_id, status, ack_error FROM command_logs WHERE command_id IN (${placeholders})`).all(...commandIds);
    const failed = rows.find((row) => ['failed', 'timeout'].includes(row.status));
    if (failed) throw new Error(`${action} failed: ${failed.command_id}/${failed.status}/${failed.ack_error || ''}`);
    if (rows.length === commandIds.length && rows.every((row) => row.status === 'acked')) {
      return { action, command_ids: commandIds, ack_ms: Date.now() - startedAt };
    }
    await sleep(250);
  }
  throw new Error(`${action} acknowledgement timeout`);
}

async function main() {
  const userId = required('SMOKE_USER_ID');
  const workspaceId = required('SMOKE_WORKSPACE_ID');
  const contentId = required('SMOKE_CONTENT_ID');
  const restoreContentId = required('SMOKE_RESTORE_CONTENT_ID');
  const deviceIds = required('SMOKE_DEVICE_IDS').split(',').map((value) => value.trim()).filter(Boolean);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`user not found: ${userId}`);
  const token = generateToken(user, workspaceId);
  let socket;
  let smokeError;
  const evidence = [];
  try {
    await broadcast(token, contentId, deviceIds);
    evidence.push({ phase: 'load', states: await waitForStates(deviceIds, (row) => (
      row.current_content_id === contentId && row.content_type === 'video'
      && row.duration > 0 && row.render_state !== 'failed'
    ), 'video load') });
    socket = await connectDashboard(token);

    evidence.push({ command: await sendCommand(socket, deviceIds, 'pause'), states: await waitForStates(deviceIds, (row) => row.paused === 1, 'pause') });
    evidence.push({ command: await sendCommand(socket, deviceIds, 'seek', { position_seconds: 2 }), states: await waitForStates(deviceIds, (row) => Math.abs(Number(row.current_time) - 2) < 1.25, 'absolute seek') });
    evidence.push({ command: await sendCommand(socket, deviceIds, 'play'), states: await waitForStates(deviceIds, (row) => row.paused === 0, 'play') });
    const normalized = await sendCommand(socket, deviceIds, 'seek', { position_normalized: 0.5 });
    evidence.push({ command: normalized, states: await waitForStates(deviceIds, (row) => Math.abs(Number(row.current_time) - Number(row.duration) * 0.5) < 1.75, 'normalized seek') });
    evidence.push({ command: await sendCommand(socket, deviceIds, 'restart'), states: await waitForStates(deviceIds, (row) => (
      Number(row.current_time) < 3
      && row.ended === 0
      && row.paused === 0
      && row.render_state === 'playing'
    ), 'restart') });
    evidence.push({ command: await sendCommand(socket, deviceIds, 'play_pause'), states: await waitForStates(deviceIds, (row) => row.paused === 1, 'play/pause toggle') });
    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } catch (error) {
    smokeError = error;
  } finally {
    if (socket) socket.close();
    try {
      await broadcast(token, restoreContentId, deviceIds);
      await waitForStates(deviceIds, (row) => row.current_content_id === restoreContentId, 'baseline restore');
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
