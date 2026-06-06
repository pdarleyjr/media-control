// multiview.js — the "Multiview Layout" composer for the Command Center.
//
// A single display is split into a 4-left / 2-center / 4-right mosaic (every
// cell 16:9). The operator drags source tiles from the toolbox into each frame,
// sees a thumbnail + label in just the frame they dropped into, can click any
// frame to monitor THAT stream's audio locally (in this browser, not on the
// wall — so they can switch which feed they hear), then sends the assembled
// layout to a display.
//
// ARCHITECTURE: the layout is NOT a new player protocol. On "Send", the filled
// cells are encoded into a /player/grid.html?cells=<base64url> URL and pushed as
// an ordinary text/html remote_url through the existing send funnel — the
// display iframes grid.html, which iframes each cell's own per-source player
// (oz.html / hls.html / cam.html / youtube-nocookie / deck / content file),
// reusing every existing renderer verbatim. The SLOTS geometry + cell-URL
// allowlist here MIRROR server/player/multiview-core.js (the renderer + tests
// share that file); keep them in sync.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../../components/toast.js';

// 4-left / 2-center / 4-right, in percent of the 16:9 canvas. MIRROR of SLOTS
// in server/player/multiview-core.js.
const SLOTS = [
  { id: 'L1', x: 0,  y: 0,  w: 25, h: 25, side: 'left'   },
  { id: 'L2', x: 0,  y: 25, w: 25, h: 25, side: 'left'   },
  { id: 'L3', x: 0,  y: 50, w: 25, h: 25, side: 'left'   },
  { id: 'L4', x: 0,  y: 75, w: 25, h: 25, side: 'left'   },
  { id: 'C1', x: 25, y: 0,  w: 50, h: 50, side: 'center' },
  { id: 'C2', x: 25, y: 50, w: 50, h: 50, side: 'center' },
  { id: 'R1', x: 75, y: 0,  w: 25, h: 25, side: 'right'  },
  { id: 'R2', x: 75, y: 25, w: 25, h: 25, side: 'right'  },
  { id: 'R3', x: 75, y: 50, w: 25, h: 25, side: 'right'  },
  { id: 'R4', x: 75, y: 75, w: 25, h: 25, side: 'right'  },
];
const SLOT_BY_ID = Object.fromEntries(SLOTS.map((s) => [s.id, s]));

const STORE_KEY = 'mc_multiview_cells_v1';
const LABEL_MAX = 80;

// ---- category icons (stroke SVGs, matching the dashboard vocabulary) ----
const IC = {
  broadcast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"></path></svg>',
  film:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"></rect><path d="M7 3v18M17 3v18M2 9h5M17 9h5M2 15h5M17 15h5"></path></svg>',
  image:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>',
  slides:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M12 17v3M8 20h8"></path></svg>',
  generic:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path></svg>',
  sound:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"></path></svg>',
  mute:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"></path><path d="M22 9l-6 6M16 9l6 6"></path></svg>',
  clear:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
};

// ---- module state (one composer per Command Center mount) ----
let cells = {};               // slotId -> { cellUrl, monitorUrl, kind, label, thumb, category }
let contentIndex = {};        // content_id -> { mime, thumbnail_url, filename }
let routeSourceFn = null;     // injected: (source, label) => Promise<bool>
let monitorSlot = null;       // slot id currently being monitored locally
let rootEl = null;

// ---------- persistence ----------
function loadStore() {
  try { cells = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { cells = {}; }
  // Drop anything that isn't a known slot or lost its URL.
  for (const id of Object.keys(cells)) {
    if (!SLOT_BY_ID[id] || !cells[id] || !cells[id].cellUrl) delete cells[id];
  }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cells)); } catch { /* quota — non-fatal */ }
}

// ---------- source → cell resolution ----------

// Extract an 11-char-ish YouTube id from any common URL shape.
function ytId(url) {
  const m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/.exec(url || '');
  return m ? m[1] : null;
}

// Strip the origin from a same-origin (or canonical media.mbfdhub.com) absolute
// URL so the cell payload carries a short root-relative path that the allowlist
// accepts. Returns the input unchanged if it isn't one of ours.
function toRelativeIfOurs(url) {
  try {
    const u = new URL(url, location.origin);
    const ours = u.host === location.host || u.host === 'media.mbfdhub.com';
    if (ours && (u.pathname.indexOf('/player/') === 0 || u.pathname.indexOf('/api/content/') === 0)) {
      return u.pathname + u.search;
    }
  } catch { /* not absolute */ }
  return url;
}

