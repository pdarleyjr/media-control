// toolbox.js — the segmented source-dock below the stage in the unified Media
// Control dashboard. Five tabs: Templates · Media · Presentations · YouTube/URL · Scenes.
//
// Clicking a tile (or dropping it on a stage card) calls sendToDisplays() — the
// shared send funnel — which handles the 409 confirm-all gate and toasts.
//
// Drag-drop from toolbox tiles onto stage cards is coordinated from the CALLER
// (media-control.js): toolbox tiles carry [data-drag-source] with a JSON payload
// so that drag events on stage cards can extract the source and call
// sendToDisplays(). This module sets up the dragstart on its own tiles.
//
// The Templates tab is handled by the inspector (Task 4.4); here we show a hint.

import { api } from '../../api.js';
import { sendToDisplays } from './send.js';
import { showToast } from '../../components/toast.js';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Active tab id (persisted only for the lifetime of the rendered toolbox).
let activeTab = 'media';

// ---- tab definitions ----
const TABS = [
  { id: 'templates',     label: 'Templates' },
  { id: 'media',         label: 'Media' },
  { id: 'presentations', label: 'Presentations' },
  { id: 'youtube',       label: 'YouTube / URL' },
  { id: 'scenes',        label: 'Scenes' },
];

// ---- tab content renderers ----

function renderTemplatesTab(container) {
  container.innerHTML = `
    <div class="mc-tb-hint">
      <p>Select a display on the stage above, then click <strong>Partition into regions</strong>
      in the inspector to apply a layout template to that display.</p>
    </div>`;
}

async function renderMediaTab(container, { selectedIds, onAfterSend }) {
  container.innerHTML = '<div class="mc-tb-loading">Loading media…</div>';
  let items = [];
  try {
    const result = await api.getContent();
    // api.getContent returns an object with a 'content' array or an array directly
    items = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
  } catch (e) {
    container.innerHTML = `<div class="mc-tb-error">Could not load media: ${escHtml(e?.message)}</div>`;
    return;
  }
  if (items.length === 0) {
    container.innerHTML = '<div class="mc-tb-empty">No media yet — upload some in the Content Library.</div>';
    return;
  }
  const tiles = items.slice(0, 48).map(item => {
    const src = JSON.stringify({ content_id: item.id });
    const thumb = item.thumbnail_url ? `<img class="mc-tile-thumb" src="${escHtml(item.thumbnail_url)}" alt="" loading="lazy">` : `<span class="mc-tile-icon">🖼</span>`;
    return `<button type="button" class="mc-tile" draggable="true"
      data-drag-source='${escHtml(src)}'
      data-label="${escHtml(item.filename || item.name || 'Content')}"
      title="${escHtml(item.filename || item.name || 'Content')}">
      ${thumb}
      <span class="mc-tile-label">${escHtml(item.filename || item.name || 'Content')}</span>
    </button>`;
  }).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  attachTileHandlers(container, selectedIds, onAfterSend);
}

async function renderPresentationsTab(container, { selectedIds, onAfterSend }) {
  container.innerHTML = '<div class="mc-tb-loading">Loading presentations…</div>';
  let items = [];
  try {
    const result = await api.presentations.list();
    items = Array.isArray(result) ? result : (result && Array.isArray(result.presentations) ? result.presentations : []);
  } catch (e) {
    container.innerHTML = `<div class="mc-tb-error">Could not load presentations: ${escHtml(e?.message)}</div>`;
    return;
  }
  if (items.length === 0) {
    container.innerHTML = '<div class="mc-tb-empty">No presentations yet — create one in the Presentations page.</div>';
    return;
  }
  const tiles = items.slice(0, 48).map(item => {
    const src = JSON.stringify({ presentation_id: item.id });
    return `<button type="button" class="mc-tile" draggable="true"
      data-drag-source='${escHtml(src)}'
      data-label="${escHtml(item.title || 'Presentation')}"
      title="${escHtml(item.title || 'Presentation')}">
      <span class="mc-tile-icon">📊</span>
      <span class="mc-tile-label">${escHtml(item.title || 'Presentation')}</span>
    </button>`;
  }).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  attachTileHandlers(container, selectedIds, onAfterSend);
}

