#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const deviceContract = require('../server/player/device-contract');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writePrivateEvidence(filePath, data) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function jsonFetch(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket connect timeout')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')); };
      this.ws.onmessage = (event) => this.onMessage(event.data);
    });
  }

  onMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) this.events.push(message);
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* */ }
  }
}

function connectDashboard(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/socket.io/?EIO=4&transport=websocket');
    const pending = new Map();
    let nextAckId = 1;
    const timer = setTimeout(() => reject(new Error('dashboard websocket connect timeout')), 10000);
    ws.onerror = () => reject(new Error('dashboard websocket error'));
    ws.onmessage = (event) => {
      const message = String(event.data || '');
      if (message === '2') return ws.send('3');
      if (message.startsWith('0')) return ws.send(`40/dashboard,${JSON.stringify({ token })}`);
      if (message.startsWith('40/dashboard,')) {
        clearTimeout(timer);
        resolve({
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
        return;
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

async function waitForTarget(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const targets = await jsonFetch(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chromium is still starting. */ }
    await sleep(150);
  }
  throw new Error('Chromium DevTools target did not become ready');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression).catch((error) => ({ error: error.message }));
    if (last && last !== false) return last;
    await sleep(150);
  }
  throw new Error(`${label} timeout; last=${JSON.stringify(last)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dragDropConfig() {
  const contentId = String(process.env.SMOKE_DRAG_CONTENT_ID || '').trim();
  const sourceLabel = String(process.env.SMOKE_DRAG_SOURCE_LABEL || '').trim();
  if (!contentId && !sourceLabel) return null;
  if (contentId && sourceLabel) throw new Error('set only one of SMOKE_DRAG_CONTENT_ID or SMOKE_DRAG_SOURCE_LABEL');
  const wallId = required('SMOKE_DRAG_WALL_ID');
  const groupId = String(process.env.SMOKE_DRAG_GROUP_ID || '').trim();
  const layoutRevision = Number(required('SMOKE_DRAG_LAYOUT_REVISION'));
  const dwellMs = Number(process.env.SMOKE_DRAG_DWELL_MS || 5000);
  const config = {
    contentId,
    sourceLabel,
    sourceMarker: String(process.env.SMOKE_DRAG_SOURCE_MARKER || sourceLabel.toLowerCase().replace(/\s+/g, '-')).trim(),
    expectedContentType: String(process.env.SMOKE_DRAG_EXPECT_CONTENT_TYPE || 'web').trim(),
    wallId,
    groupId,
    layoutRevision,
    dwellMs,
    targetSelector: groupId
      ? `.mc-wall-region[data-wall-id="${wallId}"][data-layout-group-id="${groupId}"]`
      : `.mc-wall[data-wall-id="${wallId}"] .mc-wall-all`,
    deviceIds: csv(required('SMOKE_DRAG_DEVICE_IDS')),
    nonTargetDeviceIds: csv(required('SMOKE_DRAG_NON_TARGET_DEVICE_IDS')),
    restoreContentId: required('SMOKE_DRAG_RESTORE_CONTENT_ID'),
    restoreUserEmail: String(process.env.SMOKE_DRAG_RESTORE_USER_EMAIL || 'peterdarley@miamibeachfl.gov').trim().toLowerCase(),
  };
  if (!config.deviceIds.length) throw new Error('SMOKE_DRAG_DEVICE_IDS must contain at least one display');
  if (!Number.isSafeInteger(config.layoutRevision) || config.layoutRevision < 0) {
    throw new Error('SMOKE_DRAG_LAYOUT_REVISION must be a non-negative integer');
  }
  if (!Number.isFinite(config.dwellMs) || config.dwellMs < 2000 || config.dwellMs > 30000) {
    throw new Error('SMOKE_DRAG_DWELL_MS must be between 2000 and 30000');
  }
  if (!config.nonTargetDeviceIds.length) {
    throw new Error('SMOKE_DRAG_NON_TARGET_DEVICE_IDS must contain at least one display');
  }
  if (config.nonTargetDeviceIds.some((id) => config.deviceIds.includes(id))) {
    throw new Error('SMOKE_DRAG_NON_TARGET_DEVICE_IDS must not overlap SMOKE_DRAG_DEVICE_IDS');
  }
  return config;
}

function webLoginConfig(url) {
  const identifier = String(process.env.SMOKE_LOGIN_IDENTIFIER || '').trim();
  if (!identifier) return null;
  return {
    identifier,
    password: required('SMOKE_LOGIN_PASSWORD'),
    origin: new URL(url).origin,
  };
}

async function clickLayoutControl(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.hidden) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `layout control is missing: ${selector}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await evaluate(cdp, `(() => ({
      active: document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true',
      confirmationOpen: !!document.querySelector('dialog.mc-dialog[open] [data-mc-confirm]'),
    }))()`);
    if (state.active) return;
    if (state.confirmationOpen) {
      await evaluate(cdp, `document.querySelector('dialog.mc-dialog[open] [data-mc-confirm]').click()`);
      return;
    }
    await sleep(50);
  }
  throw new Error(`layout control did not open confirmation or become active: ${selector}`);
}

async function waitForHybridPreset(cdp, preset) {
  return waitFor(cdp, `(async () => {
    const active = document.querySelector('[data-layout-preset="${preset}"]');
    const overview = document.querySelector('.mc-wall-groups-overview');
    const regions = [...(overview?.querySelectorAll('.mc-wall-region[data-layout-group-id][data-wall-id]') || [])];
    const response = await fetch('/api/walls', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
    });
    if (!response.ok) return false;
    const body = await response.json();
    const wall = (body.walls || body || []).find((item) => /Classroom 1 Primary Wall/i.test(item.name || ''));
    if (!active?.classList.contains('is-active') || active.getAttribute('aria-pressed') !== 'true') return false;
    if (!wall || wall.layout_mode !== 'groups' || wall.layout?.preset !== ${JSON.stringify(preset)}) return false;
    if (regions.length !== 2 || regions.some((region) => !region.querySelector('.mc-wall-all[data-wall-ids]'))) return false;
    return {
      preset: wall.layout.preset,
      revision: wall.layout.revision,
      group_ids: wall.layout.groups.map((group) => group.id),
      member_ids: wall.layout.groups.map((group) => group.member_ids),
      region_widths: regions.map((region) => region.getBoundingClientRect().width),
    };
  })()`, `hybrid preset ${preset}`, 30000);
}

async function exerciseHybridLayouts(cdp) {
  const initial = await evaluate(cdp, `(async () => {
    const response = await fetch('/api/walls', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
    });
    if (!response.ok) throw new Error('wall inventory failed: HTTP ' + response.status);
    const body = await response.json();
    const wall = (body.walls || body || []).find((item) => /Classroom 1 Primary Wall/i.test(item.name || ''));
    return wall ? { id: wall.id, layout_mode: wall.layout_mode } : null;
  })()`);
  assert(initial, 'Classroom 1 Primary Wall inventory is missing');
  assert(['span', 'split'].includes(initial.layout_mode), `hybrid smoke cannot safely restore ${initial.layout_mode}`);

  const results = [];
  try {
    for (const preset of ['span-left', 'span-right']) {
      await clickLayoutControl(cdp, `[data-layout-preset="${preset}"]`);
      const snapshot = await waitForHybridPreset(cdp, preset);
      for (const groupId of snapshot.group_ids) {
        const clicked = await evaluate(cdp, `(() => {
          const region = document.querySelector('[data-layout-group-id="${groupId}"]');
          if (!region) return false;
          region.click();
          return true;
        })()`);
        assert(clicked, `hybrid control region is missing: ${groupId}`);
        await waitFor(
          cdp,
          `document.querySelector('[data-layout-group-id="${groupId}"]')?.classList.contains('is-active')`,
          `hybrid control region ${groupId}`
        );
      }
      results.push(snapshot);
    }
  } finally {
    await clickLayoutControl(cdp, `[data-ss-mode="${initial.layout_mode}"]`);
    await waitFor(cdp, `(async () => {
      const response = await fetch('/api/walls', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
      });
      if (!response.ok) return false;
      const body = await response.json();
      const wall = (body.walls || body || []).find((item) => item.id === ${JSON.stringify(initial.id)});
      return wall?.layout_mode === ${JSON.stringify(initial.layout_mode)}
        && !document.querySelector('.mc-wall-groups-overview');
    })()`, `restore wall mode ${initial.layout_mode}`, 30000);
  }
  return { initial_mode: initial.layout_mode, restored_mode: initial.layout_mode, presets: results };
}

async function createWebSession(config) {
  const response = await fetch(`${config.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: config.identifier, password: config.password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token || !body.user) {
    throw new Error(`web login failed (${response.status}): ${body.error || 'invalid response'}`);
  }
  return body;
}

async function waitForPhysicalContent(db, deviceIds, contentId, timeoutMs = 20000) {
  const placeholders = deviceIds.map(() => '?').join(',');
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = db.prepare(`
      SELECT target_id, current_content_id, render_state, error_state, state_revision
      FROM display_states
      WHERE target_type = 'display' AND target_id IN (${placeholders})
      ORDER BY target_id
    `).all(...deviceIds);
    if (rows.length === deviceIds.length && rows.every((row) => (
      row.current_content_id === contentId
      && row.render_state === 'playing'
      && !row.error_state
    ))) return rows;
    await sleep(250);
  }
  throw new Error(`display state did not converge to ${contentId}: ${JSON.stringify(rows)}`);
}

function physicalDisplayStates(db, deviceIds) {
  const placeholders = deviceIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT target_id, current_content_id, current_asset_id, content_type,
           render_state, error_state, state_revision, command_revision,
           slide_index, current_time, duration, paused, muted, volume
    FROM display_states
    WHERE target_type = 'display' AND target_id IN (${placeholders})
    ORDER BY target_id
  `).all(...deviceIds);
}

function sameStateValue(left, right) {
  return (left ?? null) === (right ?? null);
}

function stablePlaybackStateMatches(actual, expected) {
  return ['current_content_id', 'current_asset_id', 'content_type', 'render_state',
    'error_state', 'slide_index', 'paused', 'muted', 'volume']
    .every((key) => sameStateValue(actual?.[key], expected?.[key]))
    && (expected?.paused !== 1 || expected?.current_time == null
      || Math.abs(Number(actual?.current_time) - Number(expected.current_time)) <= 1.25);
}

async function sendRestorationCommand(socket, db, deviceId, action, payload = {}) {
  const envelope = deviceContract.createCommand({
    device_id: deviceId,
    target_scope: 'display',
    payload: { ...payload, action },
  });
  const ack = await socket.emitWithAck('dashboard:device-command', { device_id: deviceId, envelope });
  if (!ack?.delivered) {
    throw new Error(`${action} restore delivery rejected for ${deviceId}: ${ack?.reason || 'unknown'}`);
  }
  const deadline = Date.now() + 15000;
  let row = null;
  while (Date.now() < deadline) {
    row = db.prepare(`
      SELECT command_id, status, ack_at, ack_error
      FROM command_logs
      WHERE command_id = ?
    `).get(envelope.command_id) || null;
    if (row && ['failed', 'timeout'].includes(row.status)) {
      throw new Error(`${action} restore failed for ${deviceId}: ${row.status}/${row.ack_error || ''}`);
    }
    if (row?.status === 'acked' && row.ack_at && !row.ack_error) {
      return { device_id: deviceId, action, command_id: envelope.command_id, acknowledged_at: row.ack_at };
    }
    await sleep(250);
  }
  throw new Error(`${action} restore acknowledgement timeout for ${deviceId}: ${JSON.stringify(row)}`);
}

async function restoreTransportState(db, token, beforeStates) {
  const socket = await connectDashboard(token);
  const commands = [];
  try {
    for (const state of beforeStates) {
      if (!['playing', 'paused'].includes(state.render_state)) {
        throw new Error(`unsupported baseline render state for exact restore: ${JSON.stringify(state)}`);
      }
      if (Number.isInteger(state.slide_index) && state.slide_index > 1) {
        commands.push(await sendRestorationCommand(socket, db, state.target_id, 'go_to_slide', {
          slide: state.slide_index,
        }));
      } else if (/^(video|audio)$/i.test(String(state.content_type || ''))
        && Number.isFinite(Number(state.current_time)) && Number(state.current_time) > 0) {
        commands.push(await sendRestorationCommand(socket, db, state.target_id, 'seek', {
          position_seconds: Number(state.current_time),
        }));
      }
      if (Number.isFinite(Number(state.volume)) && Number(state.volume) >= 0 && Number(state.volume) <= 1) {
        commands.push(await sendRestorationCommand(socket, db, state.target_id, 'volume', {
          volume: Number(state.volume),
        }));
      }
      if (state.muted === 1 || state.muted === 0) {
        commands.push(await sendRestorationCommand(
          socket,
          db,
          state.target_id,
          state.muted === 1 ? 'mute' : 'unmute'
        ));
      }
      if (state.paused === 1 || state.paused === 0) {
        commands.push(await sendRestorationCommand(
          socket,
          db,
          state.target_id,
          state.paused === 1 ? 'pause' : 'play'
        ));
      }
    }
  } finally {
    socket.close();
  }
  return commands;
}

function assertNonTargetImmutability(db, deviceIds, beforeStates, config, startedAt) {
  const placeholders = deviceIds.map(() => '?').join(',');
  const sourceCommands = db.prepare(`
    SELECT target_id, command_id, command_type, status, ack_at, ack_error, created_at
    FROM command_logs
    WHERE target_type = 'display'
      AND target_id IN (${placeholders})
      AND created_at >= ?
      AND payload LIKE ?
    ORDER BY created_at, target_id
  `).all(...deviceIds, startedAt - 1000, `%${config.sourceMarker}%`);
  const afterStates = physicalDisplayStates(db, deviceIds);
  const beforeByTarget = new Map(beforeStates.map((row) => [row.target_id, row]));
  const changed = afterStates.filter((row) => {
    const before = beforeByTarget.get(row.target_id);
    return !before
      || row.command_revision !== before.command_revision
      || !stablePlaybackStateMatches(row, before);
  });
  assert(sourceCommands.length === 0,
    `non-target displays received ${config.sourceLabel} commands: ${JSON.stringify(sourceCommands)}`);
  assert(afterStates.length === deviceIds.length && changed.length === 0,
    `non-target display state changed: ${JSON.stringify({ beforeStates, afterStates, changed })}`);
  return {
    device_ids: deviceIds,
    source_command_count: sourceCommands.length,
    states: afterStates.map((row) => ({
      ...row,
      state_revision_delta: (Number(row.state_revision) || 0)
        - (Number(beforeByTarget.get(row.target_id)?.state_revision) || 0),
    })),
  };
}

async function waitForRestoredStates(db, beforeStates, timeoutMs = 20000) {
  const deviceIds = beforeStates.map((row) => row.target_id);
  const beforeByTarget = new Map(beforeStates.map((row) => [row.target_id, row]));
  const deadline = Date.now() + timeoutMs;
  let states = [];
  while (Date.now() < deadline) {
    states = physicalDisplayStates(db, deviceIds);
    const restored = states.length === deviceIds.length && states.every((row) => {
      const before = beforeByTarget.get(row.target_id);
      return stablePlaybackStateMatches(row, before)
        && (Number(row.state_revision) || 0) > (Number(before?.state_revision) || 0);
    });
    if (restored) return states;
    await sleep(250);
  }
  throw new Error(`display state did not restore exactly: ${JSON.stringify({ beforeStates, states })}`);
}

async function waitForPhysicalSource(db, deviceIds, config, beforeStates, startedAt, timeoutMs = 20000) {
  const placeholders = deviceIds.map(() => '?').join(',');
  const beforeRevision = new Map(beforeStates.map((row) => [row.target_id, Number(row.state_revision) || 0]));
  const deadline = Date.now() + timeoutMs;
  let commands = [];
  let states = [];
  let delivery = null;
  let deliveryResults = [];
  while (Date.now() < deadline) {
    const candidates = db.prepare(`
      SELECT target_id, command_id, command_type, payload, status, ack_at, ack_error, created_at
      FROM command_logs
      WHERE target_type = 'display'
        AND target_id IN (${placeholders})
        AND created_at >= ?
        AND payload LIKE ?
      ORDER BY created_at DESC
    `).all(...deviceIds, startedAt - 1000, `%${config.sourceMarker}%`);
    const latestByTarget = new Map();
    for (const row of candidates) {
      if (!latestByTarget.has(row.target_id)) latestByTarget.set(row.target_id, row);
    }
    commands = deviceIds.map((id) => latestByTarget.get(id)).filter(Boolean);
    states = physicalDisplayStates(db, deviceIds);
    delivery = null;
    deliveryResults = [];
    if (commands.length === deviceIds.length) {
      const commandIds = commands.map((row) => row.command_id);
      const commandPlaceholders = commandIds.map(() => '?').join(',');
      delivery = db.prepare(`
        SELECT br.id, br.source_type, br.source_id, br.typed_targets_json,
               br.resolved_target_ids_json, br.expected_target_count, br.status, br.created_at,
               COUNT(DISTINCT bdr.command_id) AS matched_command_count
        FROM broadcast_requests br
        JOIN broadcast_device_results bdr ON bdr.request_id = br.id
        WHERE bdr.command_id IN (${commandPlaceholders}) AND br.created_at >= ?
        GROUP BY br.id
        HAVING matched_command_count = ?
        ORDER BY br.created_at DESC
        LIMIT 1
      `).get(...commandIds, startedAt - 1000, deviceIds.length) || null;
      if (delivery) {
        deliveryResults = db.prepare(`
          SELECT device_id, command_id, state, delivery_state, acknowledgment_state,
                 failure_reason, delivered_at, acknowledged_at, confirmed_at
          FROM broadcast_device_results
          WHERE request_id = ?
          ORDER BY ordinal, device_id
        `).all(delivery.id);
      }
    }
    let typedTargets = [];
    let resolvedTargetIds = [];
    try { typedTargets = JSON.parse(delivery?.typed_targets_json || '[]'); } catch { /* fail below */ }
    try { resolvedTargetIds = JSON.parse(delivery?.resolved_target_ids_json || '[]'); } catch { /* fail below */ }
    const typedTarget = typedTargets[0] || {};
    const targetIdentityMatches = config.groupId
      ? typedTarget.type === 'wall-group'
        && typedTarget.wall_id === config.wallId
        && typedTarget.group_id === config.groupId
        && Number(typedTarget.layout_revision) === config.layoutRevision
      : typedTarget.type === 'wall'
        && (typedTarget.id === config.wallId || typedTarget.wall_id === config.wallId)
        && Number(typedTarget.layout_revision) === config.layoutRevision;
    const deliveryResultsConfirmed = deliveryResults.length === deviceIds.length
      && deliveryResults.every((row) => deviceIds.includes(row.device_id)
        && row.state === 'confirmed'
        && row.delivery_state === 'delivered'
        && row.acknowledgment_state === 'confirmed'
        && !row.failure_reason
        && row.delivered_at
        && row.acknowledged_at
        && row.confirmed_at);
    const typedTargetConfirmed = delivery?.status === 'confirmed'
      && typedTargets.length === 1
      && targetIdentityMatches
      && resolvedTargetIds.slice().sort().join(',') === deviceIds.slice().sort().join(',')
      && Number(delivery.expected_target_count) === deviceIds.length
      && Number(delivery.matched_command_count) === deviceIds.length
      && deliveryResultsConfirmed;
    const commandsAcked = commands.length === deviceIds.length
      && commands.every((row) => row.status === 'acked' && row.ack_at && !row.ack_error);
    const statesAdvanced = states.length === deviceIds.length && states.every((row) => (
      (Number(row.state_revision) || 0) > (beforeRevision.get(row.target_id) || 0)
      && row.command_revision
      && row.command_revision !== beforeStates.find((before) => before.target_id === row.target_id)?.command_revision
      && row.render_state === 'playing'
      && !row.error_state
      && (!config.expectedContentType || row.content_type === config.expectedContentType)
    ));
    if (commandsAcked && statesAdvanced && typedTargetConfirmed) {
      return {
        commands: commands.map((row) => ({
          target_id: row.target_id,
          command_id: row.command_id,
          command_type: row.command_type,
          status: row.status,
          acknowledged_at: row.ack_at,
          source_marker_confirmed: String(row.payload || '').includes(config.sourceMarker),
        })),
        states,
        delivery: {
          request_id: delivery.id,
          status: delivery.status,
          source_type: delivery.source_type,
          typed_targets: typedTargets,
          resolved_target_ids: resolvedTargetIds,
          expected_target_count: delivery.expected_target_count,
          device_results: deliveryResults,
        },
      };
    }
    await sleep(250);
  }
  throw new Error(`physical source did not converge to ${config.sourceLabel}: ${JSON.stringify({ commands, states, delivery, deliveryResults })}`);
}

async function restoreDragDropContent(db, config, beforeStates) {
  assert(beforeStates.length === config.deviceIds.length,
    `drag restore baseline is incomplete: ${JSON.stringify(beforeStates)}`);
  assert(beforeStates.every((row) => row.current_content_id === config.restoreContentId),
    `SMOKE_DRAG_RESTORE_CONTENT_ID does not match the live baseline: ${JSON.stringify(beforeStates)}`);
  const { generateToken } = require('../server/middleware/auth');
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(config.restoreUserEmail);
  if (!user) throw new Error(`drag restore user not found: ${config.restoreUserEmail}`);
  const target = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(config.deviceIds[0]);
  if (!target?.workspace_id) throw new Error('drag restore target workspace not found');
  const membership = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(target.workspace_id, user.id);
  if (!membership && user.role !== 'platform_admin') throw new Error('drag restore user cannot access the target workspace');
  const restoreTarget = config.groupId
    ? {
        type: 'wall-group',
        wall_id: config.wallId,
        group_id: config.groupId,
        layout_revision: config.layoutRevision,
      }
    : { type: 'wall', id: config.wallId, layout_revision: config.layoutRevision };
  const response = await fetch('http://127.0.0.1:3001/api/broadcast', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${generateToken(user, target.workspace_id)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_id: config.restoreContentId, targets: [restoreTarget] }),
  });
  const body = await response.json();
  if (!response.ok || body.sent !== config.deviceIds.length) {
    throw new Error(`drag restore failed (${response.status}): ${JSON.stringify(body)}`);
  }
  await waitForPhysicalContent(db, config.deviceIds, config.restoreContentId);
  const transportCommands = await restoreTransportState(db, generateToken(user, target.workspace_id), beforeStates);
  return {
    states: await waitForRestoredStates(db, beforeStates),
    transport_commands: transportCommands,
  };
}