// Remove an existing &label= param (grid.html draws its own per-cell label chip,
// so the inner player's overlay would just double up at the bottom of the cell).
function stripLabelParam(relUrl) {
  return relUrl.replace(/([?&])label=[^&]*/i, '$1').replace(/[?&]$/, '').replace(/\?&/, '?');
}

// Build a youtube-nocookie embed URL (cell = muted autoplay; monitor = unmuted).
function ytEmbed(id, muted) {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=${muted ? 1 : 0}` +
         `&controls=0&rel=0&playsinline=1&loop=1&playlist=${id}`;
}

// Resolve a dropped { source, label, thumb } into a cell descriptor, or return
// { error } with a reason key. Mirrors the allowlist of multiview-core.js: only
// same-origin /player + /api/content paths and youtube-nocookie embeds become
// cells.
function resolveCell(source, label, thumb) {
  label = (label || '').slice(0, LABEL_MAX);

  if (source.playlist_id) return { error: 'mc.mv.err_playlist' };

  if (source.presentation_id) {
    return {
      cellUrl: `/player/deck/${encodeURIComponent(source.presentation_id)}`,
      monitorUrl: null, kind: 'i', label, thumb: thumb || null, category: 'slides',
    };
  }

  if (source.content_id) {
    const meta = contentIndex[source.content_id] || {};
    const mime = meta.mime || '';
    const fileUrl = `/api/content/${encodeURIComponent(source.content_id)}/file`;
    if (/^image\//.test(mime)) {
      return { cellUrl: fileUrl, monitorUrl: null, kind: 'm', label, thumb: thumb || meta.thumbnail_url || null, category: 'image' };
    }
    if (/^video\//.test(mime)) {
      return { cellUrl: fileUrl, monitorUrl: fileUrl, kind: 'v', label, thumb: thumb || meta.thumbnail_url || null, category: 'film' };
    }
    // Unknown / web content → iframe the file (browser picks a viewer).
    return { cellUrl: fileUrl, monitorUrl: null, kind: 'i', label, thumb: thumb || meta.thumbnail_url || null, category: 'generic' };
  }

  if (source.remote_url) {
    const url = source.remote_url;
    const yid = ytId(url);
    if (yid) {
      return { cellUrl: ytEmbed(yid, true), monitorUrl: ytEmbed(yid, false), kind: 'i', label, thumb: thumb || `https://i.ytimg.com/vi/${yid}/hqdefault.jpg`, category: 'broadcast' };
    }
    const rel = toRelativeIfOurs(url);
    if (rel.indexOf('/player/') === 0) {
      const cellUrl = stripLabelParam(rel);
      // oz.html / hls.html carry audio (add &audio=1 for the monitor); cam.html
      // is a still-image snapshot (no audio).
      const audioCapable = /\/player\/(oz|hls)\.html/.test(cellUrl);
      const monitorUrl = audioCapable ? cellUrl + (cellUrl.indexOf('?') === -1 ? '?' : '&') + 'audio=1' : null;
      const category = /cam\.html/.test(cellUrl) ? 'image' : 'broadcast';
      return { cellUrl, monitorUrl, kind: 'i', label, thumb: thumb || null, category };
    }
    if (rel.indexOf('/api/content/') === 0) {
      return { cellUrl: rel, monitorUrl: null, kind: 'i', label, thumb: thumb || null, category: 'generic' };
    }
    return { error: 'mc.mv.err_unsupported' };
  }

  return { error: 'mc.mv.err_unsupported' };
}

// ---------- encode for grid.html (mirror of multiview-core encodeCells) ----------
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildGridUrl() {
  const map = {};
  for (const id of Object.keys(cells)) {
    const c = cells[id];
    if (c && c.cellUrl) map[id] = { u: c.cellUrl, l: c.label || '', k: c.kind || 'i' };
  }
  return `${location.origin}/player/grid.html?cells=${b64url(JSON.stringify(map))}`;
}

// ---------- rendering ----------
function slotName(slot) {
  return t(`mc.mv.slot.${slot.id}`);
}

