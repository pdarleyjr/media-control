// Shared rendering helpers for enterprise components. Kept tiny and dependency
// light so components can be unit-tested in isolation and rendered headlessly.
import { OPERATOR_STATE_META, OPERATOR_STATE } from '../../state/operator-state.js';

// Build a color-independent state chip: tone class + glyph + text label.
// `i18n` is the t() function injected at mount so this module stays pure.
export function stateChip(state, i18n) {
  const meta = OPERATOR_STATE_META[state] || OPERATOR_STATE_META[OPERATOR_STATE.STANDBY];
  const label = (i18n && typeof i18n === 'function') ? i18n(meta.labelKey) : state;
  const tone = meta.tone || 'idle';
  return `<span class="mc-e-state-chip is-${tone}" data-op-state="${state}" role="status">
    <span class="mc-e-state-glyph" aria-hidden="true">${meta.glyph}</span>
    <span class="mc-e-state-text">${esc(label)}</span>
  </span>`;
}

export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Create an element from an HTML string (first child) for safe insertion.
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

// Debounce helper for resize/refresh.
export function debounce(fn, ms = 120) {
  let t = null;
  return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Format seconds as M:SS.
export function fmtTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '--:--';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
