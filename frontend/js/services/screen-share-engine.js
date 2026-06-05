/**
 * Persistent screen-share broadcaster engine (singleton).
 *
 * Lives for the SPA session — NOT tied to any view — so navigating away from
 * the dashboard does NOT tear down a live broadcast (the bug this fixes). The
 * screen-share view becomes a thin presenter that calls these methods and
 * subscribes to onChange; the unified Media Control view + live-broadcast chip
 * also drive it.
 *
 * The WebRTC state (stream / peerConnections / iceConfig) and the (idempotent,
 * sentinel-guarded) signaling listeners were hoisted verbatim out of
 * frontend/js/views/screen-share.js so existing behavior is preserved 1:1.
 *
 * Public interface:
 *   engine.init()                       // idempotent: prime ICE + wire signaling listeners ONCE on the singleton socket
 *   engine.startBroadcastTo(deviceId, opts?) -> Promise   // capture (once) + add a peer for this device
 *   engine.stopBroadcastTo(deviceId) -> Promise           // close one peer; stop capture if it was the last
 *   engine.stopAll() -> Promise                           // close all peers + stop capture
 *   engine.getActiveTargets() -> string[]                 // device ids currently being broadcast to
 *   engine.isActive() -> boolean
 *   engine.onChange(cb) -> unsubscribe   // cb({ active, targets }) on every state change
 *
 * Capture-surface helpers (used by the screen-share view's explicit
 * "Choose screen / window / tab" flow; instant callers like Media Control just
 * call startBroadcastTo which captures on demand):
 *   engine.startCapture(contentHint?) -> Promise<{ ok, stream?, status?, reason? }>
 *   engine.getStream() -> MediaStream | null
 *   engine.applyContentHint(hint)
 *   engine.onCaptureEnded(cb) -> unsubscribe   // browser "Stop sharing" pill fired
 */

import { getSocket } from '../socket.js';
import { SS } from '../player-protocol.js';

// ----------------------------------------------------------------------
// Debug logger - opt-in via localStorage.SCREEN_SHARE_DEBUG='1'. Keeps the
// production console quiet while preserving on-demand observability.
// ----------------------------------------------------------------------
const SS_DEBUG = (() => {
  try { return localStorage.getItem('SCREEN_SHARE_DEBUG') === '1'; } catch (_) { return false; }
})();
function dbg(...args) {
  if (SS_DEBUG) console.log('[screen-share-engine]', ...args);
}
function warnLog(...args) { console.warn('[screen-share-engine]', ...args); }
function errLog(...args) { console.error('[screen-share-engine]', ...args); }

// ----------------------------------------------------------------------
// Self-contained API helper - intentionally does NOT import from api.js so
// the engine stays a single drop-in without requiring api.js to expose a
// specific helper name. Uses the same JWT bearer pattern as the rest of the
// dashboard (token stored in localStorage by login.js).
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

// ----------------------------------------------------------------------
// Engine state — held at MODULE scope here (NOT in the view), so it persists
// across view mounts/unmounts for the whole SPA session.
// ----------------------------------------------------------------------
let stream = null;                       // MediaStream from getDisplayMedia
let peerConnections = new Map();         // device_id -> RTCPeerConnection
let pendingDeviceCandidates = new Map(); // device_id -> RTCIceCandidateInit[]
let connectionTimeouts = new Map();      // device_id -> setTimeout handle
let iceConfig = null;                    // cached from /api/screen-share/turn-credentials
let currentContentHint = 'detail';       // 'detail' | 'motion'

// onChange subscribers — notified { active, targets } on every state change.
const changeSubs = new Set();
// onCaptureEnded subscribers — notified when the browser "Stop sharing" pill ends the track.
const captureEndedSubs = new Set();

