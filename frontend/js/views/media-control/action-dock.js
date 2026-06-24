// action-dock.js — the Command Center bottom action dock. Large touch-friendly
// round-rect buttons, each routing to EXISTING functionality via callbacks the
// host view supplies (multiview toggle, blank-selected, blank-all, share,
// add-display). The LIVE-control buttons (start / remove / stop) ARE handled
// here directly against api.liveStream.* so the dock reflects the real PeerTube
// + AI-camera-orchestrator state with confirm dialogs + toasts. Live-control
// visibility syncs from api.liveStream.status() on mount so the Start / Remove /
// Stop buttons show the right one for the current broadcast state. Color classes
// (mc-dock-primary / -default / -live / -danger / -add) are styled in
// media-control.css.
//
// `isLiveActive()` is the module-scoped read of the live-stream-active flag shared
// with the broadcast funnel (send.js FIX2) and the chips so a send can prompt
// "include this content in the live stream?" only while a stream is on-air.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';

// Live-stream-active flag, initialized from api.liveStream.status() on mount and
// refreshed after every start/stop. Read by the broadcast funnel (send.js) and
// the Command Center chips.
let liveActive = false;

export function isLiveActive() {
  return liveActive;
}

/**
 * @param {HTMLElement} hostEl
 * @param {object} opts callback providers from the host view
 *   ({ onMultiview, onBlankSelected, onBlankAll, onShare, onAddDisplay,
 *      onLiveChanged } — host-chosen repaint, e.g. paintChips)
 * @returns {{ syncLive: ()=>Promise<void> }}
 */
export function mountActionDock(hostEl, opts = {}) {
  if (!hostEl) return { syncLive() { return Promise.resolve(); }, repaintBlank() {} };
  const cb = opts || {};
  hostEl.innerHTML = `
    <div class="mc-action-dock" role="toolbar" aria-label="${esc(t('mc.cc.brand'))}">
      <button type="button" class="mc-dock-btn mc-dock-primary" data-dock="multiview">${esc(t('mc.cc.dock.multiview'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="blank-toggle" id="mc-dock-blank-btn">${esc(t('mc.cc.dock.blank_all'))}</button>
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
  const blankBtn = hostEl.querySelector('[data-dock="blank-toggle"]');

  // Repaint the Blank button label based on whether the active target is currently
  // blanked (any member screen_on===false → show "Unblank"; all on → "Blank").
  function repaintBlank() {
    if (!blankBtn) return;
    const getIds = typeof cb.getActiveTargetDeviceIds === 'function' ? cb.getActiveTargetDeviceIds : () => [];
    const getDs  = typeof cb.getDisplayState === 'function' ? cb.getDisplayState : () => null;
    const ids = getIds();
    const ds  = getDs();
    if (!ids.length || !ds) {
      blankBtn.textContent = t('mc.cc.dock.blank_all');
      blankBtn.classList.remove('mc-dock-blank-active');
      return;
    }
    const all = ds.getAll ? ds.getAll() : [];
    const byId = new Map(all.map((d) => [d.id, d]));
    const anyBlanked = ids.some((id) => { const d = byId.get(id); return d && d.screen_on === false; });
    blankBtn.textContent = anyBlanked ? t('mc.cmd.unblank') : t('mc.cc.dock.blank_all');
    if (anyBlanked) blankBtn.classList.add('mc-dock-blank-active');
    else blankBtn.classList.remove('mc-dock-blank-active');
  }

  function repaintLive() {
    if (startBtn) startBtn.hidden = liveActive;
    if (removeBtn) removeBtn.hidden = !liveActive;
    if (stopBtn) stopBtn.hidden = !liveActive;
  }

  async function syncLive() {
    try {
      const status = await api.liveStream.status();
      const director = status && status.ai_director && status.ai_director.data;
      liveActive = !!(director && director.stream_active === true);
    } catch {
      liveActive = false;
    }
    repaintLive();
  }

  async function onStartLive() {
    const ok = await confirmDialog({
      title: t('mc.cc.confirm.start_live_title'),
      message: t('mc.cc.confirm.start_live'),
      confirmLabel: t('mc.cc.dock.start_live'),
      tone: 'default',
    });
    if (!ok) return;
    try {
      await api.liveStream.start();
      liveActive = true;
      repaintLive();
      showToast(t('mc.cc.live.started'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast((e && e.message) ? e.message : t('mc.cc.live.start_failed'), 'error');
      // Keep current dock state; re-sync to be safe.
      syncLive().catch(() => {});
    }
  }

  async function onStopLive() {
    const ok = await confirmDialog({
      title: t('mc.cc.dock.stop_live'),
      message: t('mc.cc.confirm.stop_live'),
      confirmLabel: t('mc.cc.dock.stop_live'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.liveStream.stop();
      liveActive = false;
      repaintLive();
      showToast(t('mc.cc.live.stopped'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast((e && e.message) ? e.message : t('mc.cc.live.stop_failed'), 'error');
      syncLive().catch(() => {});
    }
  }

  async function onRemoveLive() {
    if (!liveActive) {
      showToast(t('mc.cc.live.not_active'), 'info');
      return;
    }
    try {
      await api.liveStream.clearContent();
      showToast(t('mc.cc.live.cleared'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast((e && e.message) ? e.message : t('mc.cc.live.clear_failed'), 'error');
    }
  }

  hostEl.querySelectorAll('[data-dock]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      switch (btn.dataset.dock) {
        case 'multiview': if (typeof cb.onMultiview === 'function') cb.onMultiview(); break;
        case 'blank-selected': if (typeof cb.onBlankSelected === 'function') cb.onBlankSelected(); break;
        case 'blank-toggle':
          if (typeof cb.onBlankToggle === 'function') await cb.onBlankToggle();
          else if (typeof cb.onBlankAll === 'function') await cb.onBlankAll();
          repaintBlank();
          break;
        case 'blank-all': if (typeof cb.onBlankAll === 'function') await cb.onBlankAll(); break;
        case 'share': if (typeof cb.onShare === 'function') cb.onShare(); break;
        case 'start-live': await onStartLive(); await syncLive(); break;
        case 'stop-live': await onStopLive(); await syncLive(); break;
        case 'remove-live': await onRemoveLive(); await syncLive(); break;
        case 'add-display': if (typeof cb.onAddDisplay === 'function') cb.onAddDisplay(); break;
      }
    });
  });

  syncLive();
  return { syncLive, repaintBlank };
}