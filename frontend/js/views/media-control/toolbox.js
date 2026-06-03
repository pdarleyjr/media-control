// toolbox.js — the segmented source-dock below the stage in the unified Media
// Control dashboard. Five SOURCE tabs: Media · Presentations · YouTube/URL ·
// Scenes · Nextcloud. (Region "templates" are a per-display layout, not a source
// to send, so they live in the inspector's "Partition into regions" flow — not
// as a toolbox tab.)
//
// Clicking a tile (or dropping it on a stage card) calls sendToDisplays() — the
// shared send funnel — which handles the 409 confirm-all gate and toasts.
//
// Drag-drop from toolbox tiles onto stage cards is coordinated from the CALLER
// (media-control.js): toolbox tiles carry [data-drag-source] with a JSON payload
// so that drag events on stage cards can extract the source and call
// sendToDisplays(). This module sets up the dragstart on its own tiles.

import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { api } from '../../api.js';
import { sendToDisplays, sentToast } from './send.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';

// Active tab id (persisted only for the lifetime of the rendered toolbox).
let activeTab = 'media';

// ---- tab definitions (labels resolved through t() at render time) ----
const TABS = [
  { id: 'media',         key: 'mc.tab.media' },
  { id: 'presentations', key: 'mc.tab.presentations' },
  { id: 'youtube',       key: 'mc.tab.youtube' },
  { id: 'scenes',        key: 'mc.tab.scenes' },
  { id: 'nextcloud',     key: 'mc.tab.nextcloud' },
];

// ---- composed state blocks (never a bare sentence) ----
const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';

function loadingState(msg) {
  return `<div class="mc-tb-state mc-tb-loading"><span class="mc-tb-spin" aria-hidden="true"></span><span>${esc(msg)}</span></div>`;
}
function emptyState(msg) {
  return `<div class="mc-tb-state mc-tb-empty"><span class="mc-tb-state-ico" aria-hidden="true">${ICON_EMPTY}</span><span>${esc(msg)}</span></div>`;
}
function errorState(msg) {
  return `<div class="mc-tb-state mc-tb-error" role="alert"><span class="mc-tb-state-ico" aria-hidden="true">${ICON_ERROR}</span><span>${esc(msg)}</span></div>`;
}

// ---- tab content renderers ----

async function renderMediaTab(container, { selectedIds, onAfterSend }) {
  container.innerHTML = loadingState(t('mc.tb.loading_media'));
  let items = [];
  try {
    const result = await api.getContent();
    // api.getContent returns an object with a 'content' array or an array directly
    items = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
  } catch (e) {
    container.innerHTML = errorState(t('mc.media.error', { error: e?.message || '' }));
    return;
  }
  if (items.length === 0) {
    container.innerHTML = emptyState(t('mc.media.empty'));
    return;
  }
  const tiles = items.slice(0, 48).map(item => {
    const src = JSON.stringify({ content_id: item.id });
    const name = item.filename || item.name || t('mc.tile.content_fallback');
    const thumb = item.thumbnail_url ? `<img class="mc-tile-thumb" src="${esc(item.thumbnail_url)}" alt="" loading="lazy">` : `<span class="mc-tile-icon">🖼</span>`;
    return `<button type="button" class="mc-tile" draggable="true"
      data-drag-source='${esc(src)}'
      data-label="${esc(name)}"
      title="${esc(name)}">
      ${thumb}
      <span class="mc-tile-label">${esc(name)}</span>
    </button>`;
  }).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  attachTileHandlers(container, selectedIds, onAfterSend);
}

async function renderPresentationsTab(container, { selectedIds, onAfterSend }) {
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
  const tiles = items.slice(0, 48).map(item => {
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
  attachTileHandlers(container, selectedIds, onAfterSend);
}

function renderYouTubeTab(container, { selectedIds, onAfterSend }) {
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
    const ok = await sendToDisplays({ remote_url: url }, selectedIds, url);
    if (ok && typeof onAfterSend === 'function') onAfterSend();
  });
}