async function proveStableSourcePlayback(db, config, routedStates) {
  await sleep(config.dwellMs);
  const states = physicalDisplayStates(db, config.deviceIds);
  const routedByTarget = new Map(routedStates.map((row) => [row.target_id, row]));
  const stable = states.length === config.deviceIds.length && states.every((row) => {
    const routed = routedByTarget.get(row.target_id);
    return row.render_state === 'playing'
      && !row.error_state
      && (!config.expectedContentType || row.content_type === config.expectedContentType)
      && row.command_revision === routed?.command_revision
      && (Number(row.state_revision) || 0) >= (Number(routed?.state_revision) || 0);
  });
  assert(stable, `${config.sourceLabel} did not remain stable for ${config.dwellMs}ms: ${JSON.stringify(states)}`);
  return { dwell_ms: config.dwellMs, states };
}

async function main() {
  const url = String(process.env.SMOKE_CONSOLE_URL || 'http://127.0.0.1:3001/console/classroom-1#/control');
  const loginConfig = webLoginConfig(url);
  const deviceToken = String(process.env.CONSOLE_DEVICE_TOKEN || '').trim();
  if (!loginConfig && !deviceToken) throw new Error('CONSOLE_DEVICE_TOKEN or SMOKE_LOGIN_IDENTIFIER is required');
  const webSession = loginConfig ? await createWebSession(loginConfig) : null;
  const dragConfig = dragDropConfig();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-console-evidence-'));
  const screenshotName = path.basename(String(process.env.SMOKE_SCREENSHOT_PATH || 'console-ui-smoke.png'));
  const screenshotPath = path.join(evidenceDir, screenshotName);
  const liveSourceScreenshotPath = screenshotPath.replace(/(\.png)?$/i, '-live-source.png');
  const startupSettleMs = Number(process.env.SMOKE_STARTUP_SETTLE_MS || 0);
  if (!Number.isFinite(startupSettleMs) || startupSettleMs < 0 || startupSettleMs > 10000) {
    throw new Error('SMOKE_STARTUP_SETTLE_MS must be between 0 and 10000');
  }
  const chromium = String(process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser');
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-console-smoke-'));
  const child = spawn(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--window-size=1920,1080',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromiumError = '';
  child.stderr.on('data', (chunk) => { chromiumError = (chromiumError + chunk).slice(-4000); });

  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
      cdp.send('Log.enable'),
    ]);
    if (deviceToken) {
      await cdp.send('Network.setExtraHTTPHeaders', {
        headers: { 'X-MBFD-Device-Token': deviceToken },
      });
    }
    if (webSession) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try {
          localStorage.setItem('token', ${JSON.stringify(webSession.token)});
          localStorage.setItem('user', ${JSON.stringify(JSON.stringify(webSession.user))});
          localStorage.setItem('rd_onboarded', '1');
        } catch (_) {}`,
      });
    }
    await cdp.send('Page.navigate', { url });

    const ready = await waitFor(cdp, `(() => {
      const buttons = [...document.querySelectorAll('.mc-target-wall-btn')];
      if (!document.querySelector('.mc-cc-shell') || buttons.length < 2) return false;
      return buttons.map((button) => ({ text: button.textContent.trim(), value: button.dataset.targetValue }));
    })()`, 'command center ready', 30000);
    if (ready.length < 2) {
      throw new Error(`at least two authorized wall targets are required: ${JSON.stringify(ready)}`);
    }
    if (startupSettleMs > 0) await sleep(startupSettleMs);
    const expectedWallTargets = csv(process.env.SMOKE_EXPECT_WALL_TARGETS);
    const targetCycle = expectedWallTargets.length
      ? expectedWallTargets.map((label) => {
        const target = ready.find((item) => item.text === label);
        assert(target, `configured wall target is missing: ${label}; visible=${JSON.stringify(ready)}`);
        return target.value;
      })
      : ready.slice(0, 2).map((item) => item.value).reverse();

    for (const targetValue of targetCycle) {
      await evaluate(cdp, `(() => {
        const button = [...document.querySelectorAll('.mc-target-wall-btn')]
          .find((button) => button.dataset.targetValue === ${JSON.stringify(targetValue)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      await waitFor(cdp, `(() => {
        const button = [...document.querySelectorAll('.mc-target-wall-btn')]
          .find((button) => button.dataset.targetValue === ${JSON.stringify(targetValue)});
        return !!button && button.getAttribute('aria-selected') === 'true' && button.classList.contains('is-active');
      })()`, `${targetValue} selection`);
    }

    const hybridLayouts = process.env.SMOKE_HYBRID_LAYOUTS === '1'
      ? await exerciseHybridLayouts(cdp)
      : null;

    const uploadDialog = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-mc-rail="upload"]');
      if (!button) return false;
      button.click();
      const input = document.querySelector('.mc-view-modal[open] [data-quick-upload-input]');
      const picker = document.querySelector('.mc-view-modal[open] [data-quick-upload-pick]');
      return input && picker ? {
        multiple: input.multiple,
        accept: input.accept,
        pickerText: picker.textContent.trim().replace(/\\s+/g, ' '),
      } : false;
    })()`);
    assert(uploadDialog, 'Upload Media rail action did not open its dialog');
    assert(uploadDialog.multiple, 'Upload Media picker does not support multiple files');
    assert(/powerpoint/i.test(uploadDialog.accept), 'Upload Media picker does not accept PowerPoint files');
    await evaluate(cdp, `document.querySelector('.mc-view-modal[open] [data-modal-close]')?.click()`);
    await waitFor(cdp, `!document.querySelector('.mc-view-modal[open]')`, 'upload dialog close');

    let dragDrop = null;
    if (dragConfig) {
      const { db } = require('../server/db/database');
      if (dragConfig.sourceLabel) {
        const opened = await evaluate(cdp, `(() => {
          const tab = document.querySelector('.mc-tb-tab[data-tab="camerafeeds"]');
          if (!tab) return false;
          tab.click();
          return true;
        })()`);
        assert(opened, 'Live Sources tab is missing for configured drag source');
        await waitFor(cdp, `!![...document.querySelectorAll('.mc-live-source-tile[data-label]')]
          .find((item) => item.dataset.label === ${JSON.stringify(dragConfig.sourceLabel)})`, 'configured live drag source', 30000);
      }
      const inventory = await waitFor(cdp, `(() => {
        const target = document.querySelector(${JSON.stringify(dragConfig.targetSelector)});
        const sources = [...document.querySelectorAll('.mc-tile[data-drag-source]')].map((item) => {
          try {
            const source = JSON.parse(item.dataset.dragSource || '{}');
            return {
              content_id: source.content_id || null,
              label: item.dataset.label || item.textContent.trim().slice(0, 120),
              live_source_id: source.live_source_id || null,
            };
          } catch { return null; }
        }).filter(Boolean);
        if (!target || !sources.length) return false;
        return { target: true, sources };
      })()`, 'podium drag inventory', 30000);

      if (dragConfig.contentId && dragConfig.contentId.toLowerCase() === 'auto') {
        const selected = inventory.sources.find((source) => (
          source.content_id && source.content_id !== dragConfig.restoreContentId
        ));
        if (!selected) throw new Error(`no visible drag source differs from restore content: ${JSON.stringify(inventory.sources)}`);
        dragConfig.contentId = selected.content_id;
      }

      const configuredSource = inventory.sources.find((source) => dragConfig.sourceLabel
        ? source.label === dragConfig.sourceLabel
        : source.content_id === dragConfig.contentId);
      assert(configuredSource, `configured drag source is not visible: ${dragConfig.sourceLabel || dragConfig.contentId}; visible=${JSON.stringify(inventory.sources)}`);
      await waitFor(cdp, `(() => {
        const contentId = ${JSON.stringify(dragConfig.contentId)};
        const sourceLabel = ${JSON.stringify(dragConfig.sourceLabel)};
        const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
          try {
            return sourceLabel
              ? item.dataset.label === sourceLabel
              : JSON.parse(item.dataset.dragSource || '{}').content_id === contentId;
          } catch { return false; }
        });
        return !!tile && !!document.querySelector(${JSON.stringify(dragConfig.targetSelector)});
      })()`, 'podium drag source and wall target', 30000);

      let dispatched = false;
      let beforeState = [];
      try {
        beforeState = physicalDisplayStates(db, dragConfig.deviceIds);
        const beforeNonTargetState = physicalDisplayStates(db, dragConfig.nonTargetDeviceIds);
        const dragStartedAt = Date.now();
        const browserResult = await evaluate(cdp, `(() => {
          const contentId = ${JSON.stringify(dragConfig.contentId)};
          const sourceLabel = ${JSON.stringify(dragConfig.sourceLabel)};
          const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
            try {
              return sourceLabel
                ? item.dataset.label === sourceLabel
                : JSON.parse(item.dataset.dragSource || '{}').content_id === contentId;
            } catch { return false; }
          });
          const target = document.querySelector(${JSON.stringify(dragConfig.targetSelector)});
          if (!tile || !target) return { ok: false, reason: 'source or target missing' };
          const dataTransfer = new DataTransfer();
          tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
          const source = dataTransfer.getData('application/x-mc-source');
          const label = dataTransfer.getData('application/x-mc-label');
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
          return { ok: true, source, label, types: [...dataTransfer.types] };
        })()`);
        assert(browserResult?.ok, `podium drag event failed: ${JSON.stringify(browserResult)}`);
        assert(browserResult.types.includes('application/x-mc-source'), 'podium drag event omitted the media-control source MIME');
        dispatched = true;
        const probeState = dragConfig.sourceLabel
          ? await waitForPhysicalSource(db, dragConfig.deviceIds, dragConfig, beforeState, dragStartedAt)
          : await waitForPhysicalContent(db, dragConfig.deviceIds, dragConfig.contentId);
        const stableState = dragConfig.sourceLabel
          ? await proveStableSourcePlayback(db, dragConfig, probeState.states)
          : null;
        const nonTargetState = assertNonTargetImmutability(
          db,
          dragConfig.nonTargetDeviceIds,
          beforeNonTargetState,
          dragConfig,
          dragStartedAt
        );
        dragDrop = {
          before_state: beforeState,
          browser: browserResult,
          probe_state: probeState,
          stable_state: stableState,
          non_target_state: nonTargetState,
          convergence_ms: Date.now() - dragStartedAt,
        };
      } finally {
        if (dispatched) {
          const restoredState = await restoreDragDropContent(db, dragConfig, beforeState);
          dragDrop = { ...(dragDrop || {}), restored_state: restoredState };
        }
      }

      let touchDispatched = false;
      let beforeTouchState = [];
      try {
        beforeTouchState = physicalDisplayStates(db, dragConfig.deviceIds);
        const beforeTouchNonTargetState = physicalDisplayStates(db, dragConfig.nonTargetDeviceIds);
        const touchStartedAt = Date.now();
        const touchResult = await evaluate(cdp, `(() => {
          const contentId = ${JSON.stringify(dragConfig.contentId)};
          const sourceLabel = ${JSON.stringify(dragConfig.sourceLabel)};
          const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
            try {
              return sourceLabel
                ? item.dataset.label === sourceLabel
                : JSON.parse(item.dataset.dragSource || '{}').content_id === contentId;
            } catch { return false; }
          });
          const target = document.querySelector(${JSON.stringify(dragConfig.targetSelector)});
          if (!tile || !target) return { ok: false, reason: 'touch source or target missing' };
          const from = tile.getBoundingClientRect();
          const to = target.getBoundingClientRect();
          const pointerId = 73;
          const event = (type, x, y, buttons) => new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
            buttons,
          });
          tile.dispatchEvent(event('pointerdown', from.left + from.width / 2, from.top + from.height / 2, 1));
          tile.dispatchEvent(event('pointermove', to.left + to.width / 2, to.top + to.height / 2, 1));
          const ghostVisible = !!document.querySelector('.mc-touch-drag-ghost');
          tile.dispatchEvent(event('pointerup', to.left + to.width / 2, to.top + to.height / 2, 0));
          return { ok: true, ghost_visible: ghostVisible };
        })()`);
        assert(touchResult?.ok, `podium touch drag failed: ${JSON.stringify(touchResult)}`);
        assert(touchResult.ghost_visible, 'podium touch drag did not enter dragging state');
        touchDispatched = true;
        const touchProbeState = dragConfig.sourceLabel
          ? await waitForPhysicalSource(db, dragConfig.deviceIds, dragConfig, beforeTouchState, touchStartedAt)
          : await waitForPhysicalContent(db, dragConfig.deviceIds, dragConfig.contentId);
        const touchStableState = dragConfig.sourceLabel
          ? await proveStableSourcePlayback(db, dragConfig, touchProbeState.states)
          : null;
        const touchNonTargetState = assertNonTargetImmutability(
          db,
          dragConfig.nonTargetDeviceIds,
          beforeTouchNonTargetState,
          dragConfig,
          touchStartedAt
        );
        dragDrop = {
          ...(dragDrop || {}),
          touch_before_state: beforeTouchState,
          touch_browser: touchResult,
          touch_probe_state: touchProbeState,
          touch_stable_state: touchStableState,
          touch_non_target_state: touchNonTargetState,
          touch_convergence_ms: Date.now() - touchStartedAt,
        };
      } finally {
        if (touchDispatched) {
          const touchRestoredState = await restoreDragDropContent(db, dragConfig, beforeTouchState);
          dragDrop = { ...(dragDrop || {}), touch_restored_state: touchRestoredState };
        }
      }
    }

    const whiteboardOpened = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-mc-rail="whiteboard"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(whiteboardOpened, 'Whiteboard rail action is missing');
    let whiteboard = null;
    try {
      await waitFor(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        const target = overlay?.querySelector('#mc-wb-target-select');
        return !!overlay && !!canvas && canvas.width > 0 && canvas.height > 0 && !!target?.value;
      })()`, 'whiteboard overlay', 30000);

      const modeResult = await evaluate(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const blank = overlay?.querySelector('[data-wb-mode="blank"]');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        const surface = overlay?.querySelector('.mc-wb-canvas-wrap');
        const viewport = overlay?.querySelector('.mc-wb-canvas-viewport');
        if (!blank || !canvas || !surface || !viewport) return { ok: false };
        blank.click();
        const surfaceRect = surface.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        const ratioParts = surface.style.aspectRatio.split('/').map(Number);
        const expectedRatio = ratioParts.length === 2 && ratioParts[1] > 0
          ? ratioParts[0] / ratioParts[1]
          : canvas.width / canvas.height;
        const actualRatio = surfaceRect.width / surfaceRect.height;
        return {
          ok: true,
          width: canvas.width,
          height: canvas.height,
          aspectError: Math.abs(actualRatio - expectedRatio) / expectedRatio,
          viewportBounded: surfaceRect.left >= viewportRect.left - 1
            && surfaceRect.right <= viewportRect.right + 1
            && surfaceRect.top >= viewportRect.top - 1
            && surfaceRect.bottom <= viewportRect.bottom + 1,
        };
      })()`);
      assert(modeResult?.ok, 'Whiteboard Blank mode control is missing');
      assert(modeResult.viewportBounded, `Whiteboard drawing frame exceeds its viewport: ${JSON.stringify(modeResult)}`);
      assert(modeResult.aspectError <= 0.02, `Whiteboard target aspect ratio is distorted: ${JSON.stringify(modeResult)}`);
      await waitFor(cdp, `document.querySelector('[data-wb-mode="blank"]')?.getAttribute('aria-pressed') === 'true'`, 'whiteboard Blank mode');
      await evaluate(cdp, `document.querySelector('[data-wb-mode="overlay"]')?.click()`);
      await waitFor(cdp, `document.querySelector('[data-wb-mode="overlay"]')?.getAttribute('aria-pressed') === 'true'`, 'whiteboard Overlay mode');

      const drawResult = await evaluate(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        if (!canvas) return { ok: false };
        const rect = canvas.getBoundingClientRect();
        const before = canvas.toDataURL();
        const point = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 41,
          pointerType: 'mouse',
          isPrimary: true,
          buttons,
          clientX: rect.left + x,
          clientY: rect.top + y,
        }));
        point('pointerdown', Math.max(20, rect.width * 0.25), Math.max(20, rect.height * 0.35), 1);
        point('pointermove', Math.max(40, rect.width * 0.50), Math.max(40, rect.height * 0.55), 1);
        point('pointerup', Math.max(60, rect.width * 0.70), Math.max(60, rect.height * 0.65), 0);
        return {
          ok: true,
          before,
          target: overlay.querySelector('#mc-wb-target-select')?.selectedOptions?.[0]?.textContent?.trim() || '',
          options: [...overlay.querySelectorAll('#mc-wb-target-select option')].map((item) => item.textContent.trim()),
        };
      })()`);
      assert(drawResult?.ok, 'Whiteboard canvas is missing');
      await sleep(250);
      const drawingChanged = await evaluate(cdp, `(() => {
        const canvas = document.querySelector('.mc-wb-overlay #mc-wb-canvas');
        return !!canvas && canvas.toDataURL() !== ${JSON.stringify(drawResult.before)};
      })()`);
      assert(drawingChanged, 'Whiteboard pointer stroke did not render on the operator canvas');
      whiteboard = {
        target: drawResult.target,
        targets: drawResult.options,
        blank_mode: true,
        overlay_mode: true,
        drawing_changed: drawingChanged,
        canvas: { width: modeResult.width, height: modeResult.height },
        aspect_error: modeResult.aspectError,
      };
      await evaluate(cdp, `document.querySelector('.mc-wb-overlay #mc-wb-clear')?.click()`);
    } finally {
      await evaluate(cdp, `document.querySelector('.mc-wb-overlay #mc-wb-close')?.click()`).catch(() => {});
      await waitFor(cdp, `!document.querySelector('.mc-wb-overlay')`, 'whiteboard close').catch(() => {});
    }

    const viewport = await evaluate(cdp, `(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
      };
      return {
        innerWidth, innerHeight,
        htmlScrollWidth: document.documentElement.scrollWidth,
        htmlScrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        shell: rect('.mc-cc-shell'),
        main: rect('.mc-cc-main'),
        stage: rect('.mc-stage'),
      };
    })()`);
    assert(viewport.htmlScrollWidth <= viewport.innerWidth + 2, `command center has horizontal overflow: ${JSON.stringify(viewport)}`);
    assert(viewport.htmlScrollHeight <= viewport.innerHeight + 2, `command center has page-level vertical overflow: ${JSON.stringify(viewport)}`);
    assert(viewport.shell && viewport.shell.bottom <= viewport.innerHeight + 2, 'command center shell exceeds the viewport');

    await evaluate(cdp, `(() => {
      localStorage.removeItem('mc_multiview_cells_v1');
      const toolbox = document.querySelector('#mc-toolbox');
      if (toolbox && !toolbox.querySelector('.mc-tile[data-drag-source]')) {
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'mc-tile';
        source.dataset.dragSource = JSON.stringify({ remote_url: '/player/site.html?id=multiview-smoke' });
        source.dataset.label = 'Multiview smoke source';
        source.textContent = 'Multiview smoke source';
        toolbox.appendChild(source);
      }
    })()`);
    const opened = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-dock="multiview"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(opened, 'Multiview action is missing');
    await waitFor(cdp, `!!document.querySelector('.mc-multiview-host:not([hidden]) .mc-mv-stage')`, 'Multiview overlay');

    const multiviewContentAdded = await evaluate(cdp, `(() => {
      const add = document.querySelector('.mc-multiview-host:not([hidden]) [data-mv-add="C1"]')
        || document.querySelector('.mc-multiview-host:not([hidden]) [data-mv-add]');
      if (!add) return { ok: false, reason: 'no empty-frame add control' };
      const slot = add.dataset.mvAdd;
      add.click();
      const source = document.querySelector('.mc-multiview-host:not([hidden]) .mc-mv-source[data-source]');
      if (!source) return { ok: false, reason: 'no built-in source choices', slot };
      const label = source.dataset.label;
      source.click();
      const filled = document.querySelector('.mc-multiview-host:not([hidden]) .mc-mv-cell[data-mv-cell="' + slot + '"].filled');
      const send = document.querySelector('.mc-multiview-host:not([hidden]) .mc-mv-send');
      return { ok: !!filled && !send?.disabled, slot, label, filled: !!filled, send_disabled: !!send?.disabled };
    })()`);
    assert(multiviewContentAdded?.ok, `Multiview built-in content selection failed: ${JSON.stringify(multiviewContentAdded)}`);

    const multiview = await evaluate(cdp, `(() => {
      const host = document.querySelector('.mc-multiview-host:not([hidden])');
      const card = host?.querySelector('.mc-mv');
      const stage = host?.querySelector('.mc-mv-stage');
      const send = host?.querySelector('.mc-mv-send');
      const box = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { top:r.top, right:r.right, bottom:r.bottom, left:r.left, width:r.width, height:r.height }; })() : null;
      const style = host ? getComputedStyle(host) : null;
      return {
        host: box(host), card: box(card), stage: box(stage), send: box(send),
        overflowY: style?.overflowY,
        scrollHeight: host?.scrollHeight || 0,
        clientHeight: host?.clientHeight || 0,
        sendDisabled: !!send?.disabled,
      };
    })()`);
    assert(multiview.host?.top === 0 && multiview.host?.bottom <= viewport.innerHeight + 2, `Multiview overlay is not viewport bounded: ${JSON.stringify(multiview)}`);
    assert(['auto', 'scroll'].includes(multiview.overflowY), `Multiview overlay is not scrollable: ${JSON.stringify(multiview)}`);
    assert(multiview.stage?.height > 100, `Multiview stage did not render: ${JSON.stringify(multiview)}`);
    assert(!multiview.sendDisabled, 'Multiview Send remained disabled with a valid source');

    await evaluate(cdp, `document.querySelector('.mc-mv-send').click()`);
    await waitFor(cdp, `!!document.querySelector('dialog.mc-target-picker[open]')`, 'routing picker');
    const routeDialog = await evaluate(cdp, `(() => {
      const dialog = document.querySelector('dialog.mc-target-picker[open]');
      const card = dialog?.querySelector('.mc-target-picker-card');
      const list = dialog?.querySelector('.mc-target-picker-scroll');
      const actions = dialog?.querySelector('.mc-dialog-actions');
      const box = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { top:r.top, right:r.right, bottom:r.bottom, left:r.left, width:r.width, height:r.height }; })() : null;
      return {
        dialog: box(dialog), card: box(card), list: box(list), actions: box(actions),
        listOverflowY: list ? getComputedStyle(list).overflowY : null,
      };
    })()`);
    assert(routeDialog.card?.top >= -1 && routeDialog.card?.bottom <= viewport.innerHeight + 1, `routing picker exceeds viewport: ${JSON.stringify(routeDialog)}`);
    assert(routeDialog.actions?.bottom <= viewport.innerHeight + 1, `routing actions are unreachable: ${JSON.stringify(routeDialog)}`);
    assert(['auto', 'scroll'].includes(routeDialog.listOverflowY), `routing choices are not independently scrollable: ${JSON.stringify(routeDialog)}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writePrivateEvidence(screenshotPath, Buffer.from(shot.data, 'base64'));
    await evaluate(cdp, `document.querySelector('[data-target-cancel]')?.click()`);
    await waitFor(cdp, `!document.querySelector('dialog.mc-target-picker[open]')`, 'routing picker close');
    await evaluate(cdp, `document.querySelector('.mc-mv-close')?.click()`);
    await waitFor(cdp, `document.querySelector('.mc-multiview-host')?.hidden === true`, 'Multiview close');

    const liveSourceTabOpened = await evaluate(cdp, `(() => {
      const tab = document.querySelector('.mc-tb-tab[data-tab="camerafeeds"]');
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    assert(liveSourceTabOpened, 'Live Sources tab is missing');
    const inScopeLiveSourceLabel = dragConfig?.sourceLabel || '';
    await waitFor(cdp, `!![...document.querySelectorAll('.mc-live-source-tile')].find((tile) => (
      !${JSON.stringify(inScopeLiveSourceLabel)}
      || tile.querySelector('.mc-tile-label')?.textContent?.trim() === ${JSON.stringify(inScopeLiveSourceLabel)}
    ))?.querySelector('[data-state]')`, 'live source status');
    const liveSources = await evaluate(cdp, `(() => [...document.querySelectorAll('.mc-live-source-tile')]
      .filter((tile) => !${JSON.stringify(inScopeLiveSourceLabel)}
        || tile.querySelector('.mc-tile-label')?.textContent?.trim() === ${JSON.stringify(inScopeLiveSourceLabel)})
      .map((tile) => ({
      label: tile.querySelector('.mc-tile-label')?.textContent?.trim(),
      state: tile.querySelector('[data-state]')?.dataset.state,
      disabled: tile.disabled,
      source: JSON.parse(tile.dataset.dragSource || '{}'),
      height: Math.round(tile.getBoundingClientRect().height),
    })))()`);
    if (inScopeLiveSourceLabel) {
      assert(liveSources.length === 1 && liveSources[0].label === inScopeLiveSourceLabel,
        `configured live source missing: ${JSON.stringify(liveSources)}`);
    } else {
      assert(liveSources.some((item) => item.label === 'Anpviz Camera'), `canonical Anpviz source missing: ${JSON.stringify(liveSources)}`);
      assert(!liveSources.some((item) => /Focus|ANNKE|WyreStorm|Camera [123]/i.test(item.label || '')), `obsolete camera surfaced: ${JSON.stringify(liveSources)}`);
    }
    assert(liveSources.every((item) => item.height >= 48), `live-source touch target is too small: ${JSON.stringify(liveSources)}`);
    const liveSourceShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writePrivateEvidence(liveSourceScreenshotPath, Buffer.from(liveSourceShot.data, 'base64'));

    const runtimeExceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    console.log(JSON.stringify({
      ok: true,
      auth_mode: webSession ? 'web-login' : 'podium-device',
      signed_in_as: webSession?.user?.email || webSession?.user?.username || null,
      wall_targets: ready.map((item) => item.text),
      viewport,
      multiview,
      multiview_content_added: multiviewContentAdded,
      route_dialog: routeDialog,
      live_sources: liveSources,
      upload_dialog: uploadDialog,
      drag_drop: dragDrop,
      hybrid_layouts: hybridLayouts,
      whiteboard,
      runtime_exceptions: runtimeExceptions.length,
      screenshot: screenshotPath,
      live_source_screenshot: liveSourceScreenshotPath,
    }));
  } catch (error) {
    if (cdp) {
      const diagnostics = await evaluate(cdp, `(() => ({
        href: location.href,
        hash: location.hash,
        title: document.title,
        bodyClass: document.body?.className || '',
        appHtml: document.querySelector('#app')?.innerHTML?.slice(0, 1200) || '',
        hasToken: !!localStorage.getItem('token'),
        scripts: [...document.scripts].map((script) => script.src || '[inline]'),
      }))()`).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
      const browserErrors = cdp.events
        .filter((event) => ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method))
        .slice(-12);
      error.message += `; diagnostics=${JSON.stringify({ diagnostics, browserErrors })}`;
      try {
        const failedShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writePrivateEvidence(screenshotPath, Buffer.from(failedShot.data, 'base64'));
      } catch { /* preserve the original smoke failure */ }
    }
    if (chromiumError) error.message += `; chromium=${chromiumError.replace(/\s+/g, ' ').slice(-800)}`;
    throw error;
  } finally {
    if (cdp) cdp.close();
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(3000),
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) break;
        await sleep(250);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
