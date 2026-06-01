/**
 * ScreenShare view - broadcaster (admin dashboard) side.
 *
 * Lets an authenticated MBFD admin pick a paired display and broadcast
 * their screen / window / browser tab live via WebRTC. Designed for
 * sub-300ms glass-to-glass latency.
 *
 * As of the unified-Media-Control refactor, the WebRTC engine (stream /
 * peerConnections / iceConfig + signaling) lives in a PERSISTENT singleton,
 * frontend/js/services/screen-share-engine.js, that is NOT tied to this view.
 * This view is now a thin PRESENTER: it owns the capture/target UI, but every
 * broadcast operation delegates to the engine, and the engine outlives view
 * navigation. Consequently unmount() no longer stops the broadcast — a live
 * share survives navigating away and back (the bug that motivated the hoist).
 *
 * Architecture (now split engine / view):
 *   1. The engine fetches ICE servers (STUN + OpenRelay TURN by default, CF
 *      Calls TURN when configured) from /api/screen-share/turn-credentials.
 *   2. The view captures via engine.startCapture() (getDisplayMedia w/ modern
 *      feature-detected constraints) and renders the local preview.
 *   3. For each selected target the engine creates an RTCPeerConnection,
 *      addTransceiver()s the captured tracks with the adaptive bitrate cap,
 *      generates the SDP offer, and pushes it through Socket.IO signaling.
 *   4. The engine receives SDP answer + ICE candidates from the device,
 *      buffering device ICE until the answer is applied (race-safe).
 *   5. On `connectionState === 'failed'`, the engine eagerly notifies the
 *      server so activeSessions is cleared and the user can retry.
 *   6. Local preview <video> shows what's being shared.
 *   7. Stop button: engine.stopAll() (signal stop, close peers, stop tracks).
 *   8. unmount() (router nav) ONLY detaches this view's subscriptions — the
 *      engine keeps broadcasting in the background.
 */

import * as engine from '../services/screen-share-engine.js';

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

async function listVideoWalls() {
  // Returns array of walls, each with .devices = [{ device_id, device_name,
  // device_status, grid_col, grid_row, canvas_x, canvas_y, canvas_width,
  // canvas_height }, ...]. Empty array on auth/no-workspace.
  try { return await apiGet('/api/video-walls'); } catch (_) { return []; }
}

/**
 * Compute the per-device wall_tile payload for a screen-share-to-wall session.
 * Mirrors the player playlist's wall geometry: the bounding box of all member
 * canvas_x/y/w/h becomes the "player canvas" that the broadcast paints; each
 * member's own canvas_x/y/w/h becomes its screen_rect. Receivers position the
 * stage at vw/vh coordinates derived from these two rects.
 *
 * Returns Map<device_id, { screen_rect, player_rect }>.
 */
function computeWallTiles(wall) {
  if (!wall || !Array.isArray(wall.devices) || wall.devices.length === 0) return new Map();
  // Filter members that have a canvas rect; ones without are unconfigured.
  const members = wall.devices.filter(d =>
    typeof d.canvas_x === 'number' && typeof d.canvas_y === 'number' &&
    typeof d.canvas_width === 'number' && typeof d.canvas_height === 'number' &&
    d.canvas_width > 0 && d.canvas_height > 0
  );
  if (members.length === 0) return new Map();
  // Bounding box.
  const minX = Math.min(...members.map(d => d.canvas_x));
  const minY = Math.min(...members.map(d => d.canvas_y));
  const maxX = Math.max(...members.map(d => d.canvas_x + d.canvas_width));
  const maxY = Math.max(...members.map(d => d.canvas_y + d.canvas_height));
  const playerRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const tiles = new Map();
  for (const m of members) {
    tiles.set(m.device_id, {
      screen_rect: { x: m.canvas_x, y: m.canvas_y, w: m.canvas_width, h: m.canvas_height },
      player_rect: { ...playerRect },
    });
  }
  return tiles;
}

// ----------------------------------------------------------------------
// View-scoped UI state. The WebRTC engine state lives in the engine singleton;
// here we only track view-local presentation bits + subscriptions, reset at
// the top of every render() so re-entering the route is clean.
// ----------------------------------------------------------------------
let currentContentHint = 'detail';    // 'detail' | 'motion' (UI radio mirror)
let activeContainer = null;           // bound at render time for DOM lookups
let engineUnsub = null;               // engine.onChange unsubscribe
let captureEndedUnsub = null;         // engine.onCaptureEnded unsubscribe

