// Content Selector (task §8).
//
// Unified selector across PowerPoint/Video/Image/PDF/Screen share/Camera/
// PeerTube/Web content. Renders filter facets, item cards with thumbnail/
// type/owner/visibility/processing/compatibility/duration/use indicator, and
// reports the selection to the host. Privacy across users is enforced by the
// backend (api.getGovernedContent) — the UI never surfaces private content
// belonging to others.
import { enterpriseApi } from '../../state/enterprise-api.js';
import { esc } from '../display-layout/render-helpers.js';

const TYPE_GLYPH = { slides: '📊', video: '🎬', image: '🖼', pdf: '📕', screen: '🖥', camera: '📹', peertube: '▶', web: '🌐', doc: '📄', sheet: '📈' };

function visibilityLabel(v, i18n) {
  const map = { private: 'mc.e.content.vis.private', workspace_shared: 'mc.e.content.vis.workspace', organization_shared: 'mc.e.content.vis.org', platform_template: 'mc.e.content.vis.template' };
  return i18n ? i18n(map[v] || 'mc.e.content.vis.private') : v;
}

export function mountContentSelector(host, { store, i18n, onSelect, api = enterpriseApi }) {
  if (!host) throw new Error('mountContentSelector requires a host element');
  host.classList.add('mc-e-content-selector');
  host.setAttribute('data-component', 'content-selector');
  host.setAttribute('role', 'group');

  const facets = [
    { key: 'recent', label: i18n ? i18n('mc.e.content.facet.recent') : 'Recent' },
    { key: 'favorites', label: i18n ? i18n('mc.e.content.facet.favorites') : 'Favorites' },
    { key: 'mine', label: i18n ? i18n('mc.e.content.facet.mine') : 'My private' },
    { key: 'workspace_shared', label: i18n ? i18n('mc.e.content.facet.workspace') : 'Workspace shared' },
    { key: 'organization_shared', label: i18n ? i18n('mc.e.content.facet.org') : 'Organization shared' },
    { key: 'platform_template', label: i18n ? i18n('mc.e.content.facet.templates') : 'Templates' },
    { key: 'type', label: i18n ? i18n('mc.e.content.facet.type') : 'Type' },
    { key: 'archived', label: i18n ? i18n('mc.e.content.facet.archived') : 'Archived' },
  ];

  let activeFacet = 'recent';
  let items = [];

  async function load() {
    const filters = {};
    if (activeFacet === 'mine') filters.mine = true;
    else if (activeFacet === 'archived') filters.archived = true;
    else if (['workspace_shared', 'organization_shared', 'platform_template'].includes(activeFacet)) filters.visibility = activeFacet;
    try {
      items = await api.content.list(filters);
    } catch {
      items = [];
    }
    render();
  }

  function render() {
    const facetChips = facets.map((f) =>
      `<button type="button" class="mc-e-content-facet ${f.key === activeFacet ? 'is-active' : ''}" data-facet="${f.key}" aria-pressed="${f.key === activeFacet}">${esc(f.label)}</button>`,
    ).join('');

    const cards = items.map((item) => {
      const glyph = TYPE_GLYPH[item.type] || '📄';
      const dur = item.duration ? `<span class="mc-e-content-dur">${item.duration}s</span>` : (item.slideCount ? `<span class="mc-e-content-slides">${item.slideCount} ${esc(i18n ? i18n('mc.e.content.slides') : 'slides')}</span>` : '');
      const inUse = item.inUse ? `<span class="mc-e-content-inuse" role="status">${esc(i18n ? i18n('mc.e.content.in_use') : 'In use')}</span>` : '';
      const processing = item.processing ? `<span class="mc-e-content-processing" role="status">${esc(i18n ? i18n('mc.e.content.processing') : 'Processing')}</span>` : '';
      const compat = item.compatible === false ? `<span class="mc-e-content-incompat">${esc(i18n ? i18n('mc.e.content.incompatible') : 'Incompatible')}</span>` : '';
      return `<button type="button" class="mc-e-content-card" data-content-id="${esc(item.id)}" data-content-type="${esc(item.type)}">
        <span class="mc-e-content-thumb" aria-hidden="true">${glyph}</span>
        <span class="mc-e-content-title">${esc(item.title)}</span>
        <span class="mc-e-content-meta"><span class="mc-e-content-type">${esc(item.type)}</span> · <span class="mc-e-content-owner">${esc(item.owner)}</span> · <span class="mc-e-content-vis">${esc(visibilityLabel(item.visibility, i18n))}</span></span>
        ${dur}${inUse}${processing}${compat}
      </button>`;
    }).join('') || `<div class="mc-e-content-empty">${esc(i18n ? i18n('mc.e.content.empty') : 'No content')}</div>`;

    host.innerHTML = `
      <div class="mc-e-content-facets" role="group" aria-label="${esc(i18n ? i18n('mc.e.content.facets_aria') : 'Content filters')}">${facetChips}</div>
      <div class="mc-e-content-list" role="listbox" aria-label="${esc(i18n ? i18n('mc.e.content.list_aria') : 'Content library')}">${cards}</div>`;
  }

  host.addEventListener('click', async (ev) => {
    const facetBtn = ev.target.closest('button[data-facet]');
    if (facetBtn) { activeFacet = facetBtn.getAttribute('data-facet'); await load(); return; }
    const card = ev.target.closest('button[data-content-id]');
    if (!card) return;
    const id = card.getAttribute('data-content-id');
    const type = card.getAttribute('data-content-type');
    if (onSelect) onSelect({ id, type, item: items.find((i) => i.id === id) });
  });

  const unsub = store.subscribe(() => {});
  load();
  return () => { unsub(); host.innerHTML = ''; host.removeAttribute('data-component'); };
}

export default mountContentSelector;
