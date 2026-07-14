#!/usr/bin/env node
'use strict';

const { db } = require('../server/db/database');
const { generateToken } = require('../server/middleware/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function broadcast(token, deviceId, contentId) {
  const response = await fetch('http://127.0.0.1:3001/api/broadcast', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], content_id: contentId }),
  });
  const body = await response.json();
  if (!response.ok || body.sent !== 1) {
    throw new Error(`broadcast failed (${response.status}): ${JSON.stringify(body)}`);
  }
}

function wallMembers(deviceId) {
  const wall = db.prepare(`
    SELECT vw.id, vw.layout_mode
    FROM video_walls vw
    JOIN video_wall_devices vwd ON vwd.wall_id = vw.id
    WHERE vwd.device_id = ?
  `).get(deviceId);
  if (!wall || wall.layout_mode === 'split') throw new Error('target is not a span-wall member');
  return db.prepare(`
    SELECT d.id, d.name
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `).all(wall.id);
}

async function waitForPhysicalState(memberIds, contentId, timeoutMs = 15000) {
  const placeholders = memberIds.map(() => '?').join(',');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = db.prepare(`
      SELECT target_id, current_content_id, render_state
      FROM display_states
      WHERE target_type = 'display' AND target_id IN (${placeholders})
    `).all(...memberIds);
    if (rows.length === memberIds.length && rows.every((row) => (
      row.current_content_id === contentId && row.render_state === 'playing'
    ))) return rows;
    await sleep(250);
  }
  throw new Error(`wall state did not converge to ${contentId}`);
}

async function main() {
  const email = required('SMOKE_USER_EMAIL').toLowerCase();
  const targetDeviceId = required('SMOKE_TARGET_DEVICE_ID');
  const probeContentId = required('SMOKE_CONTENT_ID');
  const restoreContentId = required('SMOKE_RESTORE_CONTENT_ID');
  const holdMs = Math.max(2000, Math.min(60000, Number(process.env.SMOKE_HOLD_MS) || 15000));

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  if (!user) throw new Error(`operator not found: ${email}`);
  const target = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(targetDeviceId);
  if (!target) throw new Error(`target not found: ${targetDeviceId}`);
  const membership = db.prepare(`
    SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?
  `).get(target.workspace_id, user.id);
  if (!membership && user.role !== 'platform_admin') throw new Error('operator cannot access target workspace');

  const members = wallMembers(targetDeviceId);
  const memberIds = members.map((member) => member.id);
  const token = generateToken(user, target.workspace_id);
  let probeStarted = false;
  try {
    await broadcast(token, targetDeviceId, probeContentId);
    probeStarted = true;
    const probeState = await waitForPhysicalState(memberIds, probeContentId);
    console.log(JSON.stringify({ phase: 'probe-ready', members, state: probeState }));
    await sleep(holdMs);
  } finally {
    if (probeStarted) {
      await broadcast(token, targetDeviceId, restoreContentId);
      const restoredState = await waitForPhysicalState(memberIds, restoreContentId);
      console.log(JSON.stringify({ phase: 'restored', members, state: restoredState }));
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