function cellInner(slot) {
  const c = cells[slot.id];
  if (!c) {
    return `<span class="mc-mv-slot-name">${esc(slotName(slot))}</span>
            <span class="mc-mv-slot-hint">${esc(t('mc.mv.drop_here'))}</span>`;
  }
  const thumb = c.thumb
    ? `<img class="mc-mv-cell-thumb" src="${esc(c.thumb)}" alt="" loading="lazy">`
    : `<span class="mc-mv-cell-ico" aria-hidden="true">${IC[c.category] || IC.generic}</span>`;
  const monitoring = monitorSlot === slot.id;
  const listenBtn = c.monitorUrl
    ? `<button type="button" class="mc-mv-cell-btn mc-mv-listen${monitoring ? ' active' : ''}"
         data-mv-listen="${esc(slot.id)}"
         title="${esc(monitoring ? t('mc.mv.stop_audio') : t('mc.mv.listen'))}"
         aria-pressed="${monitoring ? 'true' : 'false'}">${monitoring ? IC.mute : IC.sound}</button>`
    : '';
  return `
    ${thumb}
    <div class="mc-mv-cell-actions">
      ${listenBtn}
      <button type="button" class="mc-mv-cell-btn mc-mv-clear" data-mv-clear="${esc(slot.id)}" title="${esc(t('mc.mv.clear_cell'))}">${IC.clear}</button>
    </div>
    <div class="mc-mv-cell-label" title="${esc(c.label || '')}">${esc(c.label || slotName(slot))}</div>`;
}

function render() {
  if (!rootEl) return;
  const filled = Object.keys(cells).length;
  const cellsHtml = SLOTS.map((slot) => {
    const c = cells[slot.id];
    return `<div class="mc-mv-cell${c ? ' filled' : ''}${monitorSlot === slot.id ? ' monitoring' : ''}"
      data-mv-cell="${esc(slot.id)}" data-side="${slot.side}"
      style="left:${slot.x}%;top:${slot.y}%;width:${slot.w}%;height:${slot.h}%"
      aria-label="${esc(slotName(slot))}">${cellInner(slot)}</div>`;
  }).join('');

  rootEl.innerHTML = `
    <div class="mc-mv">
      <div class="mc-mv-head">
        <p class="mc-mv-hint">${esc(t('mc.mv.hint'))}</p>
        <div class="mc-mv-actions">
          <button type="button" class="mc-btn mc-btn-ghost mc-mv-clear-all"${filled ? '' : ' disabled'}>${esc(t('mc.mv.clear_all'))}</button>
          <button type="button" class="mc-btn mc-btn-primary mc-mv-send"${filled ? '' : ' disabled'}>${esc(t('mc.mv.send'))}</button>
        </div>
      </div>
      <div class="mc-mv-stage" role="application" aria-label="${esc(t('mc.mv.canvas_aria'))}">
        ${cellsHtml}
      </div>
      <div class="mc-mv-monitor" hidden>
        <div class="mc-mv-monitor-head">
          <span class="mc-mv-monitor-title">${esc(t('mc.mv.monitor'))}</span>
          <span class="mc-mv-monitor-label"></span>
          <button type="button" class="mc-btn mc-btn-sm mc-mv-monitor-stop">${esc(t('mc.mv.stop_audio'))}</button>
        </div>
        <div class="mc-mv-monitor-box"></div>
      </div>
    </div>`;

  attachHandlers();
  renderMonitor();
}

// ---------- drag-drop + buttons ----------
function dragHasSource(e) {
  return !!e.dataTransfer && (
    e.dataTransfer.types.includes('application/x-mc-source') ||
    e.dataTransfer.types.includes('text/plain'));
}
function parseDrag(e) {
  const raw = e.dataTransfer.getData('application/x-mc-source') || e.dataTransfer.getData('text/plain');
  if (!raw) return null;
  let source;
  try { source = JSON.parse(raw); } catch { return null; }
  return {
    source,
    label: e.dataTransfer.getData('application/x-mc-label') || t('mc.tile.content_fallback'),
    thumb: e.dataTransfer.getData('application/x-mc-thumb') || null,
  };
}

function dropIntoSlot(slotId, parsed) {
  const resolved = resolveCell(parsed.source, parsed.label, parsed.thumb);
  if (resolved.error) { showToast(t(resolved.error), 'error'); return; }
  cells[slotId] = resolved;
  saveStore();
  if (monitorSlot && monitorSlot !== slotId && !cells[monitorSlot]) monitorSlot = null;
  render();
}

