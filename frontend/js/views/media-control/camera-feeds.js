// camera-feeds.js — the "Camera Feeds" tab in the Media Control source dock.
//
// A curated catalog of Miami / Miami Beach live cameras and news streams, grouped
// into collapsible folders (News; Traffic · Skyline · Causeways; South Beach
// Streets; Beach Cams; Port & Marine; Miami Cams). Each feed is a draggable .mc-tile carrying a
// { remote_url } source — the SAME contract every other source tab uses — so the
// operator drags a camera onto a display card (or taps to route it) exactly like
// any other source. The player renders the remote_url in an <iframe> (text/html),
// which is how every live web cam / YouTube / Ozolio embed plays.
//
// Thumbnails are REAL where the provider exposes one (Ozolio live poster, YouTube
// frame still); otherwise a clean category icon stands in. No generic placeholder.
//
// This tab is FRONTEND-ONLY and additive: no DB rows, no server changes. YouTube
// cams use the youtube-nocookie.com/embed form on purpose — it is NOT matched by
// the send funnel's YouTube regex, so it flows through as a plain web embed and is
// NOT transcoded by yt-dlp (which would break a 24/7 live stream).

import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { attachTileHandlers } from './toolbox.js';
import { CAMERA_FEED_GROUPS } from './camera-feeds-catalog.js';

// Folder glyphs — stroke icons in the dashboard's SVG vocabulary (24x24, no fill).
const GROUP_ICONS = {
  // Broadcast tower — live news.
  news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path><path d="M12 14v8"></path><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"></path><path d="M5 5a9 9 0 0 0 0 14M19 5a9 9 0 0 1 0 14"></path></svg>',
  // Suspension bridge — traffic / skyline / causeways.
  skyline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h20"></path><path d="M4 18V8M20 18V8"></path><path d="M4 9c4 4 12 4 16 0"></path><path d="M9 18v-5M15 18v-5M12 18v-7"></path></svg>',
  // City skyline — street views.
  street: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M5 21V7l5-4v18"></path><path d="M10 21V9l5 3v9"></path><path d="M19 21V12l-4-2"></path><path d="M8 7h.01M8 11h.01M8 15h.01"></path></svg>',
  // Sun over water — beaches / coastal.
  beach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"></circle><path d="M12 1.5v1M12 13.5v1M4.5 8h1M18.5 8h1M6.4 2.4l.7.7M16.9 13.9l.7.7M17.6 2.4l-.7.7M7.1 13.9l-.7.7"></path><path d="M2 19c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"></path><path d="M2 22.5c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"></path></svg>',
  // Anchor — port & marine.
  marine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"></circle><path d="M12 7v15"></path><path d="M5 12H3a9 9 0 0 0 18 0h-2"></path><path d="M8 11H5M19 11h-3"></path></svg>',
  // Map pin — greater-Miami cams.
  miami: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
};

// Tile fallback icon (no provider thumbnail) — a small live-camera glyph.
const TILE_CAM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"></path><path d="M15 10l6-3v10l-6-3"></path></svg>';

// Resolve a feed's thumbnail-hint to a real <img>, or fall back to the folder icon.
//   "ozolio:<OID>"  -> live poster        "youtube:<ID>" -> frame still
//   "https://..."   -> direct image       (anything else) -> category icon
function thumbHtml(feed, groupId) {
  let url = null;
  const hint = feed.thumb || '';
  if (hint.startsWith('ozolio:')) {
    url = `https://relay.ozolio.com/pub.api?cmd=poster&oid=${encodeURIComponent(hint.slice(7))}`;
  } else if (hint.startsWith('youtube:')) {
    url = `https://i.ytimg.com/vi/${encodeURIComponent(hint.slice(8))}/hqdefault.jpg`;
  } else if (/^https:\/\//i.test(hint)) {
    url = hint;
  }
  if (url) {
    return `<img class="mc-tile-thumb" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const icon = GROUP_ICONS[groupId] || TILE_CAM_ICON;
  return `<span class="mc-tile-icon mc-tile-icon-svg mc-cf-tile-ico" aria-hidden="true">${icon}</span>`;
}

function tileHtml(feed, groupId) {
  const src = JSON.stringify({ remote_url: feed.url });
  const name = feed.title || t('mc.tile.content_fallback');
  // Snapshot feeds (FDOT publishes no video, only a refreshing still) carry a
  // small honest sub-label so the operator knows it updates, not full-motion.
  const sub = feed.kind === 'snapshot'
    ? `<span class="mc-tile-sub">${esc(t('mc.cf.snapshot'))}</span>` : '';
  return `<button type="button" class="mc-tile mc-cf-tile" draggable="true"
    data-drag-source='${esc(src)}'
    data-label="${esc(name)}"
    title="${esc(name)}">
    ${thumbHtml(feed, groupId)}
    <span class="mc-tile-label">${esc(name)}</span>
    ${sub}
  </button>`;
}

function groupHtml(group) {
  const icon = GROUP_ICONS[group.id] || TILE_CAM_ICON;
  const name = t(group.nameKey);
  const count = group.feeds.length;
  const tiles = group.feeds.map((f) => tileHtml(f, group.id)).join('');
  return `<details class="mc-cf-group" open>
    <summary class="mc-cf-group-head">
      <span class="mc-cf-group-ico" aria-hidden="true">${icon}</span>
      <span class="mc-cf-group-title">${esc(name)}</span>
      <span class="mc-cf-count">${esc(tn('mc.cf.feed_count', count))}</span>
    </summary>
    <div class="mc-tile-grid">${tiles}</div>
  </details>`;
}

/**
 * Render the Camera Feeds tab into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string[]} opts.selectedIds
 * @param {()=>void} [opts.onAfterSend]
 * @param {(source:object,label:string)=>Promise<boolean>} [opts.onRouteSource]
 */
export function renderCameraFeedsTab(container, { selectedIds, onAfterSend, onRouteSource } = {}) {
  const groups = (CAMERA_FEED_GROUPS || []).filter((g) => g && Array.isArray(g.feeds) && g.feeds.length);
  if (!groups.length) {
    container.innerHTML = `<div class="mc-tb-state mc-tb-empty"><span>${esc(t('mc.cf.empty'))}</span></div>`;
    return;
  }
  const hint = `<p class="mc-cf-hint">${esc(t('mc.cf.hint'))}</p>`;
  container.innerHTML = hint + `<div class="mc-cf-groups">${groups.map(groupHtml).join('')}</div>`;
  // Reuse the toolbox tile wiring verbatim: tap = route via picker, drag = serialize
  // the { remote_url } source onto the DataTransfer for a drop on a stage card.
  attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource);
}
