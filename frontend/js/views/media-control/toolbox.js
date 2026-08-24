// toolbox.js — the six-category Content Library shelf in the unified Media
// Control Command Center. The categories are operator concepts, not storage
// types: Videos · Images · Docs · Sources · Live Feeds · Additional Controls.
// The separate full Media Library keeps its administrative folder/type surface.
//
// Clicking a tile opens the Command Center routing picker. Dropping a tile on a
// stage card still calls sendToDisplays() for the explicit single-card target.
//
// Drag-drop from toolbox tiles onto stage cards is coordinated from the CALLER
// (media-control.js): toolbox tiles carry [data-drag-source] with a JSON payload
// so that drag events on stage cards can extract the source and call
// sendToDisplays(). This module sets up the dragstart on its own tiles.

import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { api } from '../../api.js';
import { sendToDisplays, sentToast, trackBroadcastDelivery } from './send.js';
import { showToast } from '../../components/toast.js';
import { renderLiveFeedsTab, renderManagedSourcesTab } from './camera-feeds.js';

let activeTab = 'videos';

const TABS = Object.freeze([
  { id: 'videos',     label: 'Videos' },
  { id: 'images',     label: 'Images' },
  { id: 'docs',       label: 'Docs' },
  { id: 'sources',    label: 'Sources' },
  { id: 'livefeeds',  label: 'Live Feeds' },
  { id: 'additional', label: 'Additional Controls' },
]);

const TAB_ALIASES = Object.freeze({
  media: 'videos',
  camerafeeds: 'sources',
  presentations: 'docs',
  youtube: 'sources',
  nextcloud: 'sources',
  playlists: 'additional',
  scenes: 'additional',
});

export function normalizeToolboxTab(tabId) {
  const requested = String(tabId || '').toLowerCase();
  const normalized = TAB_ALIASES[requested] || requested;
  return TABS.some((tab) => tab.id === normalized) ? normalized : 'videos';
}

// This mirrors the supported document renderer contract: PDF, Microsoft Office,
// OpenXML Office, and OpenDocument only. It deliberately does not admit every
// application/* row.
const SUPPORTED_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

function trustedMime(item) {
  return String(
    item?.media?.detected_mime_type
    || item?.detected_mime_type
    || item?.mime_type
    || ''
  ).toLowerCase();
}

function contentCategory(item) {
  const mime = trustedMime(item);
  if (mime.startsWith('video/')) return 'videos';
  if (mime.startsWith('image/')) return 'images';
  if (SUPPORTED_DOCUMENT_MIMES.has(mime)) return 'docs';
  // Standalone audio is accepted by the full Media Library but the normal
  // display player has no standalone audio routing/render path. Keep it out of
  // Command Center rather than presenting a route action that cannot complete.
  if (mime.startsWith('audio/')) return null;
  return null;
}

// Playlist tile glyph (stroke icon, matches the dashboard's SVG vocabulary).
const ICON_PLAYLIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="4" cy="6" r="1"></circle><circle cx="4" cy="12" r="1"></circle><circle cx="4" cy="18" r="1"></circle></svg>';

// ---- composed state blocks (never a bare sentence) ----
const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';
const failedThumbnailUrls = new Set();
const MAX_FAILED_THUMBNAILS = 200;

function rememberFailedThumbnailUrl(url) {
  if (!url) return;
  if (failedThumbnailUrls.size >= MAX_FAILED_THUMBNAILS) {
    failedThumbnailUrls.delete(failedThumbnailUrls.values().next().value);
  }
  failedThumbnailUrls.add(url);
}

function loadingState(msg) {
  return `<div class="mc-tb-state mc-tb-loading"><span class="mc-tb-spin" aria-hidden="true"></span><span>${esc(msg)}</span></div>`;
}
function emptyState(msg) {
  return `<div class="mc-tb-state mc-tb-empty"><span class="mc-tb-state-ico" aria-hidden="true">${ICON_EMPTY}</span><span>${esc(msg)}</span></div>`;
}
function errorState(msg) {
  return `<div class="mc-tb-state mc-tb-error" role="alert"><span class="mc-tb-state-ico" aria-hidden="true">${ICON_ERROR}</span><span>${esc(msg)}</span></div>`;
}

// Tile preview: real thumbnail when one exists, else a type-aware glyph so a
// document never shows the generic image placeholder (or, in the library, a
// broken <img> pointed at raw document bytes).
function mediaTileGlyph(item) {
  const mt = trustedMime(item);
  let glyph = '🖼';
  if (item.remote_url) glyph = '🔗';
  else if (/pdf/.test(mt)) glyph = '📕';
  else if (/presentation|ms-powerpoint/.test(mt)) glyph = '📊';
  else if (/wordprocessing|msword|opendocument\.text/.test(mt)) glyph = '📄';
  else if (/spreadsheet|ms-excel/.test(mt)) glyph = '📈';
  else if (mt.startsWith('video/')) glyph = '🎬';
  return glyph;
}

