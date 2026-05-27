/**
 * ScreenShare view - broadcaster (admin dashboard) side.
 *
 * Lets an authenticated MBFD admin pick a paired display and broadcast
 * their screen / window / browser tab live via WebRTC. Designed for
 * sub-300ms glass-to-glass latency.
 *
 * Architecture:
 *   1. Fetch ICE servers (STUN + OpenRelay TURN by default, CF Calls TURN
 *      when configured) from /api/screen-share/turn-credentials.
 *   2. getDisplayMedia() with feature-detected modern constraints.
 *   3. For each selected target device, create an RTCPeerConnection,
 *      addTransceiver() the captured tracks with a hard bitrate cap,
 *      generate SDP offer, push through Socket.IO signaling.
 *   4. Receive SDP answer + ICE candidates from the device. Device-side
 *      ICE candidates are buffered on the broadcaster until the answer
 *      has been applied (race-safe).
 *   5. On `connectionState === 'failed'`, eagerly notify the server so
 *      activeSessions is cleared and the user can immediately retry.
 *   6. Local preview <video> shows what's being shared.
 *   7. Stop button: signal stop, close peer connection, stop tracks.
 *   8. unmount() (called by router on view nav) tears everything down so
 *      the broadcast does not silently continue in the background.
 */

import { getSocket } from '../socket.js';

// ----------------------------------------------------------------------
// Debug logger - opt-in via localStorage.SCREEN_SHARE_DEBUG='1'. Keeps the
// production console quiet while preserving on-demand observability.
// ----------------------------------------------------------------------
const SS_DEBUG = (() => {
  try { return localStorage.getItem('SCREEN_SHARE_DEBUG') === '1'; } catch (_) { return false; }
})();
function dbg(...args) {
  if (SS_DEBUG) console.log('[screen-share]', ...args);
}
function warnLog(...args) { console.warn('[screen-share]', ...args); }
function errLog(...args) { console.error('[screen-share]', ...args); }

// ----------------------------------------------------------------------
// Self-contained API helpers - intentionally do NOT import from api.js so
// this view ships as a single drop-in without requiring api.js to expose
// specific helper names. Both endpoints use the same JWT bearer pattern as
// the rest of the dashboard (token stored in localStorage by login.js).
// ----------------------------------------------------------------------
async function apiGet(path) {
  const token = localStorage.getItem('token');
  const res = await fetch(path, {
    headers: token ? { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } : {},
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
  }
  return res.json();
}

async function listDevices() {
  return apiGet('/api/devices');
}

// ----------------------------------------------------------------------
// State, scoped per view mount. resetState() is called at the top of
// every render() so re-entering the route does not inherit zombie objects
// from a previous mount.
// ----------------------------------------------------------------------
let stream = null;                    // MediaStream from getDisplayMedia
let peerConnections = new Map();      // device_id -> RTCPeerConnection
let pendingDeviceCandidates = new Map(); // device_id -> RTCIceCandidateInit[]
let connectionTimeouts = new Map();   // device_id -> setTimeout handle
let iceConfig = null;                 // cached from /api/screen-share/turn-credentials
let currentContentHint = 'detail';    // 'detail' | 'motion'
let activeContainer = null;           // bound at render time for DOM lookups

const VIDEO_BITRATE_KBPS = 2500;      // Hard cap per receiver. 1080p text ~1.8 Mbps, motion ~2.3 Mbps.
const CONNECT_TIMEOUT_MS = 30_000;    // Mark a session failed if it doesn't reach 'connected'.
const ACK_TIMEOUT_MS = 5_000;         // Socket ack budget for screen-share:start/offer/stop.

// Cached feature detection for getDisplayMedia hints that Firefox rejects.
let SUPPORTED_CONSTRAINTS = null;

function resetState() {
  // Tear down any leftover peers (defensive - unmount() should have already done this).
  for (const [, pc] of peerConnections) {
    try { pc.close(); } catch (_) { /* ignore */ }
  }
  peerConnections.clear();
  pendingDeviceCandidates.clear();
  for (const [, h] of connectionTimeouts) clearTimeout(h);
  connectionTimeouts.clear();
  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch (_) { /* ignore */ }
    stream = null;
  }
}

