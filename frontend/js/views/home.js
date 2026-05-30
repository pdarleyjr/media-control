// MBFD Media Control Studio — Home dashboard (Phase 1b).
// The studio landing for editors/admins (instructors land on #/present). Mirrors
// reference mockup #3: 6 quick-action cards + stat widgets + recent panels, on
// the light `.mc-studio-surface`. All stats are REAL (computed from live API
// data) — no fabricated numbers. CSP-safe: static innerHTML + <a href="#/..">
// navigation; data fetched via the same JWT api client as every other view.

import { api } from '../api.js';

// Quick actions → routes. Icons are simple stroke SVGs (no external assets).
const ACTIONS = [
  { href: '#/ai-deck', primary: true, label: 'New AI Presentation', sub: 'Generate a deck with Qwen',
    icon: '<path d="M12 2l2.4 4.8L20 8l-4 3.6L17 18l-5-2.8L7 18l1-6.4L4 8l5.6-1.2z"/>' },
  { href: '#/slide-editor', label: 'New Blank Presentation', sub: 'Start from scratch',
    icon: '<path d="M12 5v14M5 12h14"/>' },
  { href: '#/content', label: 'Upload Media', sub: 'Add images & video',
    icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>' },
  { href: '#/downloads', label: 'Download Media', sub: 'Pull in by URL',
    icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' },
  { href: '#/broadcast', label: 'Broadcast Content', sub: 'Push to displays',
    icon: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>' },
  { href: '#/walls', label: 'Open Video Wall', sub: 'Control the wall',
    icon: '<rect x="2" y="3" width="9" height="8" rx="1"/><rect x="13" y="3" width="9" height="8" rx="1"/><rect x="2" y="13" width="9" height="8" rx="1"/><rect x="13" y="13" width="9" height="8" rx="1"/>' },
];

function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Normalize the various shapes the API helpers can return into a plain array.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  if (v && Array.isArray(v.devices)) return v.devices;
  return [];
}

function isOnline(d) {
  return String(d.status || '').toLowerCase() === 'online';
}

function statCard(label, value, iconInner, delta, deltaClass) {
  return `
    <div class="mc-stat-card">
      <div class="mc-stat-top">
        <span class="mc-stat-label">${esc(label)}</span>
        <span class="mc-stat-icon">${svg(iconInner)}</span>
      </div>
      <div class="mc-stat-value">${esc(value)}</div>
      ${delta ? `<div class="mc-stat-delta ${deltaClass || ''}">${esc(delta)}</div>` : ''}
    </div>`;
}

function mediaRow(item) {
  const hasThumb = !!item.thumbnail_path;
  const id = item.id;
  const thumb = hasThumb && id
    ? `<img src="/api/content/${encodeURIComponent(id)}/thumbnail" alt="" loading="lazy">`
    : svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>');
  const type = (item.mime_type || '').split('/')[0] || (item.remote_url ? 'link' : 'file');
  return `
    <div class="mc-row">
      <span class="mc-row-thumb">${thumb}</span>
      <div class="mc-row-main">
        <div class="mc-row-name">${esc(item.name || 'Untitled')}</div>
        <div class="mc-row-sub">${esc(type)}</div>
      </div>
    </div>`;
}

function deviceRow(d) {
  const online = isOnline(d);
  const status = online ? 'online' : (String(d.status || '').toLowerCase() === 'warning' ? 'warning' : 'offline');
  const res = (d.viewport_css_w && d.viewport_css_h) ? `${d.viewport_css_w}×${d.viewport_css_h}` : (d.location_label || '');
  return `
    <div class="mc-row">
      <span class="mc-row-thumb">${svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>')}</span>
      <div class="mc-row-main">
        <div class="mc-row-name">${esc(d.name || 'Display')}</div>
        <div class="mc-row-sub">${esc(res)}</div>
      </div>
      <span class="mc-row-status ${status}">${status === 'online' ? 'Online' : status === 'warning' ? 'Warning' : 'Offline'}</span>
    </div>`;
}

export async function render(app) {
  // Skeleton first so the page paints instantly; fill stats/panels after fetch.
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap">
        <div class="mc-studio-header">
          <div class="mc-studio-title">Welcome to Media Control Studio</div>
          <div class="mc-studio-sub">Create, manage, and broadcast content across your displays and video walls.</div>
        </div>

        <div class="mc-quick-actions">
          ${ACTIONS.map((a) => `
            <a class="mc-action-btn ${a.primary ? 'mc-action-btn-primary' : ''}" href="${a.href}">
              <span class="mc-action-icon">${svg(a.icon)}</span>
              <span class="mc-action-label">${esc(a.label)}</span>
              <span class="mc-action-sub">${esc(a.sub)}</span>
            </a>`).join('')}
        </div>

        <div class="mc-stat-grid" id="homeStats">
          ${statCard('Active Displays', '…', '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>')}
          ${statCard('Library Items', '…', '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>')}
          ${statCard('Playlists', '…', '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>')}
          ${statCard('Device Health', '…', '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>')}
        </div>

        <div class="mc-panels">
          <div class="mc-panel">
            <div class="mc-panel-head"><span class="mc-panel-title">Recent Presentations</span><a class="mc-panel-link" href="#/presentations">View all</a></div>
            <div class="mc-panel-body" id="homeRecentDecks"></div>
          </div>
          <div class="mc-panel">
            <div class="mc-panel-head"><span class="mc-panel-title">Recent Media</span><a class="mc-panel-link" href="#/content">View all</a></div>
            <div class="mc-panel-body" id="homeRecentMedia"></div>
          </div>
          <div class="mc-panel">
            <div class="mc-panel-head"><span class="mc-panel-title">Displays</span><a class="mc-panel-link" href="#/">View all</a></div>
            <div class="mc-panel-body" id="homeDevices"></div>
          </div>
        </div>
      </div>
    </div>`;

  // Fetch live data. allSettled so one failing endpoint can't blank the page.
  const [devRes, conRes, plRes] = await Promise.allSettled([
    api.getDevices(),
    api.getContent(),
    api.getPlaylists(),
  ]);
  const devices = devRes.status === 'fulfilled' ? asArray(devRes.value) : [];
  const content = conRes.status === 'fulfilled' ? asArray(conRes.value) : [];
  const playlists = plRes.status === 'fulfilled' ? asArray(plRes.value) : [];

  const total = devices.length;
  const online = devices.filter(isOnline).length;
  const health = total ? Math.round((online / total) * 100) : null;
  const healthClass = health == null ? '' : health >= 90 ? 'ok' : health >= 60 ? 'warn' : 'bad';

  const statsEl = document.getElementById('homeStats');
  if (statsEl) {
    statsEl.innerHTML =
      statCard('Active Displays', `${online}`, '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>',
        total ? `${online} online · ${total - online} offline` : 'No displays paired', total && online === total ? 'ok' : '') +
      statCard('Library Items', `${content.length}`, '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        'images, video & links') +
      statCard('Playlists', `${playlists.length}`, '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
        'lesson sequences') +
      statCard('Device Health', health == null ? '—' : `${health}%`, '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        health == null ? 'awaiting displays' : (health >= 90 ? 'all systems operational' : 'attention needed'), healthClass);
  }

  // Recent presentations — not built yet (Phase 2); show an inviting empty state.
  const decksEl = document.getElementById('homeRecentDecks');
  if (decksEl) {
    decksEl.innerHTML = `
      <div class="mc-panel-empty">
        No presentations yet.
        <br><a class="mc-panel-empty-cta" href="#/ai-deck">Generate your first deck with AI →</a>
      </div>`;
  }

  const mediaEl = document.getElementById('homeRecentMedia');
  if (mediaEl) {
    const recent = content.slice(0, 5);
    mediaEl.innerHTML = recent.length
      ? recent.map(mediaRow).join('')
      : '<div class="mc-panel-empty">No media yet. <a class="mc-panel-empty-cta" href="#/content">Upload media →</a></div>';
  }

  const devEl = document.getElementById('homeDevices');
  if (devEl) {
    const recent = devices.slice(0, 6);
    devEl.innerHTML = recent.length
      ? recent.map(deviceRow).join('')
      : '<div class="mc-panel-empty">No displays paired. Pair one from the Present screen.</div>';
  }
}
