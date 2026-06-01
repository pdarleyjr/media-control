// MBFD Media Control Studio — Files (per-user Nextcloud). Phase 6.
// Browses the signed-in member's own Nextcloud files over the server-side
// raw-FS proxy (routes/files.js → services/nextcloud-fs.js). Each member
// sees only THEIR own tree; the server enforces isolation via JWT email.
//
// P6-6: image/* and video/* rows get a per-row Broadcast button that opens a
// display multiselect and calls api.files.broadcast. The email is always
// req.user.email on the server side — never sent from the client.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm.js';

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

// MIME types broadcastable from Nextcloud (image/* and video/* only per plan).
const NC_BROADCASTABLE = /^(image|video)\//;

// Show a modal-style display picker and broadcast the NC file to the selected
// displays. Returns after the broadcast (success or failure).
async function broadcastNcFile(path, label) {
  let devices = [];
  try {
    const result = await api.getDevices();
    devices = Array.isArray(result) ? result : (result && Array.isArray(result.devices) ? result.devices : []);
  } catch (e) {
    showToast('Could not load displays: ' + (e?.message || ''), 'error');
    return;
  }
  if (!devices.length) {
    showToast('No displays are paired yet.', 'error');
    return;
  }

  // Build a simple modal with checkboxes for each display.
  const modalId = 'nc-broadcast-modal';
  let existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = modalId;
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';
  modal.innerHTML = `
    <div style="background:var(--mc-surface,#0f172a);border:1px solid var(--mc-border,#243044);border-radius:var(--mc-radius,8px);padding:24px;min-width:320px;max-width:480px;width:90vw">
      <div style="font-weight:var(--mc-fw-bold);font-size:var(--mc-font-size-lg,1.1rem);color:var(--mc-text-primary);margin-bottom:4px">Broadcast to displays</div>
      <div style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary);margin-bottom:16px">${esc(label)}</div>
      <div id="nc-bcast-devlist" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
        ${devices.map((d) => `
          <label style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid var(--mc-border-light);background:var(--mc-surface)">
            <input type="checkbox" value="${esc(d.id)}" style="margin:0">
            <span style="width:8px;height:8px;border-radius:50%;background:${String(d.status||'').toLowerCase()==='online'?'var(--mc-online,#16A34A)':'var(--mc-text-tertiary,#9CA3AF)'};flex:0 0 auto"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mc-text-primary)">${esc(d.name || 'Display')}</span>
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button id="nc-bcast-cancel" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:9px 18px;cursor:pointer;color:var(--mc-text-primary)">Cancel</button>
        <button id="nc-bcast-go" style="background:var(--mc-primary,#DC2626);color:#fff;border:none;border-radius:var(--mc-radius-sm);padding:9px 18px;cursor:pointer;font-weight:var(--mc-fw-bold)">Broadcast</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  await new Promise((resolve) => {
    modal.querySelector('#nc-bcast-cancel').addEventListener('click', () => { modal.remove(); resolve(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); resolve(); } });
    modal.querySelector('#nc-bcast-go').addEventListener('click', async () => {
      const checked = [...modal.querySelectorAll('#nc-bcast-devlist input[type=checkbox]:checked')].map((cb) => cb.value);
      if (!checked.length) { showToast('Select at least one display.', 'error'); return; }
      const btn = modal.querySelector('#nc-bcast-go');
      btn.disabled = true; btn.textContent = '…';
      try {
        let result = await api.files.broadcast(path, checked);
        if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
          modal.remove();
          const ok = await confirmDialog({
            title: `Show on ALL ${result.count} displays?`,
            message: `This puts "${esc(label)}" on every display in the room.`,
            confirmLabel: 'Show on all',
            tone: 'default',
          });
          if (!ok) { resolve(); return; }
          result = await api.files.broadcast(path, checked, { confirm_all: true });
        } else {
          modal.remove();
        }
        if (result && result.success) {
          const offline = (result.total || 0) - (result.sent || 0);
          showToast(
            `${esc(label)} → ${result.sent} display${result.sent === 1 ? '' : 's'}${offline > 0 ? ` (${offline} offline)` : ''}`,
            'success'
          );
        }
      } catch (err) {
        showToast(err?.message || 'Broadcast failed.', 'error');
        modal.remove();
      }
      resolve();
    });
  });
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

  const rows = items.length ? items.map((it) => {
    const canBroadcast = !it.is_dir && NC_BROADCASTABLE.test(it.mime_type || '');
    return `
    <div class="mc-row" ${it.is_dir ? `data-dir="${esc(it.path)}" style="cursor:pointer"` : ''}>
      <span class="mc-row-thumb">${it.is_dir
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'}</span>
      <div class="mc-row-main"><div class="mc-row-name">${esc(it.name)}</div><div class="mc-row-sub">${it.is_dir ? 'Folder' : fmtSize(it.size)}${it.modified ? ' · ' + esc(new Date(it.modified).toLocaleDateString()) : ''}</div></div>
      ${canBroadcast ? `<button data-bcast="${esc(it.path)}" data-bcast-label="${esc(it.name)}" style="background:var(--mc-primary,#DC2626);color:#fff;border:none;border-radius:var(--mc-radius-sm);padding:5px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;margin-right:4px" title="Broadcast to a display">Broadcast</button>` : ''}
      ${it.is_dir ? '' : `<button data-dl="${esc(it.path)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:5px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;color:var(--mc-text-primary)">Download</button>`}
    </div>`;
  }).join('') : '<div class="mc-panel-empty">This folder is empty.</div>';

  body.innerHTML = `
    <div style="margin-bottom:var(--mc-space-md);font-size:var(--mc-font-size-sm)" id="crumbs">${header()}</div>
    <div class="mc-panel"><div class="mc-panel-body">${rows}</div></div>`;

  body.querySelector('#crumbs')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]'); if (!a) return; e.preventDefault(); cur = a.dataset.go || ''; load(app);
  });
  body.addEventListener('click', async (e) => {
    const dir = e.target.closest('[data-dir]');
    const dl = e.target.closest('[data-dl]');
    const bcast = e.target.closest('[data-bcast]');
    if (dir) { cur = dir.dataset.dir; load(app); return; }
    // Broadcast button: import image/video from caller's NC → content row → display.
    // GUARDRAIL: email comes from req.user.email (JWT), never from the client.
    if (bcast) {
      const path = bcast.dataset.bcast;
      const label = bcast.dataset.bcastLabel || path.split('/').pop();
      await broadcastNcFile(path, label);
      return;
    }
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
