// multiview.js — the "Multiview Layout" composer for the Command Center.
//
// A single display is split into a 4-left / 2-center / 4-right mosaic (every
// cell 16:9 by default). The operator drags source tiles from the toolbox into
// each frame, sees a thumbnail + label in just the frame they dropped into, can
// click any frame to monitor THAT stream's audio locally (in this browser, not
// on the wall — so they can switch which feed they hear), then sends the
// assembled layout to a display.
//
// Reactive layout (2026-06-07): grab a frame's edge/corner handle to resize it;
// neighbours SHRINK away to avoid overlap and everything stays within the
// display margins. Geometry is OPTIONAL per cell — an un-resized layout encodes
// byte-identically to the fixed 4+2+4 (no regression).
//
// Screen share into a frame (2026-06-07): drag the "Screen share" chip into a
// frame, then pick a display — the operator's screen is broadcast into THAT
// frame's rect on that display via the screen-share receiver's wall-tile rect
// mode (no new pipe — reuses the existing WebRTC engine + signaling).
//
// ARCHITECTURE: the layout is NOT a new player protocol. On "Send", the filled
// cells are encoded into a /player/grid.html?cells=<base64url> URL and pushed as
// an ordinary text/html remote_url through the existing send funnel. The SLOTS
// geometry + cell-URL allowlist + reflow math here MIRROR
// server/player/multiview-core.js (the renderer + unit tests share that file);
// keep them in sync.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { openTargetPicker } from '../../components/target-picker.js';
import { waitForTargetCatalog } from '../../services/target-catalog-runtime.js';
import { findCatalogTarget } from '../../services/target-catalog.js';
import * as screenShareEngine from '../../services/screen-share-engine.js';

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
const GEOM_KEY = 'mc_multiview_geoms_v1';
const LABEL_MAX = 80;
const MIN_PCT = 5;                              // smallest tile edge (mirror of core)
const HANDLE_DIRS = ['nw', 'ne', 'sw', 'se', 'n', 'e', 's', 'w'];

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
  screen:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>',
  // Fill = arrows pushing OUT to the frame edges (content fills, may crop).
  fill:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path></svg>',
  // Fit = arrows pulling IN (content fits whole, may letterbox).
  fit:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"></path></svg>',
};

// Office/ODF mime matcher (Word/Excel/PowerPoint + OpenDocument). Such files
// can't render as raw bytes in a frame, so they route through /player/doc/:id
// (LibreOffice -> PDF -> cached page images) like the full-screen player does.
const OFFICE_DOC_RE = /(msword|ms-excel|ms-powerpoint|officedocument\.(?:wordprocessing|spreadsheet|presentation)ml|oasis\.opendocument)/;

