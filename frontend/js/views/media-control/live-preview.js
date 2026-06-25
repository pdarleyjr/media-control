// live-preview.js — build a LIVE content element (img/video/iframe) for a stage
// card so the Command Center shows ACTUAL live content, not static screenshots.
//
// The user explicitly wants live feeds in the dashboard — the multiview grid,
// HLS news streams, cameras — all playing live as iframes. This is safe because:
//   • The P3 (display machine) has 32GB RAM and only runs media control
//   • The GMKtec server has 160+ GB RAM
//   • All live iframes are muted (no audio decode overhead in the dashboard)
//   • HLS iframes use hls.js which is lightweight per-stream
//
// Returns an HTML string (live iframe/video/img) or null (caller uses screenshot).

import { esc } from '../../utils.js';

// Strip origin from same-origin absolute URLs so iframes load root-relative
// (same-origin = can call __mcEnableAudio etc, avoids cross-origin issues).
function toRootRelative(url) {
  if (!url || !url.startsWith('http')) return url;
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
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
      return `<iframe class="${klass}" src="/player/doc/${id}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;

    case 'grid':
      // LIVE multiview grid — embed the actual grid.html as a same-origin iframe.
      // Shows every cell playing live (HLS, cameras, YouTube) exactly as it
      // appears on the physical wall. Muted (no audio in the dashboard).
      if (np.remoteUrl) {
        const src = esc(toRootRelative(np.remoteUrl));
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      return null;

    case 'web':
    case 'youtube':
      // LIVE stream / web content — embed the actual player URL (hls.html, oz.html,
      // cam.html, youtube-nocookie, or our own /player/* pages) as a live iframe.
      // Muted by default (the dashboard doesn't play audio — that's on the wall).
      if (np.remoteUrl) {
        const src = esc(toRootRelative(np.remoteUrl));
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="autoplay; fullscreen" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      // No remoteUrl — use screenshot as fallback.
      return null;

    default:
      return null;
  }
}
