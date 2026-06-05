/**
 * Smartboard view - controller (admin dashboard / tablet) side. Phase 6.
 *
 * An operator opens this view on a tablet, taps a display to select it,
 * then draws on a full-screen canvas. Strokes are relayed live to the
 * chosen display, which renders them on a fullscreen whiteboard overlay.
 *
 * Architecture (reuses the EXISTING /dashboard -> /device relay, same as
 * remote-touch / screen-share — NO new Socket.IO namespace):
 *
 *   Controller emits on the shared /dashboard socket:
 *     - 'dashboard:wb-start'  { device_id }
 *     - 'dashboard:wb-stroke' { device_id, stroke:{ points:[{x,y}], color, size, tool } }
 *     - 'dashboard:wb-clear'  { device_id }
 *     - 'dashboard:wb-undo'   { device_id }
 *     - 'dashboard:wb-stop'   { device_id }
 *   The server permission-checks each via canActOnDevice(...'write') and
 *   relays to the device room as device:wb-show / wb-stroke / wb-clear /
 *   wb-undo / wb-stop.
 *
 * Coordinates are NORMALIZED 0..1 over the canvas (x = px/canvas.width,
 * y = py/canvas.height) so the display can scale to its own resolution.
 *
 * Drawing is local-immediate (smooth quadratic-midpoint curves on Canvas
 * 2D) and incrementally streamed: during a pointer drag we flush a batch of
 * collected points to the display every ~50ms (and a final flush on pointer
 * up) so the display stays in sync without flooding the socket.
 *
 * The router calls cleanup()/unmount() on nav-away; we detach all listeners
 * and emit wb-stop so the display's overlay is hidden when the operator
 * leaves the view.
 */

import { getSocket } from '../socket.js';

// ----------------------------------------------------------------------
// Self-contained API helper - intentionally does NOT import from api.js so
// this view ships as a single drop-in (mirrors screen-share.js). Uses the
// same JWT bearer pattern as the rest of the dashboard.
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

function listDevices() {
  return apiGet('/api/devices');
}

// ----------------------------------------------------------------------
// Tools / defaults
// ----------------------------------------------------------------------
const TOOLS = ['pen', 'highlighter', 'eraser'];
const COLORS = ['#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];
const DEFAULT_COLOR = '#111827';
const DEFAULT_SIZE = 6;
const STROKE_FLUSH_MS = 50;   // batch incremental stroke points during a drag
const ERASER_BG = '#ffffff';  // board background; eraser paints with this color

// ----------------------------------------------------------------------
// State (scoped per mount). resetState() runs at the top of every render()
// so re-entering the route never inherits a zombie session.
// ----------------------------------------------------------------------
let activeContainer = null;
let selectedDeviceId = null;

let canvas = null;
let ctx = null;

let currentTool = 'pen';
let currentColor = DEFAULT_COLOR;
let currentSize = DEFAULT_SIZE;
let requestedDeviceId = null;

// Drawing state for the in-progress stroke.
let drawing = false;
let activePointerId = null;
let activeStrokeId = null;
let strokePoints = [];        // ALL points of the in-progress stroke (normalized 0..1)
let pendingPoints = [];       // points collected since the last flush (normalized 0..1)
let pendingPhase = 'append';
let flushTimer = null;

// Local undo stack: each entry is a completed stroke {points, color, size, tool}.
let strokeHistory = [];

// Bound handlers (kept so we can detach on cleanup).
let boundResize = null;
let boundPointerDown = null;
let boundPointerMove = null;
let boundPointerUp = null;

function resetState() {
  detachCanvasListeners();
  clearFlushTimer();
  selectedDeviceId = null;
  canvas = null;
  ctx = null;
  currentTool = 'pen';
  currentColor = DEFAULT_COLOR;
  currentSize = DEFAULT_SIZE;
  requestedDeviceId = null;
  drawing = false;
  activePointerId = null;
  activeStrokeId = null;
  strokePoints = [];
  pendingPoints = [];
  pendingPhase = 'append';
  strokeHistory = [];
}

// ----------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------
export function render(container) {
  resetState();
  activeContainer = container;
  requestedDeviceId = deviceIdFromHash();
  renderPicker();
}

// The router invokes cleanup() (older views) AND unmount() (resource-holding
// views). We implement both as the same teardown so whichever the router
// calls, the in-progress session is stopped and listeners detached.
export function cleanup() {
  teardown();
}

export function unmount() {
  teardown();
}

function teardown() {
  // If a session is live, tell the display to hide its overlay.
  if (selectedDeviceId) {
    emitWb('dashboard:wb-stop', { device_id: selectedDeviceId });
  }
  detachCanvasListeners();
  clearFlushTimer();
  activeContainer = null;
  selectedDeviceId = null;
  canvas = null;
  ctx = null;
  drawing = false;
  activePointerId = null;
  strokePoints = [];
  pendingPoints = [];
  strokeHistory = [];
}

// ----------------------------------------------------------------------
// Socket emit helper - fire-and-forget on the shared dashboard socket.
// ----------------------------------------------------------------------
function emitWb(event, payload) {
  const sock = getSocket();
  if (sock && sock.connected) {
    sock.emit(event, payload);
  }
}

function emitWbAck(event, payload, timeoutMs = 5000) {
  const sock = getSocket();
  if (!sock || !sock.connected) return Promise.resolve({ ok: false, error: 'socket_disconnected' });
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    sock.emit(event, payload, (ack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ack || { ok: true });
    });
  });
}

