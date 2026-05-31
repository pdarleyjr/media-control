// MBFD Media Control Studio — Downloads (Phase 7). Pull media in by URL via
// yt-dlp (server-side) and track jobs. CSP-safe. Polls while jobs are active.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let pollTimer = null;
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function cleanup() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

const STATUS_COLOR = { done: 'var(--mc-success)', error: 'var(--mc-danger)', downloading: 'var(--mc-info)', pending: 'var(--mc-text-secondary)' };

function jobRow(j) {
  return `<div class="mc-row">
    <div class="mc-row-main"><div class="mc-row-name">${esc(j.title || j.source_url)}</div>
    <div class="mc-row-sub">${esc(j.source_url)}${j.error_msg ? ' · ' + esc(j.error_msg) : ''}</div></div>
    <span class="mc-row-status" style="color:${STATUS_COLOR[j.status] || 'var(--mc-text-secondary)'}">${esc(j.status)}</span>
  </div>`;
}

async function refresh() {
  const list = document.getElementById('dlList');
  if (!list) return;
  let jobs = [];
  try { jobs = await api.downloads.list(); if (!Array.isArray(jobs)) jobs = []; } catch { return; }
  list.innerHTML = jobs.length ? jobs.map(jobRow).join('') : '<div class="mc-panel-empty">No downloads yet.</div>';
  const active = jobs.some((j) => j.status === 'pending' || j.status === 'downloading');
  if (!active) cleanup();
}

export async function render(app) {
  cleanup();
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap">
        <div class="mc-studio-header">
          <div class="mc-studio-title">Downloads</div>
          <div class="mc-studio-sub">Pull a video or audio file into your library by URL (YouTube and more).</div>
        </div>
        <div id="dlHealth" style="margin-bottom:var(--mc-space-md)"></div>
        <div style="display:flex;gap:var(--mc-space-sm);margin-bottom:var(--mc-space-xl);max-width:680px">
          <input id="dlUrl" type="url" placeholder="https://…" style="flex:1;padding:10px 14px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);background:var(--mc-surface);color:var(--mc-text-primary);font-family:var(--mc-font-family-sans)">
          <button id="dlAdd" class="mc-action-btn-primary" style="border:none;border-radius:var(--mc-radius-sm);padding:0 20px;font-weight:var(--mc-fw-semibold);cursor:pointer">Download</button>
        </div>
        <div class="mc-panel"><div class="mc-panel-body" id="dlList"><div class="mc-panel-empty">Loading…</div></div></div>
      </div>
    </div>`;

  api.downloads.health().then((h) => {
    const el = document.getElementById('dlHealth'); if (!el) return;
    if (h.enabled === false) el.innerHTML = '<div class="mc-panel-empty" style="text-align:left">Downloads are disabled on this server.</div>';
    else if (!h.available) el.innerHTML = '<span class="mc-live-badge">● downloader unavailable — yt-dlp not installed in the container</span>';
    else el.innerHTML = '<span class="mc-live-badge" style="background:#DCFCE7;color:var(--mc-success)">● downloader ready</span>';
  }).catch(() => {});

  await refresh();

  document.getElementById('dlAdd')?.addEventListener('click', async () => {
    const input = document.getElementById('dlUrl');
    const url = (input.value || '').trim();
    if (!/^https?:\/\//i.test(url)) { input.focus(); return; }
    try {
      await api.downloads.create(url);
      input.value = '';
      showToast('Download queued', 'success');
      await refresh();
      cleanup();
      pollTimer = setInterval(refresh, 3000);
    } catch (e) { showToast(e.message || 'Could not queue download', 'error'); }
  });
}