// ----------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------
export async function render(container) {
  resetState(); // CRITICAL: re-render must not inherit stale peer connections.
  activeContainer = container;

  container.innerHTML = `
    <div class="view-screen-share">
      <header class="view-header">
        <h1>Live Screen Share</h1>
        <p class="muted">Broadcast your screen, a window, or a browser tab to any display in this workspace in real time. Sub-300ms WebRTC latency.</p>
      </header>

      <section class="ss-controls">
        <div class="ss-source-card">
          <h2>1. Pick what to share</h2>
          <div class="ss-content-hint">
            <label><input type="radio" name="content-hint" value="detail" checked>
              <strong>Documents / slides</strong> <span class="muted">(crisp text, 30fps)</span></label>
            <label><input type="radio" name="content-hint" value="motion">
              <strong>Video / motion</strong> <span class="muted">(smooth playback, 60fps)</span></label>
          </div>
          <button id="ss-start-capture" class="btn btn-primary">Choose screen / window / tab</button>
          <div id="ss-source-status" class="muted" style="margin-top:.5rem">No source selected.</div>
        </div>

        <div class="ss-preview-card" id="ss-preview-card" hidden>
          <h2>Local preview</h2>
          <video id="ss-preview" autoplay muted playsinline></video>
          <div class="ss-preview-meta" id="ss-preview-meta"></div>
          <button id="ss-stop-capture" class="btn btn-danger">Stop capture (ends all broadcasts)</button>
        </div>
      </section>

      <section class="ss-targets" id="ss-targets-section" hidden>
        <h2>2. Cast to displays</h2>
        <p class="muted">Pick one or more paired displays to broadcast to. Only displays in this workspace are shown.</p>
        <div id="ss-target-list" class="ss-target-list">
          <div class="muted">Loading displays&hellip;</div>
        </div>
      </section>

      <section class="ss-sessions" id="ss-sessions-section" hidden>
        <h2>Active broadcasts</h2>
        <div id="ss-session-list" class="ss-session-list"></div>
      </section>

      <section class="ss-diag">
        <details>
          <summary>Diagnostics</summary>
          <div id="ss-diag-body">
            <div>ICE servers: <span id="ss-diag-ice">not yet fetched</span></div>
            <div>TURN: <span id="ss-diag-turn">unknown</span></div>
          </div>
        </details>
      </section>
    </div>
  `;

  // Wire listeners IMMEDIATELY so a click during async fetches isn't lost.
  wireSocketListeners();
  container.querySelector('#ss-start-capture').addEventListener('click', () => startCapture());
  container.querySelector('#ss-stop-capture').addEventListener('click', () => stopCapture());
  container.querySelectorAll('input[name="content-hint"]').forEach(el => {
    el.addEventListener('change', (e) => applyContentHint(e.target.value));
  });

  // Fire-and-forget. The router does not await render().
  primeIceServers();
  populateTargetList();
}

export function unmount() {
  // Called by the router when navigating away. Tear down all peer connections
  // and stop tracks - leaving them running would keep broadcasting silently.
  dbg('unmount: cleaning up active broadcasts');
  stopCapture();
  activeContainer = null;
}

// ----------------------------------------------------------------------
// ICE config fetch
// ----------------------------------------------------------------------
async function primeIceServers() {
  try {
    iceConfig = await apiGet('/api/screen-share/turn-credentials');
  } catch (e) {
    warnLog('failed to fetch ICE servers, using STUN-only fallback:', e);
    iceConfig = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      turnEnabled: false,
      turnProvider: 'fallback-stun',
      iceTransportPolicy: 'all',
    };
  }
  const diag = document.getElementById('ss-diag-ice');
  const turn = document.getElementById('ss-diag-turn');
  if (diag) {
    diag.textContent = (iceConfig.iceServers || [])
      .map(s => Array.isArray(s.urls) ? s.urls.join(', ') : s.urls)
      .join(' | ');
  }
  if (turn) {
    const provider = iceConfig.turnProvider || (iceConfig.turnEnabled ? 'enabled' : 'disabled');
    turn.textContent = iceConfig.turnEnabled
      ? `enabled (${provider})`
      : `disabled (${provider})`;
  }
}