// ----------------------------------------------------------------------
// Step 1: display picker
// ----------------------------------------------------------------------
async function renderPicker() {
  if (!activeContainer) return;
  activeContainer.innerHTML = `
    <div class="view-smartboard sb-picker">
      <header class="view-header">
        <h1>Smartboard</h1>
        <p class="muted">Pick a display to start a live whiteboard. Draw on this tablet and it appears on the chosen display in real time.</p>
      </header>
      <section class="sb-display-list" id="sb-display-list">
        <div class="muted">Loading displays&hellip;</div>
      </section>
    </div>
  `;

  const listEl = activeContainer.querySelector('#sb-display-list');
  if (!listEl) return;
  try {
    const devices = await listDevices();
    if (!activeContainer) return; // unmounted mid-fetch
    if (!Array.isArray(devices) || devices.length === 0) {
      listEl.innerHTML = '<div class="muted">No paired displays in this workspace yet. Pair a display under Displays.</div>';
      return;
    }
    listEl.innerHTML = devices.map((d) => {
      const online = d.status === 'online';
      return `
        <button class="sb-display-card" data-device-id="${escapeHtml(d.id)}" ${online ? '' : 'disabled'}>
          <span class="sb-display-name">${escapeHtml(d.name || 'Unnamed display')}</span>
          <span class="sb-display-status">
            <span class="status-dot ${online ? 'online' : 'offline'}"></span>
            ${escapeHtml(d.status || 'unknown')}
          </span>
        </button>
      `;
    }).join('');

    listEl.querySelectorAll('.sb-display-card[data-device-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deviceId;
        if (id) selectDisplay(id);
      });
    });
    if (requestedDeviceId) {
      const target = devices.find(d => d.id === requestedDeviceId && d.status === 'online');
      requestedDeviceId = null;
      if (target) selectDisplay(target.id);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="muted">Could not load displays: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function selectDisplay(deviceId) {
  selectedDeviceId = deviceId;
  // Tell the display to show its whiteboard overlay and load persisted strokes.
  const ack = await emitWbAck('dashboard:wb-start', { device_id: deviceId });
  strokeHistory = Array.isArray(ack?.strokes) ? ack.strokes : [];
  renderBoard();
}

// ----------------------------------------------------------------------
// Step 2: drawing board + toolbar
// ----------------------------------------------------------------------
function renderBoard() {
  if (!activeContainer) return;
  activeContainer.innerHTML = `
    <div class="view-smartboard sb-board">
      <div class="sb-toolbar" id="sb-toolbar">
        <div class="sb-tool-group" role="group" aria-label="Tools">
          <button class="sb-tool" data-tool="pen" title="Pen" aria-pressed="true">Pen</button>
          <button class="sb-tool" data-tool="highlighter" title="Highlighter" aria-pressed="false">Highlighter</button>
          <button class="sb-tool" data-tool="eraser" title="Eraser" aria-pressed="false">Eraser</button>
        </div>
        <div class="sb-swatches" id="sb-swatches" role="group" aria-label="Colors">
          ${COLORS.map((c) => `<button class="sb-swatch" data-color="${escapeHtml(c)}" title="${escapeHtml(c)}" style="background:${escapeHtml(c)}"></button>`).join('')}
        </div>
        <label class="sb-size">
          <span>Size</span>
          <input type="range" id="sb-size" min="1" max="48" value="${currentSize}">
        </label>
        <div class="sb-tool-group sb-actions">
          <button class="sb-btn" id="sb-undo" title="Undo">Undo</button>
          <button class="sb-btn" id="sb-clear" title="Clear">Clear</button>
          <button class="sb-btn sb-btn-danger" id="sb-stop" title="Stop session">Stop</button>
        </div>
      </div>
      <div class="sb-canvas-wrap" id="sb-canvas-wrap">
        <canvas id="sb-canvas"></canvas>
      </div>
    </div>
  `;

  canvas = activeContainer.querySelector('#sb-canvas');
  ctx = canvas ? canvas.getContext('2d') : null;
  if (!canvas || !ctx) return;

  // Disable browser touch gestures (scroll/zoom) over the canvas so a finger
  // drag draws instead of panning the page.
  canvas.style.touchAction = 'none';

  sizeCanvasToWrap();

  // Toolbar wiring.
  activeContainer.querySelectorAll('.sb-tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  activeContainer.querySelectorAll('.sb-swatch[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => setColor(btn.dataset.color));
  });
  const sizeEl = activeContainer.querySelector('#sb-size');
  if (sizeEl) sizeEl.addEventListener('input', (e) => { currentSize = Number(e.target.value) || DEFAULT_SIZE; });
  activeContainer.querySelector('#sb-undo')?.addEventListener('click', undo);
  activeContainer.querySelector('#sb-clear')?.addEventListener('click', clearBoard);
  activeContainer.querySelector('#sb-stop')?.addEventListener('click', stopSession);

  setTool(currentTool);
  setColor(currentColor);

  // Canvas pointer + resize listeners (stored bound refs for clean detach).
  attachCanvasListeners();
}

