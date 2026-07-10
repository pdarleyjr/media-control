// live-preview.js — build a LIVE content element (img/video/iframe) for a stage
// card so the Command Center shows ACTUAL live content, not static screenshots.
//
// Key rules to avoid the CDN overload / "Reconnecting" cascade:
//   • Grid (multiview): embed grid.html with &preview=1 — grid shows labeled
//     cells (channel names per slot) but loads ZERO HLS streams. The physical
//     TV plays the full live grid; the dashboard shows a lightweight preview.
//   • Individual HLS/camera streams: embed live ONLY in the span preview (one
//     stream), never in every wall cell (N streams = CDN rate-limit = reconnect).
//   • Documents/PDFs: never embed a second player. The dashboard must render the
//     physical device's screenshot or it will remain on slide 1 while the TV advances.
//   • Images/videos: embed live (cheap, single resource).
//
// Returns an HTML string (live iframe/video/img) or null (caller uses screenshot).

import { esc } from '../../utils.js';

// Convert one of our OWN /player/* or /api/content/* URLs to root-relative so
// the iframe loads from the dashboard's own origin (same-origin). For external
// URLs (e.g. wall.mbfdhub.com, youtube-nocookie.com) keep the full URL —
// stripping the origin would turn https://wall.mbfdhub.com into "/" which
// loads the DASHBOARD ROOT PAGE inside the wall card (the "bizarre image" bug).
function toRootRelative(url) {
  if (!url) return url;
  // Already root-relative
  if (!url.startsWith('http')) return url;
  try {
    const u = new URL(url);
    // Only strip origin for our OWN player/content paths on the SAME host
    if (u.host === location.host && (u.pathname.startsWith('/player/') || u.pathname.startsWith('/api/content/'))) {
      return u.pathname + u.search;
    }
    // Different host (wall.mbfdhub.com, youtube-nocookie.com, etc.) — keep full URL
    return url;
  } catch { return url; }
}

// Check if a URL is one of our own /player/* pages (for preview-mode embedding)
function isOwnPlayer(url) {
  if (!url) return false;
  try {
    const u = new URL(url, location.origin);
    return u.pathname.startsWith('/player/');
  } catch { return false; }
}

// kinds we can render as ONE live element.
export function liveEmbedHtml(nowPlaying, cls = '', opts = {}) {
  const np = nowPlaying || null;
  if (!np || !np.contentId) return null;
  const allowVideo  = opts.allowVideo !== false;
  const fallbackSrc = typeof opts.fallbackSrc === 'string' ? opts.fallbackSrc : '';
  const id   = encodeURIComponent(np.contentId);
  const klass = `mc-live-embed${cls ? ' ' + esc(cls) : ''}`;

  switch (np.kind) {
    case 'image':
      return `<img class="${klass}" src="/api/content/${id}/file" alt="" loading="lazy">`;

    case 'video':
      if (!allowVideo) return null;
      return `<video class="${klass}" src="/api/content/${id}/file" autoplay muted loop playsinline style="pointer-events:none"></video>`;

    case 'pdf':
    case 'document':
      return null;

    case 'grid': {
      // Multiview grid in the DASHBOARD: embed grid.html with &preview=1 so it
      // shows labeled cells (which channel is in which slot) but does NOT load
      // any HLS streams. The physical TV plays the full live grid; the dashboard
      // shows a zero-bandwidth preview. This prevents the CDN overload that caused
      // every camera feed to show "Reconnecting" when the dashboard opened the grid.
      if (np.remoteUrl) {
        const src = toRootRelative(np.remoteUrl);
        // Append &preview=1 (the grid URL already has ?cells=)
        const previewSrc = src + (src.includes('?') ? '&' : '?') + 'preview=1';
        return `<iframe class="${klass}" src="${esc(previewSrc)}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      return null;
    }

    case 'web':
    case 'youtube': {
      // For live HLS/camera streams: embed live ONLY in the span preview (one
      // stream is fine). In per-cell wall previews (allowVideo=false / many cells)
      // return null so the caller uses the device screenshot instead — N live HLS
      // iframes in wall cells overloads the CDN and causes "Reconnecting" on every
      // display.
      if (!allowVideo) return null;
      if (np.remoteUrl && isOwnPlayer(np.remoteUrl)) {
        const src = esc(toRootRelative(np.remoteUrl));
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      // External URL (wall.mbfdhub.com, etc.) — iframe it directly (CSP allows *.mbfdhub.com)
      if (np.remoteUrl) {
        return `<iframe class="${klass}" src="${esc(np.remoteUrl)}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      return null;
    }

    default:
      return null;
  }
}
