// Universal Layout Selector (task §7).
//
// One layout-selection experience usable with every supported content type.
// Renders visual diagrams (not internal names) from the layout catalog, marks
// unavailable layouts disabled WITH an explanation, and reports the chosen
// intent to the host via onSelect. The actual application routes through the
// EXISTING revision-safe wall layout endpoint + broadcast (see integration
// guide) — this component never mutates topology directly.
import { enterpriseApi } from '../../state/enterprise-api.js';
import { esc } from '../display-layout/render-helpers.js';

// Minimal inline SVG diagrams per layout key. Each renders the display regions.
function diagram(key) {
  const b = (label) => `<svg viewBox="0 0 40 24" class="mc-e-layout-diagram" aria-hidden="true">${label}</svg>`;
  const rect = (x, y, w, h, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" ${extra}/>`;
  const filled = (x, y, w, h, fill = 'var(--mc-e-diagram-fill)') => rect(x, y, w, h, `fill="${fill}"`);
  const stroke = (x, y, w, h) => rect(x, y, w, h, 'fill="none" stroke="var(--mc-e-diagram-stroke)" stroke-width="0.7"');
  switch (key) {
    case 'single': case 'content-fullscreen': return b(filled(4, 4, 32, 16));
    case 'mirror': return b(filled(4, 4, 15, 16) + filled(21, 4, 15, 16));
    case 'span-two': return b(filled(4, 4, 32, 16) + stroke(20, 4, 0, 16));
    case 'span-three': return b(filled(4, 4, 32, 16) + stroke(14.6, 4, 0, 16) + stroke(25.3, 4, 0, 16));
    case 'span-five': return b(filled(4, 4, 32, 16) + [11.2, 18.4, 25.6, 32.8].map((x) => stroke(x, 4, 0, 16)).join(''));
    case 'two-plus-one': return b(filled(4, 4, 20, 16) + filled(26, 4, 10, 16));
    case 'independent': return b(filled(4, 4, 14, 7, 'var(--mc-e-diagram-fill-a)') + filled(22, 4, 14, 7, 'var(--mc-e-diagram-fill-b)') + filled(4, 13, 14, 7, 'var(--mc-e-diagram-fill-c)') + filled(22, 13, 14, 7, 'var(--mc-e-diagram-fill-d)'));
    case 'content-with-camera-pip': return b(filled(4, 4, 32, 16) + filled(26, 12, 8, 6, 'var(--mc-e-diagram-pip)'));
    case 'camera-fullscreen': return b(filled(4, 4, 32, 16, 'var(--mc-e-diagram-pip)'));
    case 'camera-with-content-pip': return b(filled(4, 4, 32, 16, 'var(--mc-e-diagram-pip)') + filled(6, 6, 10, 6, 'var(--mc-e-diagram-fill)'));
    case 'side-by-side': return b(filled(4, 4, 15, 16) + filled(21, 4, 15, 16, 'var(--mc-e-diagram-pip)'));
    case 'custom-saved': return b(filled(4, 4, 18, 16) + filled(24, 8, 12, 8, 'var(--mc-e-diagram-fill-b)'));
    case 'clear': return b(stroke(4, 4, 32, 16) + `<line x1="6" y1="6" x2="34" y2="22" stroke="var(--mc-e-diagram-stroke)" stroke-width="0.7"/>`);
    case 'restore-previous': return b(`<path d="M14 8 a6 6 0 1 0 6 6" fill="none" stroke="var(--mc-e-diagram-stroke)" stroke-width="1"/><polyline points="14 4 14 8 18 8" fill="none" stroke="var(--mc-e-diagram-stroke)" stroke-width="1"/>`);
    default: return b(stroke(4, 4, 32, 16));
  }
}

export function mountLayoutSelector(host, { store, i18n, onSelect }) {
  if (!host) throw new Error('mountLayoutSelector requires a host element');
  host.classList.add('mc-e-layout-selector');
  host.setAttribute('data-component', 'layout-selector');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.layout.aria') : 'Layout selector');

  const catalog = enterpriseApi.layouts.catalog;
  const unavailableReasons = {
    needs_more_displays: i18n ? i18n('mc.e.layout.unavailable_needs_displays') : 'Not enough displays connected',
  };

  let displayCount = 0;

  function render() {
    const cards = enterpriseApi.layouts.availability(displayCount).map((card) => {
      const disabled = !card.available;
      const reason = disabled ? (unavailableReasons[card.unavailableReason] || card.unavailableReason) : '';
      const labelKey = `mc.e.layout.${card.key}`;
      const label = i18n ? i18n(labelKey) : card.key;
      return `<button type="button" class="mc-e-layout-card" data-layout="${card.key}" ${disabled ? 'aria-disabled="true" disabled' : ''} ${reason ? `title="${esc(reason)}"` : ''}>
        ${diagram(card.key)}
        <span class="mc-e-layout-label">${esc(label)}</span>
        <span class="mc-e-layout-audio">${esc(i18n ? i18n(`mc.e.layout.audio.${card.audioAuthority}`) : card.audioAuthority)}</span>
        ${reason ? `<span class="mc-e-layout-unavailable">${esc(reason)}</span>` : ''}
      </button>`;
    }).join('');

    host.innerHTML = `
      <div class="mc-e-layout-grid" role="listbox" aria-label="${esc(i18n ? i18n('mc.e.layout.grid_aria') : 'Layout options')}">
        ${cards}
      </div>`;
  }

  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-layout]');
    if (!btn || btn.disabled) return;
    const key = btn.getAttribute('data-layout');
    const card = catalog.find((c) => c.key === key);
    if (onSelect && card) onSelect(card);
  });

  const unsub = store.subscribe((state) => {
    const next = state?.displays?.length || 0;
    if (next !== displayCount) { displayCount = next; render(); }
  });
  displayCount = store.get()?.displays?.length || 0;
  render();
  return () => { unsub(); host.innerHTML = ''; host.removeAttribute('data-component'); };
}

export default mountLayoutSelector;
