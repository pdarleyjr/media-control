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

import { sendCommand } from '../../socket.js';
import { COMMAND_TYPES, TRANSPORT_ACTIONS } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Button definitions for the four transport actions.
const TRANSPORT_BTNS = [
  { action: TRANSPORT_ACTIONS[1], label: '⏮', title: 'Previous' },   // 'prev'
  { action: TRANSPORT_ACTIONS[3], label: '↺', title: 'Restart' },    // 'restart'
  { action: TRANSPORT_ACTIONS[2], label: '⏯', title: 'Play / Pause' }, // 'play_pause'
  { action: TRANSPORT_ACTIONS[0], label: '⏭', title: 'Next' },       // 'next'
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

  const transportHtml = TRANSPORT_BTNS.map(b =>
    `<button type="button" class="mc-tp-btn" data-tp-action="${esc(b.action)}" title="${esc(b.title)}" aria-label="${esc(b.title)}">${b.label}</button>`
  ).join('');

  const blankLabel = screenOn ? 'Blank' : 'Unblank';
  const blankClass = screenOn ? 'mc-tp-blank' : 'mc-tp-blank mc-tp-blank-active';

  container.innerHTML = `
    <div class="mc-transport-bar" role="toolbar" aria-label="Transport controls">
      <div class="mc-tp-group">${transportHtml}</div>
      <button type="button" class="${blankClass}" data-tp-blank
              title="${screenOn ? 'Blank this display' : 'Unblank this display'}"
              aria-pressed="${screenOn ? 'false' : 'true'}">${blankLabel}</button>
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
          showToast(`Could not ${turningOn ? 'unblank' : 'blank'} the display — device offline or not responding.`, 'error');
          return;
        }
        // Ack received: update the button label to reflect the new state
        // immediately so the operator gets visual feedback even before the
        // next full display-state refresh paints the status dot.
        const newScreenOn = turningOn;   // screen_on = true means screen is ON
        blankBtn.textContent = newScreenOn ? 'Blank' : 'Unblank';
        blankBtn.title = newScreenOn ? 'Blank this display' : 'Unblank this display';
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
