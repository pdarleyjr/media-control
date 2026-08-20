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

async function waitForDeliveryConfirmation(token, requestId, expectedTargetCount, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:3001/api/broadcast/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const request = await response.json();
    if (!response.ok) {
      throw new Error(`broadcast status failed (${response.status}): ${JSON.stringify(request)}`);
    }
    if (request.status === 'confirmed'
      && Array.isArray(request.devices)
      && request.devices.length === expectedTargetCount
      && request.devices.every((device) => device.state === 'confirmed')) {
      return request;
    }
    if (request.status === 'failed' || request.status === 'expired') {
      throw new Error(`broadcast did not confirm: ${JSON.stringify(request)}`);
    }
    await sleep(250);
  }
  throw new Error(`broadcast ${requestId} did not confirm within ${timeoutMs}ms`);
}

async function broadcast(token, wallId, layoutRevision, contentId, expectedTargetCount, onAccepted) {
  const response = await fetch('http://127.0.0.1:3001/api/broadcast', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targets: [{ type: 'wall', id: wallId, layout_revision: layoutRevision }],
      content_id: contentId,
    }),
  });
  const body = await response.json();
  if (!response.ok
    || body.sent !== expectedTargetCount
    || body.total !== expectedTargetCount
    || body.failed?.length
    || !body.request_id) {
    throw new Error(`broadcast failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (typeof onAccepted === 'function') onAccepted(body);
  return waitForDeliveryConfirmation(token, body.request_id, expectedTargetCount);
}

function wallTopology(wallId) {
  const wall = db.prepare(`
    SELECT id, workspace_id, layout_revision
    FROM video_walls
    WHERE id = ?
  `).get(wallId);
  if (!wall) throw new Error(`wall not found: ${wallId}`);
  const members = db.prepare(`
    SELECT d.id, d.name
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `).all(wall.id);
  if (members.length < 2) throw new Error('wall must contain at least two displays');
  return { ...wall, members };
}

async function waitForPhysicalState(memberIds, contentId, timeoutMs = 15000) {
  const placeholders = memberIds.map(() => '?').join(',');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = db.prepare(`
      SELECT target_id, current_content_id, "current_time" AS current_time, render_state
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

async function waitForTimeAdvance(memberIds, contentId, initialState, timeoutMs = 10000) {
  const initialTimes = new Map(initialState.map((row) => [row.target_id, Number(row.current_time)]));
  const placeholders = memberIds.map(() => '?').join(',');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = db.prepare(`
      SELECT target_id, current_content_id, "current_time" AS current_time, render_state
      FROM display_states
      WHERE target_type = 'display' AND target_id IN (${placeholders})
    `).all(...memberIds);
    if (rows.length === memberIds.length && rows.every((row) => (
      row.current_content_id === contentId
      && row.render_state === 'playing'
      && Number.isFinite(Number(row.current_time))
      && Number(row.current_time) > initialTimes.get(row.target_id)
    ))) return rows;
    await sleep(250);
  }
  throw new Error(`wall playback time did not advance for ${contentId}`);
}

async function main() {
  const email = required('SMOKE_USER_EMAIL').toLowerCase();
  const wallId = required('SMOKE_WALL_ID');
  const probeContentId = required('SMOKE_CONTENT_ID');
  const restoreContentId = required('SMOKE_RESTORE_CONTENT_ID');
  const holdMs = Math.max(2000, Math.min(60000, Number(process.env.SMOKE_HOLD_MS) || 15000));

  const user = db.prepare(`
    SELECT id, email, username, role FROM users WHERE lower(email) = ?
  `).get(email);
  if (!user) throw new Error(`operator not found: ${email}`);
  const topology = wallTopology(wallId);
  const probe = db.prepare(`
    SELECT id, filepath, mime_type, file_size, processing_status, archived_at
    FROM content WHERE id = ?
  `).get(probeContentId);
  if (!probe
    || probe.mime_type !== 'video/mp4'
    || !probe.filepath
    || Number(probe.file_size) <= 0
    || probe.processing_status !== 'ready'
    || probe.archived_at != null) {
    throw new Error('SMOKE_CONTENT_ID must be a ready, non-archived local MP4');
  }
  const membership = db.prepare(`
    SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?
  `).get(topology.workspace_id, user.id);
  if (!membership && user.role !== 'platform_admin') throw new Error('operator cannot access target workspace');

  const members = topology.members;
  const memberIds = members.map((member) => member.id);
  const token = generateToken(user, topology.workspace_id);
  let probeStarted = false;
  try {
    const delivery = await broadcast(
      token,
      wallId,
      topology.layout_revision,
      probeContentId,
      members.length,
      () => { probeStarted = true; },
    );
    const probeState = await waitForPhysicalState(memberIds, probeContentId);
    const advancedState = await waitForTimeAdvance(memberIds, probeContentId, probeState);
    console.log(JSON.stringify({ phase: 'probe-ready', delivery, members, state: advancedState }));
    await sleep(holdMs);
  } finally {
    if (probeStarted) {
      const restoreTopology = wallTopology(wallId);
      const restoreMemberIds = restoreTopology.members.map((member) => member.id);
      if (JSON.stringify(restoreMemberIds) !== JSON.stringify(memberIds)) {
        throw new Error('wall membership changed during smoke test; refusing automatic restore');
      }
      const delivery = await broadcast(
        token,
        wallId,
        restoreTopology.layout_revision,
        restoreContentId,
        members.length,
      );
      const restoredState = await waitForPhysicalState(memberIds, restoreContentId);
      console.log(JSON.stringify({ phase: 'restored', delivery, members, state: restoredState }));
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