// Iframe player pages whose inner <video>/<img> honors a ?fit=cover param (so a
// fill choice reaches their letterboxed media). grid.html's object-fit handles
// <video>/<img> cells directly; youtube/deck/api-content are NOT in here.
const FIT_PARAM_RE = /^\/player\/(?:(oz|hls|cam|site)\.html|doc\/[^/?#]+)(\?|$)/;

// ---- module state (one composer per Command Center mount) ----
let cells = {};               // slotId -> { cellUrl, monitorUrl, kind, label, thumb, category }
let geoms = {};               // slotId -> { x,y,w,h } percent override (absent = fixed SLOT)
let shareDevice = {};         // slotId -> { deviceIds, label } receiving this frame's screen share
let contentIndex = {};        // content_id -> { mime, thumbnail_url, filename }
let routeSourceFn = null;     // injected: (source, label) => Promise<bool>
let onCloseFn = null;         // injected: () => void — closes the composer panel
let monitorSlot = null;       // slot id currently being monitored locally
let monitorRenderedKey = null;// guard so a re-render doesn't restart the monitor stream
let unsubShare = null;        // screen-share engine onChange unsubscribe
let rootEl = null;

// ---------- geometry helpers (MIRROR of multiview-core.js — keep in sync) ----------
function clampPct(v) { return Math.max(0, Math.min(100, v)); }
function validGeom(g) {
  return g && [g.x, g.y, g.w, g.h].every((n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100) && g.w > 0 && g.h > 0;
}
function cellRect(id) {
  const g = geoms[id];
  if (validGeom(g)) return g;
  const s = SLOT_BY_ID[id];
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}
function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
// SHRINK-only reflow (identical to multiview-core.reflowAroundActive).
function reflowAroundActive(rects, activeId) {
  const out = {};
  for (const k in rects) out[k] = { x: rects[k].x, y: rects[k].y, w: rects[k].w, h: rects[k].h };
  const a = out[activeId];
  if (!a) return out;
  for (const id in out) {
    if (id === activeId) continue;
    const b = out[id];
    if (!overlaps(a, b)) continue;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox <= 0 || oy <= 0) continue;
    if (ox <= oy) {
      if ((b.x + b.w / 2) >= (a.x + a.w / 2)) { const right = b.x + b.w; b.x = a.x + a.w; b.w = right - b.x; }
      else { b.w = a.x - b.x; }
    } else {
      if ((b.y + b.h / 2) >= (a.y + a.h / 2)) { const bottom = b.y + b.h; b.y = a.y + a.h; b.h = bottom - b.y; }
      else { b.h = a.y - b.y; }
    }
    if (b.w < MIN_PCT) b.w = MIN_PCT;
    if (b.h < MIN_PCT) b.h = MIN_PCT;
    b.x = clampPct(b.x); b.y = clampPct(b.y);
    if (b.x + b.w > 100) b.x = Math.max(0, 100 - b.w);
    if (b.y + b.h > 100) b.y = Math.max(0, 100 - b.h);
  }
  return out;
}

// ---------- persistence ----------
function loadStore() {
  try { cells = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { cells = {}; }
  // Keep only known slots that still carry content (a url) or are a share frame.
  for (const id of Object.keys(cells)) {
    const c = cells[id];
    if (!SLOT_BY_ID[id] || !c || (!c.cellUrl && c.kind !== 'share')) delete cells[id];
  }
  try { geoms = JSON.parse(localStorage.getItem(GEOM_KEY) || '{}') || {}; }
  catch { geoms = {}; }
  for (const id of Object.keys(geoms)) {
    if (!SLOT_BY_ID[id] || !validGeom(geoms[id])) delete geoms[id];
  }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cells)); } catch { /* quota — non-fatal */ }
  try { localStorage.setItem(GEOM_KEY, JSON.stringify(geoms)); } catch { /* */ }
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

// A cell's media-fit, defaulting to 'contain' (no distortion — grid.html's base
// behavior; letterbox/pillarbox as needed). 'cover' opts a frame into crop-to-fill.
// Only 'cover' | 'contain' are ever stored/sent.
function cellFit(c) {
  return c && c.fit === 'cover' ? 'cover' : 'contain';
}

// A cell can carry sound ON THE WALL only if it is a video file or one of our live
// audio players (oz/hls). cam.html is a still image; images/docs/decks/youtube
// can't drive wall audio. MIRROR of isAudioCapable() in multiview-core.js.
function wallAudioCapable(c) {
  if (!c || c.kind === 'share') return false;
  if (c.kind === 'v') return true;
  return c.kind === 'i' && /\/player\/(oz|hls)\.html/.test(c.cellUrl || '');
}

// Append &fit=cover to a /player iframe URL so cam/oz/hls/site honor it (their
// object-fit defaults to contain). Only added for the 'cover' (fill) choice —
// 'contain' is each page's default, so no param is needed. Same root-relative
// query style as the rest of this module; the result still passes the allowlist.
function withFit(relUrl, fit) {
  if (fit !== 'cover') return relUrl;
  return relUrl + (relUrl.indexOf('?') === -1 ? '?' : '&') + 'fit=cover';
}

// Build a youtube-nocookie embed URL (cell = muted autoplay; monitor = unmuted).
function ytEmbed(id, muted) {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=${muted ? 1 : 0}` +
         `&controls=0&rel=0&playsinline=1&loop=1&playlist=${id}`;
}

// Resolve a dropped { source, label, thumb } into a cell descriptor, or return
// { error } with a reason key. Mirrors the allowlist of multiview-core.js: only
// same-origin /player + /api/content paths and youtube-nocookie embeds become
// cells. The synthetic { screen_share:true } source becomes a no-url share frame.
function resolveCell(source, label, thumb) {
  label = (label || '').slice(0, LABEL_MAX);

  if (source.screen_share) {
    return { cellUrl: null, monitorUrl: null, kind: 'share', label: label || t('mc.mv.screen_share'), thumb: null, category: 'share' };
  }

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
    if (mime === 'text/html') {
      // Website content (external site) → server-side screenshot player, which
      // bypasses X-Frame-Options so it renders inside the cell. The shot endpoint
      // reads the real URL from the row by id. /player/* is allowlisted.
      return { cellUrl: `/player/site.html?id=${encodeURIComponent(source.content_id)}`, monitorUrl: null, kind: 'i', label, thumb: thumb || meta.thumbnail_url || null, category: 'broadcast' };
    }
    if (mime === 'application/pdf' || OFFICE_DOC_RE.test(mime)) {
      // PDF/Office/ODF doc → controllable document player. Office files are
      // converted to PDF server-side; the page then renders one cached slide/page
      // image at a time and listens for transport postMessage events.
      return { cellUrl: `/player/doc/${encodeURIComponent(source.content_id)}`, monitorUrl: null, kind: 'i', label, thumb: thumb || meta.thumbnail_url || null, category: 'slides' };
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
    if (!c) continue;
    let entry = null;
    if (c.kind === 'share') entry = { l: c.label || t('mc.mv.screen_share'), k: 'share' };
    else if (c.cellUrl) {
      const fit = cellFit(c);
      // Thread fit two ways: grid.html's object-fit reads the `f` field (video/img
      // + the fit-capable iframe pages set their own object-fit from ?fit=cover).
      // For oz/hls/cam/site iframes, also push &fit=cover into the cell URL so the
      // inner page (whose default is contain) fills the frame.
      const u = FIT_PARAM_RE.test(c.cellUrl) ? withFit(c.cellUrl, fit) : c.cellUrl;
      entry = { u, l: c.label || '', k: c.kind || 'i', f: fit };
      // Wall audio: mark THIS cell to play sound on the display (grid.html unmutes
      // only it). Guarded to audio-capable kinds so the flag can't ride an image.
      if (c.audio === true && wallAudioCapable(c)) entry.a = 1;
    }
    if (!entry) continue;
    const g = geoms[id];
    if (validGeom(g)) { entry.x = g.x; entry.y = g.y; entry.w = g.w; entry.h = g.h; }
    map[id] = entry;
  }
  return `${location.origin}/player/grid.html?cells=${b64url(JSON.stringify(map))}`;
}

// ---------- single-device wall split (N full-height column cells) ----------
// The wall card's Split button, when the wall is ONE spanning device (e.g. a PC
// using NVIDIA Mosaic to drive N TVs as one window), drops a source onto one of N
// columns. Each column maps to a fixed grid cell id (mirror of multiview-core
// splitColumnIds) so grid.html?cells=...&split=N renders N independently-sourced
// columns on the one window. `halfSources[i]` = { source, label } or null.
// Returns a grid.html URL, or null when nothing droppable is set yet.
const SPLIT_COL_IDS = { 2: ['L1', 'R1'], 3: ['L1', 'C1', 'R1'], 4: ['L1', 'L2', 'R1', 'R2'] };
async function ensureContentIndex() {
  if (contentIndex && Object.keys(contentIndex).length) return;
  try {
    const result = await api.getContent();
    const items = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
    contentIndex = {};
    for (const it of items) contentIndex[it.id] = { mime: it.mime_type || '', thumbnail_url: it.thumbnail_url || null, filename: it.filename || '' };
  } catch { /* a miss just defaults a cell to an iframe — still renders */ }
}
export async function buildSplitGridUrl(halfSources, cols) {
  const n = Math.max(2, Math.min(4, cols || 2));
  const ids = SPLIT_COL_IDS[n] || SPLIT_COL_IDS[2];
  await ensureContentIndex();
  const map = {};
  for (let i = 0; i < ids.length; i++) {
    const hs = halfSources && halfSources[i];
    if (!hs || !hs.source) continue;
    const res = resolveCell(hs.source, hs.label || '', null);
    if (!res || res.error || !res.cellUrl) continue;        // share/playlist/unsupported → skip
    map[ids[i]] = { u: res.cellUrl, l: res.label || '', k: res.kind || 'i' };
  }
  if (!Object.keys(map).length) return null;
  return `${location.origin}/player/grid.html?cells=${b64url(JSON.stringify(map))}&split=${n}`;
}

// ---------- rendering ----------
function slotName(slot) {
  return t(`mc.mv.slot.${slot.id}`);
}

function handlesHtml() {
  return HANDLE_DIRS.map((d) =>
    `<span class="mc-mv-handle mc-mv-handle-${d}" data-mv-handle="${d}" aria-hidden="true"></span>`
  ).join('');
}

function shareControlsHtml(slotId) {
  const share = shareDevice[slotId];
  const activeIds = new Set(screenShareEngine.getActiveTargets());
  const active = share && share.deviceIds.some((deviceId) => activeIds.has(deviceId));
  if (active) {
    const name = share.label || t('mc.mv.slot.' + slotId);
    return `<div class="mc-mv-share-controls">
      <span class="mc-mv-share-on">${esc(t('mc.mv.sharing_to', { name }))}</span>
      <button type="button" class="mc-btn mc-btn-sm mc-mv-share-stop" data-mv-share-stop="${esc(slotId)}">${esc(t('mc.mv.stop_share'))}</button>
    </div>`;
  }
  return `<div class="mc-mv-share-controls">
    <button type="button" class="mc-btn mc-btn-sm mc-btn-primary mc-mv-share-start" data-mv-share-start="${esc(slotId)}">${esc(t('mc.mv.share_to'))}</button>
  </div>`;
}

function cellInner(slot) {
  const c = cells[slot.id];
  if (!c) {
    return `<span class="mc-mv-slot-name">${esc(slotName(slot))}</span>
            <span class="mc-mv-slot-hint">${esc(t('mc.mv.drop_here'))}</span>`;
  }
  // Screen-share frame — placeholder + share/stop controls (no thumbnail/monitor).
  if (c.kind === 'share') {
    return `
      <span class="mc-mv-cell-ico mc-mv-cell-ico-share" aria-hidden="true">${IC.screen}</span>
      <div class="mc-mv-cell-actions">
        <button type="button" class="mc-mv-cell-btn mc-mv-clear" data-mv-clear="${esc(slot.id)}" title="${esc(t('mc.mv.clear_cell'))}">${IC.clear}</button>
      </div>
      ${shareControlsHtml(slot.id)}
      <div class="mc-mv-cell-label" title="${esc(c.label || '')}">${esc(c.label || t('mc.mv.screen_share'))}</div>
      ${handlesHtml()}`;
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
  // "Broadcast this frame's sound to the WALL" — distinct from the local 🔊 monitor
  // above. At most one frame carries wall audio; turning one on clears the rest.
  const wallOn = wallAudioCapable(c) && c.audio === true;
  const wallAudioBtn = wallAudioCapable(c)
    ? `<button type="button" class="mc-mv-cell-btn mc-mv-wallaudio${wallOn ? ' active' : ''}"
         data-mv-wallaudio="${esc(slot.id)}"
         title="${esc(wallOn ? t('mc.mv.wall_audio_on') : t('mc.mv.wall_audio'))}"
         aria-pressed="${wallOn ? 'true' : 'false'}">${IC.broadcast}</button>`
    : '';
  // Fill/Fit toggle: Fill (cover) fills the frame, Fit (contain) letterboxes.
  // Shows the CURRENT mode; clicking flips it. Default is Fit (no distortion).
  const filling = cellFit(c) !== 'contain';
  const fitBtn = `<button type="button" class="mc-mv-cell-btn mc-mv-fit${filling ? '' : ' fitmode'}"
       data-mv-fit="${esc(slot.id)}"
       title="${esc(filling ? t('mc.mv.fit_to') : t('mc.mv.fill_to'))}"
       aria-pressed="${filling ? 'false' : 'true'}">${filling ? IC.fill : IC.fit}</button>`;
  return `
    ${thumb}
    <div class="mc-mv-cell-actions">
      ${fitBtn}
      ${listenBtn}
      ${wallAudioBtn}
      <button type="button" class="mc-mv-cell-btn mc-mv-clear" data-mv-clear="${esc(slot.id)}" title="${esc(t('mc.mv.clear_cell'))}">${IC.clear}</button>
    </div>
    <div class="mc-mv-cell-label" title="${esc(c.label || '')}">${esc(c.label || slotName(slot))}</div>
    ${handlesHtml()}`;
}

function render() {
  if (!rootEl) return;
  const filled = Object.keys(cells).length;
  const resized = Object.keys(geoms).length;
  const cellsHtml = SLOTS.map((slot) => {
    const c = cells[slot.id];
    const r = cellRect(slot.id);
    const shareCls = (c && c.kind === 'share') ? ' mc-mv-cell-share' : '';
    // data-fit drives the preview thumbnail's object-fit so the composer mirrors
    // what the wall will show (cover = fill, contain = letterbox).
    const fitAttr = (c && c.kind !== 'share') ? ` data-fit="${cellFit(c)}"` : '';
    return `<div class="mc-mv-cell${c ? ' filled' : ''}${shareCls}${monitorSlot === slot.id ? ' monitoring' : ''}"
      data-mv-cell="${esc(slot.id)}" data-side="${slot.side}"${fitAttr}
      style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%"
      aria-label="${esc(slotName(slot))}">${cellInner(slot)}</div>`;
  }).join('');

  rootEl.innerHTML = `
    <div class="mc-mv">
      <div class="mc-mv-head">
        <p class="mc-mv-hint">${esc(t('mc.mv.hint'))}</p>
        <div class="mc-mv-actions">
          <button type="button" class="mc-mv-sharechip" draggable="true" data-mv-sharechip title="${esc(t('mc.mv.screen_share_hint'))}">
            <span class="mc-mv-sharechip-ico" aria-hidden="true">${IC.screen}</span><span>${esc(t('mc.mv.screen_share'))}</span>
          </button>
          <button type="button" class="mc-btn mc-btn-ghost mc-mv-reset"${resized ? '' : ' disabled'}>${esc(t('mc.mv.reset'))}</button>
          <button type="button" class="mc-btn mc-btn-ghost mc-mv-clear-all"${filled ? '' : ' disabled'}>${esc(t('mc.mv.clear_all'))}</button>
          <button type="button" class="mc-btn mc-btn-primary mc-mv-send"${filled ? '' : ' disabled'}>${esc(t('mc.mv.send'))}</button>
          <button type="button" class="mc-btn mc-btn-ghost mc-mv-close" aria-label="${esc(t('mc.mv.close'))}" title="${esc(t('mc.mv.close'))}">✕</button>
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

  monitorRenderedKey = null;   // full re-render replaced the monitor box
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
  // Default fill: live streams (news, cameras, YouTube) fill their slot (cover =
  // crop-to-fill, no letterbox). A 16:9 feed in a 50×50 center cell looks terrible
  // with letterbox bars. Documents / images default to contain (no distortion).
  if (resolved.kind !== 'share') {
    const COVER_CATEGORIES = new Set(['broadcast', 'film']);
    resolved.fit = COVER_CATEGORIES.has(resolved.category) ? 'cover' : 'contain';
  }
  cells[slotId] = resolved;
  saveStore();
  if (monitorSlot && monitorSlot !== slotId && !cells[monitorSlot]) monitorSlot = null;
  render();
}

function clearCell(slotId) {
  // Stop any active share for this frame before removing it.
  if (shareDevice[slotId]) {
    for (const deviceId of shareDevice[slotId].deviceIds) screenShareEngine.stopBroadcastTo(deviceId).catch(() => {});
    delete shareDevice[slotId];
  }
  delete cells[slotId];
  if (monitorSlot === slotId) monitorSlot = null;
  saveStore();
  render();
}

function clearAll() {
  for (const id of Object.keys(shareDevice)) {
    for (const deviceId of shareDevice[id].deviceIds) screenShareEngine.stopBroadcastTo(deviceId).catch(() => {});
  }
  shareDevice = {};
  cells = {}; geoms = {}; monitorSlot = null;
  saveStore(); render();
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
    // Resize handles (only present on filled cells).
    cellEl.querySelectorAll('[data-mv-handle]').forEach((h) => {
      h.addEventListener('pointerdown', (ev) => startResize(ev, cellEl, slotId, h.dataset.mvHandle));
    });
  });

  rootEl.querySelectorAll('[data-mv-listen]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMonitor(btn.dataset.mvListen); });
  });
  rootEl.querySelectorAll('[data-mv-fit]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFit(btn.dataset.mvFit); });
  });
  rootEl.querySelectorAll('[data-mv-wallaudio]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleWallAudio(btn.dataset.mvWallaudio); });
  });
  rootEl.querySelectorAll('[data-mv-clear]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); clearCell(btn.dataset.mvClear); });
  });
  bindShareControls();

  const sharechip = rootEl.querySelector('[data-mv-sharechip]');
  if (sharechip) {
    sharechip.addEventListener('dragstart', (e) => {
      const payload = JSON.stringify({ screen_share: true });
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', payload);
      e.dataTransfer.setData('application/x-mc-source', payload);
      e.dataTransfer.setData('application/x-mc-label', t('mc.mv.screen_share'));
    });
    // Click = drop into the first empty frame (center first), for non-drag users.
    sharechip.addEventListener('click', () => {
      const order = ['C1', 'C2', 'L1', 'R1', 'L2', 'R2', 'L3', 'R3', 'L4', 'R4'];
      const target = order.find((id) => !cells[id]);
      if (!target) { showToast(t('mc.mv.err_no_empty'), 'error'); return; }
      dropIntoSlot(target, { source: { screen_share: true }, label: t('mc.mv.screen_share'), thumb: null });
    });
  }

  const reset = rootEl.querySelector('.mc-mv-reset');
  if (reset) reset.addEventListener('click', () => { geoms = {}; saveStore(); render(); });
  const clearAllBtn = rootEl.querySelector('.mc-mv-clear-all');
  if (clearAllBtn) clearAllBtn.addEventListener('click', clearAll);
  const sendBtn = rootEl.querySelector('.mc-mv-send');
  if (sendBtn) sendBtn.addEventListener('click', sendLayout);
  const closeBtn = rootEl.querySelector('.mc-mv-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { if (typeof onCloseFn === 'function') onCloseFn(); });
  const monStop = rootEl.querySelector('.mc-mv-monitor-stop');
  if (monStop) monStop.addEventListener('click', () => { monitorSlot = null; render(); });
}

