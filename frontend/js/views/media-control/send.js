// send.js — the ONE shared broadcast funnel for the unified Media Control view.
//
// All "send to display(s)" paths converge here: toolbox tiles, drag-drop onto
// stage cards, "Send to all" in the topbar, scene triggers from the Scenes tab.
//
// CONTRACT (mirrors present.js broadcastSource exactly):
//   • source is the payload POSTed to /api/broadcast  (must have one of:
//     content_id, playlist_id, presentation_id, remote_url)
//   • YouTube / raw-URL sources MUST be materialized into a content row first
//     via POST /api/content/youtube — the player treats a bare remote_url as
//     a still image, not a YouTube embed.
//   • The 409 CONFIRM_ALL_REQUIRED gate is handled here, never by callers.
//   • Returns true on success, false on cancel/error (so callers can update UI).

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import { performanceMetrics } from '../../services/ui-runtime-v1.js';
import {
  isLiveActive,
  isLiveCompositionAvailable,
  isLiveStateKnown,
} from './action-dock.js';

// YouTube URL detection (same regex as present.js).
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

let livePromptCache = { at: 0, available: false };
const deliveryPanels = new Map();
const DELIVERY_TERMINAL = new Set(['confirmed', 'partial', 'failed', 'timed_out']);

function deliveryPanel(requestId, label) {
  if (deliveryPanels.has(requestId)) return deliveryPanels.get(requestId);
  const panel = document.createElement('section');
  panel.className = 'mc-delivery-panel';
  panel.dataset.requestId = requestId;
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');

  const header = document.createElement('div');
  header.className = 'mc-delivery-panel-head';
  const title = document.createElement('strong');
  title.textContent = `Delivery — ${label}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mc-delivery-panel-close';
  close.setAttribute('aria-label', 'Close delivery status');
  close.textContent = '×';
  close.addEventListener('click', () => {
    panel.remove();
    deliveryPanels.delete(requestId);
  });
  header.append(title, close);

  const summary = document.createElement('p');
  summary.className = 'mc-delivery-panel-summary';
  summary.textContent = 'Requesting player confirmation…';
  const list = document.createElement('ul');
  list.className = 'mc-delivery-device-list';
  panel.append(header, summary, list);
  document.body.appendChild(panel);

  const record = { panel, summary, list };
  deliveryPanels.set(requestId, record);
  return record;
}

function renderBroadcastDelivery(request, label) {
  if (!request || !request.id) return;
  const record = deliveryPanel(request.id, label);
  const devices = Array.isArray(request.devices) ? request.devices : [];
  const confirmed = devices.filter((device) => device.state === 'confirmed').length;
  record.summary.textContent = `${confirmed}/${request.expected_target_count || devices.length} players confirmed`;
  record.panel.dataset.status = request.status || 'requested';
  record.list.replaceChildren();
  for (const device of devices) {
    const item = document.createElement('li');
    item.className = 'mc-delivery-device';
    item.dataset.state = device.state || 'requested';
    const name = document.createElement('span');
    name.textContent = device.device_name || device.device_id || 'Display';
    const state = document.createElement('strong');
    state.textContent = device.state || 'requested';
    item.append(name, state);
    if (device.failure_reason) {
      const reason = document.createElement('small');
      reason.textContent = device.failure_reason;
      item.appendChild(reason);
    }
    record.list.appendChild(item);
  }
}

/**
 * Show and refresh the authoritative server/player result for one broadcast.
 * HTTP 202 is only acceptance; success is announced only after every player
 * reports the exact playlist revision as rendered.
 */
export async function trackBroadcastDelivery(requestId, label, initial = null) {
  let request = initial;
  if (request) renderBroadcastDelivery(request, label);
  const startedAt = Date.now();
  const localCeilingMs = 22000;
  while (!request || !DELIVERY_TERMINAL.has(request.status)) {
    if (Date.now() - startedAt >= localCeilingMs) break;
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      request = await api.broadcastStatus(requestId);
      renderBroadcastDelivery(request, label);
    } catch (error) {
      if (Date.now() - startedAt >= localCeilingMs) {
        showToast(error?.message || 'Could not verify player delivery', 'error');
        break;
      }
    }
  }

  if (request?.status === 'confirmed') {
    showToast(`${label}: every player confirmed`, 'success', 6000);
  } else if (request && DELIVERY_TERMINAL.has(request.status)) {
    const devices = Array.isArray(request.devices) ? request.devices : [];
    const confirmed = devices.filter((device) => device.state === 'confirmed').length;
    showToast(`${label}: ${confirmed}/${request.expected_target_count || devices.length} players confirmed`, 'error', 9000);
  }
  return request;
}

async function shouldOfferLiveStreamInclusion() {
  const now = Date.now();
  if (now - livePromptCache.at < 5000) return livePromptCache.available;
  try {
    const status = await api.liveStream.status();
    livePromptCache = {
      at: now,
      available: status?.publisher?.active === true
        && status?.publisher?.mode === 'fixed_compositor'
        && status?.compositor?.available === true,
    };
    return livePromptCache.available;
  } catch (_) {
    livePromptCache = { at: now, available: false };
    return false;
  }
}

// The Command Center action dock owns the live-active flag (refreshed on mount
// + after every start/stop). We prefer it for the prompt decision because it is
// instant and reflects the operator's live state without a network hop. If the
// dock isn't mounted on this view (the funnel is shared by other callers) we
// fall back to the cached status fetch so existing behaviour is unchanged.
async function liveStreamCurrentlyActive() {
  try {
    if (isLiveStateKnown()) return isLiveActive() && isLiveCompositionAvailable();
  } catch { /* dock not importable */ }
  return shouldOfferLiveStreamInclusion();
}

// Display only, either fixed PiP composition, or Cancel. We build a transient
// <dialog> reusing the same dialog structure. There is deliberately no generic
// yes/no choice: the operator selects the exact on-air program layout.
function chooseLiveStreamComposition(label) {
  return new Promise((resolve) => {
    let dialogEl = null;
    let settled = false;
    try {
      dialogEl = document.createElement('dialog');
    } catch { resolve('cancel'); return; }
    dialogEl.className = 'mc-dialog';
    dialogEl.setAttribute('aria-labelledby', 'mcLiveIncludeTitle');
    dialogEl.innerHTML = `
      <form method="dialog" class="mc-dialog-card">
        <h3 id="mcLiveIncludeTitle" class="mc-dialog-title">${esc(t('mc.send.live_include_title'))}</h3>
        <p class="mc-dialog-msg">${esc(t('mc.send.live_include_msg', { label }))}</p>
        <label class="mc-live-audio-choice">
          <input type="checkbox" data-mc-live-content-audio>
          <span>${esc(t('mc.send.live_content_audio'))}</span>
        </label>
        <p class="mc-live-audio-warning">${esc(t('mc.send.live_content_audio_warning'))}</p>
        <div class="mc-dialog-actions mc-live-send-choices">
          <button type="button" class="mc-btn mc-btn-ghost" data-mc-live-cancel>${esc(t('mc.send.live_include_cancel'))}</button>
          <button type="button" class="mc-btn mc-btn-ghost" data-mc-live-display-only>${esc(t('mc.send.live_display_only'))}</button>
          <button type="button" class="mc-btn mc-btn-confirm" data-mc-live-content-main>${esc(t('mc.send.live_content_main'))}</button>
          <button type="button" class="mc-btn mc-btn-confirm" data-mc-live-camera-main>${esc(t('mc.send.live_camera_main'))}</button>
        </div>
      </form>`;
    document.body.appendChild(dialogEl);

    const cleanup = () => {
      displayOnlyBtn.removeEventListener('click', onDisplayOnly);
      contentMainBtn.removeEventListener('click', onContentMain);
      cameraMainBtn.removeEventListener('click', onCameraMain);
      cancelBtn.removeEventListener('click', onCancel);
      dialogEl.removeEventListener('cancel', onCancel);
      dialogEl.removeEventListener('close', onCancel);
      if (dialogEl && dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { if (dialogEl.open) dialogEl.close(); } catch { /* noop */ }
      cleanup();
      resolve(val);
    };
    const displayOnlyBtn = dialogEl.querySelector('[data-mc-live-display-only]');
    const contentMainBtn = dialogEl.querySelector('[data-mc-live-content-main]');
    const cameraMainBtn = dialogEl.querySelector('[data-mc-live-camera-main]');
    const cancelBtn = dialogEl.querySelector('[data-mc-live-cancel]');
    const contentAudio = dialogEl.querySelector('[data-mc-live-content-audio]');
    const compositionChoice = (layout) => ({
      layout,
      audio_policy: contentAudio?.checked ? 'content_replace' : 'camera',
      confirm_content_audio: contentAudio?.checked === true,
    });
    const onDisplayOnly = () => finish('display_only');
    const onContentMain = () => finish(compositionChoice('content_main_camera_pip'));
    const onCameraMain = () => finish(compositionChoice('camera_main_content_pip'));
    const onCancel = (e) => { if (e && e.preventDefault) e.preventDefault(); finish('cancel'); };

    displayOnlyBtn.addEventListener('click', onDisplayOnly);
    contentMainBtn.addEventListener('click', onContentMain);
    cameraMainBtn.addEventListener('click', onCameraMain);
    cancelBtn.addEventListener('click', onCancel);
    dialogEl.addEventListener('cancel', onCancel);
    dialogEl.addEventListener('close', onCancel);

    try { dialogEl.showModal(); } catch (e) { cleanup(); resolve('cancel'); }
  });
}

// Resolve the exact composition choice. Returns null when no stream is active,
// so the existing display-only flow remains unchanged.
async function resolveLiveStreamChoice(label, source) {
  if (source?.playlist_id) return null;
  let active = false;
  try { active = await liveStreamCurrentlyActive(); } catch { active = false; }
  if (!active) return null;
  try { return await chooseLiveStreamComposition(label); }
  catch { return 'display_only'; }
}

async function routeToLiveComposition(choice, source) {
  if (!choice || choice === 'display_only') return true;
  const composition = await api.liveStream.composition();
  const contentInstanceId = globalThis.crypto?.randomUUID?.()
    || `live-content-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await api.liveStream.compositionContent({
    content_id: source?.content_id || null,
    presentation_id: source?.presentation_id || null,
    remote_url: source?.remote_url || null,
    content_instance_id: contentInstanceId,
    layout: choice.layout,
    audio_policy: choice.audio_policy,
    confirm_content_audio: choice.confirm_content_audio === true,
    expected_compositor_revision: Number(composition?.revision) || 0,
    idempotency_key: globalThis.crypto?.randomUUID?.()
      || `live-composition-${contentInstanceId}`,
  });
  return true;
}