function resetViewSubscriptions() {
  if (engineUnsub) { try { engineUnsub(); } catch (_) { /* */ } engineUnsub = null; }
  if (captureEndedUnsub) { try { captureEndedUnsub(); } catch (_) { /* */ } captureEndedUnsub = null; }
}

// ----------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------
export async function render(container) {
  resetViewSubscriptions(); // CRITICAL: re-render must not stack duplicate subscriptions.
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

  // Bring up the engine (idempotent): primes ICE + wires signaling once.
  engine.init().then(() => paintDiagnostics()).catch(() => paintDiagnostics());

  // Repaint the session list on every engine state change, even those caused
  // by another view / the broadcast chip.
  engineUnsub = engine.onChange(() => { refreshSessionList(); syncTargetChecksFromEngine(); });
  // If the browser "Stop sharing" pill ends capture, sync this view's UI.
  captureEndedUnsub = engine.onCaptureEnded(() => syncCaptureStoppedUI());

  container.querySelector('#ss-start-capture').addEventListener('click', () => startCapture());
  container.querySelector('#ss-stop-capture').addEventListener('click', () => engine.stopAll());
  container.querySelectorAll('input[name="content-hint"]').forEach(el => {
    el.addEventListener('change', (e) => applyContentHint(e.target.value));
  });

  // Fire-and-forget. The router does not await render().
  populateTargetList();
  // If a broadcast is already live (engine survived a prior navigation),
  // reflect it immediately + re-attach the preview to the live stream.
  rehydrateFromEngine();
}

export function unmount() {
  // Called by the router when navigating away. The broadcast lives in the
  // engine singleton, NOT this view, so we DO NOT stop capture here — the
  // share must survive navigation. Only detach this view's subscriptions and
  // drop the container reference.
  dbg('unmount: detaching view subscriptions (broadcast persists in engine)');
  resetViewSubscriptions();
  activeContainer = null;
}

// Reflect an already-live engine broadcast when (re)mounting the view: show the
// preview + target sections, re-attach the live stream to the <video>, mark the
// active target checkboxes, and paint the session list.
function rehydrateFromEngine() {
  const liveStream = engine.getStream();
  if (liveStream && activeContainer) {
    const videoEl = activeContainer.querySelector('#ss-preview');
    if (videoEl) videoEl.srcObject = liveStream;
    const previewCard = activeContainer.querySelector('#ss-preview-card');
    if (previewCard) previewCard.hidden = false;
    const targets = activeContainer.querySelector('#ss-targets-section');
    if (targets) targets.hidden = false;
    setSourceStatus('Broadcast in progress (re-attached from background).');
  }
  refreshSessionList();
}

