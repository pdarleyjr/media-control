import { t } from './i18n.js';
import { performanceMetrics } from './services/ui-runtime-v1.js';
import { createRoomStateStore } from './services/room-state-store.js';

let dashboardSocket = null;
const listeners = new Map();
const nodeStatusById = new Map();
const nodeStatusByRoom = new Map();
let selectedTarget = null;
const pendingCommandMetrics = new Map();
let socketIdentity = null;
let roomRecoveryRequested = false;
let roomRecoveryTimer = null;

function identityFromToken(token) {
  try {
    const payload = JSON.parse(atob(String(token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return `${payload.id || ''}\u0000${payload.current_workspace_id || ''}`;
  } catch {
    return String(token || '');
  }
}

function clearRoomRecovery() {
  roomRecoveryRequested = false;
  if (roomRecoveryTimer) clearTimeout(roomRecoveryTimer);
  roomRecoveryTimer = null;
}

function requestAuthoritativeRoomSnapshot() {
  if (!dashboardSocket?.connected || roomRecoveryRequested) return;
  roomRecoveryRequested = true;
  roomRecoveryTimer = setTimeout(clearRoomRecovery, 5000);
  dashboardSocket.emit('dashboard:room-resume', { revision: roomState.getRevision() });
}

export const roomState = createRoomStateStore({
  onGap: requestAuthoritativeRoomSnapshot,
});

export function connectSocket() {
  const token = localStorage.getItem('token');
  const nextIdentity = identityFromToken(token);
  if (socketIdentity && nextIdentity !== socketIdentity) {
    roomState.reset();
    nodeStatusById.clear();
    nodeStatusByRoom.clear();
    selectedTarget = null;
    pendingCommandMetrics.clear();
  }
  socketIdentity = nextIdentity;
  clearRoomRecovery();
  if (dashboardSocket) {
    try { dashboardSocket.disconnect(); } catch { /* reconnect best-effort */ }
    dashboardSocket = null;
  }
  dashboardSocket = io('/dashboard', {
    auth: { token },
    // Prefer WebSocket; fall back to polling on the same connect attempt.
    // Mirrors the player-side fix in 1aee4f2 - skips the polling->WS upgrade
    // dance that was causing the dashboard socket to flicker on Apply.
    transports: ['websocket', 'polling']
  });

  dashboardSocket.on('connect', () => {
    console.log('Dashboard connected, socket id:', dashboardSocket.id);
    updateConnectionStatus(true);
    emitSelectedTarget();
    requestAuthoritativeRoomSnapshot();
    emit('connected');
  });

  dashboardSocket.on('connect_error', (err) => {
    console.error('Dashboard socket connect error:', err.message);
    updateConnectionStatus(false);
    emit('disconnected', { reason: 'connect_error', message: err?.message || '' });
    if (window.location.pathname.startsWith('/console/') && /auth|token|unauthor|forbidden/i.test(err?.message || '')) {
      window.location.reload();
    }
  });

  dashboardSocket.on('disconnect', (reason) => {
    console.log('Dashboard disconnected:', reason);
    updateConnectionStatus(false);
    emit('disconnected');
  });

  // Device status updates
  dashboardSocket.on('dashboard:device-status', (data) => {
    emit('device-status', data);
  });

  dashboardSocket.on('dashboard:node-status', (data) => {
    if (data && typeof data === 'object') {
      if (data.node_id) nodeStatusById.set(String(data.node_id), data);
      if (data.room_id) nodeStatusByRoom.set(String(data.room_id), data);
    }
    emit('node-status', data);
  });

  // Screenshot ready
  dashboardSocket.on('dashboard:screenshot-ready', (data) => {
    emit('screenshot-ready', data);
  });

  // Device added
  dashboardSocket.on('dashboard:device-added', (data) => {
    emit('device-added', data);
  });

  // Device removed
  dashboardSocket.on('dashboard:device-removed', (data) => {
    emit('device-removed', data);
  });

  // Playback state
  dashboardSocket.on('dashboard:playback-state', (data) => {
    emit('playback-state', data);
  });

  // Playback progress (play_start with duration — drives device-card progress bars)
  dashboardSocket.on('dashboard:playback-progress', (data) => {
    emit('playback-progress', data);
  });

  // Wall changed — dashboard refreshes wall cards + device-grouping layout
  dashboardSocket.on('dashboard:wall-changed', () => {
    emit('wall-changed');
  });

// Content ack
  dashboardSocket.on('dashboard:content-ack', (data) => {
    emit('content-ack', data);
  });

  // Command ack / timeout (Phase-2 reliable command model). Server emits
  // command:ack to the target's workspace room. ok:false (status 'timeout' or
  // a device-reported failure) is the non-silent failure path: the Command
  // Center shows a toast and flips the status chip to Stale/Failed.
  dashboardSocket.on('command:ack', (data) => {
    const commandId = data?.command_id || data?.id || null;
    const pending = commandId ? pendingCommandMetrics.get(commandId) : null;
    if (pending) performanceMetrics.record('command.ack', performance.now() - pending.started);
    emit('command-ack', data);
  });

  // Display state self-report → also fed to the Command Center chips.
  dashboardSocket.on('dashboard:state-sync', (data) => {
    const state = data?.state || data || {};
    const commandId = state.command_revision || state.telemetry?.last_command_id || null;
    const pending = commandId ? pendingCommandMetrics.get(commandId) : null;
    if (pending) {
      performanceMetrics.record('command.ui_convergence', performance.now() - pending.started);
      pendingCommandMetrics.delete(commandId);
    }
    emit('state-sync', data);
  });

  // The room contract is the sole full-state reconciliation path. Snapshot
  // revisions survive reconnects; deltas are accepted only when contiguous.
  dashboardSocket.on('room:snapshot', (snapshot) => {
    clearRoomRecovery();
    const result = roomState.applySnapshot(snapshot);
    if (result.applied) emit('room-snapshot', roomState.getSnapshot());
  });

  dashboardSocket.on('room:resumed', (data) => {
    clearRoomRecovery();
    emit('room-resumed', data);
  });

  dashboardSocket.on('room:delta', (delta) => {
    const result = roomState.applyDelta(delta);
    if (result.applied) emit('room-snapshot', roomState.getSnapshot());
  });

  return dashboardSocket;
}

export function disconnectSocket() {
  if (!dashboardSocket) return;
  try { dashboardSocket.disconnect(); } catch { /* disconnect best-effort */ }
  dashboardSocket = null;
}

function updateConnectionStatus(connected) {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('span:last-child');
  if (connected) {
    dot.className = 'status-dot online';
    text.textContent = t('common.connected');
  } else {
    dot.className = 'status-dot offline';
    text.textContent = t('common.disconnected');
  }
}

export function on(event, callback) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(callback);
}

export function off(event, callback) {
  if (!listeners.has(event)) return;
  const cbs = listeners.get(event);
  const idx = cbs.indexOf(callback);
  if (idx > -1) cbs.splice(idx, 1);
}

function emit(event, data) {
  const cbs = listeners.get(event);
  if (cbs) cbs.forEach(cb => cb(data));
}

export function requestScreenshot(deviceId) {
  console.log('requestScreenshot:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (dashboardSocket) dashboardSocket.emit('dashboard:request-screenshot', { device_id: deviceId });
}

function emitSelectedTarget() {
  if (!dashboardSocket || !dashboardSocket.connected || !selectedTarget) return;
  dashboardSocket.emit('dashboard:select-target', selectedTarget);
}

export function selectTarget(targetType, targetId) {
  if (!targetType || !targetId) {
    clearTarget();
    return;
  }
  selectedTarget = { target_type: targetType, target_id: targetId };
  emitSelectedTarget();
}

export function clearTarget() {
  selectedTarget = null;
  if (dashboardSocket && dashboardSocket.connected) dashboardSocket.emit('dashboard:clear-target');
}

export function startRemote(deviceId) {
  console.log('startRemote:', deviceId, 'socket connected:', dashboardSocket?.connected);
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-start', { device_id: deviceId });
}

export function stopRemote(deviceId) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-stop', { device_id: deviceId });
}

export function sendTouch(deviceId, x, y, action) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-touch', { device_id: deviceId, x, y, action });
}

export function sendKey(deviceId, keycode) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:remote-key', { device_id: deviceId, keycode });
}