// Adaptive per-receiver video bitrate. There is NO fixed cap: the encoder target
// is derived from the ACTUAL captured resolution + frame rate (a bits-per-pixel
// heuristic) and bounded only by a high, operator-tunable CEILING. Resolution of
// the ceiling, in priority order:
//   1) server-provided iceConfig.maxBitrateKbps (env SCREEN_SHARE_MAX_BITRATE_KBPS
//      on the box — the real, deployment-time knob),
//   2) a localStorage override (SCREEN_SHARE_MAX_BITRATE_KBPS, mirroring the
//      SCREEN_SHARE_DEBUG idiom above) for per-display field tuning,
//   3) DEFAULT_MAX_BITRATE_KBPS.
// (process.env is intentionally NOT used — this module runs in the browser.)
const DEFAULT_MAX_BITRATE_KBPS = 50000; // 50 Mbps ceiling (replaces the old fixed 2500 cap).
function bitrateCeilingKbps() {
  const fromServer = iceConfig && Number(iceConfig.maxBitrateKbps);
  if (fromServer && fromServer > 0) return fromServer;
  try {
    const ls = parseInt(localStorage.getItem('SCREEN_SHARE_MAX_BITRATE_KBPS') || '', 10);
    if (ls > 0) return ls;
  } catch (_) { /* ignore */ }
  return DEFAULT_MAX_BITRATE_KBPS;
}
// Adaptive encoder target from the captured geometry. ~0.08 bits per pixel per
// frame is a high-fidelity target for screen content:
//   1080p@30 ~5 Mbps, 1080p@60 ~10 Mbps, 4K@30 ~20 Mbps, 4K@60 ~40 Mbps; ultra-wide
//   scales by area. Floored at 1.5 Mbps, ceilinged by bitrateCeilingKbps().
function computeAdaptiveBitrate(width, height, fps) {
  const pixels = (width || 1920) * (height || 1080);
  const f = fps && fps > 0 ? fps : 30;
  const targetKbps = Math.round((pixels * f * 0.08) / 1000);
  return Math.max(1500, Math.min(targetKbps, bitrateCeilingKbps()));
}
const CONNECT_TIMEOUT_MS = 30_000;    // Mark a session failed if it doesn't reach 'connected'.
const ACK_TIMEOUT_MS = 5_000;         // Socket ack budget for screen-share:start/offer/stop.

// Cached feature detection for getDisplayMedia hints that Firefox rejects.
let SUPPORTED_CONSTRAINTS = null;

// ----------------------------------------------------------------------
// Subscriptions
// ----------------------------------------------------------------------
function notifyChange() {
  const snapshot = { active: peerConnections.size > 0, targets: [...peerConnections.keys()] };
  changeSubs.forEach((cb) => {
    try { cb(snapshot); } catch (e) { errLog('onChange subscriber threw:', e); }
  });
}

export function onChange(cb) {
  changeSubs.add(cb);
  return () => changeSubs.delete(cb);
}

export function onCaptureEnded(cb) {
  captureEndedSubs.add(cb);
  return () => captureEndedSubs.delete(cb);
}

function notifyCaptureEnded() {
  captureEndedSubs.forEach((cb) => {
    try { cb(); } catch (e) { errLog('onCaptureEnded subscriber threw:', e); }
  });
}

// ----------------------------------------------------------------------
// State queries
// ----------------------------------------------------------------------
export function getActiveTargets() { return [...peerConnections.keys()]; }
export function isActive() { return peerConnections.size > 0; }
// Per-target RTCPeerConnection.connectionState, for presenters that render a
// live status column (the screen-share view's "Active broadcasts" list).
export function getTargetStates() {
  const out = new Map();
  for (const [deviceId, pc] of peerConnections) {
    out.set(deviceId, pc.connectionState || 'new');
  }
  return out;
}
export function getStream() { return stream; }
export function getIceConfig() { return iceConfig; }

// ----------------------------------------------------------------------
// init — idempotent. Primes ICE servers + wires signaling listeners once.
// ----------------------------------------------------------------------
let icePrimed = false;
export async function init() {
  wireSocketListeners();
  if (!icePrimed) {
    icePrimed = true;
    await primeIceServers();
  }
}

// ----------------------------------------------------------------------
// ICE config fetch (returns the resolved iceConfig; STUN-only fallback on error).
// ----------------------------------------------------------------------
export async function primeIceServers() {
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
  return iceConfig;
}

