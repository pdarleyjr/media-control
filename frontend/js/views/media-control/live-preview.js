// live-preview.js — build a LIVE content element (img/video/iframe) for a stage
// card so the Command Center shows ACTUAL live content, not static screenshots.
//
// Key rules to avoid the CDN overload / "Reconnecting" cascade:
//   • Grid (multiview): embed one operator preview with all cells live. Only the
//     selected Command Center target gets this preview, so opening the dashboard
//     does not multiply the grid across every wall card.
//   • Individual HLS/camera streams: embed live ONLY in the span preview (one
//     stream), never in every wall cell (N streams = CDN rate-limit = reconnect).
//   • Documents/decks: render one same-origin preview at the slide index reported
//     by the physical player. The parent keeps it synchronized without sending a
//     second command to the display.
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

function appendQuery(url, values) {
  try {
    const parsed = new URL(url, location.origin);
    Object.entries(values).forEach(([key, value]) => parsed.searchParams.set(key, String(value)));
    if (parsed.origin === location.origin) return parsed.pathname + parsed.search + parsed.hash;
    return parsed.toString();
  } catch { return url; }
}

function slideNumber(nowPlaying) {
  const parsed = parseInt(nowPlaying?.slideIndex ?? nowPlaying?.slide_index ?? 1, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function playbackSeconds(nowPlaying) {
  const parsed = Number(nowPlaying?.currentTime ?? nowPlaying?.current_time ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// Modern iframe allow list. Bare "autoplay" alone triggers Firefox
// "Feature Policy: Skipping unsupported feature name autoplay" warnings;
// pair with encrypted-media + fullscreen which browsers accept.
const IFRAME_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture; web-share';

function presentationFrameHtml(src, klass, slide) {
  return `<iframe class="${klass}" src="${esc(src)}" loading="eager" allow="${IFRAME_ALLOW}" referrerpolicy="no-referrer" style="pointer-events:none" data-mc-presentation="1" data-mc-slide-index="${slide}"></iframe>`;
}

export function enableLivePreviewAudio(root = document) {
  root.querySelectorAll('video.mc-live-embed').forEach((video) => {
    video.muted = false;
    video.volume = 1;
    video.play().catch(() => {});
  });
  root.querySelectorAll('iframe.mc-live-embed').forEach((frame) => {
    try {
      const child = frame.contentWindow;
      if (child && typeof child.__mcEnableAudio === 'function') child.__mcEnableAudio();
    } catch { /* Cross-origin previews cannot expose the same-origin audio hook. */ }
  });
}

// kinds we can render as ONE live element.
export function liveEmbedHtml(nowPlaying, cls = '', opts = {}) {
  const np = nowPlaying || null;
  if (!np) return null;
  const allowVideo  = opts.allowVideo !== false;
  const audioPreview = opts.audioPreview === true;
  const fallbackSrc = typeof opts.fallbackSrc === 'string' ? opts.fallbackSrc : '';
  const id   = np.contentId ? encodeURIComponent(np.contentId) : '';
  const klass = `mc-live-embed${cls ? ' ' + esc(cls) : ''}`;
  const slide = slideNumber(np);

  if (np.remoteUrl && isOwnPlayer(np.remoteUrl)) {
    const ownPath = new URL(np.remoteUrl, location.origin).pathname;
    if (ownPath.startsWith('/player/doc/') || ownPath.startsWith('/player/deck/')) {
      const key = ownPath.startsWith('/player/doc/') ? 'page' : 'slide';
      const src = appendQuery(toRootRelative(np.remoteUrl), { [key]: slide, preview: 1 });
      return presentationFrameHtml(src, klass, slide);
    }
  }

  switch (np.kind) {
    case 'image':
      if (!id) return null;
      return `<img class="${klass}" src="/api/content/${id}/file" alt="" loading="lazy">`;

    case 'video':
      if (!allowVideo || !id) return null;
      return `<video class="${klass}" src="/api/content/${id}/file"${np.paused === true ? '' : ' autoplay'}${audioPreview ? '' : ' muted'} loop playsinline controls data-mc-video="1" data-mc-current-time="${playbackSeconds(np)}" data-mc-paused="${np.paused === true ? '1' : '0'}"></video>`;

    case 'pdf':
    case 'document': {
      if (!id) return null;
      const src = appendQuery(`/player/doc/${id}`, { page: slide, preview: 1 });
      return presentationFrameHtml(src, klass, slide);
    }

    case 'presentation':
    case 'deck': {
      if (!id) return null;
      const src = appendQuery(`/player/deck/${id}`, { slide, preview: 1 });
      return presentationFrameHtml(src, klass, slide);
    }

    case 'grid': {
      // Multiview grid in the dashboard: load every cell in one operator preview.
      // The stage renders a live element for only activePreviewDeviceId, avoiding
      // the old N-cards-times-N-streams cascade while preserving real playback.
      if (np.remoteUrl) {
        const src = toRootRelative(np.remoteUrl);
        const previewSrc = src + (src.includes('?') ? '&' : '?') + 'operator_preview=1' + (audioPreview ? '&audio_preview=1' : '');
        return `<iframe class="${klass}" src="${esc(previewSrc)}" loading="lazy" allow="${IFRAME_ALLOW}" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
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
        return `<iframe class="${klass}" src="${src}" loading="lazy" allow="${IFRAME_ALLOW}" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      // External URL (wall.mbfdhub.com, etc.) — iframe it directly (CSP allows *.mbfdhub.com)
      if (np.remoteUrl) {
        return `<iframe class="${klass}" src="${esc(np.remoteUrl)}" loading="lazy" allow="${IFRAME_ALLOW}" referrerpolicy="no-referrer" style="pointer-events:none"></iframe>`;
      }
      return null;
    }

    default:
      return null;
  }
}
