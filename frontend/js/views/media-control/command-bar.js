// command-bar.js — the classroom QUICK-ACTION bar for the unified Media Control
// view. It folds in the retired Present surface's command row: one big PRIMARY
// "Start Class" CTA (wake every display), a "Blank all" toggle (with a visible
// banner so nobody forgets the room is dark), and a row of quick-launch tiles
// for the four classroom sources (Share screen · Whiteboard · YouTube · Library).
//
// Mental model carried over from present.js: "tap Start Class → the wall wakes;
// tap Blank → the wall goes dark with a banner; tap a source → it routes there."
//
// Reuses existing plumbing only:
//   • sendCommand() over the /dashboard socket with the FROZEN COMMAND_TYPES
//     (SCREEN_ON / SCREEN_OFF) — never hardcode the wire strings.
//   • sendToDisplays() + sentToast() — the shared broadcast funnel (handles the
//     409 confirm-all gate and YouTube materialization) — for the YouTube launch.
//   • routes to the already-built screen-share / smartboard / content views.
//
// CSP-clean: addEventListener only (no inline on* handlers), esc() on every
// piece of dynamic text, no inline magic colors (the integrator styles the
// class names below). Safe to call repeatedly — re-render replaces innerHTML.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { sendCommand } from '../../socket.js';
import { api } from '../../api.js';
import { confirmDialog } from '../../components/confirm.js';
import { COMMAND_TYPES } from '../../player-protocol.js';
import { sendToDisplays } from './send.js';

// Module-local UI state for the Blank toggle (best-effort, mirrors present.js).
// Tracks whether the room is currently blanked so the toggle, banner, and
// aria-pressed all reflect a single source of truth across re-renders.
let blanked = false;

// YouTube / youtu.be detection — same regex used in present.js / send.js.
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

// ---- inline stroke icons (controlled markup, no user input) ----
const ICON_MV = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1"></rect><rect x="13" y="4" width="8" height="7" rx="1"></rect><rect x="3" y="13" width="8" height="7" rx="1"></rect><rect x="13" y="13" width="8" height="7" rx="1"></rect></svg>';
const ICON_BLANK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><path d="M4 5l16 14"></path></svg>';
const ICON_SCREEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><polyline points="9 9 12 6 15 9"></polyline><line x1="12" y1="6" x2="12" y2="14"></line></svg>';
const ICON_YT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"></rect><polygon points="10 9 16 12 10 15 10 9" fill="currentColor" stroke="none"></polygon></svg>';
const ICON_LIB = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
const ICON_LIVE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8.5a7 7 0 0 1 14 0"></path><path d="M8 8.5a4 4 0 0 1 8 0"></path><circle cx="12" cy="8.5" r="1.7" fill="currentColor" stroke="none"></circle><rect x="4" y="12" width="16" height="8" rx="2"></rect><path d="M10 15.5l4 2-4 2v-4z" fill="currentColor" stroke="none"></path></svg>';
const ICON_PREPARE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path><path d="M8.5 10.5l2 2 4.5-5"></path></svg>';
const ICON_LIVE_CLEAR = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="2"></rect><path d="M19 9l2-2M21 9l-2-2"></path><line x1="5" y1="19" x2="15" y2="19"></line></svg>';
const ICON_LIVE_STOP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"></rect></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';
const ICON_SPIN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"></path></svg>';

// ---- composed state blocks (never a bare spinner / blank / raw error) ----
// Mirrors toolbox.js's loadingState/emptyState/errorState (icon + message).
function loadingState(msg) {
  return `<div class="mc-cmd-state mc-cmd-loading"><span class="mc-cmd-state-ico mc-cmd-spin" aria-hidden="true">${ICON_SPIN}</span><span>${esc(msg)}</span></div>`;
}
function errorState(msg) {
  return `<div class="mc-cmd-state mc-cmd-error" role="alert"><span class="mc-cmd-state-ico" aria-hidden="true">${ICON_ERROR}</span><span>${esc(msg)}</span></div>`;
}