function mediaTileThumb(item) {
  const url = String(item.thumbnail_url || '');
  const fallback = `<span class="mc-tile-icon mc-tile-thumb-fallback" data-thumb-fallback${url && !failedThumbnailUrls.has(url) ? ' hidden' : ''}>${mediaTileGlyph(item)}</span>`;
  if (!url || failedThumbnailUrls.has(url)) return fallback;
  return `<img class="mc-tile-thumb" data-media-thumb data-thumb-url="${esc(url)}" src="${esc(url)}" alt="" loading="lazy" decoding="async">${fallback}`;
}

function wireMediaThumbnailFallbacks(root) {
  root.querySelectorAll('img[data-media-thumb]').forEach((img) => {
    const showFallback = () => {
      rememberFailedThumbnailUrl(img.dataset.thumbUrl || img.currentSrc || img.src);
      img.hidden = true;
      const fallback = img.nextElementSibling;
      if (fallback?.matches('[data-thumb-fallback]')) fallback.hidden = false;
    };
    img.addEventListener('error', showFallback, { once: true });
    if (img.complete && img.naturalWidth === 0) showFallback();
  });
}

function mediaTileName(item) {
  const storedName = String(item.filename || item.name || '').trim();
  if (storedName && storedName.toLowerCase() !== 'remote') return storedName;
  if (item.remote_url) {
    try {
      return new URL(item.remote_url).hostname || storedName || t('mc.tile.content_fallback');
    } catch {
      // The server validates remote URLs. Preserve a useful local fallback if
      // a legacy row predates that validation.
    }
  }
  return storedName || t('mc.tile.content_fallback');
}

// ---- tab content renderers ----

