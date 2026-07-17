// transport.js — transport controls (prev / play_pause / next / restart) and
// blank/unblank toggle for a single display on the unified Media Control stage.
//
// Renders a compact control bar into `container`. Uses `sendCommand` from
// socket.js with COMMAND_TYPES / TRANSPORT_ACTIONS constants from
// player-protocol.js. The blank toggle uses the ack callback so the card's
// screen_on status reflects the authoritative server-side value (Task 1.4 persists
// it on the DB side; we update the display-state store client-side on ack here).
//
// The Play/Pause button reflects the device's CURRENT playback state: it shows
// "Pause" when the display is playing and "Play" when it is paused. State comes
// from display-state.js `now_playing.paused` which is kept live by the
// dashboard:playback-state event stream. `paused` undefined (no state report
// yet) defaults to the mid-state label "Play / Pause".
//
// Public exports:
//   renderTransportBar(container, { deviceId, transportDeviceIds, screenOn, paused, onScreenOnChange, onTransportAction })
//     — Renders the bar into `container` immediately (synchronous DOM write).
//       The `onScreenOnChange` callback is invoked with the new boolean value
//       once the device acks the blank/unblank command so callers can repaint.
//       The `onTransportAction` callback is invoked after transport sends so
//       callers can refresh state and preview screenshots.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { sendCommand } from '../../socket.js';
import { COMMAND_TYPES, TRANSPORT_ACTIONS } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';

// Fixed transport buttons — all except play_pause have invariant labels.
// play_pause is rendered dynamically based on `paused` state (see below).
const STATIC_TRANSPORT_BTNS = [
  { action: TRANSPORT_ACTIONS[1], label: '⏮', titleKey: 'mc.tp.prev' },        // 'prev'
  { action: TRANSPORT_ACTIONS[3], label: '↺', titleKey: 'mc.tp.restart' },     // 'restart'
  // play_pause handled separately below
  { action: TRANSPORT_ACTIONS[0], label: '⏭', titleKey: 'mc.tp.next' },        // 'next'
];

/**
 * Render transport controls + blank toggle into `container`.
 *
 * @param {HTMLElement} container
 * @param {object}  opts
 * @param {string}  opts.deviceId          primary target device id
 * @param {string[]} [opts.transportDeviceIds]
 *   Transport target set. Standalone displays use [deviceId]. Span walls pass
 *   every member id so document/deck commands advance each physical player.
 * @param {boolean} [opts.screenOn=true]   current screen_on state (drives blank label/colour)
 * @param {boolean|undefined} [opts.paused]
 *   Current play/pause state from the device. `undefined` = unknown (shows "Play / Pause");
 *   `true` = paused (shows "Play"); `false` = playing (shows "Pause").
 * @param {(newValue:boolean)=>void} [opts.onScreenOnChange]
 *   Called after the device acks a blank/unblank command with the new boolean
 *   value. Callers should use this to update display-state so the stage card
 *   re-paints with the correct status dot and "Blanked" label.
 * @param {(ids:string[], action:string)=>void} [opts.onTransportAction]
 *   Called after a transport command is sent so callers can refresh the
 *   authoritative state and request a fresh preview.
 */
export function renderTransportBar(container, { deviceId, transportDeviceIds, blankDeviceIds, screenOn = true, paused, onScreenOnChange, onTransportAction } = {}) {
  if (!container) return;

  const transportIds = (Array.isArray(transportDeviceIds) && transportDeviceIds.length)
    ? [...new Set(transportDeviceIds.filter(Boolean))]
    : [deviceId];

  // Blank/unblank target set. For a standalone display this is just [deviceId].
  // For a video wall the caller passes every member id (data-blank-ids) so the
  // toggle darkens ALL screens at once — the primary `deviceId` (leader) carries
  // the ack that drives this button's UI state; the rest fire-and-forget.
  const blankIds = (Array.isArray(blankDeviceIds) && blankDeviceIds.length)
    ? [...new Set(blankDeviceIds.filter(Boolean))]
    : [deviceId];

  // Build static transport buttons (prev, restart, next).
  const staticHtml = STATIC_TRANSPORT_BTNS.map(b => {
    const title = t(b.titleKey);
    return `<button type="button" class="mc-tp-btn" data-tp-action="${esc(b.action)}" title="${esc(title)}" aria-label="${esc(title)}"><span class="mc-tp-ico" aria-hidden="true">${b.label}</span><span class="mc-tp-text">${esc(title)}</span></button>`;
  });

  // Play/Pause button: label reflects actual device state when known.
  // paused===true  → show "Play"  (clicking will resume)
  // paused===false → show "Pause" (clicking will pause)
  // paused===undefined → show "Play / Pause" (state not yet known)
  const ppLabel = paused === true ? '▶' : paused === false ? '⏸' : '⏯';
  const ppTitle = paused === true ? t('mc.tp.play') : paused === false ? t('mc.tp.pause') : t('mc.tp.play_pause');
  const ppHtml = `<button type="button" class="mc-tp-btn mc-tp-playpause" data-tp-action="${esc(TRANSPORT_ACTIONS[2])}" title="${esc(ppTitle)}" aria-label="${esc(ppTitle)}"><span class="mc-tp-ico" aria-hidden="true">${ppLabel}</span><span class="mc-tp-text">${esc(ppTitle)}</span></button>`;

  // Insert play/pause after restart (index 1) so order is: ⏮ ↺ ⏯/▶/⏸ ⏭
  const allBtns = [...staticHtml.slice(0, 2), ppHtml, ...staticHtml.slice(2)];
  const transportHtml = allBtns.join('');

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
      const resolvedAction = action === 'play_pause' && paused !== undefined
        ? (paused ? 'play' : 'pause')
        : action;
      transportIds.forEach(id => sendCommand(id, COMMAND_TYPES.TRANSPORT, { action: resolvedAction }));
      if (typeof onTransportAction === 'function') onTransportAction(transportIds, resolvedAction);
    });
  });

  // Blank / unblank toggle — uses ack callback for authoritative state update.
  const blankBtn = container.querySelector('[data-tp-blank]');
  if (blankBtn) {
    blankBtn.addEventListener('click', () => {
      const turningOn = blankBtn.classList.contains('mc-tp-blank-active'); // currently blanked → turn on
      const type = turningOn ? COMMAND_TYPES.SCREEN_ON : COMMAND_TYPES.SCREEN_OFF;
      blankBtn.disabled = true;

      // Fan to every other member first (fire-and-forget); the primary device's
      // ack below drives the button's authoritative UI state.
      blankIds.filter(id => id && id !== deviceId).forEach(id => sendCommand(id, type, {}));

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