// Coerce whatever roomIds() returns into a clean string[] of display ids.
// Tolerates an Array, a wrapped { ids:[...] } / single-key object, or junk.
function normalizeIds(value) {
  let list = value;
  if (!Array.isArray(list) && list && typeof list === 'object') {
    const firstArray = Object.values(list).find((v) => Array.isArray(v));
    list = firstArray || [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((id) => id != null).map((id) => String(id));
}

// CSP-safe YouTube prompt dialog. Built entirely via createElement +
// addEventListener (no inline handlers, no inline magic colors). Mirrors
// present.js promptYouTube but routes through the shared sendToDisplays funnel
// (which materializes the URL into a content row so the player embeds it).
function promptYouTube(roomIds, refreshAfterSend, onRouteSource) {
  const dlg = document.createElement('dialog');
  dlg.className = 'mc-dialog';

  const card = document.createElement('form');
  card.method = 'dialog';
  card.className = 'mc-dialog-card';

  const title = document.createElement('h3');
  title.className = 'mc-dialog-title';
  title.textContent = t('mc.cmd.yt_title');

  const msg = document.createElement('p');
  msg.className = 'mc-dialog-msg';
  msg.textContent = t('mc.cmd.yt_msg');

  const input = document.createElement('input');
  input.className = 'input mc-cmd-yt-input';
  input.type = 'url';
  input.inputMode = 'url';
  input.autocomplete = 'off';
  input.placeholder = t('mc.cmd.yt_placeholder');
  input.setAttribute('aria-label', t('mc.cmd.yt_title'));

  const actions = document.createElement('div');
  actions.className = 'mc-dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'mc-btn mc-btn-ghost';
  cancelBtn.textContent = t('mc.cmd.cancel');

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'mc-btn mc-btn-cta';
  goBtn.textContent = t('mc.cmd.yt_show');

  actions.append(cancelBtn, goBtn);
  card.append(title, msg, input, actions);
  dlg.append(card);
  document.body.appendChild(dlg);

  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  cancelBtn.addEventListener('click', cleanup);
  dlg.addEventListener('cancel', cleanup);

  goBtn.addEventListener('click', async () => {
    const url = (input.value || '').trim();
    if (!YT_RE.test(url)) {
      showToast(t('mc.cmd.yt_invalid'), 'error');
      return;
    }
    const ids = normalizeIds(roomIds && roomIds());
    if (typeof onRouteSource !== 'function' && ids.length === 0) {
      showToast(t('mc.cmd.no_displays'), 'error');
      return;
    }
    goBtn.disabled = true;
    const ok = typeof onRouteSource === 'function'
      ? await onRouteSource({ remote_url: url }, url)
      : await sendToDisplays({ remote_url: url }, ids, url);
    if (ok) {
      cleanup();
      if (typeof refreshAfterSend === 'function') refreshAfterSend();
    } else {
      goBtn.disabled = false;
    }
  });

  dlg.showModal();
  input.focus();
}

async function startLiveStream(btn, refreshAfterSend) {
  if (!btn || btn.disabled) return;
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('mc-cmd-live-busy');
  btn.innerHTML = `${ICON_SPIN}<span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_starting'))}</span>`;
  try {
    const result = await api.liveStream.start({ director_mode: 'manual' });
    const displayName = result && result.display && result.display.name ? result.display.name : t('mc.cmd.live_display');
    if (result && result.stream_started) {
      showToast(t('mc.cmd.live_started', { display: displayName }), 'success');
    } else {
      const msg = result && result.stream_start && (result.stream_start.data?.message || result.stream_start.message);
      showToast(t('mc.cmd.live_prepared', { display: displayName, message: msg || t('mc.cmd.live_stream_disabled') }), 'info');
    }
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  } catch (e) {
    showToast(e?.message || t('mc.cmd.live_failed'), 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('mc-cmd-live-busy');
    btn.innerHTML = oldHtml;
  }
}

async function prepareLiveProgram(btn, refreshAfterSend) {
  if (!btn || btn.disabled) return;
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${ICON_SPIN}<span class="mc-cmd-btn-label">${esc(t('mc.cc.dock.prepare_live'))}</span>`;
  try {
    await api.liveStream.prepare();
    btn.classList.add('is-prepared');
    btn.setAttribute('aria-pressed', 'true');
    btn.innerHTML = `${ICON_PREPARE}<span class="mc-cmd-btn-label">${esc(t('mc.cc.dock.program_ready'))}</span>`;
    showToast(t('mc.cc.live.prepared'), 'success');
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  } catch (e) {
    btn.classList.remove('is-prepared');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = oldHtml;
    showToast(e?.message || t('mc.cc.live.prepare_failed'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function clearLiveContent(btn, refreshAfterSend) {
  if (!btn || btn.disabled) return;
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${ICON_SPIN}<span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_clearing'))}</span>`;
  try {
    await api.liveStream.clearContent();
    showToast(t('mc.cmd.live_cleared'), 'success');
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  } catch (e) {
    showToast(e?.message || t('mc.cmd.live_clear_failed'), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
  }
}

async function stopLiveStream(btn, refreshAfterSend) {
  if (!btn || btn.disabled) return;
  const ok = await confirmDialog({
    title: t('mc.cmd.live_stop_title'),
    message: t('mc.cmd.live_stop_msg'),
    confirmLabel: t('mc.cmd.live_stop_ok'),
    cancelLabel: t('mc.cmd.cancel'),
    tone: 'danger',
  });
  if (!ok) return;
  const oldHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${ICON_SPIN}<span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_stopping'))}</span>`;
  try {
    await api.liveStream.stop();
    showToast(t('mc.cmd.live_stopped'), 'success');
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  } catch (e) {
    showToast(e?.message || t('mc.cmd.live_stop_failed'), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
  }
}

/**
 * Render the classroom quick-action command bar into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {() => (string[]|object)} opts.roomIds  returns every controllable
 *   (non-wall) display id in the room — used for content sends (YouTube).
 *   Tolerated shapes: Array or { key:[...] }.
 * @param {() => (string[]|object)} [opts.blankIds]  device ids for "Blank all".
 *   Includes video-wall MEMBER devices (each wall screen is a real device that
 *   must receive its own screen_off/on). Falls back to roomIds when absent.
 * @param {() => void} [opts.refreshAfterSend]  re-fetches live display state
 *   after a successful send.
 * @param {() => void} [opts.onMultiview]  opens the multiview layout builder
 *   (mounted above the Video Wall 1 card by the host view).
 */
export function renderCommandBar(container, {
  roomIds,
  blankIds,
  refreshAfterSend,
  onMultiview,
  onRouteSource,
  onBlankChange,
} = {}) {
  if (!container) return;

  // Guard: a usable roomIds() provider is required. Render a composed error
  // state (not a bare string) so the bar never shows a raw failure.
  if (typeof roomIds !== 'function') {
    container.innerHTML = `<div class="mc-cmdbar">${errorState(t('mc.cmd.error'))}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="mc-cmdbar" role="group" aria-label="${esc(t('mc.cmd.aria_bar'))}">
      <div class="mc-cmd-row">
        <button type="button" class="mc-btn mc-cmd-btn mc-btn-cta mc-cmd-multiview" data-cmd="multiview">
          ${ICON_MV}
          <span class="mc-cmd-btn-label">${esc(t('mc.cmd.multiview'))}</span>
        </button>

        <button type="button" class="mc-btn mc-cmd-btn mc-cmd-blank" data-cmd="blank" aria-pressed="false">
          ${ICON_BLANK}
          <span class="mc-cmd-btn-label" data-blank-label>${esc(t('mc.cmd.blank'))}</span>
        </button>

        <div class="mc-cmd-launch" role="group" aria-label="${esc(t('mc.cmd.aria_launch'))}">
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="screen">
            ${ICON_SCREEN}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.share_screen'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="youtube">
            ${ICON_YT}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.youtube'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="library">
            ${ICON_LIB}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.library'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary mc-cmd-live-prepare" data-launch="live-prepare" aria-pressed="false">
            ${ICON_PREPARE}
            <span class="mc-cmd-btn-label">${esc(t('mc.cc.dock.prepare_live'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-cmd-live" data-launch="live-stream">
            ${ICON_LIVE}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_stream'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="live-clear" hidden>
            ${ICON_LIVE_CLEAR}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_clear'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-cmd-live-stop" data-launch="live-stop" hidden>
            ${ICON_LIVE_STOP}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.live_stop'))}</span>
          </button>
        </div>
      </div>

      <div class="mc-cmd-blank-banner" role="status" aria-live="polite" hidden>${esc(t('mc.cmd.blank_banner'))}</div>
    </div>`;

  const blankBtn = container.querySelector('.mc-cmd-blank');
  const blankLabel = container.querySelector('[data-blank-label]');
  const banner = container.querySelector('.mc-cmd-blank-banner');
  const liveStartBtn = container.querySelector('[data-launch="live-stream"]');
  const livePrepareBtn = container.querySelector('[data-launch="live-prepare"]');
  const liveClearBtn = container.querySelector('[data-launch="live-clear"]');
  const liveStopBtn = container.querySelector('[data-launch="live-stop"]');

  const syncLiveControls = async () => {
    try {
      const status = await api.liveStream.status();
      const active = status?.ai_director?.data?.stream_active === true;
      if (livePrepareBtn) livePrepareBtn.hidden = active;
      if (liveStartBtn) liveStartBtn.hidden = active;
      if (liveStopBtn) liveStopBtn.hidden = !active;
      if (liveClearBtn) liveClearBtn.hidden = !active;
    } catch {
      if (livePrepareBtn) livePrepareBtn.hidden = false;
      if (liveStartBtn) liveStartBtn.hidden = false;
      if (liveStopBtn) liveStopBtn.hidden = true;
      if (liveClearBtn) liveClearBtn.hidden = true;
    }
  };

  // Mirror present.js's reflectBlank: keep the toggle label, active class,
  // aria-pressed, and the visible banner all in sync with the `blanked` flag.
  const reflect = () => {
    if (blankLabel) blankLabel.textContent = blanked ? t('mc.cmd.unblank') : t('mc.cmd.blank');
    if (blankBtn) {
      blankBtn.classList.toggle('mc-cmd-blank-active', blanked);
      blankBtn.setAttribute('aria-pressed', blanked ? 'true' : 'false');
    }
    if (banner) banner.hidden = !blanked;
  };

  // PRIMARY: Multiview — open the multiview layout builder. The host view
  // mounts the composer directly above the Video Wall 1 card.
  const mvBtn = container.querySelector('[data-cmd="multiview"]');
  if (mvBtn) {
    mvBtn.addEventListener('click', () => {
      if (typeof onMultiview === 'function') onMultiview();
    });
  }

  // TOGGLE: Blank all — flip the module flag, then drive every room display to
  // SCREEN_OFF (blanked) or SCREEN_ON (resumed).
  blankBtn.addEventListener('click', async () => {
    const nextBlanked = !blanked;
    if (typeof onBlankChange === 'function') {
      blankBtn.disabled = true;
      try {
        await onBlankChange(nextBlanked);
        blanked = nextBlanked;
        reflect();
        showToast(blanked ? t('mc.cmd.blanked') : t('mc.cmd.unblanked'), 'info');
      } catch (error) {
        showToast(error?.message || t('mc.cmd.error'), 'error');
      } finally {
        blankBtn.disabled = false;
      }
      return;
    }
    // Blank all targets every physical screen, INCLUDING video-wall members
    // (via blankIds); fall back to roomIds when no wall-aware provider is given.
    const blankProvider = (typeof blankIds === 'function') ? blankIds : roomIds;
    const ids = normalizeIds(blankProvider());
    if (ids.length === 0) {
      showToast(t('mc.cmd.no_displays'), 'error');
      return;
    }
    blanked = !blanked;
    const cmd = blanked ? COMMAND_TYPES.SCREEN_OFF : COMMAND_TYPES.SCREEN_ON;
    ids.forEach((id) => sendCommand(id, cmd, {}));
    reflect();
    showToast(blanked ? t('mc.cmd.blanked') : t('mc.cmd.unblanked'), 'info');
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  });

  // SECONDARY quick-launch buttons.
  container.querySelectorAll('[data-launch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      switch (btn.dataset.launch) {
        case 'screen': window.location.hash = '#/screen-share'; break;
        case 'youtube': promptYouTube(roomIds, refreshAfterSend, onRouteSource); break;
        case 'library': window.location.hash = '#/content'; break;
        case 'live-prepare': await prepareLiveProgram(btn, refreshAfterSend); break;
        case 'live-stream': await startLiveStream(btn, refreshAfterSend); await syncLiveControls(); break;
        case 'live-clear': await clearLiveContent(btn, refreshAfterSend); break;
        case 'live-stop': await stopLiveStream(btn, refreshAfterSend); await syncLiveControls(); break;
      }
    });
  });

  // Sync the toggle to the persisted module state on (re-)render.
  reflect();
  syncLiveControls();
}