export function identifyDevice(deviceId, payload = {}) {
  if (dashboardSocket) dashboardSocket.emit('dashboard:identify', { device_id: deviceId, ...payload });
}

// Optional callback receives the server-side ack: { delivered, queued, reason }.
// Callers without a callback keep firing-and-forgetting (no behavior change).
// With a callback, we use Socket.IO's .timeout() so the callback always fires -
// either with the ack or with an Error if the server doesn't respond in 5s.
export function sendCommand(deviceId, type, payload, callback) {
  const contract = globalThis.MbfdDeviceContract;
  const envelope = contract && typeof contract.createCommand === 'function'
    ? contract.createCommand({
      device_id: deviceId,
      target_scope: 'display',
      payload: { ...(payload || {}), action: payload?.action || type },
    })
    : null;
  emit('command-sent', {
    device_id: deviceId,
    type,
    payload,
    command_id: envelope?.command_id || null,
    sent_at: Date.now(),
  });
  if (envelope?.command_id) {
    pendingCommandMetrics.set(envelope.command_id, { started: performance.now() });
    setTimeout(() => pendingCommandMetrics.delete(envelope.command_id), 30000);
  }
  if (!dashboardSocket) return;
  if (typeof callback === 'function') {
    dashboardSocket.timeout(5000).emit('dashboard:device-command', { device_id: deviceId, type, payload, envelope }, (err, ack) => {
      if (err) callback({ delivered: false, reason: 'no_ack' });
      else callback(ack || { delivered: false, reason: 'no_ack' });
    });
  } else {
    dashboardSocket.emit('dashboard:device-command', { device_id: deviceId, type, payload, envelope });
  }
}

export function getSocket() { return dashboardSocket; }

export function requestRoomSnapshot() { requestAuthoritativeRoomSnapshot(); }

export function getNodeStatus(idOrRoom) {
  if (!idOrRoom) return null;
  const key = String(idOrRoom);
  return nodeStatusById.get(key) || nodeStatusByRoom.get(key) || null;
}

export function getAllNodeStatus() {
  return [...nodeStatusById.values()];
}
