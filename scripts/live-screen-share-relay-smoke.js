#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { db } = require('../server/db/database');
const { generateToken } = require('../server/middleware/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function connectDashboard(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/socket.io/?EIO=4&transport=websocket');
    const pending = new Map();
    let nextAckId = 1;
    const connectTimer = setTimeout(() => reject(new Error('dashboard socket connect timeout')), 10000);

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
        clearTimeout(connectTimer);
        resolve({
          close: () => ws.close(),
          emitWithAck(name, data, timeoutMs = 10000) {
            return new Promise((ackResolve, ackReject) => {
              const id = nextAckId++;
              const timer = setTimeout(() => {
                pending.delete(id);
                ackReject(new Error(`socket ack timeout: ${name}`));
              }, timeoutMs);
              pending.set(id, { resolve: ackResolve, timer });
              ws.send(`42/dashboard,${id}${JSON.stringify([name, data])}`);
            });
          },
        });
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

function wallTileForDevice(deviceId) {
  const member = db.prepare(`
    SELECT vwd.*
    FROM video_wall_devices vwd
    JOIN video_walls vw ON vw.id = vwd.wall_id
    WHERE vwd.device_id = ? AND vw.layout_mode != 'split'
    LIMIT 1
  `).get(deviceId);
  if (!member) return null;

  const members = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ?').all(member.wall_id);
  const rects = members.map((row) => ({
    x: Number(row.canvas_x ?? row.grid_col * 320),
    y: Number(row.canvas_y ?? row.grid_row * 180),
    w: Number(row.canvas_width ?? 320),
    h: Number(row.canvas_height ?? 180),
  }));
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    screen_rect: {
      x: Number(member.canvas_x ?? member.grid_col * 320),
      y: Number(member.canvas_y ?? member.grid_row * 180),
      w: Number(member.canvas_width ?? 320),
      h: Number(member.canvas_height ?? 180),
    },
    player_rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

async function main() {
  const email = required('SMOKE_USER_EMAIL').toLowerCase();
  const deviceIds = required('SMOKE_DEVICE_IDS').split(',').map((id) => id.trim()).filter(Boolean);
  const framePath = required('SMOKE_FRAME_PATH');
  const durationMs = Math.max(2000, Math.min(30000, Number(process.env.SMOKE_DURATION_MS) || 10000));
  const intervalMs = Math.max(150, Math.min(1000, Number(process.env.SMOKE_INTERVAL_MS) || 200));
  const frame = fs.readFileSync(framePath).toString('base64');
  if (frame.length > 1_200_000) throw new Error(`frame is too large: ${frame.length} base64 characters`);

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!user) throw new Error(`operator not found: ${email}`);
  const membership = db.prepare(`
    SELECT workspace_id FROM workspace_members
    WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1
  `).get(user.id);
  if (!membership) throw new Error(`operator has no workspace: ${email}`);

  const socket = await connectDashboard(generateToken(user, membership.workspace_id));
  const started = [];
  let deliveredFrames = 0;
  try {
    for (const deviceId of deviceIds) {
      const ack = await socket.emitWithAck('screen-share:start', {
        device_id: deviceId,
        wall_tile: wallTileForDevice(deviceId),
      });
      if (!ack?.ok) throw new Error(`screen-share:start rejected for ${deviceId}: ${ack?.error || 'unknown'}`);
      started.push(deviceId);
    }

    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const ack = await socket.emitWithAck('screen-share:frame', {
        device_ids: deviceIds,
        image_b64: frame,
        captured_at: Date.now(),
      });
      if (ack?.ok) deliveredFrames += Number(ack.delivered || 0);
      await sleep(intervalMs);
    }
  } finally {
    for (const deviceId of started) {
      await socket.emitWithAck('screen-share:stop', { device_id: deviceId }).catch(() => {});
    }
    socket.close();
  }

  console.log(JSON.stringify({
    ok: deliveredFrames > 0,
    devices: deviceIds.length,
    delivered_frames: deliveredFrames,
    duration_ms: durationMs,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