// ---- Nextcloud tab ----
// Lists the signed-in member's own NC files via api.files.list(path), with
// folder navigation. image/* and video/* rows get a "Broadcast" tile button;
// clicking calls api.files.broadcast using the shared confirm-all 409 gate.
// Presentations (deck player path) are intentionally NOT shown here — use the
// Presentations tab. The email comes from the JWT (server-enforced); the client
// never sends it.
async function renderNextcloudTab(container, { selectedIds, onAfterSend }, path = '') {
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
      renderNextcloudTab(container, { selectedIds, onAfterSend }, el.dataset.ncPath || '');
    });
  });

  // Folder drill-down
  container.querySelectorAll('[data-nc-dir]').forEach((el) => {
    el.addEventListener('click', () => {
      renderNextcloudTab(container, { selectedIds, onAfterSend }, el.dataset.ncDir);
    });
  });

  // Broadcast buttons — import NC bytes to a content row, then push to displays.
  // GUARDRAIL: email comes from req.user.email server-side, never from the client.
  container.querySelectorAll('.mc-nc-broadcast').forEach((btn) => {
    const restore = () => { btn.disabled = false; btn.textContent = t('mc.nc.broadcast'); };
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
        showToast(t('mc.nc.no_displays'), 'error');
        return;
      }
      btn.disabled = true; btn.textContent = '…';
      const ncPath = btn.dataset.ncPath;
      const label = btn.dataset.ncLabel || ncPath;
      try {
        let result = await api.files.broadcast(ncPath, selectedIds);
        if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
          const ok = await confirmDialog({
            title: t('mc.send.confirm_all_title', { n: result.count }),
            message: t('mc.send.confirm_all_msg', { label }),
            confirmLabel: t('mc.send.confirm_all_ok'),
            tone: 'default',
          });
          if (!ok) { restore(); return; }
          result = await api.files.broadcast(ncPath, selectedIds, { confirm_all: true });
        }
        if (result && result.success) {
          sentToast(label, result.sent, result.total);
          if (typeof onAfterSend === 'function') onAfterSend();
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
  const tiles = scenes.slice(0, 48).map(sc => {
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
        await api.scenes.trigger(id);
        showToast(t('mc.scenes.triggered', { name }), 'success');
        if (typeof onAfterSend === 'function') onAfterSend();
      } catch (e) {
        showToast(e?.message || t('mc.scenes.trigger_failed'), 'error');
      }
    });
  });
}

// Attach click + dragstart on toolbox tiles that call sendToDisplays.
function attachTileHandlers(container, selectedIds, onAfterSend) {
  container.querySelectorAll('.mc-tile[data-drag-source]').forEach(tile => {
    // Click = send to all selectedIds immediately
    tile.addEventListener('click', async () => {
      let source;
      try { source = JSON.parse(tile.dataset.dragSource); } catch { return; }
      const label = tile.dataset.label || t('mc.tile.content_fallback');
      const ok = await sendToDisplays(source, selectedIds, label);
      if (ok && typeof onAfterSend === 'function') onAfterSend();
    });

    // Dragstart = serialize source onto the DataTransfer so stage cards can
    // receive it as a drop and call sendToDisplays({ source }, [deviceId]).
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-source', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-label', tile.dataset.label || t('mc.tile.content_fallback'));
    });
  });
}

// Load and render the given tab into the tab-body container.
async function loadTab(tabId, tabBody, { selectedIds, onAfterSend }) {
  tabBody.innerHTML = loadingState(t('mc.tb.loading'));
  switch (tabId) {
    case 'media':
      await renderMediaTab(tabBody, { selectedIds, onAfterSend });
      break;
    case 'presentations':
      await renderPresentationsTab(tabBody, { selectedIds, onAfterSend });
      break;
    case 'youtube':
      renderYouTubeTab(tabBody, { selectedIds, onAfterSend });
      break;
    case 'scenes':
      await renderScenesTab(tabBody, { onAfterSend });
      break;
    case 'nextcloud':
      await renderNextcloudTab(tabBody, { selectedIds, onAfterSend });
      break;
    default:
      tabBody.innerHTML = '';
  }
}

/**
 * Render the toolbox dock into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string[]} opts.selectedIds   currently-selected display ids (passed to send funnel)
 * @param {()=>void} [opts.onAfterSend] called after a successful send (e.g. to refresh stage)
 */
export function renderToolbox(container, { selectedIds = [], onAfterSend } = {}) {
  if (!container) return;

  const tabHtml = TABS.map(tab =>
    `<button type="button" class="mc-tb-tab${tab.id === activeTab ? ' active' : ''}"
             role="tab" aria-selected="${tab.id === activeTab ? 'true' : 'false'}"
             data-tab="${esc(tab.id)}">${esc(t(tab.key))}</button>`
  ).join('');

  container.innerHTML = `
    <div class="mc-tb-bar" role="tablist">${tabHtml}</div>
    <div class="mc-tb-body" id="mc-tb-body"></div>`;

  const tabBody = container.querySelector('#mc-tb-body');

  // Tab switching
  container.querySelectorAll('.mc-tb-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll('.mc-tb-tab').forEach(b => {
        const on = b.dataset.tab === activeTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      await loadTab(activeTab, tabBody, { selectedIds, onAfterSend });
    });
  });

  // Load initial tab
  loadTab(activeTab, tabBody, { selectedIds, onAfterSend });
}
