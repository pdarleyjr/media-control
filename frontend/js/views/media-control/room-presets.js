// room-presets.js — the right-rail "Room Presets" panel in the unified Media
// Control dashboard. This is the Command-360 "Layouts" analog: one-tap recall
// of a saved multi-display scene.
//
// A "preset" here is just a Scene (a named snapshot of which content/playlist
// shows on which display). Tapping a tile calls api.scenes.trigger(id), which
// pushes the whole snapshot to every display in the scene in one go. Creating /
// editing scenes lives on the dedicated #/scenes route — this panel only RECALLS
// them, with a "Manage" deep-link for the full editor.
//
// Loading / empty / error states are composed (icon + message), mirroring
// toolbox.js — never a bare spinner, blank, or raw error string.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';
import { showToast } from '../../components/toast.js';
import { trackBroadcastDelivery } from './send.js';

// ---- composed state blocks (icon + message — never a bare sentence) ----
const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18M9 21V9"></path></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';

// "recall / play" affordance shown on each tile (blue=go is applied by CSS).
const ICON_RECALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';

function loadingState(msg) {
  return `<div class="mc-presets-state mc-presets-loading"><span class="mc-tb-spin" aria-hidden="true"></span><span>${esc(msg)}</span></div>`;
}
function emptyState(msg, cta) {
  return `<div class="mc-presets-state mc-presets-empty">
    <span class="mc-presets-state-ico" aria-hidden="true">${ICON_EMPTY}</span>
    <span>${esc(msg)}</span>
    <a class="mc-btn mc-btn-secondary mc-btn-sm mc-presets-empty-cta" href="#/scenes">${esc(cta)}</a>
  </div>`;
}
function errorState(msg) {
  return `<div class="mc-presets-state mc-presets-error" role="alert"><span class="mc-presets-state-ico" aria-hidden="true">${ICON_ERROR}</span><span>${esc(msg)}</span></div>`;
}

// Render the static panel chrome (header + body container) and return the body
// element so the loader can swap states into it without rebuilding the header.
function renderShell(container) {
  container.innerHTML = `
    <div class="mc-presets">
      <div class="mc-presets-head">
        <span class="mc-presets-title">${esc(t('mc.presets.title'))}</span>
        <a class="mc-presets-manage" href="#/scenes">${esc(t('mc.presets.manage'))}</a>
      </div>
      <div class="mc-presets-body" data-presets-body></div>
    </div>`;
  return container.querySelector('[data-presets-body]');
}

// Attach the tap-to-recall handler to a single tile. Disabled in-flight so a
// double-tap can't fire two triggers; restored on success or failure.
function attachRecall(tile, onAfterApply) {
  const id = tile.dataset.sceneId;
  const name = tile.dataset.sceneName || t('mc.presets.scene_fallback');
  tile.addEventListener('click', async () => {
    if (tile.disabled) return;
    tile.disabled = true;
    tile.setAttribute('aria-busy', 'true');
    try {
      const result = await api.scenes.trigger(id);
      if (result?.request_id) {
        const delivery = await trackBroadcastDelivery(result.request_id, name, result.delivery || null);
        if (delivery?.status === 'confirmed' && typeof onAfterApply === 'function') onAfterApply();
      } else {
        showToast(t('mc.presets.recalled', { name }), 'success');
        if (typeof onAfterApply === 'function') onAfterApply();
      }
    } catch (e) {
      showToast(e?.message || t('mc.presets.recall_failed'), 'error');
    } finally {
      tile.disabled = false;
      tile.removeAttribute('aria-busy');
    }
  });
}

/**
 * Render the right-rail "Room Presets" panel into `container`. Lists saved
 * scenes; each tile recalls its scene in one tap via api.scenes.trigger.
 *
 * Safe to call repeatedly — it replaces container.innerHTML on each render.
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {()=>void} [opts.onAfterApply] called after a scene is recalled (e.g. to refresh the stage)
 */
export async function renderRoomPresets(container, { onAfterApply } = {}) {
  if (!container) return;

  const body = renderShell(container);
  body.innerHTML = loadingState(t('mc.presets.loading'));

  let scenes = [];
  try {
    const result = await api.scenes.list();
    // Tolerate an Array OR { scenes: [...] }.
    scenes = Array.isArray(result)
      ? result
      : (result && Array.isArray(result.scenes) ? result.scenes : []);
  } catch (e) {
    body.innerHTML = errorState(t('mc.presets.error', { error: e?.message || '' }));
    return;
  }

  if (scenes.length === 0) {
    body.innerHTML = emptyState(t('mc.presets.empty'), t('mc.presets.empty_cta'));
    return;
  }

  const tiles = scenes.map((sc) => {
    const name = sc.name || t('mc.presets.scene_fallback');
    return `
    <button type="button" class="mc-btn mc-btn-ghost mc-preset-tile"
            data-scene-id="${esc(sc.id)}" data-scene-name="${esc(name)}"
            title="${esc(name)}">
      <span class="mc-preset-name">${esc(name)}</span>
      <span class="mc-preset-recall" aria-hidden="true">${ICON_RECALL}</span>
    </button>`;
  }).join('');

  body.innerHTML = `<div class="mc-presets-list">${tiles}</div>`;

  body.querySelectorAll('.mc-preset-tile[data-scene-id]').forEach((tile) => {
    attachRecall(tile, onAfterApply);
  });
}
