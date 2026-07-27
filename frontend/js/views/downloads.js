// MBFD Media Control Studio — Downloads (Phase 7). Pull media in by URL via
// yt-dlp (server-side) and track jobs. CSP-safe. Polls while jobs are active.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { readDownloadJobs } from '../services/download-status.js';

let pollTimer = null;
let onlineHandler = null;
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function cleanup() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
}

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
  if (!list) return false;
  const refreshState = document.getElementById('dlRefreshState');
  let jobs;
  try {
    jobs = await readDownloadJobs((options) => api.downloads.list(options));
    if (refreshState) {
      refreshState.hidden = true;
      refreshState.textContent = '';
    }
  } catch {
    if (refreshState) {
      refreshState.hidden = false;
      refreshState.textContent = 'Status refresh delayed — reconnecting automatically…';
    }
    return true;
  }
  list.innerHTML = jobs.length ? jobs.map(jobRow).join('') : '<div class="mc-panel-empty">No downloads yet.</div>';
  return jobs.some((j) => j.status === 'pending' || j.status === 'downloading');
}

function scheduleRefresh(delayMs = 3000) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const shouldContinue = await refresh();
    if (shouldContinue) scheduleRefresh();
  }, delayMs);
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
        <div id="dlRefreshState" class="mc-panel-empty" role="status" aria-live="polite" hidden style="text-align:left;margin-bottom:var(--mc-space-sm)"></div>
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

  if (await refresh()) scheduleRefresh();
  onlineHandler = () => {
    if (!document.getElementById('dlList')) return;
    refresh().then((shouldContinue) => {
      if (shouldContinue) scheduleRefresh(250);
    });
  };
  window.addEventListener('online', onlineHandler);

  document.getElementById('dlAdd')?.addEventListener('click', async () => {
    const input = document.getElementById('dlUrl');
    const url = (input.value || '').trim();
    if (!/^https?:\/\//i.test(url)) { input.focus(); return; }
    try {
      await api.downloads.create(url);
      input.value = '';
      showToast('Download queued', 'success');
      if (await refresh()) scheduleRefresh();
    } catch (e) { showToast(e.message || 'Could not queue download', 'error'); }
  });
}