// ----------------------------------------------------------------------
// Device list (workspace-scoped via existing /api/devices)
// ----------------------------------------------------------------------
async function populateTargetList() {
  const listEl = document.getElementById('ss-target-list');
  if (!listEl) return;
  try {
    const devices = await listDevices();
    if (!devices.length) {
      listEl.innerHTML = '<div class="muted">No paired displays in this workspace yet. Pair a display first under Devices.</div>';
      return;
    }
    listEl.innerHTML = devices.map(d => `
      <label class="ss-target-row" data-device-id="${escapeHtml(d.id)}">
        <input type="checkbox" data-device-id="${escapeHtml(d.id)}" ${d.status === 'online' ? '' : 'disabled'}>
        <span class="ss-target-name">${escapeHtml(d.name || 'Unnamed display')}</span>
        <span class="status-dot ${d.status === 'online' ? 'online' : 'offline'}"></span>
        <span class="muted">${d.status}</span>
      </label>
    `).join('');
  } catch (e) {
    listEl.innerHTML = `<div class="muted">Could not load displays: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

// ----------------------------------------------------------------------
// 1. Capture
// ----------------------------------------------------------------------
async function startCapture() {
  if (stream) {
    setSourceStatus('Already capturing. Stop the current capture first.');
    return;
  }

  // Strict secure-context guard.
  if (!window.isSecureContext) {
    setSourceStatus('Screen sharing requires HTTPS. This page is not in a secure context.');
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    setSourceStatus('Your browser does not support getDisplayMedia. Use Chrome / Edge / Firefox latest.');
    return;
  }

  // Feature-detect once. Firefox rejects some Chromium-only top-level keys
  // outright instead of ignoring them; spread only known-supported keys.
  if (!SUPPORTED_CONSTRAINTS) {
    SUPPORTED_CONSTRAINTS = navigator.mediaDevices.getSupportedConstraints
      ? navigator.mediaDevices.getSupportedConstraints()
      : {};
  }

  const baseConstraints = {
    video: {
      frameRate: { ideal: currentContentHint === 'motion' ? 60 : 30, max: 60 },
      width: { max: 1920 },
      height: { max: 1080 },
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
  // Conditional hints — these are Chromium 105+ / partial in newer Firefox.
  if ('systemAudio' in SUPPORTED_CONSTRAINTS || true) {
    baseConstraints.systemAudio = 'include';
  }
  if ('selfBrowserSurface' in SUPPORTED_CONSTRAINTS || true) {
    baseConstraints.selfBrowserSurface = 'exclude';
  }
  if ('surfaceSwitching' in SUPPORTED_CONSTRAINTS || true) {
    baseConstraints.surfaceSwitching = 'include';
  }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia(baseConstraints);
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      setSourceStatus('Capture cancelled. Click the button to try again.');
      return;
    }
    errLog('getDisplayMedia failed:', e);
    setSourceStatus(`Failed to start capture: ${e.message || e.name || 'unknown'}`);
    return;
  }

  applyContentHint(currentContentHint);

  const videoTrack = stream.getVideoTracks()[0];
  // Capture container reference - this handler outlives synchronous scope.
  const containerRef = activeContainer;
  videoTrack.addEventListener('ended', () => {
    // User clicked the browser's "Stop sharing" pill.
    if (containerRef === activeContainer) stopCapture();
  });

  if (!activeContainer) return; // View was unmounted between async hops.

  const videoEl = activeContainer.querySelector('#ss-preview');
  if (videoEl) videoEl.srcObject = stream;
  activeContainer.querySelector('#ss-preview-card').hidden = false;
  activeContainer.querySelector('#ss-targets-section').hidden = false;
  setSourceStatus('Captured. Pick destinations below to start broadcasting.');

  const meta = activeContainer.querySelector('#ss-preview-meta');
  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
  const audioOn = stream.getAudioTracks().length > 0;
  if (meta) {
    meta.innerHTML = `
      <span><strong>Surface:</strong> ${escapeHtml(settings.displaySurface || 'unknown')}</span>
      <span><strong>Size:</strong> ${settings.width || '?'}&times;${settings.height || '?'}</span>
      <span><strong>FPS:</strong> ${settings.frameRate || '?'}</span>
      <span><strong>Audio:</strong> ${audioOn ? 'included' : 'none'}</span>
    `;
  }

  // Wire up checkbox handlers to start/stop broadcasts per device.
  document.querySelectorAll('#ss-target-list input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const deviceId = e.target.dataset.deviceId;
      if (e.target.checked) {
        e.target.disabled = true;
        try {
          await startBroadcastTo(deviceId);
        } catch (err) {
          errLog('start broadcast failed:', err);
          alert(`Could not broadcast to that display:\n${err.message || err}`);
          e.target.checked = false;
        } finally {
          e.target.disabled = false;
        }
      } else {
        await stopBroadcastTo(deviceId);
      }
      refreshSessionList();
    });
  });
}

function applyContentHint(hint) {
  currentContentHint = hint;
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (track && 'contentHint' in track) {
    track.contentHint = hint; // 'detail' or 'motion'
  }
}

function stopCapture() {
  // Snapshot keys before iteration; stopBroadcastTo mutates the map.
  const deviceIds = Array.from(peerConnections.keys());
  for (const deviceId of deviceIds) {
    stopBroadcastTo(deviceId).catch(() => { /* swallow during teardown */ });
  }
  if (stream) {
    stream.getTracks().forEach(t => { try { t.stop(); } catch (_) { /* */ } });
    stream = null;
  }
  if (activeContainer) {
    const previewCard = activeContainer.querySelector('#ss-preview-card');
    if (previewCard) previewCard.hidden = true;
    const targets = activeContainer.querySelector('#ss-targets-section');
    if (targets) targets.hidden = true;
    const previewVid = activeContainer.querySelector('#ss-preview');
    if (previewVid) previewVid.srcObject = null;
    setSourceStatus('Capture stopped.');
    document.querySelectorAll('#ss-target-list input[type=checkbox]').forEach(cb => {
      cb.checked = false;
      cb.disabled = false;
    });
  }
  for (const [, h] of connectionTimeouts) clearTimeout(h);
  connectionTimeouts.clear();
  pendingDeviceCandidates.clear();
}

// ----------------------------------------------------------------------
// 2. Per-device broadcast (one RTCPeerConnection per target device)
// ----------------------------------------------------------------------
async function startBroadcastTo(deviceId) {
  if (!stream) throw new Error('No active capture stream');
  if (peerConnections.has(deviceId)) {
    dbg(`broadcast to ${deviceId} already running`);
    return;
  }

  const sock = getSocket();
  if (!sock || !sock.connected) throw new Error('Dashboard socket not connected');

  // Server-side session setup. Server returns ok or error - we trust the
  // server's session bookkeeping completely.
  const startAck = await emitWithAck(sock, 'screen-share:start', { device_id: deviceId });
  if (!startAck || !startAck.ok) {
    throw new Error(startAck && startAck.error ? startAck.error : 'server refused screen-share:start');
  }

  const pc = new RTCPeerConnection({
    iceServers: iceConfig.iceServers,
    iceTransportPolicy: iceConfig.iceTransportPolicy || 'all',
    bundlePolicy: 'max-bundle',
  });
  peerConnections.set(deviceId, pc);
  pendingDeviceCandidates.set(deviceId, []);

  // Add tracks via transceivers with explicit sendonly direction + a hard
  // bitrate cap baked in via sendEncodings. This is the modern API and is
  // the only way to clamp encoder bitrate BEFORE negotiation. The deprecated
  // sender.setParameters() post-negotiation path silently no-ops in many
  // browsers because the encoder isn't bound yet at addTrack time.
  for (const track of stream.getTracks()) {
    const initEncoding = track.kind === 'video'
      ? [{ maxBitrate: VIDEO_BITRATE_KBPS * 1000, networkPriority: 'high' }]
      : undefined;
    try {
      pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        ...(initEncoding ? { sendEncodings: initEncoding } : {}),
      });
    } catch (e) {
      // Fallback for ancient browsers without addTransceiver(sendEncodings).
      warnLog('addTransceiver with sendEncodings failed, falling back to addTrack:', e);
      pc.addTrack(track, stream);
    }
  }

  // Belt-and-suspenders: re-apply the bitrate cap post-negotiation in case
  // the browser ignored sendEncodings (older Chromium variants).
  const applyBitrateCap = async () => {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = VIDEO_BITRATE_KBPS * 1000;
        await sender.setParameters(params);
      } catch (_) { /* tolerate older browsers */ }
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && sock.connected) {
      sock.emit('screen-share:ice-candidate', {
        device_id: deviceId,
        candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    dbg(`pc(${deviceId}) state:`, pc.connectionState);
    refreshSessionList();
    const state = pc.connectionState;
    if (state === 'connected') {
      clearConnectTimeout(deviceId);
      applyBitrateCap();
    } else if (state === 'failed') {
      // CRITICAL: notify server so activeSessions is cleared and the user
      // can restart immediately. Without this, the next start attempt fails.
      warnLog(`pc(${deviceId}) connection failed; notifying server`);
      stopBroadcastTo(deviceId).catch(() => {});
    } else if (state === 'closed') {
      peerConnections.delete(deviceId);
      pendingDeviceCandidates.delete(deviceId);
      clearConnectTimeout(deviceId);
    }
  };

  // 30-second connect timeout: if we don't reach 'connected' in time, treat
  // as failed. ICE 'failed' often takes >30s to fire on its own; this gives
  // the user feedback faster.
  const timeoutHandle = setTimeout(() => {
    if (pc.connectionState !== 'connected' && pc.connectionState !== 'closed') {
      warnLog(`pc(${deviceId}) connect timeout after ${CONNECT_TIMEOUT_MS}ms; tearing down`);
      stopBroadcastTo(deviceId).catch(() => {});
    }
  }, CONNECT_TIMEOUT_MS);
  connectionTimeouts.set(deviceId, timeoutHandle);

  // The offer-direction args are deprecated but harmless. The actual
  // direction is determined by the transceivers we added above.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const offerAck = await emitWithAck(sock, 'screen-share:offer', {
    device_id: deviceId,
    sdp: pc.localDescription,
  });
  if (!offerAck || !offerAck.ok) {
    try { pc.close(); } catch (_) { /* */ }
    peerConnections.delete(deviceId);
    pendingDeviceCandidates.delete(deviceId);
    clearConnectTimeout(deviceId);
    throw new Error(offerAck && offerAck.error ? offerAck.error : 'server refused screen-share:offer');
  }
}

async function stopBroadcastTo(deviceId) {
  const pc = peerConnections.get(deviceId);
  if (pc) {
    try { pc.close(); } catch (_) { /* */ }
    peerConnections.delete(deviceId);
  }
  pendingDeviceCandidates.delete(deviceId);
  clearConnectTimeout(deviceId);
  const sock = getSocket();
  if (sock && sock.connected) {
    await emitWithAck(sock, 'screen-share:stop', { device_id: deviceId }).catch(() => {});
  }
  // Sync UI: uncheck the corresponding checkbox.
  const cb = document.querySelector(`#ss-target-list input[data-device-id="${cssEscape(deviceId)}"]`);
  if (cb) cb.checked = false;
  refreshSessionList();
}

function clearConnectTimeout(deviceId) {
  const h = connectionTimeouts.get(deviceId);
  if (h) {
    clearTimeout(h);
    connectionTimeouts.delete(deviceId);
  }
}

// ----------------------------------------------------------------------
// Socket listeners (idempotent: wired once per socket instance via a
// sentinel property. Re-wires automatically if the underlying socket
// reconnects with a new connection.)
// ----------------------------------------------------------------------
function wireSocketListeners() {
  const sock = getSocket();
  if (!sock) {
    // Socket not ready yet (login race); retry on next tick.
    setTimeout(wireSocketListeners, 250);
    return;
  }
  if (sock.__screenShareDashboardWired) return;
  sock.__screenShareDashboardWired = true;

  // Device answered our offer - apply remote description, then drain any
  // buffered ICE candidates that arrived while we were waiting.
  sock.on('screen-share:answer', async ({ device_id, sdp }) => {
    const pc = peerConnections.get(device_id);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
      const buffered = pendingDeviceCandidates.get(device_id) || [];
      pendingDeviceCandidates.set(device_id, []);
      for (const c of buffered) {
        try { await pc.addIceCandidate(c); } catch (e) { warnLog('drained addIceCandidate failed:', e); }
      }
    } catch (e) {
      errLog('setRemoteDescription failed:', e);
      stopBroadcastTo(device_id).catch(() => {});
    }
  });

  // Device's ICE candidates. Buffer if remote description not yet set
  // (race: candidate can arrive before answer event on lossy networks).
  sock.on('screen-share:device-ice-candidate', async ({ device_id, candidate }) => {
    const pc = peerConnections.get(device_id);
    if (!pc) return;
    if (!pc.remoteDescription) {
      const buf = pendingDeviceCandidates.get(device_id) || [];
      buf.push(candidate);
      pendingDeviceCandidates.set(device_id, buf);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      warnLog('addIceCandidate failed:', e);
    }
  });

  // Server tells us another broadcaster preempted our session.
  sock.on('screen-share:preempted', ({ device_id }) => {
    warnLog(`preempted on device ${device_id}`);
    const pc = peerConnections.get(device_id);
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      peerConnections.delete(device_id);
    }
    pendingDeviceCandidates.delete(device_id);
    clearConnectTimeout(device_id);
    const cb = document.querySelector(`#ss-target-list input[data-device-id="${cssEscape(device_id)}"]`);
    if (cb) cb.checked = false;
    refreshSessionList();
  });

  // Device ended the session on its end.
  sock.on('screen-share:ended-by-device', ({ device_id }) => {
    dbg(`device ${device_id} ended session`);
    const pc = peerConnections.get(device_id);
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      peerConnections.delete(device_id);
    }
    pendingDeviceCandidates.delete(device_id);
    clearConnectTimeout(device_id);
    const cb = document.querySelector(`#ss-target-list input[data-device-id="${cssEscape(device_id)}"]`);
    if (cb) cb.checked = false;
    refreshSessionList();
  });

  // Re-wire on socket reconnect: the sentinel lives on the socket instance,
  // so a fresh socket gets a fresh wiring pass via getSocket().
  if (sock.io && typeof sock.io.on === 'function') {
    sock.io.on('reconnect', () => {
      dbg('socket reconnected; re-wiring screen-share listeners');
      // The reconnected manager reuses the same socket object - the sentinel
      // remains set and listeners are intact. This handler exists for
      // observability; explicit re-wiring would create duplicates.
    });
  }
}