function clearCell(slotId) {
  delete cells[slotId];
  if (monitorSlot === slotId) monitorSlot = null;
  saveStore();
  render();
}

function attachHandlers() {
  rootEl.querySelectorAll('.mc-mv-cell').forEach((cellEl) => {
    const slotId = cellEl.dataset.mvCell;
    cellEl.addEventListener('dragover', (e) => {
      if (!dragHasSource(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      cellEl.classList.add('dragover');
    });
    cellEl.addEventListener('dragleave', () => cellEl.classList.remove('dragover'));
    cellEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cellEl.classList.remove('dragover');
      const parsed = parseDrag(e);
      if (parsed) dropIntoSlot(slotId, parsed);
    });
  });

  rootEl.querySelectorAll('[data-mv-listen]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMonitor(btn.dataset.mvListen); });
  });
  rootEl.querySelectorAll('[data-mv-clear]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); clearCell(btn.dataset.mvClear); });
  });
  const clearAll = rootEl.querySelector('.mc-mv-clear-all');
  if (clearAll) clearAll.addEventListener('click', () => {
    cells = {}; monitorSlot = null; saveStore(); render();
  });
  const sendBtn = rootEl.querySelector('.mc-mv-send');
  if (sendBtn) sendBtn.addEventListener('click', sendLayout);
  const monStop = rootEl.querySelector('.mc-mv-monitor-stop');
  if (monStop) monStop.addEventListener('click', () => { monitorSlot = null; render(); });
}

// ---------- local audio monitor ----------
function toggleMonitor(slotId) {
  monitorSlot = (monitorSlot === slotId) ? null : slotId;
  render();
}
function renderMonitor() {
  const wrap = rootEl.querySelector('.mc-mv-monitor');
  const box = rootEl.querySelector('.mc-mv-monitor-box');
  const labelEl = rootEl.querySelector('.mc-mv-monitor-label');
  if (!wrap || !box) return;
  box.innerHTML = '';
  const c = monitorSlot ? cells[monitorSlot] : null;
  if (!c || !c.monitorUrl) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (labelEl) labelEl.textContent = c.label || '';
  // The element is created in response to the operator's click (a user gesture),
  // so unmuted autoplay is permitted for this monitor preview.
  if (c.kind === 'v') {
    const v = document.createElement('video');
    v.src = c.monitorUrl; v.autoplay = true; v.controls = true; v.muted = false; v.playsInline = true;
    box.appendChild(v);
    v.play().catch(() => {});
  } else {
    const f = document.createElement('iframe');
    f.src = c.monitorUrl;
    f.setAttribute('allow', 'autoplay; encrypted-media');
    f.setAttribute('title', c.label || 'audio monitor');
    box.appendChild(f);
  }
}

// ---------- send ----------
async function sendLayout() {
  if (!Object.keys(cells).length) { showToast(t('mc.mv.err_empty'), 'error'); return; }
  if (typeof routeSourceFn !== 'function') { showToast(t('mc.send.failed'), 'error'); return; }
  const url = buildGridUrl();
  await routeSourceFn({ remote_url: url }, t('mc.mv.layout_label'));
}

/**
 * Render the Multiview composer into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {(source:object,label:string)=>Promise<boolean>} opts.routeSource  send funnel (routing picker)
 */
export async function renderMultiview(container, { routeSource } = {}) {
  if (!container) return;
  rootEl = container;
  routeSourceFn = routeSource;
  loadStore();
  // Build the content id→meta index once so dropped uploads resolve to the right
  // renderer (image vs video). Best-effort; a miss just defaults to an iframe.
  try {
    const result = await api.getContent();
    const items = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
    contentIndex = {};
    for (const it of items) contentIndex[it.id] = { mime: it.mime_type || '', thumbnail_url: it.thumbnail_url || null, filename: it.filename || '' };
  } catch { contentIndex = {}; }
  render();
}

// Stop the local audio monitor and drop DOM refs (called on view unmount so a
// monitored stream can't keep playing audio after navigating away).
export function teardownMultiview() {
  monitorSlot = null;
  if (rootEl) {
    const box = rootEl.querySelector('.mc-mv-monitor-box');
    if (box) box.innerHTML = '';
  }
  rootEl = null;
  routeSourceFn = null;
}