// ----------------------------------------------------------------------
// Capture (getDisplayMedia). startCapture() backs the screen-share view's
// explicit "Choose screen / window / tab" button; startBroadcastTo() calls the
// same single-capture path on demand for instant callers (Media Control).
//
// Returns { ok:true, stream } on success, or { ok:false, status, reason } with
// a human-readable status string for the view to surface (mirrors the old
// setSourceStatus() messages verbatim).
// ----------------------------------------------------------------------
export async function startCapture(contentHint) {
  if (typeof contentHint === 'string') currentContentHint = contentHint;

  if (stream) {
    return { ok: false, reason: 'already_capturing', status: 'Already capturing. Stop the current capture first.' };
  }

  // Strict secure-context guard.
  if (!window.isSecureContext) {
    return { ok: false, reason: 'insecure_context', status: 'Screen sharing requires HTTPS. This page is not in a secure context.' };
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    return { ok: false, reason: 'unsupported', status: 'Your browser does not support getDisplayMedia. Use Chrome / Edge / Firefox latest.' };
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
      // Adaptive resolution: 'ideal' targets at 4K scale with NO hard max, so the
      // browser captures the source's absolute native resolution (4K, ultra-wide,
      // even the full 12372x2160 wall canvas where the source supports it). The
      // browser gracefully falls back to whatever the source can actually provide;
      // adaptive bitrate (computeAdaptiveBitrate) sizes the encoder to the real
      // captured geometry, and the receiver scales via object-fit.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
  // Chromium-specific top-level hints. Firefox/Safari can reject unknown
  // getDisplayMedia keys instead of ignoring them, so retry with the conservative
  // constraints below when the rich request fails with a constraint/type error.
  const richConstraints = {
    ...baseConstraints,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  };

  try {
    stream = await navigator.mediaDevices.getDisplayMedia(richConstraints);
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      return { ok: false, reason: 'cancelled', status: 'Capture cancelled. Click the button to try again.' };
    }
    const retryable = e && ['TypeError', 'OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotSupportedError'].includes(e.name);
    if (retryable) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(baseConstraints);
      } catch (retryError) {
        if (retryError && retryError.name === 'NotAllowedError') {
          return { ok: false, reason: 'cancelled', status: 'Capture cancelled. Click the button to try again.' };
        }
        errLog('getDisplayMedia fallback failed:', retryError);
        return { ok: false, reason: 'failed', status: `Failed to start capture: ${retryError.message || retryError.name || 'unknown'}` };
      }
    } else {
      errLog('getDisplayMedia failed:', e);
      return { ok: false, reason: 'failed', status: `Failed to start capture: ${e.message || e.name || 'unknown'}` };
    }
  }

  applyContentHint(currentContentHint);

  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.addEventListener('ended', () => {
    // User clicked the browser's "Stop sharing" pill. Tear everything down,
    // then notify presenters so they can sync their UI.
    stopAll();
    notifyCaptureEnded();
  });

  return { ok: true, stream };
}

export function applyContentHint(hint) {
  currentContentHint = hint;
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (track && 'contentHint' in track) {
    track.contentHint = hint; // 'detail' or 'motion'
  }
}

// Capture on demand if not already capturing. Throws with the human-readable
// status so the broadcast caller can surface it.
async function ensureCapture() {
  if (stream) return stream;
  const res = await startCapture();
  if (!res.ok || !stream) {
    throw new Error(res.status || 'Failed to start capture');
  }
  return stream;
}

