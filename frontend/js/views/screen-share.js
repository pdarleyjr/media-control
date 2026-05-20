/**
 * ScreenShare view - broadcaster (admin dashboard) side.
 *
 * Lets an authenticated MBFD admin pick a paired display and broadcast
 * their screen / window / browser tab live via WebRTC. Designed for
 * sub-300ms glass-to-glass latency.
 *
 * Architecture:
 *   1. Fetch ICE servers (STUN, optional CF TURN) from /api/screen-share/turn-credentials
 *   2. getDisplayMedia() with modern constraints (system audio, surface switching,
 *      no self-mirror)
 *   3. For each selected target device, create an RTCPeerConnection,
 *      addTrack() the captured stream, generate SDP offer, push through
 *      Socket.IO signaling
 *   4. Receive SDP answer + ICE candidates from the device, complete handshake
 *   5. Local preview <video> shows what's being shared
 *   6. Stop button: signal stop, close peer connection, stop tracks
 *
 * All Socket.IO events go through the existing JWT-authenticated /dashboard
 * namespace - no separate auth context.
 */

import { getSocket } from '../socket.js';

// Self-contained API helpers - intentionally do NOT import from api.js so this
// view ships as a single drop-in without requiring api.js to expose specific
// helper names. Both endpoints use the same JWT bearer pattern as the rest of
// the dashboard (token stored in localStorage by login.js).
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

// State, scoped per view mount.
let stream = null;                    // MediaStream from getDisplayMedia
let peerConnections = new Map();      // device_id -> RTCPeerConnection
let iceConfig = null;                 // cached from /api/screen-share/turn-credentials
let socketListenersWired = false;
let currentContentHint = 'detail';    // 'detail' | 'motion'

const VIDEO_BITRATE_KBPS = 2500;      // Reasonable cap for 1080p text-heavy

export async function render(container) {
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

  wireSocketListenersOnce();
  await Promise.all([
    primeIceServers(),
    populateTargetList(),
  ]);

  container.querySelector('#ss-start-capture').addEventListener('click', () => startCapture(container));
  container.querySelector('#ss-stop-capture').addEventListener('click', () => stopCapture(container));
  container.querySelectorAll('input[name="content-hint"]').forEach(el => {
    el.addEventListener('change', (e) => applyContentHint(e.target.value));
  });
}

export function unmount() {
  // Called by the router when navigating away. Tear down all peer connections
  // and stop tracks - leaving them running would keep broadcasting silently.
  stopCapture(null);
}

// ----------------------------------------------------------------------
// ICE config fetch
// ----------------------------------------------------------------------
async function primeIceServers() {
  try {
    iceConfig = await apiGet('/api/screen-share/turn-credentials');
    const diag = document.getElementById('ss-diag-ice');
    const turn = document.getElementById('ss-diag-turn');
    if (diag) diag.textContent = (iceConfig.iceServers || []).map(s => Array.isArray(s.urls) ? s.urls.join(', ') : s.urls).join(' | ');
    if (turn) turn.textContent = iceConfig.turnEnabled ? 'enabled (Cloudflare Calls)' : 'disabled (STUN-only)';
  } catch (e) {
    console.warn('[screen-share] failed to fetch ICE servers, will use STUN-only fallback:', e);
    iceConfig = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      turnEnabled: false,
      iceTransportPolicy: 'all',
    };
  }
}

