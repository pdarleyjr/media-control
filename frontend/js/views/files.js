// MBFD Media Control Studio — Files (per-user Nextcloud). Phase 6.
// Browses the signed-in member's own Nextcloud files over the server-side
// raw-FS proxy (routes/files.js → services/nextcloud-fs.js). Each member
// sees only THEIR own tree; the server enforces isolation via JWT email.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

let cur = '';

function header() {
  const parts = cur.split('/').filter(Boolean);
  let acc = '';
  const crumbs = ['<a href="#" data-go="" style="color:var(--mc-primary);text-decoration:none">Files</a>']
    .concat(parts.map((p) => { acc += '/' + p; return `<a href="#" data-go="${esc(acc)}" style="color:var(--mc-primary);text-decoration:none">${esc(p)}</a>`; }));
  return crumbs.join('<span style="color:var(--mc-text-tertiary);margin:0 8px">/</span>');
}

async function load(app) {
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap">
        <div class="mc-studio-header">
          <div class="mc-studio-title">Files</div>
          <div class="mc-studio-sub">Browse <strong>your</strong> Nextcloud files — exported decks and shared assets.</div>
        </div>
        <div id="filesBody"><div class="mc-panel"><div class="mc-panel-empty">Connecting to Nextcloud…</div></div></div>
      </div>
    </div>`;
  const body = document.getElementById('filesBody');

  let health;
  try { health = await api.files.health(); } catch { health = { enabled: true, connected: false, error: 'unreachable' }; }
  if (health.enabled === false) {
    body.innerHTML = `<div class="mc-panel"><div class="mc-panel-empty">The Files module is disabled on this server.</div></div>`;
    return;
  }
  if (!health.connected) {
    body.innerHTML = `<div class="mc-panel"><div class="mc-panel-empty">
      <strong>Could not connect to your Nextcloud files.</strong><br>
      ${esc(health.error || 'The Nextcloud microservice may be unreachable.')}
    </div></div>`;
    return;
  }

  let items = [];
  try { items = await api.files.list(cur); if (!Array.isArray(items)) items = []; }
  catch (e) { body.innerHTML = `<div class="mc-panel"><div class="mc-panel-empty">Could not list this folder: ${esc(e.message || '')}</div></div>`; return; }

  const rows = items.length ? items.map((it) => `
    <div class="mc-row" ${it.is_dir ? `data-dir="${esc(it.path)}" style="cursor:pointer"` : ''}>
      <span class="mc-row-thumb">${it.is_dir
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'}</span>
      <div class="mc-row-main"><div class="mc-row-name">${esc(it.name)}</div><div class="mc-row-sub">${it.is_dir ? 'Folder' : fmtSize(it.size)}${it.modified ? ' · ' + esc(new Date(it.modified).toLocaleDateString()) : ''}</div></div>
      ${it.is_dir ? '' : `<button data-dl="${esc(it.path)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:5px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;color:var(--mc-text-primary)">Download</button>`}
    </div>`).join('') : '<div class="mc-panel-empty">This folder is empty.</div>';

  body.innerHTML = `
    <div style="margin-bottom:var(--mc-space-md);font-size:var(--mc-font-size-sm)" id="crumbs">${header()}</div>
    <div class="mc-panel"><div class="mc-panel-body">${rows}</div></div>`;

  body.querySelector('#crumbs')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]'); if (!a) return; e.preventDefault(); cur = a.dataset.go || ''; load(app);
  });
  body.addEventListener('click', async (e) => {
    const dir = e.target.closest('[data-dir]');
    const dl = e.target.closest('[data-dl]');
    if (dir) { cur = dir.dataset.dir; load(app); return; }
    if (dl) {
      const path = dl.dataset.dl;
      dl.disabled = true; dl.textContent = '…';
      try {
        const token = localStorage.getItem('token');
        const r = await fetch('/api/files/download?path=' + encodeURIComponent(path), { headers: token ? { Authorization: 'Bearer ' + token } : {} });
        if (!r.ok) throw new Error('download failed');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = path.split('/').pop(); document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (err) { showToast(err.message || 'Download failed', 'error'); }
      dl.disabled = false; dl.textContent = 'Download';
    }
  });
}

export async function render(app) { cur = ''; await load(app); }
