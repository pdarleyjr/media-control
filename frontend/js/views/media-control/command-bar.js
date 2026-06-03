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
import { t, tn } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { sendCommand } from '../../socket.js';
import { COMMAND_TYPES } from '../../player-protocol.js';
import { sendToDisplays } from './send.js';

// Module-local UI state for the Blank toggle (best-effort, mirrors present.js).
// Tracks whether the room is currently blanked so the toggle, banner, and
// aria-pressed all reflect a single source of truth across re-renders.
let blanked = false;

// YouTube / youtu.be detection — same regex used in present.js / send.js.
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

// ---- inline stroke icons (controlled markup, no user input) ----
const ICON_START = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
const ICON_BLANK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><path d="M4 5l16 14"></path></svg>';
const ICON_SCREEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><polyline points="9 9 12 6 15 9"></polyline><line x1="12" y1="6" x2="12" y2="14"></line></svg>';
const ICON_WB = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1"></rect><path d="M12 17v3"></path><path d="M8 20h8"></path><path d="M7 12c1.5-2 3-2 5 0s3.5 2 5 0"></path></svg>';
const ICON_YT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"></rect><polygon points="10 9 16 12 10 15 10 9" fill="currentColor" stroke="none"></polygon></svg>';
const ICON_LIB = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
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
function promptYouTube(roomIds, refreshAfterSend) {
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
    if (ids.length === 0) {
      showToast(t('mc.cmd.no_displays'), 'error');
      return;
    }
    goBtn.disabled = true;
    const ok = await sendToDisplays({ remote_url: url }, ids, url);
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

/**
 * Render the classroom quick-action command bar into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {() => (string[]|object)} opts.roomIds  returns every controllable
 *   (non-wall) display id in the room. Tolerated shapes: Array or { key:[...] }.
 * @param {() => void} [opts.refreshAfterSend]  re-fetches live display state
 *   after a successful send.
 */
export function renderCommandBar(container, { roomIds, refreshAfterSend } = {}) {
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
        <button type="button" class="mc-btn mc-cmd-btn mc-btn-cta mc-cmd-start" data-cmd="start">
          ${ICON_START}
          <span class="mc-cmd-btn-label">${esc(t('mc.cmd.start'))}</span>
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
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="whiteboard">
            ${ICON_WB}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.whiteboard'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="youtube">
            ${ICON_YT}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.youtube'))}</span>
          </button>
          <button type="button" class="mc-btn mc-cmd-btn mc-btn-secondary" data-launch="library">
            ${ICON_LIB}
            <span class="mc-cmd-btn-label">${esc(t('mc.cmd.library'))}</span>
          </button>
        </div>
      </div>

      <div class="mc-cmd-blank-banner" role="status" aria-live="polite" hidden>${esc(t('mc.cmd.blank_banner'))}</div>
    </div>`;

  const blankBtn = container.querySelector('.mc-cmd-blank');
  const blankLabel = container.querySelector('[data-blank-label]');
  const banner = container.querySelector('.mc-cmd-blank-banner');

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

  // PRIMARY: Start Class — wake/un-blank EVERY room display.
  container.querySelector('[data-cmd="start"]').addEventListener('click', () => {
    const ids = normalizeIds(roomIds());
    if (ids.length === 0) {
      showToast(t('mc.cmd.no_displays'), 'error');
      return;
    }
    ids.forEach((id) => sendCommand(id, COMMAND_TYPES.SCREEN_ON, {}));
    blanked = false;
    reflect();
    showToast(tn('mc.cmd.started', ids.length), 'success');
    if (typeof refreshAfterSend === 'function') refreshAfterSend();
  });

  // TOGGLE: Blank all — flip the module flag, then drive every room display to
  // SCREEN_OFF (blanked) or SCREEN_ON (resumed).
  blankBtn.addEventListener('click', () => {
    const ids = normalizeIds(roomIds());
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
    btn.addEventListener('click', () => {
      switch (btn.dataset.launch) {
        case 'screen': window.location.hash = '#/screen-share'; break;
        case 'whiteboard': window.location.hash = '#/smartboard'; break;
        case 'youtube': promptYouTube(roomIds, refreshAfterSend); break;
        case 'library': window.location.hash = '#/content'; break;
      }
    });
  });

  // Sync the toggle to the persisted module state on (re-)render.
  reflect();
}
