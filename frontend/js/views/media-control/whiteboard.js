// whiteboard.js — Command Center whiteboard surface. Self-contained component
// mountable over the Media Control canvas (a transparent, full-stage overlay).
//
// Architecture mirrors views/smartboard.js (the legacy tablet controller): the
// operator draws on a local <canvas> and streams normalized 0..1 strokes over
// the shared /dashboard socket ('dashboard:wb-*'); the server permission-checks
// + relays them to the target's /device room, where the player renders them on
// its fullscreen overlay. This module is ADDITIVE — smartboard.js is untouched.
//
// New strokes this module can originate (all persisted by the server; all
// rendered by the player):
//   - pen / highlighter / eraser  (original, free ink, streamed per-phase)
//   - text                         (one anchor + string payload)
//   - line / rect / ellipse        (start+end corner, drag to preview)
//
// The redo stack lives SERVER-side (services/whiteboard-state.js), bounded to
// 50 entries per (workspace, device). Undo is a single-stroke pop; redo pops the
// redo stack back onto the session. Local history is a mirror used only for the
// local redraw on this surface.
//
// mount(containerEl, options) -> { unmount, setTarget }
//   options.onStatus(message)        optional status line callback
//   options.plan                    optional map of feature flags (overrides)
//   options.initialTarget           optional target passed straight to setTarget

import { getSocket } from '../../socket.js';
import { t } from '../../i18n.js';
import { esc } from '../../utils.js';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------
const TOOLS = ['pen', 'highlighter', 'eraser', 'text', 'line', 'rect', 'ellipse'];
const INK_TOOLS = ['pen', 'highlighter', 'eraser'];
const SHAPE_TOOLS = ['line', 'rect', 'ellipse'];
const COLORS = ['#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#f43f5e'];
const DEFAULT_COLOR = '#111827';
const DEFAULT_SIZE = 6;
const STROKE_FLUSH_MS = 50;
const WHITE_BG = '#ffffff';

// Honest capability matrix. PDF + background import are NOT feasible without a
// new dependency / a server storage table that is out of scope for this pass,
// so they ship as DISABLED "coming soon". Everything else is genuinely wired.
const PLAN_DEFAULTS = {
  pdf: false,
  background: false,
};

function toolLabel(tool) {
  return t('mc.wb.tool.' + tool);
}

