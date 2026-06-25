// live-preview.js — build a LIVE content element (img/video/iframe) for a stage
// frame from a device's now_playing summary, so the Command Center shows the
// actual content playing rather than a static screenshot/poster.
//
// Returns an HTML string (drops into the existing stage template literals) or
// null when the content is not single-item-embeddable (idle, playlist, widget,
// youtube, or no contentId) — callers then fall back to the screenshot/poster.
//
// Token-less by design: currently-playing content is playlist-assigned, so
// /api/content/:id/file and the open /player/* routes serve without a JWT.

import { esc } from '../../utils.js';

// Our own player pages — recognised by path prefix. These iframe LIVE and
// must NEVER go through site.html/site-shot (Chromium screenshot). site-shot
// is only for genuinely external third-party websites that block iframes.
function isOwnPlayerUrl(url) {
  if (!url) return false;
  const path = url.startsWith('http') ? (() => { try { return new URL(url).pathname; } catch { return ''; } })() : url;
  return path.startsWith('/player/') || path.startsWith('/api/content/');
}

// For own /player/* URLs, strip the origin so the iframe loads root-relative
// from the dashboard's own origin (same-origin = can call __mcEnableAudio etc).
function toRootRelative(url) {
  if (!url) return url;
  if (!url.startsWith('http')) return url;
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

// kinds we can render as ONE live element. youtube is intentionally excluded
// (now_playing carries no youtube id; its poster fallback is fine). playlist /
// widget / idle have no single source to embed.
export function liveEmbedHtml(nowPlaying, cls = '', opts = {}) {
  const np = nowPlaying || null;
  if (!np || !np.contentId) return null;
  const allowVideo = opts.allowVideo !== false;        // default true
  const fb = typeof opts.fallbackSrc === 'string' ? opts.fallbackSrc : '';
  const id = encodeURIComponent(np.contentId);
  const klass = `mc-live-embed${cls ? ' ' + esc(cls) : ''}`;
  // onerror swap for raster embeds: if the public content route 403s (content not
  // playlist-assigned), fall back to the poster/screenshot rather than show black.
  const onerr = fb ? ` onerror="this.onerror=null;this.src='${esc(fb)}'"` : '';
  switch (np.kind) {
    case 'image':
      return `<img class="${klass}" src="/api/content/${id}/file" alt=""${onerr} loading="lazy">`;
    case 'video':
      if (!allowVideo) return null; // per-cell wall video -> poster fallback (avoid N decoders)
      // muted+loop so browser autoplay policy allows it and it mirrors the wall silently.
      return `<video class="${klass}" src="/api/content/${id}/file" autoplay muted loop playsinline style="pointer-events:none"></video>`;
    case 'pdf':
    case 'document':
      return `<iframe class="${klass}" src="/player/doc/${id}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    case 'grid':
      // Multiview layout — embed the grid LIVE so the UI mirrors exactly what is
      // on the physical wall. The grid URL is our own /player/grid.html (same-origin)
      // so it renders with live HLS/camera cells rather than a Chromium screenshot.
      // np.remoteUrl carries the full grid URL (set server-side for grid content rows).
      if (np.remoteUrl) {
        const src = esc(toRootRelative(np.remoteUrl));
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      return null;
    case 'web':
      // If the URL is one of our OWN /player/* pages (hls.html, oz.html, cam.html,
      // classroom-camera.html, etc.) → embed it live as a direct iframe. NEVER run
      // our own player pages through site.html/site-shot: that spawns Chromium,
      // which fails in Docker → "chromium produced no screenshot" crash loop →
      // CPU spike → WebSocket timeouts → all devices disconnect simultaneously.
      if (np.remoteUrl && isOwnPlayerUrl(np.remoteUrl)) {
        const src = esc(toRootRelative(np.remoteUrl));
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      // Genuinely external third-party website → Chromium screenshot path.
      // Only reaches here for e.g. https://weather.gov, never for our own pages.
      return `<iframe class="${klass}" src="/player/site.html?id=${id}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    default:
      return null; // idle / playlist / widget / youtube / content(unknown) -> screenshot fallback
  }
}
