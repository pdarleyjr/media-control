// live-preview.js — build a lightweight live-preview element for a stage card.
//
// RULE: never embed live HLS/WebRTC/external iframes here. Each live iframe
// that loads inside the dashboard adds HLS segment fetches, hls.js CPU, and
// network connections — even 2-3 concurrent streams cause visible UI lag.
//
// What we DO embed (safe, cheap):
//   image   → <img src="/api/content/:id/file">         (single HTTP req, cached)
//   video   → <video muted> local file                  (one decoded stream - allowed
//               for span-preview where allowVideo=true)
//   pdf/doc → <iframe /player/doc/:id>                  (static renders quickly)
//   grid    → lightweight CSS mosaic thumbnail          (zero network, just CSS+text)
//   web/hls → styled "● LIVE" label card                (zero network)
//
// Returns an HTML string or null (caller falls back to screenshot/poster).

import { esc } from '../../utils.js';

// ── Grid (multiview) lightweight thumbnail ────────────────────────────────────
// Decode the cells= base64url param from the grid URL and render a pure-CSS
// 4+2+4 mosaic showing labels. No iframes, no HLS, no network requests.

// base64url → JSON string (mirrors multiview-core.js b64urlDecode)
function b64urlDecode(s) {
  if (!s) return '{}';
  try {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b.length % 4 ? '='.repeat(4 - b.length % 4) : '';
    return atob(b + pad);
  } catch { return '{}'; }
}

// The fixed 4+2+4 slot definitions (mirrors multiview-core.js SLOTS)
const SLOTS = [
  { id:'L1', x:0,  y:0,  w:25, h:25 },
  { id:'L2', x:0,  y:25, w:25, h:25 },
  { id:'L3', x:0,  y:50, w:25, h:25 },
  { id:'L4', x:0,  y:75, w:25, h:25 },
  { id:'C1', x:25, y:0,  w:50, h:50 },
  { id:'C2', x:25, y:50, w:50, h:50 },
  { id:'R1', x:75, y:0,  w:25, h:25 },
  { id:'R2', x:75, y:25, w:25, h:25 },
  { id:'R3', x:75, y:50, w:25, h:25 },
  { id:'R4', x:75, y:75, w:25, h:25 },
];

function gridThumbnail(remoteUrl, cls) {
  let cells = {};
  try {
    const u = new URL(remoteUrl, location.href);
    const raw = u.searchParams.get('cells');
    if (raw) cells = JSON.parse(b64urlDecode(raw)) || {};
  } catch { /* use empty cells */ }

  // Build absolute-positioned cell divs.
  const cellDivs = SLOTS.map(sl => {
    const c = cells[sl.id];
    const label = (c && c.l) ? c.l : '';
    const filled = !!(c && (c.u || c.k === 'share'));
    const isAudio = !!(c && c.a);
    const bg = filled ? '#1e293b' : '#0f172a';
    const border = isAudio
      ? 'box-shadow:inset 0 0 0 2px #22c55e'
      : 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)';
    const style = [
      `position:absolute`,
      `left:${sl.x}%`, `top:${sl.y}%`,
      `width:${sl.w}%`, `height:${sl.h}%`,
      `background:${bg}`,
      `display:flex`, `align-items:flex-end`, `overflow:hidden`,
      border,
    ].join(';');
    const labelHtml = label
      ? `<span style="font-size:clamp(7px,1.1cqw,11px);font-weight:600;color:#e2e8f0;padding:2px 4px;background:rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%">${esc(label)}</span>`
      : '';
    const dot = isAudio
      ? `<span style="position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#22c55e"></span>`
      : '';
    return `<div style="${esc(style)}">${labelHtml}${dot}</div>`;
  }).join('');

  return `<div class="${esc(cls)} mc-live-embed"
    style="position:absolute;inset:0;background:#0f172a;container-type:inline-size"
    aria-label="Multiview layout preview">${cellDivs}</div>`;
}

// ── Live-stream label card ────────────────────────────────────────────────────
// For hls.html, oz.html, cam.html, YouTube live: a tiny styled badge so the
// card still shows *something* meaningful without any HLS connections.
const LIVE_DOT = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444;flex-shrink:0"></span>`;

function liveLabelCard(label, cls) {
  const safe = esc(label || 'Live');
  return `<div class="${esc(cls)} mc-live-embed"
    style="position:absolute;inset:0;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px">
    <div style="display:flex;align-items:center;gap:6px">${LIVE_DOT}<span style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#94a3b8;text-transform:uppercase">Live</span></div>
    <div style="font-size:clamp(9px,1.5cqw,12px);font-weight:600;color:#e2e8f0;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${safe}</div>
  </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────
export function liveEmbedHtml(nowPlaying, cls = '', opts = {}) {
  const np = nowPlaying || null;
  if (!np || !np.contentId) return null;
  const allowVideo = opts.allowVideo !== false;
  const fb = typeof opts.fallbackSrc === 'string' ? opts.fallbackSrc : '';
  const id = encodeURIComponent(np.contentId);
  const klass = `mc-live-embed${cls ? ' ' + esc(cls) : ''}`;
  const onerr = fb ? ` onerror="this.onerror=null;this.src='${esc(fb)}'"` : '';

  switch (np.kind) {
    case 'image':
      return `<img class="${klass}" src="/api/content/${id}/file" alt=""${onerr} loading="lazy">`;

    case 'video':
      if (!allowVideo) return null;
      return `<video class="${klass}" src="/api/content/${id}/file" autoplay muted loop playsinline style="pointer-events:none"></video>`;

    case 'pdf':
    case 'document':
      return `<iframe class="${klass}" src="/player/doc/${id}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;

    case 'grid':
      // Lightweight CSS mosaic: shows which slots are filled and their labels.
      // Decodes the cells= param from now_playing.remoteUrl client-side.
      // Zero network requests — pure CSS/HTML.
      return gridThumbnail(np.remoteUrl || '', klass);

    case 'web':
    case 'youtube':
      // Live stream or external site: show a "● LIVE" label card instead of
      // loading any iframe. Too heavy for the dashboard (HLS connections lag UI).
      return liveLabelCard(np.label, klass);

    default:
      return null;
  }
}