/**
 * Shared success toast for a broadcast result: "{label} on N displays" with an
 * "M offline" tail when some targets were unreachable. Used by sendToDisplays
 * and the Nextcloud-tab broadcast so the wording stays identical.
 * @param {string} label   human-readable source label
 * @param {number} sent    displays the source reached
 * @param {number} total   displays targeted
 */
export function sentToast(label, sent, total) {
  const offline = (total || 0) - (sent || 0);
  const msg = offline > 0
    ? tn('mc.send.result_offline', sent, { label, offline })
    : tn('mc.send.result', sent, { label });
  showToast(msg, 'success');
}

/**
 * Materialize a YouTube URL into a content row so the player renders it as an
 * embed (not a still image), then return a source object with content_id set.
 * @param {string} url
 * @returns {Promise<{content_id:string}|null>}  null on failure (toast shown)
 */
async function materializeYouTube(url) {
  let content;
  try {
    // api.addYoutubeContent idempotently creates or returns an existing row.
    content = await api.addYoutubeContent(url, url);
  } catch (e) {
    showToast(e?.message || t('mc.send.yt_prepare_failed'), 'error');
    return null;
  }
  if (!content || !content.id) {
    showToast(t('mc.send.yt_unavailable'), 'error');
    return null;
  }
  return { content_id: content.id };
}

