import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { on, off } from '../socket.js';
import { esc } from '../utils.js';

const VISIBILITY = Object.freeze({
  PRIVATE: 'PRIVATE',
  WORKSPACE_SHARED: 'WORKSPACE_SHARED',
  PLATFORM_TEMPLATE: 'PLATFORM_TEMPLATE',
});

let root = null;
let rows = [];
let revision = 0;
let loading = false;
let clickHandler = null;
let replayChangedHandler = null;
const visibilityChoices = new Map();

function formatDate(epoch) {
  const value = Number(epoch);
  if (!Number.isFinite(value) || value <= 0) return t('replays.unknown');
  return new Date(value > 1e12 ? value : value * 1000).toLocaleString();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return t('replays.unknown');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function visibilityLabel(value) {
  return {
    PRIVATE: t('replays.visibility_private'),
    WORKSPACE_SHARED: t('replays.visibility_workspace'),
    ORGANIZATION_SHARED: t('replays.organization_request'),
    PLATFORM_TEMPLATE: t('replays.visibility_platform'),
  }[value] || value || t('replays.unknown');
}

function evidence(label, value, className = '', data = '') {
  return `<div class="replay-evidence-item">
    <div class="replay-evidence-label">${esc(label)}</div>
    <div class="replay-evidence-value ${className}" ${data}>${esc(value)}</div>
  </div>`;
}

function action(id, name, label, { primary = false, danger = false, disabled = false } = {}) {
  const classes = ['replay-action'];
  if (primary) classes.push('replay-action-primary');
  if (danger) classes.push('replay-action-danger');
  return `<button type="button" class="${classes.join(' ')}" data-action="${name}" data-replay-id="${esc(id)}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
}

function visibilityControl(replay) {
  const selected = visibilityChoices.get(replay.id) || replay.library_visibility || VISIBILITY.PRIVATE;
  const choices = [
    [VISIBILITY.PRIVATE, t('replays.visibility_private')],
    [VISIBILITY.WORKSPACE_SHARED, t('replays.visibility_workspace')],
    [VISIBILITY.PLATFORM_TEMPLATE, t('replays.visibility_platform')],
  ];
  return `<div class="replay-visibility">
    <div class="replay-visibility-label">${esc(t('replays.visibility'))}: ${esc(visibilityLabel(selected))}</div>
    <div class="replay-visibility-options" role="group" aria-label="${esc(t('replays.visibility'))}">
      ${choices.map(([value, label]) => `<button type="button" class="replay-choice" data-action="choose-visibility" data-replay-id="${esc(replay.id)}" data-visibility="${value}" aria-pressed="${selected === value}">${esc(label)}</button>`).join('')}
    </div>
  </div>`;
}

function replayCard(replay) {
  const title = replay.recording_title || replay.title || replay.peertube_video_uuid;
  const ready = replay.processing_state === 'ready';
  const added = Boolean(replay.content_id) || replay.processing_state === 'added';
  const retryable = replay.processing_state === 'failed' || replay.processing_state === 'discarded';
  const archivable = !added && replay.processing_state !== 'archived';
  const playable = ready || added;
  const selectedVisibility = visibilityChoices.get(replay.id) || replay.library_visibility || VISIBILITY.PRIVATE;
  const organizationPending = replay.publication_status === 'pending';

  return `<article class="replay-card" data-replay-card="${esc(replay.id)}">
    <div class="replay-visual">
      ${replay.thumbnail_url
        ? `<img src="${esc(replay.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="replay-visual-empty">${esc(t('replays.watch'))}</div>`}
      <span class="replay-state" data-state="${esc(replay.processing_state)}">${esc(replay.processing_state)}</span>
    </div>
    <div class="replay-detail">
      <div class="replay-title-row">
        <div>
          <h2 class="replay-title">${esc(title)}</h2>
          <div class="replay-subtitle">${esc(replay.peertube_video_uuid)} · ${esc(t('replays.retry_count', { count: replay.retry_count || 0 }))}</div>
        </div>
        ${added ? `<span class="mc-live-badge">${esc(t('replays.added'))}</span>` : ''}
      </div>
      <div class="replay-evidence">
        ${evidence(t('replays.instructor'), replay.instructor_name || replay.instructor_user_id || t('replays.unknown'))}
        ${evidence(t('replays.room'), replay.room_name || replay.room_id || t('replays.unknown'))}
        ${evidence(t('replays.duration'), formatDuration(replay.duration_sec))}
        ${evidence(t('replays.capture_window'), `${formatDate(replay.started_at)} — ${formatDate(replay.ended_at)}`)}
        ${evidence(t('replays.validation'), replay.media_validation || 'unknown', 'replay-validation', `data-validation="${esc(replay.media_validation || 'unknown')}"`)}
        ${evidence(t('replays.state'), `${replay.processing_state} · ${visibilityLabel(replay.library_visibility)}`)}
      </div>
      ${replay.error_message ? `<div class="replay-error" role="status">${esc(replay.error_message)}</div>` : ''}
      ${!added ? visibilityControl(replay) : ''}
      <div class="replay-controls">
        <div class="replay-actions">
          ${playable ? action(replay.id, 'watch', t('replays.watch')) : ''}
          ${playable ? action(replay.id, 'download', t('replays.download')) : ''}
          ${ready && !added ? action(replay.id, 'add', t('replays.add'), { primary: true }) : ''}
          ${added && replay.library_visibility !== selectedVisibility ? action(replay.id, 'visibility', t('replays.visibility'), { primary: true }) : ''}
          ${added && !organizationPending ? action(replay.id, 'visibilityRequest', t('replays.organization_request')) : ''}
          ${organizationPending ? action(replay.id, 'approve', t('replays.approve_organization')) : ''}
        </div>
        <div class="replay-actions">
          ${retryable ? action(replay.id, 'retry', t('replays.retry')) : ''}
          ${!added && replay.processing_state !== 'discarded' && replay.processing_state !== 'archived' ? action(replay.id, 'discard', t('replays.discard'), { danger: true }) : ''}
          ${archivable ? action(replay.id, 'archive', t('replays.archive')) : ''}
        </div>
      </div>
    </div>
  </article>`;
}

function renderRows() {
  const list = root?.querySelector('#replayList');
  const revisionEl = root?.querySelector('#replayRevision');
  if (!list) return;
  if (revisionEl) revisionEl.textContent = `r${revision}`;
  list.innerHTML = rows.length
    ? rows.map(replayCard).join('')
    : `<div class="mc-panel"><div class="mc-panel-empty">${esc(t('replays.empty'))}</div></div>`;
}

async function load({ quiet = false } = {}) {
  if (loading) return;
  loading = true;
  const list = root?.querySelector('#replayList');
  if (!quiet && list) list.innerHTML = `<div class="mc-panel"><div class="mc-panel-empty">${esc(t('replays.loading'))}</div></div>`;
  try {
    const result = await api.peertubeReplays.list();
    if (!root) return;
    rows = Array.isArray(result?.replays) ? result.replays : [];
    revision = Number(result?.revision) || 0;
    renderRows();
  } catch (caught) {
    if (list) list.innerHTML = `<div class="mc-panel"><div class="mc-panel-empty">${esc(t('replays.load_error'))} ${esc(caught?.message || '')}</div></div>`;
  } finally {
    loading = false;
  }
}

async function openPlayback(replayId, download) {
  const grant = await api.peertubeReplays.playbackGrant(replayId, download);
  const opened = window.open(grant.url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error(t('replays.open_failed'));
}

async function runAction(button) {
  const replayId = button.dataset.replayId;
  const replay = rows.find((candidate) => candidate.id === replayId);
  if (!replay) return;
  const name = button.dataset.action;
  if (name === 'choose-visibility') {
    visibilityChoices.set(replayId, button.dataset.visibility);
    renderRows();
    return;
  }
  root?.querySelectorAll(`[data-replay-id="${CSS.escape(replayId)}"]`).forEach((control) => { control.disabled = true; });
  try {
    if (name === 'watch') await openPlayback(replayId, false);
    else if (name === 'download') await openPlayback(replayId, true);
    else if (name === 'add') await api.peertubeReplays.add(replayId, visibilityChoices.get(replayId) || VISIBILITY.PRIVATE, replay.recording_title || replay.title);
    else if (name === 'visibility') await api.peertubeReplays.visibility(replayId, visibilityChoices.get(replayId) || VISIBILITY.PRIVATE);
    else if (name === 'visibilityRequest') await api.peertubeReplays.visibilityRequest(replayId);
    else if (name === 'approve') await api.peertubeReplays.approveOrganization(replayId);
    else if (name === 'discard') await api.peertubeReplays.discard(replayId);
    else if (name === 'archive') await api.peertubeReplays.archive(replayId);
    else if (name === 'retry') await api.peertubeReplays.retry(replayId);
    else return;
    if (name !== 'watch' && name !== 'download') showToast(t('replays.action_complete'), 'success');
    await load({ quiet: true });
  } catch (caught) {
    showToast(caught?.message || t('replays.load_error'), 'error');
    renderRows();
  }
}

export function cleanup() {
  if (replayChangedHandler) off('peertube-replays-changed', replayChangedHandler);
  if (root && clickHandler) root.removeEventListener('click', clickHandler);
  replayChangedHandler = null;
  clickHandler = null;
  root = null;
  rows = [];
  revision = 0;
  loading = false;
  visibilityChoices.clear();
}

export async function render(app) {
  cleanup();
  root = app;
  app.innerHTML = `<div class="mc-studio-surface">
    <div class="mc-studio-wrap">
      <div class="mc-studio-header">
        <div class="mc-studio-title">${esc(t('replays.title'))}</div>
        <div class="mc-studio-sub">${esc(t('replays.subtitle'))}</div>
      </div>
      <div class="replay-toolbar">
        <div class="replay-revision" id="replayRevision" aria-live="polite">r0</div>
        <button type="button" class="replay-action" id="replayRefresh">${esc(t('replays.refresh'))}</button>
      </div>
      <div class="replay-list" id="replayList" aria-live="polite"></div>
    </div>
  </div>`;

  clickHandler = (event) => {
    const button = event.target.closest('[data-action]');
    if (button && root?.contains(button)) runAction(button);
  };
  root.addEventListener('click', clickHandler);
  root.querySelector('#replayRefresh')?.addEventListener('click', () => load());
  replayChangedHandler = (event) => {
    const nextRevision = Number(event?.revision) || 0;
    if (nextRevision > revision) load({ quiet: true });
  };
  on('peertube-replays-changed', replayChangedHandler);
  await load();
}
