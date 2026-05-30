// CSP-safe confirm/alert dialogs built on the native <dialog> element.
//
// Why this exists: the classroom controller is touch-first and must not use
// window.confirm()/alert() (un-styleable, not touch-friendly, jarring on a
// wall-mounted panel). <dialog>.showModal() gives top-layer stacking, an inert
// background, ::backdrop and Esc-to-close for free — no focus-trap library.
//
// CSP: all behavior is wired with addEventListener (no inline handlers) and all
// positioning/state is via class toggles + CSSOM, so this works even under a
// strict policy. Styling lives in main.css (.mc-dialog*).
//
// Usage:
//   import { confirmDialog } from './confirm.js';
//   if (await confirmDialog({ title: 'Blank ALL displays?', message: '…',
//                             confirmLabel: 'Blank all', tone: 'danger',
//                             hold: true })) { … }

import { esc } from '../utils.js';

let dialogEl = null;

function ensureDialog() {
  if (dialogEl && document.body.contains(dialogEl)) return dialogEl;
  dialogEl = document.createElement('dialog');
  dialogEl.className = 'mc-dialog';
  dialogEl.setAttribute('aria-labelledby', 'mcDialogTitle');
  dialogEl.innerHTML = `
    <form method="dialog" class="mc-dialog-card">
      <h3 id="mcDialogTitle" class="mc-dialog-title"></h3>
      <p class="mc-dialog-msg"></p>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-mc-cancel></button>
        <button type="button" class="mc-btn mc-btn-confirm" data-mc-confirm>
          <span class="mc-hold-fill"></span><span class="mc-btn-label"></span>
        </button>
      </div>
    </form>`;
  document.body.appendChild(dialogEl);
  return dialogEl;
}

/**
 * Show a modal confirm. Resolves true on confirm, false on cancel/Esc/backdrop.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.message]
 * @param {string} [o.confirmLabel='Confirm']
 * @param {string} [o.cancelLabel='Cancel']
 * @param {'default'|'danger'} [o.tone='default']
 * @param {boolean} [o.hold=false]  press-and-hold (~800ms) to confirm — for irreversible all-display blasts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(o = {}) {
  const d = ensureDialog();
  const titleEl = d.querySelector('.mc-dialog-title');
  const msgEl = d.querySelector('.mc-dialog-msg');
  const cancelBtn = d.querySelector('[data-mc-cancel]');
  const confirmBtn = d.querySelector('[data-mc-confirm]');
  const fill = confirmBtn.querySelector('.mc-hold-fill');
  const label = confirmBtn.querySelector('.mc-btn-label');

  titleEl.textContent = o.title || 'Are you sure?';
  msgEl.textContent = o.message || '';
  msgEl.style.display = o.message ? '' : 'none';
  cancelBtn.textContent = o.cancelLabel || 'Cancel';
  label.textContent = o.confirmLabel || 'Confirm';
  confirmBtn.classList.toggle('mc-btn-danger', o.tone === 'danger');
  confirmBtn.classList.toggle('mc-btn-hold', !!o.hold);

  return new Promise((resolve) => {
    let settled = false;
    let holdTimer = null;

    const cleanup = () => {
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirmClick);
      confirmBtn.removeEventListener('pointerdown', onHoldStart);
      confirmBtn.removeEventListener('pointerup', onHoldEnd);
      confirmBtn.removeEventListener('pointercancel', onHoldEnd);
      confirmBtn.removeEventListener('pointerleave', onHoldEnd);
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onClose);
      clearTimeout(holdTimer);
      fill.classList.remove('active');
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (d.open) d.close();
      resolve(val);
    };
    const onCancel = (e) => { if (e) e.preventDefault(); finish(false); };
    const onClose = () => finish(false);            // backdrop / Esc fallthrough
    const onConfirmClick = () => { if (!o.hold) finish(true); };
    const onHoldStart = (e) => {
      if (!o.hold) return;
      e.preventDefault();
      fill.classList.add('active');                 // CSS transitions the fill width
      holdTimer = setTimeout(() => finish(true), 820);
    };
    const onHoldEnd = () => {
      if (!o.hold) return;
      clearTimeout(holdTimer);
      fill.classList.remove('active');
    };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirmClick);
    confirmBtn.addEventListener('pointerdown', onHoldStart);
    confirmBtn.addEventListener('pointerup', onHoldEnd);
    confirmBtn.addEventListener('pointercancel', onHoldEnd);
    confirmBtn.addEventListener('pointerleave', onHoldEnd);
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onClose);

    d.showModal();
  });
}

/** Simple modal alert (one OK button). Resolves when dismissed. */
export function alertDialog({ title, message, okLabel = 'OK' } = {}) {
  return confirmDialog({ title, message, confirmLabel: okLabel, cancelLabel: '' })
    .then(() => { /* either button just closes */ });
}
