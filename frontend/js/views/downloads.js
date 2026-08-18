// MBFD Media Control Studio — YouTube Downloader. Pull media in by URL via
// yt-dlp (server-side) and track jobs. CSP-safe. Polls while jobs are active.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
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

const STATUS_CLASS = {
  done: 'mc-downloader-status--done',
  error: 'mc-downloader-status--error',
  downloading: 'mc-downloader-status--downloading',
  pending: 'mc-downloader-status--pending',
};

function jobRow(j) {
  const statusClass = STATUS_CLASS[j.status] || 'mc-downloader-status--unknown';
  const statusLabel = STATUS_CLASS[j.status]
    ? t(`downloads.status.${j.status}`)
    : t('downloads.status.unknown');
  const errorDetail = j.error_msg
    ? `<div class="mc-row-sub mc-downloader-error">${esc(t('downloads.failed_detail'))}</div>`
    : '';
  return `<div class="mc-row">
    <div class="mc-row-main">
      <div class="mc-row-name">${esc(j.title || j.source_url)}</div>
      <div class="mc-row-sub">${esc(j.source_url)}</div>
      ${errorDetail}
    </div>
    <span class="mc-row-status ${statusClass}">${esc(statusLabel)}</span>
  </div>`;
}

function healthMarkup(state, key) {
  return `<div class="mc-downloader-health mc-downloader-health--${state}" role="status">${esc(t(key))}</div>`;
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
      refreshState.textContent = t('downloads.refresh_delayed');
    }
    return true;
  }
  list.innerHTML = jobs.length
    ? jobs.map(jobRow).join('')
    : `<div class="mc-panel-empty">${esc(t('downloads.empty'))}</div>`;
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
        <header class="mc-studio-header mc-downloader-header">
          <h1 class="mc-studio-title mc-downloader-title" aria-label="${esc(t('downloads.title'))}">
            <img class="mc-downloader-wordmark" src="/assets/youtube-logo.png" alt="" aria-hidden="true">
            <span>${esc(t('downloads.title_suffix'))}</span>
          </h1>
          <p class="mc-studio-sub">${esc(t('downloads.subtitle'))}</p>
        </header>

        <section class="mc-downloader-guide" aria-labelledby="dlInstructionsTitle">
          <svg class="mc-downloader-guide-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path>
            <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>
          </svg>
          <div>
            <h2 id="dlInstructionsTitle" class="mc-downloader-guide-title">${esc(t('downloads.how_to'))}</h2>
            <p class="mc-downloader-guide-copy">${esc(t('downloads.instructions'))}</p>
          </div>
        </section>

        <div id="dlHealth" class="mc-downloader-health-slot"></div>
        <div id="dlRefreshState" class="mc-downloader-refresh" role="status" aria-live="polite" hidden></div>

        <form id="dlForm" class="mc-downloader-form" aria-describedby="dlInstructionsTitle" novalidate>
          <label class="mc-downloader-label" for="dlUrl">${esc(t('downloads.url_label'))}</label>
          <input id="dlUrl" class="mc-downloader-control mc-downloader-input" type="url" inputmode="url" autocomplete="url" required placeholder="${esc(t('downloads.url_placeholder'))}">
          <button id="dlAdd" class="mc-downloader-control mc-downloader-submit" type="submit">${esc(t('downloads.download'))}</button>
        </form>

        <div class="mc-panel">
          <div class="mc-panel-body" id="dlList" aria-live="polite">
            <div class="mc-panel-empty">${esc(t('downloads.loading'))}</div>
          </div>
        </div>
      </div>
    </div>`;

  api.downloads.health().then((health) => {
    const el = document.getElementById('dlHealth');
    if (!el) return;
    if (health.enabled === false) el.innerHTML = healthMarkup('disabled', 'downloads.disabled');
    else if (!health.available) el.innerHTML = healthMarkup('unavailable', 'downloads.unavailable');
    else el.innerHTML = healthMarkup('ready', 'downloads.ready');
  }).catch(() => {
    const el = document.getElementById('dlHealth');
    if (el) el.innerHTML = healthMarkup('unavailable', 'downloads.health_unknown');
  });

  if (await refresh()) scheduleRefresh();
  onlineHandler = () => {
    if (!document.getElementById('dlList')) return;
    refresh().then((shouldContinue) => {
      if (shouldContinue) scheduleRefresh(250);
    });
  };
  window.addEventListener('online', onlineHandler);

  let submitting = false;
  document.getElementById('dlForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const input = document.getElementById('dlUrl');
    const button = document.getElementById('dlAdd');
    const url = (input?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      input?.focus();
      showToast(t('downloads.invalid_url'), 'error');
      return;
    }

    submitting = true;
    if (button) {
      button.disabled = true;
      button.textContent = t('downloads.queuing');
    }
    try {
      await api.downloads.create(url);
      input.value = '';
      showToast(t('downloads.queued'), 'success');
      if (await refresh()) scheduleRefresh();
    } catch (error) {
      showToast(error.message || t('downloads.queue_failed'), 'error');
    } finally {
      submitting = false;
      if (button && document.getElementById('dlAdd') === button) {
        button.disabled = false;
        button.textContent = t('downloads.download');
      }
    }
  });
}
