// action-dock.js — the Command Center bottom action dock. Large touch-friendly
// round-rect buttons, each routing to EXISTING functionality via callbacks the
// host view supplies (multiview toggle, blank-selected, blank-all, share, live
// start/remove/stop, add-display). Live-control visibility syncs from
// api.liveStream.status() on mount so the Start / Remove / Stop buttons show the
// right one for the current broadcast state. Color classes (mc-dock-primary /
// -default / -live / -danger / -add) are styled in media-control.css.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';

/**
 * @param {HTMLElement} hostEl
 * @param {object} opts callback providers from the host view
 * @returns {{ syncLive: ()=>Promise<void> }}
 */
export function mountActionDock(hostEl, opts = {}) {
  if (!hostEl) return { syncLive() { return Promise.resolve(); } };
  const cb = opts || {};
  hostEl.innerHTML = `
    <div class="mc-action-dock" role="toolbar" aria-label="${esc(t('mc.cc.brand'))}">
      <button type="button" class="mc-dock-btn mc-dock-primary" data-dock="multiview">${esc(t('mc.cc.dock.multiview'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="blank-selected">${esc(t('mc.cc.dock.blank_selected'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="blank-all">${esc(t('mc.cc.dock.blank_all'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="share">${esc(t('mc.cc.dock.share'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-live" data-dock="start-live">${esc(t('mc.cc.dock.start_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="remove-live" hidden>${esc(t('mc.cc.dock.remove_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-danger" data-dock="stop-live" hidden>${esc(t('mc.cc.dock.stop_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-add" data-dock="add-display" aria-label="${esc(t('mc.cc.dock.add_display'))}">
        <span class="mc-dock-add-text">${esc(t('mc.cc.dock.add_display'))}</span>
        <span class="mc-dock-add-plus" aria-hidden="true">+</span>
      </button>
    </div>`;

  const startBtn = hostEl.querySelector('[data-dock="start-live"]');
  const removeBtn = hostEl.querySelector('[data-dock="remove-live"]');
  const stopBtn = hostEl.querySelector('[data-dock="stop-live"]');

  async function syncLive() {
    try {
      const status = await api.liveStream.status();
      const active = status && status.ai_director && status.ai_director.data
        ? status.ai_director.data.stream_active === true : false;
      if (startBtn) startBtn.hidden = active;
      if (removeBtn) removeBtn.hidden = !active;
      if (stopBtn) stopBtn.hidden = !active;
    } catch {
      if (startBtn) startBtn.hidden = false;
      if (removeBtn) removeBtn.hidden = true;
      if (stopBtn) stopBtn.hidden = true;
    }
  }

  hostEl.querySelectorAll('[data-dock]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      switch (btn.dataset.dock) {
        case 'multiview': if (typeof cb.onMultiview === 'function') cb.onMultiview(); break;
        case 'blank-selected': if (typeof cb.onBlankSelected === 'function') cb.onBlankSelected(); break;
        case 'blank-all': if (typeof cb.onBlankAll === 'function') await cb.onBlankAll(); break;
        case 'share': if (typeof cb.onShare === 'function') cb.onShare(); break;
        case 'start-live': if (typeof cb.onStartLive === 'function') await cb.onStartLive(); await syncLive(); break;
        case 'remove-live': if (typeof cb.onRemoveLive === 'function') await cb.onRemoveLive(); await syncLive(); break;
        case 'stop-live': if (typeof cb.onStopLive === 'function') await cb.onStopLive(); await syncLive(); break;
        case 'add-display': if (typeof cb.onAddDisplay === 'function') cb.onAddDisplay(); break;
      }
    });
  });

  syncLive();
  return { syncLive };
}