// Secure content download (task §13). Fetches the file as an authenticated
// Blob (token in the Authorization header, NEVER in the URL) and triggers a
// save-to-disk via a temporary object URL. Never broadcasts, never changes
// playback, never selects a display target.
async function downloadContentItem(id, name) {
  try {
    const { blob, filename } = await api.downloadContent(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(t('mc.media.download_started'), 'success');
  } catch (e) {
    const msg = e?.status === 403 ? t('mc.media.download_forbidden')
      : e?.status === 404 ? t('mc.media.download_missing')
      : (e?.message || t('mc.media.download_failed'));
    showToast(msg, 'error');
  }
}

const MEDIA_SORTS = [
  { id: 'newest', key: 'mc.media.sort_newest' },
  { id: 'name',   key: 'mc.media.sort_name' },
  { id: 'type',   key: 'mc.media.sort_type' },
];

async function renderMediaCategoryTab(container, { selectedIds, onAfterSend, onRouteSource }, category, context = {}) {
  const PAGE = 60;
  const state = {
    folder: category === 'images' && context.folder ? String(context.folder) : undefined,
    search: '',
    sort: 'newest',
    items: [],
    offset: 0,
    hasMore: true,
    loading: false,
    requestGeneration: 0,
    requestController: null,
  };

  container.innerHTML = `
    <div class="mc-tb-media-toolbar">
      <div class="mc-tb-context-filter-host"></div>
      <div class="mc-tb-media-controls">
        <input class="mc-tb-search" id="mc-media-search" type="search" placeholder="${esc(t('mc.media.search_placeholder'))}" autocomplete="off">
        <select class="mc-tb-sort" id="mc-media-sort" aria-label="${esc(t('mc.media.sort_label'))}">
          ${MEDIA_SORTS.map(o => `<option value="${esc(o.id)}"${o.id === state.sort ? ' selected' : ''}>${esc(t(o.key))}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="mc-tb-media-status" id="mc-media-status"></div>
    <div class="mc-tile-grid" id="mc-media-grid"></div>
    <div class="mc-tb-loadmore-wrap" id="mc-media-loadmore-wrap"></div>`;

  const grid = container.querySelector('#mc-media-grid');
  const statusEl = container.querySelector('#mc-media-status');
  const contextFilterHost = container.querySelector('.mc-tb-context-filter-host');
  const loadmoreWrap = container.querySelector('#mc-media-loadmore-wrap');

  function renderContextFilter() {
    if (!state.folder) {
      contextFilterHost.replaceChildren();
      return;
    }
    contextFilterHost.innerHTML = `
      <div class="mc-tb-context-filter" data-context-filter="${esc(state.folder)}" role="status">
        <span>Images in <strong>${esc(state.folder)}</strong></span>
        <button type="button" data-clear-context-filter aria-label="Clear ${esc(state.folder)} image filter">Clear filter</button>
      </div>`;
    contextFilterHost.querySelector('[data-clear-context-filter]').addEventListener('click', () => {
      state.folder = undefined;
      delete context.folder;
      renderContextFilter();
      loadPage({ offset: 0, append: false });
    });
  }

  function sortItems(items) {
    const s = state.sort;
    const arr = items.slice();
    if (s === 'name') arr.sort((a, b) => String(a.filename || a.name || '').localeCompare(String(b.filename || b.name || '')));
    else if (s === 'type') arr.sort((a, b) => trustedMime(a).localeCompare(trustedMime(b)));
    else arr.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    return arr;
  }

  function tileHtml(item) {
    const src = JSON.stringify({ content_id: item.id });
    const name = mediaTileName(item);
    const thumb = mediaTileThumb(item);
    const downloadable = !!item.filepath;
    return `<div class="mc-tile-cell">
      <button type="button" class="mc-tile" draggable="true"
        data-drag-source='${esc(src)}'
        data-label="${esc(name)}"
        title="${esc(name)}">
        ${thumb}
        <span class="mc-tile-label">${esc(name)}</span>
      </button>
      ${downloadable ? `<button type="button" class="mc-tile-dl" data-download-id="${esc(item.id)}" data-download-name="${esc(name)}" title="${esc(t('mc.media.download'))}" aria-label="${esc(t('mc.media.download'))} ${esc(name)}">⬇</button>` : ''}
    </div>`;
  }

  function renderGrid() {
    grid.innerHTML = state.items.length ? state.items.map(tileHtml).join('') : '';
    wireMediaThumbnailFallbacks(grid);
    attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource);
    grid.querySelectorAll('[data-download-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        downloadContentItem(btn.dataset.downloadId, btn.dataset.downloadName);
      });
    });
  }

  function renderLoadMore() {
    loadmoreWrap.innerHTML = state.hasMore
      ? `<button type="button" class="mc-btn mc-tb-loadmore" id="mc-media-loadmore"${state.loading ? ' disabled aria-busy="true"' : ''}>${esc(t('mc.media.load_more'))}</button>`
      : (state.items.length ? `<div class="mc-tb-end">${esc(t('mc.media.end_of_list'))}</div>` : '');
    const lm = loadmoreWrap.querySelector('#mc-media-loadmore');
    if (lm) lm.addEventListener('click', () => {
      if (state.loading) return;
      loadPage({ offset: state.offset + PAGE, append: true });
    });
  }

  function renderStatus() {
    if (state.loading) { statusEl.innerHTML = `<span class="mc-tb-spin" aria-hidden="true"></span><span>${esc(t('mc.tb.loading_media'))}</span>`; return; }
    if (!state.items.length && state.search) { statusEl.innerHTML = `<span>${esc(t('mc.media.no_search_results'))}</span>`; return; }
    if (!state.items.length) { statusEl.innerHTML = `<span>${esc(t('mc.media.empty'))}</span>`; return; }
    statusEl.innerHTML = `<span>${esc(t('mc.media.count', { n: state.items.length }))}</span>`;
  }

  async function loadPage({ offset = 0, append = false } = {}) {
    const requestGeneration = ++state.requestGeneration;
    if (state.requestController) state.requestController.abort();
    const controller = new AbortController();
    state.requestController = controller;
    state.loading = true;
    renderStatus();
    renderLoadMore();
    let failed = false;
    let succeeded = false;
    try {
      const result = await api.getGovernedContent({
        folder: state.folder,
        search: state.search || undefined,
        limit: PAGE,
        offset,
      }, { signal: controller.signal });
      if (requestGeneration !== state.requestGeneration) return;
      const page = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
      const sorted = sortItems(page.filter((item) => contentCategory(item) === category));
      state.items = append ? state.items.concat(sorted) : sorted;
      state.offset = offset;
      state.hasMore = page.length === PAGE;
      if (!state.items.length) grid.innerHTML = '';
      else renderGrid();
      succeeded = true;
    } catch (e) {
      if (e?.name === 'AbortError' || requestGeneration !== state.requestGeneration) return;
      failed = true;
      if (!append) {
        state.items = [];
        state.offset = 0;
        state.hasMore = false;
        grid.innerHTML = '';
      }
      statusEl.innerHTML = `<span class="mc-tb-error-text">${esc(t('mc.media.error', { error: e?.message || '' }))}</span>`;
    } finally {
      if (requestGeneration === state.requestGeneration) {
        state.requestController = null;
        state.loading = false;
        renderLoadMore();
        if (succeeded || !failed) renderStatus();
      }
    }
  }

  renderContextFilter();

  // Debounced search + filter/sort change resets to page 1.
  let searchTimer = null;
  container.querySelector('#mc-media-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = (e.target.value || '').trim();
      loadPage({ offset: 0, append: false });
    }, 300);
  });
  container.querySelector('#mc-media-sort').addEventListener('change', (e) => {
    state.sort = e.target.value; state.items = sortItems(state.items); renderGrid();
  });

  await loadPage({ offset: 0, append: false });
}

// Playlists tab — every playlist is a drag-or-tap source ({ playlist_id }); the
// send funnel already accepts playlist_id. A "Manage playlists" link opens the
// full builder (kept reachable, just no longer a sidebar item). The item count +
// a Draft badge ride on each tile so the operator picks the right one at a glance.
async function renderPlaylistsTab(container, { selectedIds, onAfterSend, onRouteSource }) {
  container.innerHTML = loadingState(t('mc.tb.loading_playlists'));
  let items = [];
  try {
    const result = await api.getPlaylists();
    items = Array.isArray(result) ? result : (result && Array.isArray(result.playlists) ? result.playlists : []);
  } catch (e) {
    container.innerHTML = errorState(t('mc.playlists.error', { error: e?.message || '' }));
    return;
  }
  const manage = `<div class="mc-tb-head"><a class="mc-tb-manage" href="#/playlists">${esc(t('mc.playlists.manage'))}</a></div>`;
  if (items.length === 0) {
    container.innerHTML = manage + emptyState(t('mc.playlists.empty'));
    return;
  }
  const tiles = items.map(item => {
    const src = JSON.stringify({ playlist_id: item.id });
    const name = item.name || t('mc.tile.playlist_fallback');
    const count = tn('mc.playlists.items', item.item_count || 0);
    const draft = item.status === 'draft'
      ? `<span class="mc-tile-badge">${esc(t('mc.playlists.draft'))}</span>` : '';
    return `<button type="button" class="mc-tile" draggable="true"
      data-drag-source='${esc(src)}'
      data-label="${esc(name)}"
      title="${esc(name)}">
      <span class="mc-tile-icon mc-tile-icon-svg" aria-hidden="true">${ICON_PLAYLIST}</span>
      ${draft}
      <span class="mc-tile-label">${esc(name)}</span>
      <span class="mc-tile-sub">${esc(count)}</span>
    </button>`;
  }).join('');
  container.innerHTML = manage + `<div class="mc-tile-grid">${tiles}</div>`;
  attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource);
}

async function renderPresentationsTab(container, { selectedIds, onAfterSend, onRouteSource }) {
  container.innerHTML = loadingState(t('mc.tb.loading_presentations'));
  let items = [];
  try {
    const result = await api.presentations.list();
    items = Array.isArray(result) ? result : (result && Array.isArray(result.presentations) ? result.presentations : []);
  } catch (e) {
    container.innerHTML = errorState(t('mc.presentations.error', { error: e?.message || '' }));
    return;
  }
  if (items.length === 0) {
    container.innerHTML = emptyState(t('mc.presentations.empty'));
    return;
  }
  const tiles = items.map(item => {
    const src = JSON.stringify({ presentation_id: item.id });
    const name = item.title || t('mc.tile.presentation_fallback');
    return `<button type="button" class="mc-tile" draggable="true"
      data-drag-source='${esc(src)}'
      data-label="${esc(name)}"
      title="${esc(name)}">
      <span class="mc-tile-icon">📊</span>
      <span class="mc-tile-label">${esc(name)}</span>
    </button>`;
  }).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource);
}

function renderYouTubeTab(container, { selectedIds, onAfterSend, onRouteSource }) {
  container.innerHTML = `
    <form class="mc-yt-form" data-yt-form>
      <label class="mc-tb-label" for="mc-yt-url">${esc(t('mc.youtube.label'))}</label>
      <div class="mc-yt-row">
        <input class="mc-yt-input" id="mc-yt-url" type="url" inputmode="url"
               placeholder="${esc(t('mc.youtube.placeholder'))}" autocomplete="off">
        <button type="submit" class="mc-btn mc-btn-primary">${esc(t('mc.youtube.send'))}</button>
      </div>
    </form>`;
  container.querySelector('[data-yt-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = (container.querySelector('.mc-yt-input').value || '').trim();
    if (!url) { showToast(t('mc.youtube.need_url'), 'error'); return; }
    const ok = typeof onRouteSource === 'function'
      ? await onRouteSource({ remote_url: url }, url)
      : await sendToDisplays({ remote_url: url }, selectedIds, url);
    if (ok && typeof onAfterSend === 'function' && typeof onRouteSource !== 'function') onAfterSend();
    if (ok) container.querySelector('.mc-yt-input').value = '';
  });
}

// ---- Nextcloud tab ----
// Lists the signed-in member's own NC files via api.files.list(path), with
// folder navigation. image/* and video/* rows get a "Broadcast" tile button;
// clicking calls api.files.broadcast using the shared confirm-all 409 gate.
// Presentations (deck player path) are intentionally NOT shown here — use Docs.
// The email comes from the JWT (server-enforced); the client
// never sends it.
async function renderNextcloudTab(container, { selectedIds, onAfterSend, onRouteNextcloud }, path = '') {
  container.innerHTML = loadingState(t('mc.tb.loading_nextcloud'));
  let health;
  // error:null (not a literal) so the localized t('mc.nc.unreachable') tail fires.
  try { health = await api.files.health(); } catch { health = { enabled: true, connected: false, error: null }; }
  if (health.enabled === false) {
    container.innerHTML = errorState(t('mc.nc.disabled'));
    return;
  }
  if (!health.connected) {
    container.innerHTML = errorState(`${t('mc.nc.not_connected')} ${health.error || t('mc.nc.unreachable')}`);
    return;
  }

  let items = [];
  try {
    items = await api.files.list(path);
    if (!Array.isArray(items)) items = [];
  } catch (e) {
    container.innerHTML = errorState(t('mc.nc.list_error', { error: e?.message || '' }));
    return;
  }

  // Breadcrumb back-navigation
  const parts = path.split('/').filter(Boolean);
  const crumbs = [`<span class="mc-nc-crumb" data-nc-path="">${esc(t('mc.nc.root'))}</span>`];
  let acc = '';
  parts.forEach((p) => { acc += '/' + p; crumbs.push(`<span class="mc-nc-crumb" data-nc-path="${esc(acc)}">${esc(p)}</span>`); });

  const mediaTypes = /^(image|video)\//;

  const rows = items.length
    ? items.map((it) => {
        const isBroadcastable = !it.is_dir && mediaTypes.test(it.mime_type || '');
        return `<div class="mc-nc-row" ${it.is_dir ? `data-nc-dir="${esc(it.path)}"` : ''}>
          <span class="mc-nc-icon">${it.is_dir ? '📁' : '📄'}</span>
          <span class="mc-nc-name" title="${esc(it.path)}">${esc(it.name)}</span>
          ${isBroadcastable
            ? `<button type="button" class="mc-btn mc-btn-sm mc-nc-broadcast" data-nc-path="${esc(it.path)}" data-nc-label="${esc(it.name)}" title="${esc(t('mc.nc.broadcast_title'))}">${esc(t('mc.nc.broadcast'))}</button>`
            : ''}
        </div>`;
      }).join('')
    : emptyState(t('mc.nc.empty'));

  container.innerHTML = `
    <div class="mc-nc-crumbs">${crumbs.join('<span class="mc-nc-sep">/</span>')}</div>
    <div class="mc-nc-list">${rows}</div>`;

  // Breadcrumb navigation
  container.querySelectorAll('.mc-nc-crumb').forEach((el) => {
    el.addEventListener('click', () => {
      renderNextcloudTab(container, { selectedIds, onAfterSend, onRouteNextcloud }, el.dataset.ncPath || '');
    });
  });

  // Folder drill-down
  container.querySelectorAll('[data-nc-dir]').forEach((el) => {
    el.addEventListener('click', () => {
      renderNextcloudTab(container, { selectedIds, onAfterSend, onRouteNextcloud }, el.dataset.ncDir);
    });
  });

  // Broadcast buttons — import NC bytes to a content row, then push to displays.
  // GUARDRAIL: email comes from req.user.email server-side, never from the client.
  container.querySelectorAll('.mc-nc-broadcast').forEach((btn) => {
    const restore = () => { btn.disabled = false; btn.textContent = t('mc.nc.broadcast'); };
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (typeof onRouteNextcloud !== 'function'
        && (!Array.isArray(selectedIds) || selectedIds.length === 0)) {
        showToast(t('mc.nc.no_displays'), 'error');
        return;
      }
      btn.disabled = true; btn.textContent = '…';
      const ncPath = btn.dataset.ncPath;
      const label = btn.dataset.ncLabel || ncPath;
      try {
        if (typeof onRouteNextcloud === 'function') {
          const ok = await onRouteNextcloud(ncPath, label);
          if (!ok) restore();
          return;
        }
        const result = await api.files.broadcast(ncPath, selectedIds);
        if (result && result.success) {
          if (result.request_id) {
            const delivery = await trackBroadcastDelivery(result.request_id, label, result.delivery || null);
            if (delivery?.status === 'confirmed' && typeof onAfterSend === 'function') onAfterSend();
          } else {
            sentToast(label, Number(result.sent) || 0, Number(result.total) || 0);
            if (typeof onAfterSend === 'function') onAfterSend();
          }
        }
      } catch (err) {
        showToast(err?.message || t('mc.send.failed'), 'error');
      } finally {
        restore();
      }
    });
  });
}

async function renderScenesTab(container, { onAfterSend }) {
  container.innerHTML = loadingState(t('mc.tb.loading_scenes'));
  let scenes = [];
  try {
    const result = await api.scenes.list();
    scenes = Array.isArray(result) ? result : (result && Array.isArray(result.scenes) ? result.scenes : []);
  } catch (e) {
    container.innerHTML = errorState(t('mc.scenes.error', { error: e?.message || '' }));
    return;
  }
  if (scenes.length === 0) {
    container.innerHTML = emptyState(t('mc.scenes.empty'));
    return;
  }
  const tiles = scenes.map(sc => {
    const name = sc.name || t('mc.tile.scene_fallback');
    return `
    <button type="button" class="mc-tile mc-scene-tile" data-scene-id="${esc(sc.id)}"
            data-scene-name="${esc(name)}" title="${esc(name)}">
      <span class="mc-tile-icon">🎬</span>
      <span class="mc-tile-label">${esc(name)}</span>
    </button>`;
  }).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  container.querySelectorAll('[data-scene-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.sceneId;
      const name = btn.dataset.sceneName || t('mc.tile.scene_fallback');
      try {
        const result = await api.scenes.trigger(id);
        if (result?.request_id) {
          const delivery = await trackBroadcastDelivery(result.request_id, name, result.delivery || null);
          if (delivery?.status === 'confirmed' && typeof onAfterSend === 'function') onAfterSend();
        } else {
          showToast(t('mc.scenes.triggered', { name }), 'success');
          if (typeof onAfterSend === 'function') onAfterSend();
        }
      } catch (e) {
        showToast(e?.message || t('mc.scenes.trigger_failed'), 'error');
      }
    });
  });
}

function categorySection(title, className) {
  return `<section class="mc-tb-category-section ${className}"><h3>${esc(title)}</h3><div class="mc-tb-category-host"></div></section>`;
}

async function renderDocsCategory(container, options, context) {
  container.innerHTML = categorySection('Files', 'mc-tb-doc-files')
    + categorySection('Media Control presentations', 'mc-tb-doc-presentations');
  const filesHost = container.querySelector('.mc-tb-doc-files .mc-tb-category-host');
  const presentationsHost = container.querySelector('.mc-tb-doc-presentations .mc-tb-category-host');
  await Promise.all([
    renderMediaCategoryTab(filesHost, options, 'docs', context),
    renderPresentationsTab(presentationsHost, options),
  ]);
}

async function renderSourcesCategory(container, options) {
  container.innerHTML = categorySection('Managed sources', 'mc-tb-managed-sources')
    + categorySection('YouTube or URL', 'mc-tb-url-source')
    + categorySection('Nextcloud', 'mc-tb-nextcloud-source');
  const managedHost = container.querySelector('.mc-tb-managed-sources .mc-tb-category-host');
  const urlHost = container.querySelector('.mc-tb-url-source .mc-tb-category-host');
  const nextcloudHost = container.querySelector('.mc-tb-nextcloud-source .mc-tb-category-host');
  renderYouTubeTab(urlHost, options);
  await Promise.all([
    renderManagedSourcesTab(managedHost, options),
    renderNextcloudTab(nextcloudHost, options),
  ]);
}

async function renderAdditionalCategory(container, options) {
  container.innerHTML = categorySection('Actions', 'mc-tb-additional-actions')
    + categorySection('Playlists', 'mc-tb-additional-playlists')
    + categorySection('Scenes', 'mc-tb-additional-scenes');
  const actionsHost = container.querySelector('.mc-tb-additional-actions .mc-tb-category-host');
  if (typeof options.onMountAdditionalControls === 'function') {
    options.onMountAdditionalControls(actionsHost);
  }
  await Promise.all([
    renderPlaylistsTab(container.querySelector('.mc-tb-additional-playlists .mc-tb-category-host'), options),
    renderScenesTab(container.querySelector('.mc-tb-additional-scenes .mc-tb-category-host'), options),
  ]);
}

// Attach click + dragstart on toolbox tiles that call sendToDisplays.
// Exported so the Camera Feeds tab (camera-feeds.js) reuses the identical
// tap-to-route + drag-to-card wiring instead of duplicating it.
const TOUCH_DROP_SELECTOR = [
  '.mc-wall-region[data-layout-group-id][data-wall-id]',
  '.mc-display-card[data-device-id]',
  '.mc-wall-cell[data-device-id]',
  '.mc-wall-split-half[data-device-id][data-split-half]',
  '.mc-wall-all[data-wall-ids]',
  '#mc-stage',
].join(',');

function touchDropTargetAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const groupedRegion = hit.closest('.mc-wall-region[data-layout-group-id][data-wall-id]');
  if (groupedRegion) return groupedRegion;
  const target = hit.closest(TOUCH_DROP_SELECTOR);
  if (!target) return null;
  if (target.classList.contains('mc-wall-cell') &&
      target.closest('.mc-wall')?.dataset.layoutMode !== 'split') {
    return target.closest('.mc-wall')?.querySelector('.mc-wall-all[data-wall-ids]') ||
      target.closest('#mc-stage');
  }
  return target;
}

function setTouchDropHighlight(target, enabled) {
  if (!target) return;
  const highlightClass = target.classList.contains('mc-wall-all')
    ? 'mc-wall-all-dragover'
    : target.id === 'mc-stage' ? 'mc-stage-dragover' : 'mc-card-dragover';
  target.classList.toggle(highlightClass, enabled);
}

function attachTouchDrag(tile, suppressClick) {
  tile.addEventListener('pointerdown', (event) => {
    if (!(event.pointerType === 'touch' || event.pointerType === 'pen')) return;
    try { tile.setPointerCapture(event.pointerId); } catch { /* unsupported renderer */ }
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost = null;
    let target = null;

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 8) return;
      if (!dragging) {
        dragging = true;
        suppressClick();
        ghost = tile.cloneNode(true);
        ghost.className = 'mc-touch-drag-ghost';
        ghost.removeAttribute('id');
        ghost.removeAttribute('draggable');
        document.body.appendChild(ghost);
      }
      moveEvent.preventDefault();
      ghost.style.left = `${moveEvent.clientX}px`;
      ghost.style.top = `${moveEvent.clientY}px`;
      const nextTarget = touchDropTargetAt(moveEvent.clientX, moveEvent.clientY);
      if (nextTarget !== target) {
        setTouchDropHighlight(target, false);
        target = nextTarget;
        setTouchDropHighlight(target, true);
      }
    };

    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', finish);
      tile.removeEventListener('pointercancel', cancel);
      try { tile.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      if (dragging) {
        finishEvent.preventDefault();
        const source = (() => { try { return JSON.parse(tile.dataset.dragSource); } catch { return null; } })();
        if (target && source) {
          const thumbImg = tile.querySelector('img');
          target.dispatchEvent(new CustomEvent('mc:source-drop', {
            bubbles: true,
            detail: {
              source,
              label: tile.dataset.label || t('mc.tile.content_fallback'),
              thumb: thumbImg && (thumbImg.currentSrc || thumbImg.src) || '',
            },
          }));
        }
      }
      setTouchDropHighlight(target, false);
      ghost?.remove();
    };
    const cancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      const highlightedTarget = target;
      target = null;
      finish(cancelEvent);
      setTouchDropHighlight(highlightedTarget, false);
    };

    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', finish);
    tile.addEventListener('pointercancel', cancel);
  });
}

export function attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource) {
  container.querySelectorAll('.mc-tile[data-drag-source]').forEach(tile => {
    let suppressNextClick = false;
    let suppressClickTimer = null;
    // Click = explicit target picker in Command Center; fallback preserves the
    // legacy immediate send contract for other callers/tests.
    tile.addEventListener('click', async (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      let source;
      try { source = JSON.parse(tile.dataset.dragSource); } catch { return; }
      const label = tile.dataset.label || t('mc.tile.content_fallback');
      const ok = typeof onRouteSource === 'function'
        ? await onRouteSource(source, label)
        : await sendToDisplays(source, selectedIds, label);
      if (ok && typeof onAfterSend === 'function' && typeof onRouteSource !== 'function') onAfterSend();
    });

    // Dragstart = serialize source onto the DataTransfer so stage cards can
    // receive it as a drop and call sendToDisplays({ source }, [deviceId]).
    // Also carry the tile's thumbnail (if it has a real image, not just an icon)
    // so the Multiview composer can show that picture inside the cell it's
    // dropped into. Tiles with only a glyph carry no thumb → the cell falls back
    // to a category icon + the source label (which still identifies the feed).
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-source', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-label', tile.dataset.label || t('mc.tile.content_fallback'));
      const thumbImg = tile.querySelector('img');
      const thumbSrc = thumbImg && (thumbImg.currentSrc || thumbImg.src);
      if (thumbSrc) e.dataTransfer.setData('application/x-mc-thumb', thumbSrc);
    });
    attachTouchDrag(tile, () => {
      suppressNextClick = true;
      if (suppressClickTimer) clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => { suppressNextClick = false; }, 700);
    });
  });
}

// Load and render the given tab into the tab-body container.
function clearLiveSourceTimers(root) {
  if (!root) return;
  [root, ...root.querySelectorAll('*')].forEach((element) => {
    if (!element._liveSourcesTimer) return;
    clearTimeout(element._liveSourcesTimer);
    element._liveSourcesTimer = null;
  });
}

async function loadTab(tabId, tabBody, options, context = {}) {
  const { selectedIds, onAfterSend, onRouteSource, onRouteNextcloud, onMountAdditionalControls, onBeforeToolboxReplace } = options;
  if (typeof onBeforeToolboxReplace === 'function') onBeforeToolboxReplace();
  const previousHost = tabBody._renderHost;
  clearLiveSourceTimers(previousHost);
  const renderHost = document.createElement('div');
  renderHost.className = 'mc-tb-render-host';
  renderHost.innerHTML = loadingState(t('mc.tb.loading'));
  tabBody.replaceChildren(renderHost);
  tabBody._renderHost = renderHost;
  switch (tabId) {
    case 'videos':
    case 'images':
      await renderMediaCategoryTab(renderHost, { selectedIds, onAfterSend, onRouteSource }, tabId, context);
      break;
    case 'docs':
      await renderDocsCategory(renderHost, { selectedIds, onAfterSend, onRouteSource }, context);
      break;
    case 'sources':
      await renderSourcesCategory(renderHost, { selectedIds, onAfterSend, onRouteSource, onRouteNextcloud });
      break;
    case 'livefeeds':
      renderLiveFeedsTab(renderHost, { selectedIds, onAfterSend, onRouteSource });
      break;
    case 'additional':
      await renderAdditionalCategory(renderHost, { selectedIds, onAfterSend, onRouteSource, onMountAdditionalControls });
      break;
    default:
      renderHost.innerHTML = '';
  }
}

/**
 * Render the toolbox dock into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string[]} opts.selectedIds   currently-selected display ids (passed to send funnel)
 * @param {()=>void} [opts.onAfterSend] called after a successful fallback send
 * @param {(source:object,label:string)=>Promise<boolean>} [opts.onRouteSource]
 * @param {(path:string,label:string)=>Promise<boolean>} [opts.onRouteNextcloud]
 * @param {(host:HTMLElement)=>void} [opts.onMountAdditionalControls]
 * @param {()=>void} [opts.onBeforeToolboxReplace]
 */
export function renderToolbox(container, { selectedIds = [], onAfterSend, onRouteSource, onRouteNextcloud, onMountAdditionalControls, onBeforeToolboxReplace } = {}) {
  if (!container) return;
  if (typeof onBeforeToolboxReplace === 'function') onBeforeToolboxReplace();
  activeTab = normalizeToolboxTab(activeTab);
  const options = { selectedIds, onAfterSend, onRouteSource, onRouteNextcloud, onMountAdditionalControls, onBeforeToolboxReplace };

  const tabHtml = TABS.map(tab =>
    `<button type="button" class="mc-tb-tab${tab.id === activeTab ? ' active' : ''}"
             id="mc-tb-tab-${esc(tab.id)}" role="tab"
             aria-selected="${tab.id === activeTab ? 'true' : 'false'}" aria-controls="mc-tb-panel"
             tabindex="${tab.id === activeTab ? '0' : '-1'}"
             data-tab="${esc(tab.id)}">${esc(tab.label)}</button>`
  ).join('');

  container.innerHTML = `
    <div class="mc-tb-bar" role="tablist" aria-label="Content Library categories">${tabHtml}</div>
    <div class="mc-tb-body" id="mc-tb-panel" role="tabpanel" aria-labelledby="mc-tb-tab-${esc(activeTab)}"></div>`;

  const tabBody = container.querySelector('#mc-tb-panel');
  const tabs = [...container.querySelectorAll('.mc-tb-tab')];

  const activateTab = async (requestedTab, context) => {
    activeTab = normalizeToolboxTab(requestedTab);
    if (activeTab === 'images' && context?.folder) {
      container._mcToolboxContext = { folder: String(context.folder) };
    } else if (activeTab !== 'images') {
      container._mcToolboxContext = {};
    }
    tabs.forEach((tab) => {
      const selected = tab.dataset.tab === activeTab;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    tabBody.setAttribute('aria-labelledby', `mc-tb-tab-${activeTab}`);
    await loadTab(activeTab, tabBody, options, container._mcToolboxContext || {});
  };
  container._mcOpenToolboxTab = activateTab;

  tabs.forEach((btn, index) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    btn.addEventListener('keydown', (event) => {
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      tabs[nextIndex].focus();
      activateTab(tabs[nextIndex].dataset.tab);
    });
  });

  loadTab(activeTab, tabBody, options, container._mcToolboxContext || {});
}

export function openToolboxTab(container, tabId, context = {}) {
  if (!container) return false;
  const normalized = normalizeToolboxTab(tabId);
  if (typeof container._mcOpenToolboxTab === 'function') {
    container._mcOpenToolboxTab(normalized, context);
    return true;
  }
  container.querySelector(`.mc-tb-tab[data-tab="${normalized}"]`)?.click();
  return true;
}