// ----------------------------------------------------------------------
// Device list (workspace-scoped via existing /api/devices)
// ----------------------------------------------------------------------
async function populateTargetList() {
  const listEl = document.getElementById('ss-target-list');
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
async function startCapture(container) {
  if (stream) {
    setSourceStatus('Already capturing. Stop the current capture first.');
    return;
  }

  // Strict secure-context guard. getDisplayMedia requires HTTPS, but we double
  // check here so the user gets a clear message instead of a Promise rejection.
  if (!window.isSecureContext) {
    setSourceStatus('Screen sharing requires HTTPS. This page is not in a secure context.');
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    setSourceStatus('Your browser does not support getDisplayMedia. Use Chrome / Edge / Firefox latest.');
    return;
  }

  try {
    // Modern constraints per spec. Browsers without support for the newer
    // hints (selfBrowserSurface / surfaceSwitching / systemAudio) silently
    // ignore them - no need for feature detection.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        // Browser picks the resolution based on the surface; we cap at 1080p
        // to keep bitrate within VIDEO_BITRATE_KBPS comfortably.
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: {
        // System audio capture (Windows / ChromeOS) - falls back gracefully
        // on macOS where the OS doesn't expose system audio without a driver.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      // The four modern getDisplayMedia hints (Chromium 105+, partial in FF):
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    // NotAllowedError (user cancelled picker) is the most common; don't shout
    if (e && e.name === 'NotAllowedError') {
      setSourceStatus('Capture cancelled. Click the button to try again.');
      return;
    }
    console.error('[screen-share] getDisplayMedia failed:', e);
    setSourceStatus(`Failed to start capture: ${e.message || e.name || 'unknown'}`);
    return;
  }

  applyContentHint(currentContentHint);

  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.addEventListener('ended', () => {
    // User clicked the browser's "Stop sharing" pill - revert UI.
    stopCapture(container);
  });

  const videoEl = container.querySelector('#ss-preview');
  videoEl.srcObject = stream;
  container.querySelector('#ss-preview-card').hidden = false;
  container.querySelector('#ss-targets-section').hidden = false;
  setSourceStatus('Captured. Pick destinations below to start broadcasting.');

  const meta = container.querySelector('#ss-preview-meta');
  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
  const audioOn = stream.getAudioTracks().length > 0;
  meta.innerHTML = `
    <span><strong>Surface:</strong> ${escapeHtml(settings.displaySurface || 'unknown')}</span>
    <span><strong>Size:</strong> ${settings.width || '?'}&times;${settings.height || '?'}</span>
    <span><strong>FPS:</strong> ${settings.frameRate || '?'}</span>
    <span><strong>Audio:</strong> ${audioOn ? 'included' : 'none'}</span>
  `;

  // Wire up checkbox handlers to start/stop broadcasts per device.
  document.querySelectorAll('#ss-target-list input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const deviceId = e.target.dataset.deviceId;
      if (e.target.checked) {
        e.target.disabled = true;
        try {
          await startBroadcastTo(deviceId);
        } catch (err) {
          console.error('[screen-share] start broadcast failed:', err);
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

function stopCapture(container) {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  for (const [deviceId, _] of peerConnections) {
    stopBroadcastTo(deviceId).catch(() => {});
  }
  if (container) {
    const previewCard = container.querySelector('#ss-preview-card');
    if (previewCard) previewCard.hidden = true;
    const targets = container.querySelector('#ss-targets-section');
    if (targets) targets.hidden = true;
    setSourceStatus('Capture stopped.');
    document.querySelectorAll('#ss-target-list input[type=checkbox]').forEach(cb => {
      cb.checked = false;
    });
  }
}

// ----------------------------------------------------------------------
// 2. Per-device broadcast (one RTCPeerConnection per target device)
// ----------------------------------------------------------------------
async function startBroadcastTo(deviceId) {
  if (!stream) throw new Error('No active capture stream');
  if (peerConnections.has(deviceId)) return;

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

  // Add all captured tracks (video + audio if present).
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }

  // Cap outgoing bitrate so a high-frame-rate desktop doesn't saturate the link.
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = VIDEO_BITRATE_KBPS * 1000;
      try { await sender.setParameters(params); } catch (_) { /* older browsers */ }
    }
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sock.emit('screen-share:ice-candidate', {
        device_id: deviceId,
        candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[screen-share] pc(${deviceId}) state:`, pc.connectionState);
    refreshSessionList();
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      // Clean up local state if the peer died.
      peerConnections.delete(deviceId);
    }
  };

  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  const offerAck = await emitWithAck(sock, 'screen-share:offer', {
    device_id: deviceId,
    sdp: pc.localDescription,
  });
  if (!offerAck || !offerAck.ok) {
    pc.close();
    peerConnections.delete(deviceId);
    throw new Error(offerAck && offerAck.error ? offerAck.error : 'server refused screen-share:offer');
  }
}

async function stopBroadcastTo(deviceId) {
  const pc = peerConnections.get(deviceId);
  if (pc) {
    try { pc.close(); } catch (_) { /* */ }
    peerConnections.delete(deviceId);
  }
  const sock = getSocket();
  if (sock && sock.connected) {
    await emitWithAck(sock, 'screen-share:stop', { device_id: deviceId }).catch(() => {});
  }
  refreshSessionList();
}

// ----------------------------------------------------------------------
// Socket listeners (wire once at view init; idempotent if user navigates
// back to the view)
// ----------------------------------------------------------------------
function wireSocketListenersOnce() {
  if (socketListenersWired) return;
  socketListenersWired = true;
  const sock = getSocket();
  if (!sock) return;

  // Device answered our offer - apply remote description.
  sock.on('screen-share:answer', async ({ device_id, sdp }) => {
    const pc = peerConnections.get(device_id);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
    } catch (e) {
      console.error('[screen-share] setRemoteDescription failed:', e);
    }
  });

  // Device's ICE candidates.
  sock.on('screen-share:device-ice-candidate', async ({ device_id, candidate }) => {
    const pc = peerConnections.get(device_id);
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('[screen-share] addIceCandidate failed:', e);
    }
  });

  // Server tells us another broadcaster preempted our session (only one
  // broadcaster per device at a time).
  sock.on('screen-share:preempted', ({ device_id }) => {
    console.warn(`[screen-share] preempted on device ${device_id}`);
    const pc = peerConnections.get(device_id);
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      peerConnections.delete(device_id);
    }
    refreshSessionList();
  });

  // Device ended the session on its end (player crashed, user closed, etc.)
  sock.on('screen-share:ended-by-device', ({ device_id }) => {
    console.log(`[screen-share] device ${device_id} ended session`);
    const pc = peerConnections.get(device_id);
    if (pc) {
      try { pc.close(); } catch (_) { /* */ }
      peerConnections.delete(device_id);
    }
    document.querySelectorAll(`#ss-target-list input[data-device-id="${cssEscape(device_id)}"]`).forEach(cb => {
      cb.checked = false;
    });
    refreshSessionList();
  });
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
  const rows = [];
  for (const [deviceId, pc] of peerConnections) {
    rows.push(`
      <div class="ss-session-row">
        <span class="ss-session-device">${escapeHtml(deviceId)}</span>
        <span class="ss-session-state">${escapeHtml(pc.connectionState || 'new')}</span>
        <button class="btn btn-small btn-danger" data-stop="${escapeHtml(deviceId)}">Stop</button>
      </div>
    `);
  }
  list.innerHTML = rows.join('');
  list.querySelectorAll('button[data-stop]').forEach(b => {
    b.addEventListener('click', async () => {
      const deviceId = b.dataset.stop;
      await stopBroadcastTo(deviceId);
      const cb = document.querySelector(`#ss-target-list input[data-device-id="${cssEscape(deviceId)}"]`);
      if (cb) cb.checked = false;
    });
  });
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

function emitWithAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, ack) => {
      if (err) resolve({ ok: false, error: 'no_ack' });
      else resolve(ack || { ok: false, error: 'no_ack' });
    });
  });
}