function bindShareControls() {
  rootEl.querySelectorAll('[data-mv-share-start]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); startShare(btn.dataset.mvShareStart); });
  });
  rootEl.querySelectorAll('[data-mv-share-stop]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); stopShare(btn.dataset.mvShareStop); });
  });
}

// ---------- reactive resize (port of region-editor's percent-space pointer drag) ----------
function applyResize(dir, dx, dy, start) {
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = Math.max(MIN_PCT, Math.min(start.w + dx, 100 - start.x));
  if (dir.includes('s')) h = Math.max(MIN_PCT, Math.min(start.h + dy, 100 - start.y));
  if (dir.includes('w')) { const nw = Math.max(MIN_PCT, Math.min(start.w - dx, start.x + start.w)); x = start.x + (start.w - nw); w = nw; }
  if (dir.includes('n')) { const nh = Math.max(MIN_PCT, Math.min(start.h - dy, start.y + start.h)); y = start.y + (start.h - nh); h = nh; }
  return { x: clampPct(x), y: clampPct(y), w: clampPct(w), h: clampPct(h) };
}

function applyLiveStyles() {
  rootEl.querySelectorAll('.mc-mv-cell').forEach((el) => {
    const r = cellRect(el.dataset.mvCell);
    el.style.left = r.x + '%'; el.style.top = r.y + '%';
    el.style.width = r.w + '%'; el.style.height = r.h + '%';
  });
}