function sizeCanvasToWrap() {
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  // Preserve already-drawn strokes across a resize by repainting from history.
  canvas.width = w;
  canvas.height = h;
  repaintFromHistory();
}

function attachCanvasListeners() {
  boundResize = () => sizeCanvasToWrap();
  boundPointerDown = onPointerDown;
  boundPointerMove = onPointerMove;
  boundPointerUp = onPointerUp;

  window.addEventListener('resize', boundResize);
  canvas.addEventListener('pointerdown', boundPointerDown);
  canvas.addEventListener('pointermove', boundPointerMove);
  canvas.addEventListener('pointerup', boundPointerUp);
  canvas.addEventListener('pointercancel', boundPointerUp);
  canvas.addEventListener('pointerleave', boundPointerUp);
}

function detachCanvasListeners() {
  if (boundResize) window.removeEventListener('resize', boundResize);
  if (canvas) {
    if (boundPointerDown) canvas.removeEventListener('pointerdown', boundPointerDown);
    if (boundPointerMove) canvas.removeEventListener('pointermove', boundPointerMove);
    if (boundPointerUp) {
      canvas.removeEventListener('pointerup', boundPointerUp);
      canvas.removeEventListener('pointercancel', boundPointerUp);
      canvas.removeEventListener('pointerleave', boundPointerUp);
    }
  }
  boundResize = null;
  boundPointerDown = null;
  boundPointerMove = null;
  boundPointerUp = null;
}