function paintDiagnostics() {
  const iceConfig = engine.getIceConfig();
  if (!iceConfig) return;
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
// Target list - both video walls (as single targets that fan out to all
// members on the broadcaster side, each receiver getting its computed
// wall_tile) AND individual displays.
// ----------------------------------------------------------------------
let walls = []; // cached walls (with .devices) for use by the checkbox handler

async function populateTargetList() {
  const listEl = document.getElementById('ss-target-list');
  if (!listEl) return;
  try {
    const [devices, fetchedWalls] = await Promise.all([listDevices(), listVideoWalls()]);
    walls = Array.isArray(fetchedWalls) ? fetchedWalls : [];

    // Devices that are members of a wall are still individually targetable, but
    // we tag them visually so the user can see they belong to a wall.
    const wallMemberById = new Map();
    for (const w of walls) {
      for (const m of (w.devices || [])) {
        wallMemberById.set(m.device_id, w);
      }
    }

    let html = '';

    if (walls.length > 0) {
      html += `<div class="ss-target-section-label">Video walls</div>`;
      for (const w of walls) {
        const members = (w.devices || []);
        const onlineMembers = members.filter(m => m.device_status === 'online');
        const allOnline = members.length > 0 && onlineMembers.length === members.length;
        const tiles = computeWallTiles(w);
        const wellFormed = tiles.size === members.length && tiles.size > 0;
        const disabled = !(allOnline && wellFormed);
        const reason = !wellFormed ? 'missing canvas layout' : (!allOnline ? `${members.length - onlineMembers.length} of ${members.length} offline` : `${members.length} displays`);
        html += `
          <label class="ss-target-row ss-target-wall" data-wall-id="${escapeHtml(w.id)}">
            <input type="checkbox" data-wall-id="${escapeHtml(w.id)}" ${disabled ? 'disabled' : ''}>
            <span class="ss-target-name">${escapeHtml(w.name || 'Wall')} <span class="muted">(${w.grid_cols}×${w.grid_rows} — single broadcast)</span></span>
            <span class="status-dot ${allOnline ? 'online' : 'offline'}"></span>
            <span class="muted">${escapeHtml(reason)}</span>
          </label>
        `;
      }
    }

    if (devices.length > 0) {
      html += `<div class="ss-target-section-label">Individual displays</div>`;
      for (const d of devices) {
        const wallTag = wallMemberById.has(d.id) ? `<span class="ss-target-walltag" title="Member of wall: ${escapeHtml(wallMemberById.get(d.id).name)}">in wall</span>` : '';
        html += `
          <label class="ss-target-row" data-device-id="${escapeHtml(d.id)}">
            <input type="checkbox" data-device-id="${escapeHtml(d.id)}" ${d.status === 'online' ? '' : 'disabled'}>
            <span class="ss-target-name">${escapeHtml(d.name || 'Unnamed display')} ${wallTag}</span>
            <span class="status-dot ${d.status === 'online' ? 'online' : 'offline'}"></span>
            <span class="muted">${d.status}</span>
          </label>
        `;
      }
    }

    if (html === '') {
      listEl.innerHTML = '<div class="muted">No paired displays or walls in this workspace yet. Pair a display under Devices.</div>';
      return;
    }
    listEl.innerHTML = html;

    // If a broadcast is already live, pre-check the matching boxes + wire
    // change handlers (mirrors the post-capture wiring done in startCapture).
    syncTargetChecksFromEngine();
    wireTargetCheckboxHandlers();
  } catch (e) {
    listEl.innerHTML = `<div class="muted">Could not load displays: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

// Resolve a wall id to the broadcast targets we need to dispatch. Returns
// [{ device_id, wall_tile }] for use by the broadcast loop.
function resolveWallTargets(wallId) {
  const w = walls.find(x => x.id === wallId);
  if (!w) return [];
  const tiles = computeWallTiles(w);
  const out = [];
  for (const m of (w.devices || [])) {
    const tile = tiles.get(m.device_id);
    if (m.device_status === 'online' && tile) {
      out.push({ device_id: m.device_id, wall_tile: tile });
    }
  }
  return out;
}

// ----------------------------------------------------------------------
// 1. Capture (delegates to the engine; this view owns the preview UI).
// ----------------------------------------------------------------------
async function startCapture() {
  const res = await engine.startCapture(currentContentHint);
  if (!res.ok) {
    setSourceStatus(res.status || 'Could not start capture.');
    return;
  }

  const liveStream = res.stream;
  if (!activeContainer) return; // View was unmounted between async hops.

  const videoEl = activeContainer.querySelector('#ss-preview');
  if (videoEl) videoEl.srcObject = liveStream;
  activeContainer.querySelector('#ss-preview-card').hidden = false;
  activeContainer.querySelector('#ss-targets-section').hidden = false;
  setSourceStatus('Captured. Pick destinations below to start broadcasting.');

  const meta = activeContainer.querySelector('#ss-preview-meta');
  const videoTrack = liveStream.getVideoTracks()[0];
  const settings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {};
  const audioOn = liveStream.getAudioTracks().length > 0;
  if (meta) {
    meta.innerHTML = `
      <span><strong>Surface:</strong> ${escapeHtml(settings.displaySurface || 'unknown')}</span>
      <span><strong>Size:</strong> ${settings.width || '?'}&times;${settings.height || '?'}</span>
      <span><strong>FPS:</strong> ${settings.frameRate || '?'}</span>
      <span><strong>Audio:</strong> ${audioOn ? 'included' : 'none'}</span>
    `;
  }

  // Wire up checkbox handlers (idempotent-ish: populateTargetList already wires
  // them, but capture may complete before/after that fetch resolves, so ensure
  // they're attached here too).
  wireTargetCheckboxHandlers();
}

function applyContentHint(hint) {
  currentContentHint = hint;
  engine.applyContentHint(hint);
}

// Attach change handlers to the target checkboxes. Guarded by a per-element
// sentinel so repeated calls (populateTargetList + startCapture) don't stack.
function wireTargetCheckboxHandlers() {
  document.querySelectorAll('#ss-target-list input[type=checkbox]').forEach(cb => {
    if (cb.__ssWired) return;
    cb.__ssWired = true;
    cb.addEventListener('change', async (e) => {
      const wallId = e.target.dataset.wallId;
      const deviceId = e.target.dataset.deviceId;
      const isWall = !!wallId;
      if (e.target.checked) {
        e.target.disabled = true;
        try {
          if (isWall) {
            const targets = resolveWallTargets(wallId);
            if (targets.length === 0) throw new Error('wall has no broadcastable members');
            // Start all members in parallel; partial success is acceptable
            // (the user sees per-tile status in the Active broadcasts list
            // and can stop the wall to roll back).
            const settled = await Promise.allSettled(
              targets.map(t => engine.startBroadcastTo(t.device_id, { wallTile: t.wall_tile }))
            );
            const failures = settled.filter(s => s.status === 'rejected');
            if (failures.length === targets.length) {
              throw new Error(failures[0].reason && failures[0].reason.message || 'all wall members refused');
            }
            if (failures.length > 0) {
              warnLog(`wall broadcast: ${failures.length}/${targets.length} members failed`);
              alert(`Broadcasting to ${targets.length - failures.length} of ${targets.length} wall tiles. Check the Active broadcasts list for which tile failed.`);
            }
          } else {
            await engine.startBroadcastTo(deviceId);
          }
          // First successful broadcast may have triggered capture-on-demand;
          // reflect the preview if it's not already showing.
          rehydratePreviewIfNeeded();
        } catch (err) {
          errLog('start broadcast failed:', err);
          alert(`Could not broadcast to that target:\n${err.message || err}`);
          e.target.checked = false;
        } finally {
          e.target.disabled = false;
        }
      } else {
        if (isWall) {
          const targets = resolveWallTargets(wallId);
          await Promise.allSettled(targets.map(t => engine.stopBroadcastTo(t.device_id)));
        } else {
          await engine.stopBroadcastTo(deviceId);
        }
      }
      refreshSessionList();
    });
  });
}

// Pre-check the boxes for targets the engine is already broadcasting to.
function syncTargetChecksFromEngine() {
  const active = new Set(engine.getActiveTargets());
  document.querySelectorAll('#ss-target-list input[data-device-id]').forEach(cb => {
    cb.checked = active.has(cb.dataset.deviceId);
  });
  // A wall checkbox is "on" only if all its broadcastable members are active.
  document.querySelectorAll('#ss-target-list input[data-wall-id]').forEach(cb => {
    const targets = resolveWallTargets(cb.dataset.wallId);
    cb.checked = targets.length > 0 && targets.every(t => active.has(t.device_id));
  });
}

// If the engine has a live stream but the preview isn't showing it yet
// (broadcast started via capture-on-demand from a checkbox click), attach it.
function rehydratePreviewIfNeeded() {
  if (!activeContainer) return;
  const liveStream = engine.getStream();
  if (!liveStream) return;
  const previewCard = activeContainer.querySelector('#ss-preview-card');
  if (previewCard && previewCard.hidden) {
    const videoEl = activeContainer.querySelector('#ss-preview');
    if (videoEl && !videoEl.srcObject) videoEl.srcObject = liveStream;
    previewCard.hidden = false;
    activeContainer.querySelector('#ss-targets-section').hidden = false;
  }
}

// Sync this view's UI back to the idle state after the engine stops capture
// (browser "Stop sharing" pill, stopAll, or last-peer drop).
function syncCaptureStoppedUI() {
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
  refreshSessionList();
}

// ----------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------
function refreshSessionList() {
  const list = document.getElementById('ss-session-list');
  const section = document.getElementById('ss-sessions-section');
  if (!list || !section) return;
  const states = engine.getTargetStates();
  if (states.size === 0) {
    section.hidden = true;
    list.innerHTML = '';
    // No active broadcast: also collapse the preview/targets if the engine
    // released capture (e.g. last peer stopped from another view / the chip).
    if (!engine.getStream()) syncCaptureStoppedUI();
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
  for (const [deviceId, state] of states) {
    seen.add(deviceId);
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
        engine.stopBroadcastTo(deviceId);
        const cb = document.querySelector(`#ss-target-list input[data-device-id="${cssEscape(deviceId)}"]`);
        if (cb) cb.checked = false;
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
