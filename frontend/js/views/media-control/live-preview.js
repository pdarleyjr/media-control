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
    case 'web':
      return `<iframe class="${klass}" src="/player/site.html?id=${id}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    default:
      return null; // idle / playlist / widget / youtube / content(unknown) -> screenshot fallback
  }
}
