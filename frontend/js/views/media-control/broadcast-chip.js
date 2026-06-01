// broadcast-chip.js — persistent live-broadcast status chip (Task 4.5).
//
// Subscribes to the screen-share engine singleton's onChange feed and renders
// a compact "● Live broadcast → N display(s)" indicator into the supplied element.
// Stays mounted for the lifetime of the view (and is re-mounted on every
// media-control.js render); because the engine is a singleton the chip always
// reflects the true broadcast state even if the user navigated away and back.
//
// Public API:
//   mountBroadcastChip(el)  ->  unsubscribe function
//
// The caller MUST save the return value and call it from the view's unmount()
// so subscriptions don't accumulate across re-renders.

import * as engine from '../../services/screen-share-engine.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Mount the broadcast chip into `el` (#mc-broadcast-chip).
 *
 * @param {HTMLElement} el  The container element for the chip.
 * @returns {() => void}    Unsubscribe function — call from the view's unmount().
 */
export function mountBroadcastChip(el) {
  if (!el) return () => {};

  function paint({ active, targets } = {}) {
    if (!active || !targets || targets.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const n = targets.length;
    el.hidden = false;
    el.innerHTML = `
      <span class="mc-chip-dot" aria-hidden="true">●</span>
      <span class="mc-chip-label">Live broadcast → ${esc(String(n))} display${n === 1 ? '' : 's'}</span>
      <button type="button" class="mc-chip-stop mc-btn mc-btn-danger-sm" data-chip-stop>Stop all</button>`;

    const stopBtn = el.querySelector('[data-chip-stop]');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        engine.stopAll().catch(() => {});
      });
    }
  }

  // Paint the current state immediately (handles the "navigated back" case
  // where a broadcast was already active before the chip was mounted).
  paint({ active: engine.isActive(), targets: engine.getActiveTargets() });

  // Subscribe for all future changes.
  const unsub = engine.onChange((state) => { paint(state); });
  return unsub;
}
