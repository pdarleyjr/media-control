// transport.js — transport controls (prev / play_pause / next / restart) and
// blank/unblank toggle for a single display on the unified Media Control stage.
//
// Renders a compact control bar into `container`. Uses `sendCommand` from
// socket.js with COMMAND_TYPES / TRANSPORT_ACTIONS constants from
// player-protocol.js. The blank toggle uses the ack callback so the card's
// screen_on status reflects the authoritative server-side value (Task 1.4 persists
// it on the DB side; we update the display-state store client-side on ack here).
//
// Public exports:
//   renderTransportBar(container, { deviceId, screenOn, onScreenOnChange })
//     — Renders the bar into `container` immediately (synchronous DOM write).
//       The `onScreenOnChange` callback is invoked with the new boolean value
//       once the device acks the blank/unblank command so callers can repaint.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { sendCommand } from '../../socket.js';
import { COMMAND_TYPES, TRANSPORT_ACTIONS } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';

// Button definitions for the four transport actions. Glyph labels stay literal;
// the accessible name (title/aria) is localized at render time via titleKey.
const TRANSPORT_BTNS = [
  { action: TRANSPORT_ACTIONS[1], label: '⏮', titleKey: 'mc.tp.prev' },        // 'prev'
  { action: TRANSPORT_ACTIONS[3], label: '↺', titleKey: 'mc.tp.restart' },     // 'restart'
  { action: TRANSPORT_ACTIONS[2], label: '⏯', titleKey: 'mc.tp.play_pause' },  // 'play_pause'
  { action: TRANSPORT_ACTIONS[0], label: '⏭', titleKey: 'mc.tp.next' },        // 'next'
];

/**
 * Render transport controls + blank toggle into `container`.
 *
 * @param {HTMLElement} container
 * @param {object}  opts
 * @param {string}  opts.deviceId          target device id
 * @param {boolean} [opts.screenOn=true]   current screen_on state (drives blank label/colour)
 * @param {(newValue:boolean)=>void} [opts.onScreenOnChange]
 *   Called after the device acks a blank/unblank command with the new boolean
 *   value. Callers should use this to update display-state so the stage card
 *   re-paints with the correct status dot and "Blanked" label.
 */
export function renderTransportBar(container, { deviceId, screenOn = true, onScreenOnChange } = {}) {
  if (!container) return;

  const transportHtml = TRANSPORT_BTNS.map(b => {
    const title = t(b.titleKey);
    // Glyph + visible text label so each control reads clearly (Previous /
    // Restart / Play / Pause / Next), not just an icon. title/aria stay for AT.
    return `<button type="button" class="mc-tp-btn" data-tp-action="${esc(b.action)}" title="${esc(title)}" aria-label="${esc(title)}"><span class="mc-tp-ico" aria-hidden="true">${b.label}</span><span class="mc-tp-text">${esc(title)}</span></button>`;
  }).join('');

  const blankLabel = screenOn ? t('mc.tp.blank') : t('mc.tp.unblank');
  const blankTitle = screenOn ? t('mc.tp.blank_title') : t('mc.tp.unblank_title');
  const blankClass = screenOn ? 'mc-tp-blank' : 'mc-tp-blank mc-tp-blank-active';

  container.innerHTML = `
    <div class="mc-transport-bar" role="toolbar" aria-label="${esc(t('mc.tp.toolbar'))}">
      <div class="mc-tp-group">${transportHtml}</div>
      <button type="button" class="${blankClass}" data-tp-blank
              title="${esc(blankTitle)}"
              aria-pressed="${screenOn ? 'false' : 'true'}">${esc(blankLabel)}</button>
    </div>`;

  // Stop event propagation so clicks on transport buttons do NOT bubble up to
  // the parent stage card's click handler (which would open the inspector).
  container.querySelectorAll('.mc-tp-btn, [data-tp-blank]').forEach(btn => {
    btn.addEventListener('click', e => e.stopPropagation());
  });

  // Transport action buttons (prev / play_pause / next / restart)
  container.querySelectorAll('[data-tp-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.tpAction;
      if (!TRANSPORT_ACTIONS.includes(action)) return;
      sendCommand(deviceId, COMMAND_TYPES.TRANSPORT, { action });
    });
  });

  // Blank / unblank toggle — uses ack callback for authoritative state update.
  const blankBtn = container.querySelector('[data-tp-blank]');
  if (blankBtn) {
    blankBtn.addEventListener('click', () => {
      const turningOn = blankBtn.classList.contains('mc-tp-blank-active'); // currently blanked → turn on
      const type = turningOn ? COMMAND_TYPES.SCREEN_ON : COMMAND_TYPES.SCREEN_OFF;
      blankBtn.disabled = true;

      sendCommand(deviceId, type, {}, (ack) => {
        blankBtn.disabled = false;
        if (!ack || (!ack.delivered && !ack.queued)) {
          showToast(turningOn ? t('mc.tp.unblank_failed') : t('mc.tp.blank_failed'), 'error');
          return;
        }
        // Ack received: update the button label to reflect the new state
        // immediately so the operator gets visual feedback even before the
        // next full display-state refresh paints the status dot.
        const newScreenOn = turningOn;   // screen_on = true means screen is ON
        blankBtn.textContent = newScreenOn ? t('mc.tp.blank') : t('mc.tp.unblank');
        blankBtn.title = newScreenOn ? t('mc.tp.blank_title') : t('mc.tp.unblank_title');
        blankBtn.setAttribute('aria-pressed', newScreenOn ? 'false' : 'true');
        if (newScreenOn) {
          blankBtn.classList.remove('mc-tp-blank-active');
        } else {
          blankBtn.classList.add('mc-tp-blank-active');
        }
        if (typeof onScreenOnChange === 'function') onScreenOnChange(newScreenOn);
      });
    });
  }
}