function startResize(ev, cellEl, slotId, dir) {
  ev.preventDefault();
  ev.stopPropagation();
  const stage = rootEl.querySelector('.mc-mv-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  try { cellEl.setPointerCapture(ev.pointerId); } catch { /* */ }
  const base = cellRect(slotId);
  const start = { x: base.x, y: base.y, w: base.w, h: base.h };
  const startX = ev.clientX, startY = ev.clientY;

  function move(e) {
    const dx = rect.width ? ((e.clientX - startX) / rect.width) * 100 : 0;
    const dy = rect.height ? ((e.clientY - startY) / rect.height) * 100 : 0;
    geoms[slotId] = applyResize(dir, dx, dy, start);
    // Snapshot every slot's current rect, reflow neighbours away from the active
    // tile, write the result back as explicit geometry.
    const all = {};
    for (const s of SLOTS) all[s.id] = cellRect(s.id);
    const reflowed = reflowAroundActive(all, slotId);
    for (const s of SLOTS) geoms[s.id] = reflowed[s.id];
    applyLiveStyles();
  }
  function up() {
    try { cellEl.releasePointerCapture(ev.pointerId); } catch { /* */ }
    cellEl.removeEventListener('pointermove', move);
    cellEl.removeEventListener('pointerup', up);
    cellEl.removeEventListener('pointercancel', up);
    saveStore();
    render();   // rebuild so handles/labels/positions are consistent + rebound
  }
  cellEl.addEventListener('pointermove', move);
  cellEl.addEventListener('pointerup', up);
  cellEl.addEventListener('pointercancel', up);
}

// ---------- per-cell fit ----------
// Flip a frame between Fill (cover, default) and Fit (contain). Persists with the
// cell so it survives re-render and is included in the encoded layout.
function toggleFit(slotId) {
  const c = cells[slotId];
  if (!c || c.kind === 'share') return;
  c.fit = cellFit(c) === 'contain' ? 'cover' : 'contain';
  saveStore();
  render();
}

// ---------- wall audio (one frame's sound plays on the display) ----------
// Mutually exclusive: turning one frame on clears the flag from every other, so
// the wall is never a cacophony. grid.html unmutes exactly this cell.
function toggleWallAudio(slotId) {
  const c = cells[slotId];
  if (!wallAudioCapable(c)) return;
  const turningOn = c.audio !== true;
  for (const id of Object.keys(cells)) { if (cells[id]) delete cells[id].audio; }
  if (turningOn) c.audio = true;
  saveStore();
  render();
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
  const c = monitorSlot ? cells[monitorSlot] : null;
  if (!c || !c.monitorUrl) { wrap.hidden = true; box.innerHTML = ''; monitorRenderedKey = null; return; }
  const key = monitorSlot + '|' + c.monitorUrl;
  if (key === monitorRenderedKey && box.firstChild) { wrap.hidden = false; return; } // already playing — don't restart
  box.innerHTML = '';
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
  monitorRenderedKey = key;
}

// ---------- screen share into a frame ----------
// Intent: a live instructor chooses one physical destination without needing to
// know which display ids form a wall. The shared picker exposes calibrated wall
// geometry/status, hides wall members, and keeps Live Program out of this flow.
async function pickDisplay() {
  try {
    const catalog = await waitForTargetCatalog({ includeVirtualDisplays: false }, { requireFresh: true });
    return openTargetPicker({
      catalog,
      capability: 'screen_share',
      selection: 'single',
      allowOffline: false,
      availability: 'all',
      allowIndividualWallMembers: false,
      allowLiveProgram: false,
    });
  } catch (error) {
    showToast(error?.message || t('mc.mv.no_online_displays'), 'error');
    return null;
  }
}

function validViewport(viewport) {
  return viewport
    && Number.isFinite(viewport.x) && Number.isFinite(viewport.y)
    && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
    && viewport.width > 0 && viewport.height > 0;
}

// Resolve a logical picker target into the receiver payloads for this frame.
// A wall uses its authoritative canvas geometry so the frame spans the wall as
// one surface. A group or standalone display receives the frame independently.
function frameShareTargets(target, frameRect) {
  if (!target) return [];
  if (target.type !== 'wall') {
    const members = target.type === 'display' ? [target] : (target.members || []);
    return members.filter((member) => member.online).map((member) => ({
      deviceId: member.id,
      wallTile: {
        screen_rect: { x: 0, y: 0, w: 100, h: 100 },
        player_rect: { ...frameRect },
      },
    }));
  }

  const members = (target.members || []).filter((member) => member.online && validViewport(member.viewport));
  if (!members.length || members.length !== target.onlineCount || target.onlineCount !== target.memberCount) return [];
  const minX = Math.min(...members.map((member) => member.viewport.x));
  const minY = Math.min(...members.map((member) => member.viewport.y));
  const maxX = Math.max(...members.map((member) => member.viewport.x + member.viewport.width));
  const maxY = Math.max(...members.map((member) => member.viewport.y + member.viewport.height));
  const canvasWidth = maxX - minX;
  const canvasHeight = maxY - minY;
  const playerRect = {
    x: minX + (canvasWidth * frameRect.x / 100),
    y: minY + (canvasHeight * frameRect.y / 100),
    w: canvasWidth * frameRect.w / 100,
    h: canvasHeight * frameRect.h / 100,
  };
  return members.map((member) => ({
    deviceId: member.id,
    wallTile: {
      screen_rect: {
        x: member.viewport.x,
        y: member.viewport.y,
        w: member.viewport.width,
        h: member.viewport.height,
      },
      player_rect: { ...playerRect },
    },
  }));
}

function targetMemberIds(target) {
  const ids = target?.type === 'display'
    ? [target.id]
    : (target?.members || []).map((member) => member.id);
  return [...new Set(ids.filter(Boolean).map(String))].sort();
}

function sameTargetTopology(selected, fresh) {
  if (!selected || !fresh || selected.type !== fresh.type || String(selected.id) !== String(fresh.id)) return false;
  if ((selected.type === 'wall' || selected.type === 'wall-group')
      && Number(selected.layoutRevision) !== Number(fresh.layoutRevision)) return false;
  return JSON.stringify(targetMemberIds(selected)) === JSON.stringify(targetMemberIds(fresh));
}

async function startShare(slotId) {
  const selection = await pickDisplay();
  if (!selection) return;
  const selectedTarget = selection.targets[0];
  let freshCatalog;
  try {
    freshCatalog = await waitForTargetCatalog({ includeVirtualDisplays: false }, { requireFresh: true });
  } catch (error) {
    showToast(error?.message || t('mc.mv.no_online_displays'), 'error');
    return;
  }
  const target = findCatalogTarget(freshCatalog, selection.references[0]);
  if (!sameTargetTopology(selectedTarget, target)) {
    showToast('Display topology changed. Reopen the destination picker and try again.', 'error');
    return;
  }
  const r = cellRect(slotId);
  const entries = frameShareTargets(target, r);
  if (!entries.length) {
    showToast(t('mc.mv.no_online_displays'), 'error');
    return;
  }
  try {
    const settled = await Promise.allSettled(entries.map((entry) => (
      screenShareEngine.startBroadcastTo(entry.deviceId, { wallTile: entry.wallTile })
    )));
    const deviceIds = entries
      .filter((_, index) => settled[index].status === 'fulfilled')
      .map((entry) => entry.deviceId);
    if (!deviceIds.length) throw settled.find((result) => result.status === 'rejected')?.reason || new Error(t('mc.mv.share_failed'));
    shareDevice[slotId] = { deviceIds, label: target.topologyLabel || target.name || target.id };
    showToast(t('mc.mv.share_started', { name: target.name || target.id }), settled.some((result) => result.status === 'rejected') ? 'warning' : 'success');
  } catch (e) {
    showToast((e && e.message) || t('mc.mv.share_failed'), 'error');
  }
  render();
}

async function stopShare(slotId) {
  const share = shareDevice[slotId];
  if (share) {
    await Promise.allSettled(share.deviceIds.map((deviceId) => screenShareEngine.stopBroadcastTo(deviceId)));
    delete shareDevice[slotId];
  }
  showToast(t('mc.mv.share_stopped'), 'info');
  render();
}

// Re-sync only the share controls when the engine's broadcast set changes (a
// share connected / failed / was preempted) — WITHOUT a full re-render, so the
// local audio monitor never restarts.
function syncShareUi() {
  if (!rootEl) return;
  const active = new Set(screenShareEngine.getActiveTargets());
  for (const id of Object.keys(shareDevice)) {
    shareDevice[id].deviceIds = shareDevice[id].deviceIds.filter((deviceId) => active.has(deviceId));
    if (!shareDevice[id].deviceIds.length) delete shareDevice[id];
  }
  rootEl.querySelectorAll('.mc-mv-cell-share[data-mv-cell]').forEach((el) => {
    const slotId = el.dataset.mvCell;
    const host = el.querySelector('.mc-mv-share-controls');
    if (host) {
      const tmp = document.createElement('div');
      tmp.innerHTML = shareControlsHtml(slotId);
      host.replaceWith(tmp.firstElementChild);
    }
  });
  bindShareControls();
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
 * @param {()=>void} [opts.onClose]  called when the operator clicks ✕ to dismiss the composer
 */
export async function renderMultiview(container, { routeSource, onClose } = {}) {
  if (!container) return;
  rootEl = container;
  routeSourceFn = routeSource;
  onCloseFn = onClose || null;
  loadStore();
  // React to screen-share connect/fail/preempt so the frame's Share/Stop button
  // reflects reality (targeted update — does not restart the audio monitor).
  if (unsubShare) { unsubShare(); unsubShare = null; }
  unsubShare = screenShareEngine.onChange(() => syncShareUi());
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
// monitored stream can't keep playing audio after navigating away). Active screen
// shares are INTENTIONALLY left running — the engine is a session singleton, so
// shares persist across navigation exactly like the standalone screen-share view.
export function teardownMultiview() {
  monitorSlot = null;
  monitorRenderedKey = null;
  if (unsubShare) { unsubShare(); unsubShare = null; }
  if (rootEl) {
    const box = rootEl.querySelector('.mc-mv-monitor-box');
    if (box) box.innerHTML = '';
  }
  rootEl = null;
  routeSourceFn = null;
}