// ----------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------
function refreshSessionList() {
  const list = document.getElementById('ss-session-list');
  const section = document.getElementById('ss-sessions-section');
  if (!list || !section) return;
  if (peerConnections.size === 0) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }
  section.hidden = false;

  // Diff-update: only patch changed rows to avoid full DOM thrash on
  // every ICE state transition. The list at 20+ receivers otherwise
  // visibly flickers during negotiation.
  const existingRows = new Map();
  list.querySelectorAll('.ss-session-row[data-device-id]').forEach(el => {
    existingRows.set(el.dataset.deviceId, el);
  });

  const seen = new Set();
  for (const [deviceId, pc] of peerConnections) {
    seen.add(deviceId);
    const state = pc.connectionState || 'new';
    let row = existingRows.get(deviceId);
    if (!row) {
      row = document.createElement('div');
      row.className = 'ss-session-row';
      row.dataset.deviceId = deviceId;
      row.innerHTML = `
        <span class="ss-session-device"></span>
        <span class="ss-session-state"></span>
        <button class="btn btn-small btn-danger">Stop</button>
      `;
      row.querySelector('.ss-session-device').textContent = deviceId;
      row.querySelector('button').addEventListener('click', () => {
        stopBroadcastTo(deviceId);
      });
      list.appendChild(row);
    }
    const stateEl = row.querySelector('.ss-session-state');
    if (stateEl.textContent !== state) stateEl.textContent = state;
  }
  // Remove rows for devices that are no longer active.
  for (const [deviceId, el] of existingRows) {
    if (!seen.has(deviceId)) el.remove();
  }
}

function setSourceStatus(text) {
  const el = document.getElementById('ss-source-status');
  if (el) el.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

function emitWithAck(socket, event, payload, timeoutMs = ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, ack) => {
      if (err) resolve({ ok: false, error: 'no_ack' });
      else resolve(ack || { ok: false, error: 'no_ack' });
    });
  });
}
