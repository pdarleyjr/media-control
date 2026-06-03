// view-modal.js — open an existing, self-contained view as an OVERLAY on the
// Command Center, so a builder (e.g. Schedules) is reachable WITHOUT a sidebar
// link and WITHOUT leaving #/control. It mounts the view's render(container)
// into a native <dialog> body and calls the view's cleanup()/unmount() on close
// so the view tears down its own listeners/timers.
//
// Only use this for views that render into the PASSED container and DON'T drive
// their own internal navigation via location.hash (those would break out of the
// overlay and trip the app router). Schedules qualifies; the playlist and
// video-wall editors are hash-driven full screens and are launched as their own
// screens instead.
//
// CSP-safe: createElement + addEventListener only, no inline on* handlers; every
// piece of dynamic text passes through esc()/t(). One overlay at a time.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

let current = null; // the single open overlay's controller, or null

const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

/**
 * Open a view as a Command-Center overlay.
 *
 * @param {object} opts
 * @param {string} opts.title                       overlay heading
 * @param {{render:(el:HTMLElement)=>void, cleanup?:Function, unmount?:Function}} [opts.module]
 *        a view module — its render() mounts into the body, cleanup()/unmount()
 *        runs on close.
 * @param {(el:HTMLElement)=>void} [opts.render]     explicit render (overrides module.render)
 * @param {Function} [opts.cleanup]                  explicit teardown (overrides module.*)
 * @param {Function} [opts.onClose]                  fired after the overlay closes
 * @returns {{close:Function}}
 */
export function openViewModal({ title = '', module, render, cleanup, onClose } = {}) {
  closeViewModal(); // singleton — never stack overlays

  const dlg = document.createElement('dialog');
  dlg.className = 'mc-modal mc-view-modal';
  dlg.setAttribute('aria-label', title);
  dlg.innerHTML = `
    <div class="mc-modal-card">
      <header class="mc-modal-head">
        <h2 class="mc-modal-title">${esc(title)}</h2>
        <button type="button" class="mc-modal-close" data-modal-close
                aria-label="${esc(t('mc.modal.close'))}">${ICON_CLOSE}</button>
      </header>
      <div class="mc-modal-body" data-modal-body></div>
    </div>`;
  document.body.appendChild(dlg);

  const body = dlg.querySelector('[data-modal-body]');
  const doRender = render || (module && module.render);
  const doCleanup = cleanup || (module && (module.cleanup || module.unmount));

  // Render the embedded view. A render failure is the view's own concern; we
  // still want the overlay (with its close affordance) to exist.
  try { if (typeof doRender === 'function') doRender(body); } catch (e) { /* view owns its errors */ }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (typeof doCleanup === 'function') doCleanup(); } catch { /* */ }
    dlg.removeEventListener('cancel', onCancel);
    if (dlg.open) { try { dlg.close(); } catch { /* */ } }
    dlg.remove();
    if (current === controller) current = null;
    if (typeof onClose === 'function') { try { onClose(); } catch { /* */ } }
  };
  const onCancel = (e) => { if (e) e.preventDefault(); close(); }; // Esc key

  dlg.querySelector('[data-modal-close]').addEventListener('click', close);
  dlg.addEventListener('cancel', onCancel);
  // Click on the backdrop (the <dialog> element itself, outside the card) closes.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  // A view that legitimately needs to leave (deep link) can request it.
  dlg.addEventListener('mc:close-overlay', close);

  dlg.showModal();

  const controller = { close };
  current = controller;
  return controller;
}

/** Close the open overlay, if any (idempotent). */
export function closeViewModal() {
  if (current) current.close();
}