/**
 * Send `source` to every display in `targetIds`, handling the 409 confirm-all
 * gate and optional label in toasts.
 *
 * @param {object} source       broadcast payload (content_id | playlist_id |
 *                              presentation_id | remote_url)
 * @param {string[]} targetIds  device ids to broadcast to
 * @param {string}  [label]     human-readable label for toasts
 * @param {{targets?:object[]}} [options] authoritative typed picker references
 * @returns {Promise<boolean>}  true = sent successfully, false = cancelled/error
 */
export async function sendToDisplays(source, targetIds, label = t('mc.tile.content_fallback'), options = {}) {
  const finishDispatchMetric = performanceMetrics.start('content.broadcast_accept');
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    showToast(t('mc.send.no_displays'), 'error');
    return false;
  }

  // YouTube raw URLs must be materialized into a content row before broadcast.
  let resolvedSource = source;
  if (source && source.remote_url && YT_RE.test(source.remote_url)) {
    const yt = await materializeYouTube(source.remote_url);
    if (!yt) return false;
    resolvedSource = { ...source, ...yt };
    delete resolvedSource.remote_url;   // replace the URL with the content id
  }

  const liveChoice = await resolveLiveStreamChoice(label, resolvedSource);
  if (liveChoice === 'cancel') return false;
  const typedTargets = Array.isArray(options.targets) ? options.targets : [];
  const targetPayload = typedTargets.length ? { targets: typedTargets } : { device_ids: targetIds };
  const idempotencyKey = globalThis.crypto?.randomUUID?.()
    || `broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let wallReplaceConfirmed = false;
  let result;
  try {
    result = await api.broadcast({
      ...resolvedSource,
      ...targetPayload,
      include_live_stream: false,
      idempotency_key: idempotencyKey,
    });
  } catch (e) {
    finishDispatchMetric();
    showToast(e?.message || t('mc.send.failed'), 'error');
    return false;
  }

  if (result && result.code === 'CONFIRM_WALL_REPLACE_REQUIRED') {
    const ok = await confirmDialog({
      title: t('mc.send.confirm_wall_replace_title'),
      message: t('mc.send.confirm_wall_replace_msg', { label, n: result.region_count }),
      confirmLabel: t('mc.send.confirm_wall_replace_ok'),
      tone: 'danger',
    });
    if (!ok) return false;
    wallReplaceConfirmed = true;
    try {
      result = await api.broadcast({
        ...resolvedSource,
        ...targetPayload,
        confirm_wall_replace: true,
        include_live_stream: false,
        idempotency_key: idempotencyKey,
      });
    } catch (e) {
      showToast(e?.message || t('mc.send.failed'), 'error');
      return false;
    }
  }

  // 409 CONFIRM_ALL_REQUIRED: operator is targeting every display in the workspace.
  if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
    const ok = await confirmDialog({
      title: t('mc.send.confirm_all_title', { n: result.count }),
      message: t('mc.send.confirm_all_msg', { label }),
      confirmLabel: t('mc.send.confirm_all_ok'),
      tone: 'default',
    });
    if (!ok) return false;
    try {
      result = await api.broadcast({
        ...resolvedSource,
        ...targetPayload,
        confirm_all: true,
        confirm_wall_replace: wallReplaceConfirmed,
        include_live_stream: false,
        idempotency_key: idempotencyKey,
      });
    } catch (e) {
      showToast(e?.message || t('mc.send.failed'), 'error');
      return false;
    }
  }

  finishDispatchMetric();

  if (result && result.success) {
    if (result.request_id) {
      const delivery = await trackBroadcastDelivery(result.request_id, label, result.delivery || null);
      if (delivery?.status !== 'confirmed') return false;
      try {
        return await routeToLiveComposition(liveChoice, resolvedSource);
      } catch (error) {
        showToast(error?.message || t('mc.send.live_failed'), 'error');
        return false;
      }
    }
    // Compatibility for an older server during a rolling deployment. This is
    // never used by a server that supports persistent player confirmation.
    sentToast(label, Number(result.sent) || 0, Number(result.total) || 0);
    try {
      return await routeToLiveComposition(liveChoice, resolvedSource);
    } catch (error) {
      showToast(error?.message || t('mc.send.live_failed'), 'error');
      return false;
    }
  }
  // Unexpected non-error non-success response — be silent (server logged it).
  return false;
}