// ----------------------------------------------------------------------
// Toolbar handlers
// ----------------------------------------------------------------------
function setTool(tool) {
  if (!TOOLS.includes(tool)) return;
  currentTool = tool;
  if (!activeContainer) return;
  activeContainer.querySelectorAll('.sb-tool[data-tool]').forEach((btn) => {
    const active = btn.dataset.tool === tool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setColor(color) {
  currentColor = color;
  if (!activeContainer) return;
  activeContainer.querySelectorAll('.sb-swatch[data-color]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

// ----------------------------------------------------------------------
// Pointer drawing
// ----------------------------------------------------------------------
function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  // Normalize to 0..1 over the canvas backing-store size. rect.width/height
  // match canvas.width/height because we size the canvas to its wrapper 1:1.
  return {
    x: clamp01(px / (rect.width || 1)),
    y: clamp01(py / (rect.height || 1)),
  };
}

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function onPointerDown(e) {
  if (drawing) return;
  drawing = true;
  activePointerId = e.pointerId;
  activeStrokeId = 'wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  const p = pointFromEvent(e);
  strokePoints = [p];
  pendingPoints = [p];
  pendingPhase = 'begin';
  // Render the initial dot immediately so a tap leaves a mark.
  drawStrokeSegment([p]);
  scheduleFlush();
  e.preventDefault();
}

function onPointerMove(e) {
  if (!drawing || e.pointerId !== activePointerId) return;
  const p = pointFromEvent(e);
  strokePoints.push(p);
  pendingPoints.push(p);
  // Draw locally from the tail of the full stroke for a smooth curve.
  drawStrokeSegment(strokePoints);
  scheduleFlush();
  e.preventDefault();
}

function onPointerUp(e) {
  if (!drawing || (e.pointerId != null && e.pointerId !== activePointerId)) return;
  drawing = false;
  try { canvas.releasePointerCapture(activePointerId); } catch (_) { /* ignore */ }
  activePointerId = null;

  // Final flush of any remaining points so the display matches exactly.
  clearFlushTimer();
  pendingPhase = 'end';
  flushPending();

  // Commit the completed stroke to local undo history.
  if (strokePoints.length > 0) {
    strokeHistory.push({
      points: strokePoints.slice(),
      color: currentColor,
      size: currentSize,
      tool: currentTool,
    });
  }
  activeStrokeId = null;
  strokePoints = [];
  pendingPoints = [];
  pendingPhase = 'append';
}

// Render the in-progress stroke locally using quadratic-midpoint smoothing.
// Repaints the whole canvas from history + the live stroke so highlighter
// transparency composites correctly without doubling alpha on overlap.
function drawStrokeSegment(points) {
  if (!ctx || points.length === 0) return;
  repaintFromHistory();
  drawStroke(ctx, { points, color: currentColor, size: currentSize, tool: currentTool });
}

// Repaint the board from the committed stroke history (white background +
// every stored stroke). Used after resize, undo, and live-stroke previews.
function repaintFromHistory() {
  if (!ctx || !canvas) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = ERASER_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  for (const s of strokeHistory) drawStroke(ctx, s);
}

// Draw one stroke onto a 2D context. Coordinates in the stroke are NORMALIZED
// 0..1 and scaled by the context's canvas width/height here. Tools:
//   pen         - solid opaque stroke
//   highlighter - semi-transparent, wider
//   eraser      - paints the background color (board has an opaque bg)
function drawStroke(c, stroke) {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  const W = c.canvas.width;
  const H = c.canvas.height;

  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.globalCompositeOperation = 'source-over';

  if (stroke.tool === 'highlighter') {
    c.strokeStyle = stroke.color;
    c.globalAlpha = 0.35;
    c.lineWidth = stroke.size * 2.5;
  } else if (stroke.tool === 'eraser') {
    c.strokeStyle = ERASER_BG;
    c.globalAlpha = 1;
    c.lineWidth = stroke.size * 2.5;
  } else { // pen
    c.strokeStyle = stroke.color;
    c.globalAlpha = 1;
    c.lineWidth = stroke.size;
  }

  // Single point -> dot.
  if (pts.length === 1) {
    c.beginPath();
    c.fillStyle = c.strokeStyle;
    c.globalAlpha = stroke.tool === 'highlighter' ? 0.35 : 1;
    c.arc(pts[0].x * W, pts[0].y * H, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    c.restore();
    return;
  }

  // Smooth path via quadratic curves through midpoints.
  c.beginPath();
  c.moveTo(pts[0].x * W, pts[0].y * H);
  for (let i = 1; i < pts.length - 1; i++) {
    const cx = pts[i].x * W;
    const cy = pts[i].y * H;
    const mx = (pts[i].x + pts[i + 1].x) / 2 * W;
    const my = (pts[i].y + pts[i + 1].y) / 2 * H;
    c.quadraticCurveTo(cx, cy, mx, my);
  }
  const last = pts[pts.length - 1];
  c.lineTo(last.x * W, last.y * H);
  c.stroke();
  c.restore();
}

// ----------------------------------------------------------------------
// Stroke streaming (throttled). We send the pending batch of points every
// ~50ms during a drag, and a final batch on pointer up. Each emitted stroke
// carries only the new points since the last flush; the display appends them
// to its own in-progress path (overlap of one point keeps the line joined).
// ----------------------------------------------------------------------
function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, STROKE_FLUSH_MS);
}

function clearFlushTimer() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function flushPending() {
  if (!selectedDeviceId || pendingPoints.length === 0) return;
  const batch = pendingPoints;
  pendingPoints = [];
  emitWb('dashboard:wb-stroke', {
    device_id: selectedDeviceId,
    stroke: {
      points: batch,
      color: currentColor,
      size: currentSize,
      tool: currentTool,
      stroke_id: activeStrokeId,
      phase: pendingPhase,
    },
  });
  pendingPhase = 'append';
}

// ----------------------------------------------------------------------
// Clear / Undo / Stop
// ----------------------------------------------------------------------
function clearBoard() {
  strokeHistory = [];
  repaintFromHistory();
  emitWb('dashboard:wb-clear', { device_id: selectedDeviceId });
}

function undo() {
  if (strokeHistory.length > 0) strokeHistory.pop();
  repaintFromHistory();
  emitWb('dashboard:wb-undo', { device_id: selectedDeviceId });
}

function stopSession() {
  emitWb('dashboard:wb-stop', { device_id: selectedDeviceId });
  detachCanvasListeners();
  clearFlushTimer();
  selectedDeviceId = null;
  canvas = null;
  ctx = null;
  drawing = false;
  activePointerId = null;
  strokePoints = [];
  pendingPoints = [];
  strokeHistory = [];
  renderPicker();
}

function deviceIdFromHash() {
  const hash = window.location.hash || '';
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  if (!q) return null;
  try { return new URLSearchParams(q).get('device') || null; } catch { return null; }
}

// ----------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