// ----------------------------------------------------------------------
// Per-device broadcast (one RTCPeerConnection per target device).
//
// opts: { wallTile, contentHint }
//   - wallTile: optional wall-tile payload forwarded to the receiver so it
//     renders its slice of the wall canvas instead of a fullscreen overlay.
//   - contentHint: optional 'detail'|'motion' applied to the capture before it
//     is established (only meaningful for the FIRST/capturing call).
// ----------------------------------------------------------------------
export async function startBroadcastTo(deviceId, opts = {}) {
  const { wallTile = null, contentHint } = (opts && typeof opts === 'object') ? opts : {};
  if (typeof contentHint === 'string') currentContentHint = contentHint;

  if (peerConnections.has(deviceId)) {
    dbg(`broadcast to ${deviceId} already running`);
    return;
  }

  await init();
  const sock = getSocket();
  if (!sock || !sock.connected) throw new Error('Dashboard socket not connected');

  // Capture (once) — backed by the same getDisplayMedia path as startCapture().
  // Do this only after the socket is available so a disconnected dashboard does
  // not leave the browser sharing indicator active with nowhere to send media.
  await ensureCapture();

  // Server-side session setup. wall_tile is optional - when present, the
  // server forwards it to the receiver so it can render this device's
  // slice of the wall canvas instead of a fullscreen overlay.
  const startPayload = wallTile
    ? { device_id: deviceId, wall_tile: wallTile }
    : { device_id: deviceId };
  const startAck = await emitWithAck(sock, SS.START, startPayload);
  if (!startAck || !startAck.ok) {
    if (peerConnections.size === 0) stopCaptureOnly();
    throw new Error(startAck && startAck.error ? startAck.error : 'server refused screen-share:start');
  }

  let pc = null;
  try {
    pc = new RTCPeerConnection({
      iceServers: (iceConfig && iceConfig.iceServers) || [],
      iceTransportPolicy: (iceConfig && iceConfig.iceTransportPolicy) || 'all',
      bundlePolicy: 'max-bundle',
    });
    peerConnections.set(deviceId, pc);
    pendingDeviceCandidates.set(deviceId, []);
    notifyChange();

    // Compute the adaptive per-receiver bitrate from the ACTUAL captured geometry
    // (resolution + frame rate). No fixed cap — see computeAdaptiveBitrate above.
    // Captured once here and reused by applyBitrateCap() below (closure scope).
    let adaptiveBitrateKbps = bitrateCeilingKbps();
    const capturedTrack = stream.getVideoTracks()[0];
    const capturedSettings = capturedTrack && capturedTrack.getSettings ? capturedTrack.getSettings() : {};
    if (capturedSettings.width && capturedSettings.height) {
      adaptiveBitrateKbps = computeAdaptiveBitrate(capturedSettings.width, capturedSettings.height, capturedSettings.frameRate);
    }
    dbg(`adaptive bitrate ${adaptiveBitrateKbps} kbps for ${capturedSettings.width || '?'}x${capturedSettings.height || '?'}@${capturedSettings.frameRate || '?'}`);

    // Add tracks via transceivers with explicit sendonly direction + the adaptive
    // bitrate target baked in via sendEncodings. This is the modern API and is
    // the only way to clamp encoder bitrate BEFORE negotiation. The deprecated
    // sender.setParameters() post-negotiation path silently no-ops in many
    // browsers because the encoder isn't bound yet at addTrack time.
    for (const track of stream.getTracks()) {
      const initEncoding = track.kind === 'video'
        ? [{ maxBitrate: adaptiveBitrateKbps * 1000, networkPriority: 'high' }]
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
          params.encodings[0].maxBitrate = adaptiveBitrateKbps * 1000;
          await sender.setParameters(params);
        } catch (_) { /* tolerate older browsers */ }
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && sock.connected) {
        sock.emit(SS.ICE, {
          device_id: deviceId,
          candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      dbg(`pc(${deviceId}) state:`, pc.connectionState);
      notifyChange();
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
        notifyChange();
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

    const offerAck = await emitWithAck(sock, SS.OFFER, {
      device_id: deviceId,
      sdp: pc.localDescription,
    });
    if (!offerAck || !offerAck.ok) {
      throw new Error(offerAck && offerAck.error ? offerAck.error : 'server refused screen-share:offer');
    }
  } catch (err) {
    try { if (pc) pc.close(); } catch (_) { /* */ }
    peerConnections.delete(deviceId);
    pendingDeviceCandidates.delete(deviceId);
    clearConnectTimeout(deviceId);
    if (sock && sock.connected) {
      await emitWithAck(sock, SS.STOP, { device_id: deviceId }).catch(() => {});
    }
    notifyChange();
    if (peerConnections.size === 0) stopCaptureOnly();
    throw err;
  }
}

export async function stopBroadcastTo(deviceId) {
  const pc = peerConnections.get(deviceId);
  if (pc) {
    try { pc.close(); } catch (_) { /* */ }
    peerConnections.delete(deviceId);
  }
  pendingDeviceCandidates.delete(deviceId);
  clearConnectTimeout(deviceId);
  const sock = getSocket();
  if (sock && sock.connected) {
    await emitWithAck(sock, SS.STOP, { device_id: deviceId }).catch(() => {});
  }
  notifyChange();
  // When the last peer drops, stop the underlying capture too so the encoder /
  // the browser "sharing" indicator are released (matches the prior single-view
  // behavior where the last stop ended capture).
  if (peerConnections.size === 0) {
    stopCaptureOnly();
  }
}

export async function stopAll() {
  // Snapshot keys before iteration; stopBroadcastTo mutates the map.
  const deviceIds = Array.from(peerConnections.keys());
  for (const deviceId of deviceIds) {
    // Don't let stopBroadcastTo's last-peer auto-stop race the explicit
    // stopCaptureOnly() below — it's idempotent, so this is safe either way.
    await stopBroadcastTo(deviceId).catch(() => { /* swallow during teardown */ });
  }
  stopCaptureOnly();
  // Defensive: clear any straggler timers / pending candidates.
  for (const [, h] of connectionTimeouts) clearTimeout(h);
  connectionTimeouts.clear();
  pendingDeviceCandidates.clear();
  notifyChange();
}

// Stop ONLY the captured tracks (does not touch peers). Idempotent.
function stopCaptureOnly() {
  if (stream) {
    try { stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* */ } }); } catch (_) { /* */ }
    stream = null;
  }
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
    notifyChange();
    if (peerConnections.size === 0) stopCaptureOnly();
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
    notifyChange();
    if (peerConnections.size === 0) stopCaptureOnly();
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
// Internal helpers
// ----------------------------------------------------------------------
function emitWithAck(socket, event, payload, timeoutMs = ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, ack) => {
      if (err) resolve({ ok: false, error: 'no_ack' });
      else resolve(ack || { ok: false, error: 'no_ack' });
    });
  });
}