// ----------------------------------------------------------------------
// mount() — the only public entrypoint
// ----------------------------------------------------------------------
export function mount(containerEl, options) {
  const opts = options || {};
  const plan = Object.assign({}, PLAN_DEFAULTS, opts.plan || {});
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const host = containerEl || document.body;

  // Target envelope. setTarget() is the public seam the Command Center uses:
  //   { target_type:'display'|'wall'|'split', target_id, wall_id, split_device_id, label }
  let target = normalizeTarget(opts.initialTarget) || null;
  // Broadcast scope derived from what the target offers.
  let scope = 'display';

  // Local redraw mirror of committed strokes (server is the source of truth).
  let strokes = [];
  let currentTool = 'pen';
  let currentColor = DEFAULT_COLOR;
  let currentSize = DEFAULT_SIZE;

  // Drawing state.
  let canvas = null, ctx = null, wrap = null;
  let drawing = false;
  let activePointerId = null;
  let activeStrokeId = null;
  let strokePoints = [];
  let pendingPoints = [];
  let pendingPhase = 'append';
  let flushTimer = null;
  // Effective size for the in-progress stroke (slider value, possibly reduced
  // by pen pressure). Kept separate from currentSize so the slider value the
  // operator sees isn't silently mutated mid-stroke.
  let activeSize = DEFAULT_SIZE;

  // Bound listeners (so unmount can detach everything).
  const bound = {};
  let textInput = null;

  renderOverlay();

  return { unmount, setTarget };

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  function setTarget(t) {
    target = normalizeTarget(t);
    scope = pickDefaultScope(target);
    refreshScopeDropdown();
    status(keyFor('status_ready'));
  }

  function unmount() {
    // Tell the target to hide its overlay so the board doesn't linger on the
    // display after the operator closes it here.
    broadcast('dashboard:wb-stop', {});
    detachAll();
    clearFlush();
    if (textInput) { textInput.remove(); textInput = null; }
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    wrap = null; canvas = null; ctx = null;
    strokes = [];
  }

  // ------------------------------------------------------------------
  // Overlay markup
  // ------------------------------------------------------------------
  function renderOverlay() {
    wrap = document.createElement('div');
    wrap.className = 'mc-wb-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', esc(t('mc.wb.title')));
    wrap.innerHTML = `
      <div class="mc-wb-panel">
        <header class="mc-wb-bar">
          <h2 class="mc-wb-title">${esc(t('mc.wb.title'))}</h2>
          <div class="mc-wb-tools" role="group" aria-label="${esc(t('mc.wb.tools'))}">
            <button type="button" class="mc-wb-tool" data-tool="pen"      aria-pressed="true">${esc(toolLabel('pen'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="highlighter">${esc(toolLabel('highlighter'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="eraser">${esc(toolLabel('eraser'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="text">${esc(toolLabel('text'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="line">${esc(toolLabel('line'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="rect">${esc(toolLabel('rect'))}</button>
            <button type="button" class="mc-wb-tool" data-tool="ellipse">${esc(toolLabel('ellipse'))}</button>
          </div>
          <div class="mc-wb-swatches" role="group" aria-label="${esc(t('mc.wb.color'))}">
            ${COLORS.map(c => `<button type="button" class="mc-wb-swatch" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="${esc(c)}"></button>`).join('')}
            <label class="mc-wb-hex">
              <span>${esc(t('mc.wb.color_hex'))}</span>
              <input type="text" id="mc-wb-hex" value="${esc(currentColor)}" maxlength="9" spellcheck="false" />
            </label>
          </div>
          <label class="mc-wb-size">
            <span>${esc(t('mc.wb.size'))}</span>
            <input type="range" id="mc-wb-size" min="1" max="96" value="${currentSize}" />
          </label>
          <div class="mc-wb-actions" role="group" aria-label="${esc(t('mc.wb.actions'))}">
            <button type="button" class="mc-wb-btn" id="mc-wb-undo" title="${esc(t('mc.wb.undo'))}">${esc(t('mc.wb.undo'))}</button>
            <button type="button" class="mc-wb-btn" id="mc-wb-redo" title="${esc(t('mc.wb.redo'))}">${esc(t('mc.wb.redo'))}</button>
            <button type="button" class="mc-wb-btn" id="mc-wb-clear" title="${esc(t('mc.wb.clear'))}">${esc(t('mc.wb.clear'))}</button>
            <button type="button" class="mc-wb-btn" id="mc-wb-png" title="${esc(t('mc.wb.export_png'))}">${esc(t('mc.wb.export_png'))}</button>
            <button type="button" class="mc-wb-btn mc-wb-coming" disabled aria-disabled="true"
              title="${esc(t('mc.wb.coming_soon'))}" id="mc-wb-pdf">${esc(t('mc.wb.export_pdf'))}</button>
            <button type="button" class="mc-wb-btn mc-wb-coming" disabled aria-disabled="true"
              title="${esc(t('mc.wb.coming_soon'))}" id="mc-wb-bg">${esc(t('mc.wb.background'))}</button>
            <button type="button" class="mc-wb-btn mc-wb-close" id="mc-wb-close" title="${esc(t('mc.wb.close'))}">${esc(t('mc.wb.close'))}</button>
          </div>
        </header>
        <div class="mc-wb-scope">
          <label for="mc-wb-scope-select">${esc(t('mc.wb.scope'))}</label>
          <select id="mc-wb-scope-select" class="mc-wb-select">
            <option value="display">${esc(t('mc.wb.scope_display'))}</option>
            <option value="wall" hidden>${esc(t('mc.wb.scope_wall'))}</option>
            <option value="split" hidden>${esc(t('mc.wb.scope_split'))}</option>
          </select>
          <span class="mc-wb-target-name" id="mc-wb-target-name">${esc((target && target.label) || t('mc.wb.status_no_target'))}</span>
        </div>
        <div class="mc-wb-canvas-wrap" id="mc-wb-canvas-wrap">
          <canvas id="mc-wb-canvas" tabindex="0"></canvas>
        </div>
      </div>`;

    host.appendChild(wrap);

    canvas = wrap.querySelector('#mc-wb-canvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) { status(keyFor('status_error')); return; }
    canvas.style.touchAction = 'none';

    wireToolbar();
    sizeCanvas();
    attachAll();
    setTool(currentTool);
    setColor(currentColor);
    refreshScopeDropdown();

    // Seed from the server if we already have a target. Best-effort: a missing
    // target shows an empty board with a status hint.
    startSessionFromTarget();
  }

  function wireToolbar() {
    wrap.querySelectorAll('.mc-wb-tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    wrap.querySelectorAll('.mc-wb-swatch[data-color]').forEach(btn => {
      btn.addEventListener('click', () => setColor(btn.dataset.color));
    });
    const hexEl = wrap.querySelector('#mc-wb-hex');
    if (hexEl) hexEl.addEventListener('change', () => setColor(hexEl.value));
    const sizeEl = wrap.querySelector('#mc-wb-size');
    if (sizeEl) sizeEl.addEventListener('input', (e) => { currentSize = Number(e.target.value) || DEFAULT_SIZE; });
    wrap.querySelector('#mc-wb-undo')?.addEventListener('click', undo);
    wrap.querySelector('#mc-wb-redo')?.addEventListener('click', redo);
    wrap.querySelector('#mc-wb-clear')?.addEventListener('click', clearBoard);
    wrap.querySelector('#mc-wb-png')?.addEventListener('click', exportPng);
    wrap.querySelector('#mc-wb-close')?.addEventListener('click', unmount);
    const scopeSel = wrap.querySelector('#mc-wb-scope-select');
    if (scopeSel) scopeSel.addEventListener('change', () => { scope = scopeSel.value; status(keyFor('status_ready')); });
  }

  // ------------------------------------------------------------------
  // Target / scope
  // ------------------------------------------------------------------
  function normalizeTarget(t) {
    if (!t || !t.target_id) return null;
    return {
      target_type: t.target_type || 'display',
      target_id: String(t.target_id),
      wall_id: t.wall_id ? String(t.wall_id) : null,
      split_device_id: t.split_device_id ? String(t.split_device_id) : null,
      label: t.label || t.target_id,
    };
  }

  function pickDefaultScope(tg) {
    if (!tg) return 'display';
    if (tg.split_device_id) return 'split';
    if (tg.wall_id) return 'wall';
    return 'display';
  }

  function refreshScopeDropdown() {
    const sel = wrap && wrap.querySelector('#mc-wb-scope-select');
    const nameEl = wrap && wrap.querySelector('#mc-wb-target-name');
    if (nameEl) nameEl.textContent = (target && target.label) || t('mc.wb.status_no_target');
    if (!sel) return;
    const wallOpt = sel.querySelector('option[value="wall"]');
    const splitOpt = sel.querySelector('option[value="split"]');
    if (wallOpt) wallOpt.hidden = !target || !target.wall_id;
    if (splitOpt) splitOpt.hidden = !target || !target.split_device_id;
    sel.value = scope;
    sel.disabled = !target;
  }

  // Envelope stamped onto every wb-* emission, derived from the active scope.
  function envelope() {
    if (!target) return {};
    const base = { device_id: target.target_id };
    if (scope === 'wall' && target.wall_id) return Object.assign(base, { wall_id: target.wall_id });
    if (scope === 'split' && target.split_device_id) return Object.assign(base, { split_device_id: target.split_device_id });
    return base;
  }

  async function startSessionFromTarget() {
    if (!target) { status(keyFor('status_no_target')); return; }
    try {
      const ack = await emitAck('dashboard:wb-start', Object.assign({}, envelope()));
      if (Array.isArray(ack && ack.strokes)) {
        strokes = ack.strokes.slice();
        repaint();
      }
      status(keyFor('status_ready'));
    } catch {
      status(keyFor('status_error'));
    }
  }

  // ------------------------------------------------------------------
  // Socket emit helpers
  // ------------------------------------------------------------------
  function getIo() { return getSocket(); }

  function broadcast(event, payload) {
    const sock = getIo();
    if (!sock || !sock.connected) return;
    if (!target) return;
    // Scope filters: split scope MUST reach only its member device; wall scope
    // reaches every member via the server's fan-out. We always stamp device_id
    // (the persistence/permission primary) plus the scope id.
    const env = envelope();
    sock.emit(event, Object.assign({}, payload, env));
  }

  function emitAck(event, payload, timeoutMs) {
    return new Promise((resolve) => {
      const sock = getIo();
      if (!sock || !sock.connected) return resolve({ ok: false, error: 'socket_disconnected' });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'timeout' }); } }, timeoutMs || 5000);
      sock.emit(event, payload, (ack) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ack || { ok: true });
      });
    });
  }

  // ------------------------------------------------------------------
  // Toolbar handlers
  // ------------------------------------------------------------------
  function setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    currentTool = tool;
    wrap.querySelectorAll('.mc-wb-tool[data-tool]').forEach(btn => {
      const active = btn.dataset.tool === tool;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    // Text input mode is special: the canvas cursor is a text caret, no ink.
    if (canvas) canvas.style.cursor = (tool === 'text') ? 'text' : 'crosshair';
  }

  function setColor(color) {
    const c = typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : DEFAULT_COLOR;
    currentColor = c;
    wrap.querySelectorAll('.mc-wb-swatch[data-color]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === c);
    });
    const hexEl = wrap.querySelector('#mc-wb-hex');
    if (hexEl && hexEl.value !== c) hexEl.value = c;
  }

  // ------------------------------------------------------------------
  // Canvas sizing + repaint
  // ------------------------------------------------------------------
  function sizeCanvas() {
    if (!canvas) return;
    const box = canvas.parentElement;
    if (!box) return;
    const r = box.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width));
    canvas.height = Math.max(1, Math.floor(r.height));
    repaint();
  }

  function repaint() {
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = WHITE_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    for (const s of strokes) drawStroke(ctx, s);
    // Live in-progress ink preview is drawn by drawStrokeSegment() right after
    // this; shapes preview themselves on pointermove. Nothing to do here.
  }

  // Draw one committed stroke. Points normalized 0..1 → scaled to this canvas.
  function drawStroke(c, s) {
    if (!s || !Array.isArray(s.points) || s.points.length === 0) return;
    const W = c.canvas.width, H = c.canvas.height;
    const px = (p) => (Number(p && p.x) || 0) * W;
    const py = (p) => (Number(p && p.y) || 0) * H;
    const color = s.color || currentColor;
    const size = Number(s.size) > 0 ? Number(s.size) : DEFAULT_SIZE;

    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';

    if (s.tool === 'text') {
      const fam = s.font === 'serif' ? 'serif' : s.font === 'mono' ? 'monospace' : 'sans-serif';
      c.fillStyle = color;
      c.textBaseline = 'top';
      c.font = String(size) + 'px ' + fam;
      const lines = String(s.text || '').split(/\r\n|\r|\n/);
      for (let k = 0; k < lines.length; k++) c.fillText(lines[k], px(s.points[0]), py(s.points[0]) + k * size * 1.15);
      c.restore();
      return;
    }
    if (SHAPE_TOOLS.includes(s.tool)) {
      c.strokeStyle = color;
      c.lineWidth = size;
      const a = s.points[0], b = s.points[s.points.length - 1];
      const x0 = px(a), y0 = py(a), x1 = px(b), y1 = py(b);
      c.beginPath();
      if (s.tool === 'line') { c.moveTo(x0, y0); c.lineTo(x1, y1); }
      else if (s.tool === 'rect') { c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); }
      else { c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, Math.abs(x1 - x0) / 2), Math.max(0.5, Math.abs(y1 - y0) / 2), 0, 0, Math.PI * 2); }
      c.stroke();
      c.restore();
      return;
    }

    const tool = s.tool === 'highlighter' || s.tool === 'eraser' ? s.tool : 'pen';
    if (tool === 'eraser') {
      c.strokeStyle = WHITE_BG; c.globalAlpha = 1; c.lineWidth = size * 2.5;
    } else if (tool === 'highlighter') {
      c.strokeStyle = color; c.globalAlpha = 0.35; c.lineWidth = size * 2.5;
    } else {
      c.strokeStyle = color; c.globalAlpha = 1; c.lineWidth = size;
    }
    const pts = s.points;
    if (pts.length === 1) {
      c.beginPath();
      c.fillStyle = tool === 'eraser' ? WHITE_BG : color;
      c.globalAlpha = tool === 'highlighter' ? 0.35 : 1;
      c.arc(px(pts[0]), py(pts[0]), Math.max(0.5, c.lineWidth / 2), 0, Math.PI * 2);
      c.fill();
      c.restore();
      return;
    }
    c.beginPath();
    c.moveTo(px(pts[0]), py(pts[0]));
    for (let i = 1; i < pts.length - 1; i++) {
      const cx = px(pts[i]), cy = py(pts[i]);
      const mx = (cx + px(pts[i + 1])) / 2, my = (cy + py(pts[i + 1])) / 2;
      c.quadraticCurveTo(cx, cy, mx, my);
    }
    const last = pts[pts.length - 1];
    c.lineTo(px(last), py(last));
    c.stroke();
    c.restore();
  }

  // ------------------------------------------------------------------
  // Pointer drawing
  // ------------------------------------------------------------------
  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / (r.width || 1)),
      y: clamp01((e.clientY - r.top) / (r.height || 1)),
    };
  }

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  // Pressure-aware width when the platform reports it (stylus-podium). Absent
  // → full size. Only applied to ink tools; shapes/text ignore pressure.
  function pressureSize(e) {
    if (!INK_TOOLS.includes(currentTool)) return currentSize;
    if (e && typeof e.pressure === 'number' && e.pressure > 0 && e.pressure < 1) {
      return Math.max(1, Math.round(currentSize * (0.35 + 0.65 * e.pressure)));
    }
    return currentSize;
  }

  function onPointerDown(e) {
    if (drawing) return;
    if (!target) { status(keyFor('status_no_target')); return; }
    if (currentTool === 'text') { beginText(e); e.preventDefault(); return; }
    if (SHAPE_TOOLS.includes(currentTool)) { beginShape(e); e.preventDefault(); return; }

    drawing = true;
    activePointerId = e.pointerId;
    activeStrokeId = 'mc-wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = pointFromEvent(e);
    strokePoints = [p];
    pendingPoints = [p];
    pendingPhase = 'begin';
    activeSize = pressureSize(e);
    drawStrokeSegment([p]);
    scheduleFlush();
    e.preventDefault();
    status(keyFor('status_drawing'));
  }

  function onPointerMove(e) {
    if (!drawing || e.pointerId !== activePointerId) return;
    const p = pointFromEvent(e);
    strokePoints.push(p);

    if (SHAPE_TOOLS.includes(currentTool)) {
      // Shape: live preview from start→current, no per-phase streaming (one
      // commit on pointer-up).
      repaint();
      drawStroke(ctx, { points: [strokePoints[0], p], color: currentColor, size: activeSize, tool: currentTool });
      return;
    }

    pendingPoints.push(p);
    drawStrokeSegment(strokePoints);
    scheduleFlush();
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!drawing || (e.pointerId != null && e.pointerId !== activePointerId)) return;
    drawing = false;
    try { canvas.releasePointerCapture(activePointerId); } catch { /* ignore */ }
    activePointerId = null;

    if (SHAPE_TOOLS.includes(currentTool)) {
      commitShape();
      activeStrokeId = null;
      strokePoints = [];
      return;
    }

    clearFlush();
    pendingPhase = 'end';
    flushPending();
    if (strokePoints.length > 0) {
      strokes.push({ points: strokePoints.slice(), color: currentColor, size: activeSize, tool: currentTool });
    }
    activeStrokeId = null;
    strokePoints = [];
    pendingPoints = [];
    pendingPhase = 'append';
    status(keyFor('status_ready'));
  }

  function drawStrokeSegment(points) {
    repaint();
    drawStroke(ctx, { points, color: currentColor, size: activeSize, tool: currentTool });
  }

  // ------------------------------------------------------------------
  // Shape commit (single stroke with start+end corner)
  // ------------------------------------------------------------------
  function beginShape(e) {
    drawing = true;
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    strokePoints = [pointFromEvent(e)];
    activeSize = currentSize; // shapes ignore pressure
  }

  function commitShape() {
    if (strokePoints.length < 2) { repaint(); return; }
    const stroke = {
      points: [strokePoints[0], strokePoints[strokePoints.length - 1]],
      color: currentColor,
      size: activeSize,
      tool: currentTool,
      stroke_id: 'mc-wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      phase: 'end',
    };
    strokes.push(stroke);
    broadcast('dashboard:wb-stroke', envelopeStroke(stroke));
    repaint();
  }

  // ------------------------------------------------------------------
  // Text placement (positioned <textarea> overlay → commit a text stroke)
  // ------------------------------------------------------------------
  function beginText(e) {
    if (textInput) { commitText(); }
    const r = canvas.getBoundingClientRect();
    const left = e.clientX - r.left + canvas.offsetLeft;
    const top = e.clientY - r.top + canvas.offsetTop;
    const ta = document.createElement('textarea');
    ta.className = 'mc-wb-text-input';
    ta.rows = 1;
    ta.style.left = left + 'px';
    ta.style.top = top + 'px';
    ta.style.color = currentColor;
    ta.style.fontSize = Math.max(12, currentSize) + 'px';
    ta.setAttribute('aria-label', esc(t('mc.wb.tool.text')));
    ta.placeholder = esc(t('mc.wb.tool.text'));
    const hostPane = wrap.querySelector('.mc-wb-canvas-wrap');
    (hostPane || wrap).appendChild(ta);
    ta.focus();
    textInput = ta;
    // Commit on blur or Ctrl/Cmd+Enter (ordinary Enter inserts a newline so
    // multi-line text is possible). Escape cancels.
    ta.addEventListener('blur', commitText);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ta.value = ''; commitText(); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commitText(); }
    });
  }

  function commitText() {
    if (!textInput) return;
    const ta = textInput;
    textInput = null;
    const text = (ta.value || '').slice(0, 500);
    const r = canvas.getBoundingClientRect();
    const left = parseFloat(ta.style.left) || 0;
    const top = parseFloat(ta.style.top) || 0;
    ta.remove();
    if (!text) return;
    const p = {
      x: clamp01(left / (r.width || 1)),
      y: clamp01(top / (r.height || 1)),
    };
    const stroke = {
      points: [p],
      text,
      font: 'sans',
      color: currentColor,
      size: Math.max(8, Math.min(200, Math.round(currentSize))),
      tool: 'text',
      stroke_id: 'mc-wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      phase: 'end',
    };
    strokes.push(stroke);
    broadcast('dashboard:wb-stroke', envelopeStroke(stroke));
    repaint();
  }

  // ------------------------------------------------------------------
  // Ink streaming (throttled phase batches)
  // ------------------------------------------------------------------
  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushPending(); }, STROKE_FLUSH_MS);
  }

  function clearFlush() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
  }

  function flushPending() {
    if (!target || pendingPoints.length === 0) return;
    const batch = pendingPoints;
    pendingPoints = [];
    broadcast('dashboard:wb-stroke', envelopeStroke({
      points: batch,
      color: currentColor,
      size: activeSize,
      tool: currentTool,
      stroke_id: activeStrokeId,
      phase: pendingPhase,
    }));
    pendingPhase = 'append';
  }

  function envelopeStroke(stroke) {
    return { stroke };
  }

  // ------------------------------------------------------------------
  // Undo / Redo / Clear
  // ------------------------------------------------------------------
  function undo() {
    if (!target) return;
    if (strokes.length > 0) strokes.pop();
    repaint();
    broadcast('dashboard:wb-undo', {});
  }

  function redo() {
    if (!target) return;
    broadcast('dashboard:wb-redo', {});
    // Mirror: ask the server for the redone stroke by re-reading the session.
    // The server is the source of truth; we re-sync so the local board matches.
    resyncFromServer();
  }

  function clearBoard() {
    if (!target) return;
    strokes = [];
    repaint();
    broadcast('dashboard:wb-clear', {});
  }

  async function resyncFromServer() {
    if (!target) return;
    try {
      const ack = await emitAck('dashboard:wb-start', Object.assign({}, envelope()));
      if (Array.isArray(ack && ack.strokes)) { strokes = ack.strokes.slice(); repaint(); }
    } catch { /* best-effort */ }
  }

  // ------------------------------------------------------------------
  // Export PNG (offscreen canvas → download). No external deps.
  // ------------------------------------------------------------------
  function exportPng() {
    try {
      const W = canvas.width, H = canvas.height;
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d');
      octx.fillStyle = WHITE_BG;
      octx.fillRect(0, 0, W, H);
      for (const s of strokes) drawStroke(octx, s);
      const url = off.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'whiteboard-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      status(keyFor('export_done'));
    } catch {
      status(keyFor('export_failed'));
    }
  }

  // ------------------------------------------------------------------
  // Listeners
  // ------------------------------------------------------------------
  function attachAll() {
    bound.resize = () => sizeCanvas();
    bound.down = onPointerDown;
    bound.move = onPointerMove;
    bound.up = onPointerUp;
    window.addEventListener('resize', bound.resize);
    canvas.addEventListener('pointerdown', bound.down);
    canvas.addEventListener('pointermove', bound.move);
    canvas.addEventListener('pointerup', bound.up);
    canvas.addEventListener('pointercancel', bound.up);
  }

  function detachAll() {
    if (bound.resize) window.removeEventListener('resize', bound.resize);
    if (canvas) {
      if (bound.down) canvas.removeEventListener('pointerdown', bound.down);
      if (bound.move) canvas.removeEventListener('pointermove', bound.move);
      if (bound.up) {
        canvas.removeEventListener('pointerup', bound.up);
        canvas.removeEventListener('pointercancel', bound.up);
      }
    }
  }

  // ------------------------------------------------------------------
  // Status + i18n
  // ------------------------------------------------------------------
  function keyFor(k) {
    // Keys defined in i18n/en.js under mc.wb.*
    return t('mc.wb.' + k);
  }

  function status(msg) {
    try { onStatus(msg || ''); } catch { /* ignore */ }
  }
}