function renderYouTubeTab(container, { selectedIds, onAfterSend }) {
  container.innerHTML = `
    <form class="mc-yt-form" data-yt-form>
      <label class="mc-tb-label" for="mc-yt-url">YouTube link or web URL</label>
      <div class="mc-yt-row">
        <input class="mc-yt-input" id="mc-yt-url" type="url" inputmode="url"
               placeholder="https://www.youtube.com/watch?v=…" autocomplete="off">
        <button type="submit" class="mc-btn mc-btn-primary">Send</button>
      </div>
    </form>`;
  container.querySelector('[data-yt-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = (container.querySelector('.mc-yt-input').value || '').trim();
    if (!url) { showToast('Paste a YouTube or web URL first.', 'error'); return; }
    const ok = await sendToDisplays({ remote_url: url }, selectedIds, url);
    if (ok && typeof onAfterSend === 'function') onAfterSend();
  });
}

async function renderScenesTab(container, { onAfterSend }) {
  container.innerHTML = '<div class="mc-tb-loading">Loading scenes…</div>';
  let scenes = [];
  try {
    const result = await api.scenes.list();
    scenes = Array.isArray(result) ? result : (result && Array.isArray(result.scenes) ? result.scenes : []);
  } catch (e) {
    container.innerHTML = `<div class="mc-tb-error">Could not load scenes: ${escHtml(e?.message)}</div>`;
    return;
  }
  if (scenes.length === 0) {
    container.innerHTML = '<div class="mc-tb-empty">No scenes yet — create one in the Scenes page.</div>';
    return;
  }
  const tiles = scenes.slice(0, 48).map(sc => `
    <button type="button" class="mc-tile mc-scene-tile" data-scene-id="${escHtml(sc.id)}"
            title="${escHtml(sc.name || 'Scene')}">
      <span class="mc-tile-icon">🎬</span>
      <span class="mc-tile-label">${escHtml(sc.name || 'Scene')}</span>
    </button>`).join('');
  container.innerHTML = `<div class="mc-tile-grid">${tiles}</div>`;
  container.querySelectorAll('[data-scene-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.sceneId;
      try {
        await api.scenes.trigger(id);
        showToast(`Scene "${escHtml(btn.title)}" triggered.`, 'success');
        if (typeof onAfterSend === 'function') onAfterSend();
      } catch (e) {
        showToast(e?.message || 'Could not trigger the scene.', 'error');
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
      const label = tile.dataset.label || 'Content';
      const ok = await sendToDisplays(source, selectedIds, label);
      if (ok && typeof onAfterSend === 'function') onAfterSend();
    });

    // Dragstart = serialize source onto the DataTransfer so stage cards can
    // receive it as a drop and call sendToDisplays({ source }, [deviceId]).
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-source', tile.dataset.dragSource);
      e.dataTransfer.setData('application/x-mc-label', tile.dataset.label || 'Content');
    });
  });
}

// Load and render the given tab into the tab-body container.
async function loadTab(tabId, tabBody, { selectedIds, onAfterSend }) {
  tabBody.innerHTML = '<div class="mc-tb-loading">Loading…</div>';
  switch (tabId) {
    case 'templates':
      renderTemplatesTab(tabBody);
      break;
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

  const tabHtml = TABS.map(t =>
    `<button type="button" class="mc-tb-tab${t.id === activeTab ? ' active' : ''}"
             data-tab="${escHtml(t.id)}">${escHtml(t.label)}</button>`
  ).join('');

  container.innerHTML = `
    <div class="mc-tb-bar">${tabHtml}</div>
    <div class="mc-tb-body" id="mc-tb-body"></div>`;

  const tabBody = container.querySelector('#mc-tb-body');

  // Tab switching
  container.querySelectorAll('.mc-tb-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll('.mc-tb-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
      await loadTab(activeTab, tabBody, { selectedIds, onAfterSend });
    });
  });

  // Load initial tab
  loadTab(activeTab, tabBody, { selectedIds, onAfterSend });
}

/**
 * Re-render just the active tab content (e.g. when selectedIds changes).
 * The container must still be in the DOM.
 *
 * @param {HTMLElement} container
 * @param {string[]} selectedIds
 * @param {()=>void} [onAfterSend]
 */
export function refreshToolbox(container, selectedIds = [], onAfterSend) {
  if (!container) return;
  const tabBody = container.querySelector('#mc-tb-body');
  if (!tabBody) return;
  // Only tabs that use selectedIds at click-time need refreshing; re-render the
  // active tab so the current selection is picked up on next click.
  loadTab(activeTab, tabBody, { selectedIds, onAfterSend });
}
