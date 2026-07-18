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
import { isLiveActive, isLiveStateKnown } from './action-dock.js';

// YouTube URL detection (same regex as present.js).
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

let livePromptCache = { at: 0, active: false };

async function shouldOfferLiveStreamInclusion() {
  const now = Date.now();
  if (now - livePromptCache.at < 5000) return livePromptCache.active;
  try {
    const status = await api.liveStream.status();
    const director = status && status.ai_director && status.ai_director.data;
    livePromptCache = {
      at: now,
      active: !!(director && director.stream_active),
    };
    return livePromptCache.active;
  } catch (_) {
    livePromptCache = { at: now, active: false };
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
    if (isLiveStateKnown()) return isLiveActive();
  } catch { /* dock not importable */ }
  return shouldOfferLiveStreamInclusion();
}

// confirmDialog only supports two buttons; the live-include choice needs three
// (Yes add to live / No display only / Cancel abort). We build a tiny transient
// <dialog> reusing the same .mc-dialog* classes + structure as
// components/confirm.js so styling stays consistent with no new CSS. Returns
// 'yes' | 'no' | 'cancel'.
function chooseLiveStreamInclusion(label) {
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
        <div class="mc-dialog-actions">
          <button type="button" class="mc-btn mc-btn-ghost" data-mc-live-cancel>${esc(t('mc.send.live_include_cancel'))}</button>
          <button type="button" class="mc-btn mc-btn-ghost" data-mc-live-no>${esc(t('mc.send.live_include_no_display'))}</button>
          <button type="button" class="mc-btn mc-btn-confirm" data-mc-live-yes>${esc(t('mc.send.live_include_yes'))}</button>
        </div>
      </form>`;
    document.body.appendChild(dialogEl);

    const cleanup = () => {
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
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
    const yesBtn = dialogEl.querySelector('[data-mc-live-yes]');
    const noBtn = dialogEl.querySelector('[data-mc-live-no]');
    const cancelBtn = dialogEl.querySelector('[data-mc-live-cancel]');
    const onYes = () => finish('yes');
    const onNo = () => finish('no');
    const onCancel = (e) => { if (e && e.preventDefault) e.preventDefault(); finish('cancel'); };

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    cancelBtn.addEventListener('click', onCancel);
    dialogEl.addEventListener('cancel', onCancel);
    dialogEl.addEventListener('close', onCancel);

    try { dialogEl.showModal(); } catch (e) { cleanup(); resolve('cancel'); }
  });
}

// Resolve the live-include choice for a broadcast. Returns null when no stream
// is active (the existing send path runs unchanged), otherwise 'yes' | 'no' |
// 'cancel' from the 3-button prompt. Never throws — a status-check failure
// resolves to null so it never blocks a local broadcast.
async function resolveLiveStreamChoice(label) {
  let active = false;
  try { active = await liveStreamCurrentlyActive(); } catch { active = false; }
  if (!active) return null;
  try { return await chooseLiveStreamInclusion(label); }
  catch { return 'no'; }
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
 * @returns {Promise<boolean>}  true = sent successfully, false = cancelled/error
 */
export async function sendToDisplays(source, targetIds, label = t('mc.tile.content_fallback')) {
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

const liveChoice = await resolveLiveStreamChoice(label);
  if (liveChoice === 'cancel') return false;          // Cancel aborts the whole broadcast
  const includeLiveStream = liveChoice === 'yes';     // 'no'/null → display only
  let result;
  try {
    result = await api.broadcast({ ...resolvedSource, device_ids: targetIds, include_live_stream: includeLiveStream });
  } catch (e) {
    finishDispatchMetric();
    showToast(e?.message || t('mc.send.failed'), 'error');
    return false;
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
      result = await api.broadcast({ ...resolvedSource, device_ids: targetIds, confirm_all: true, include_live_stream: includeLiveStream });
    } catch (e) {
      showToast(e?.message || t('mc.send.failed'), 'error');
      return false;
    }
  }

  finishDispatchMetric();

  if (result && result.success) {
    sentToast(label, result.sent, result.total);
    // "Yes, add to live stream": the broadcast already reached the display(s);
    // now refresh the live program so the new content is marked as changed on the
    // server side (api.liveStream.refresh() -> markLiveContentChanged). Sent
    // first, refreshed after — the display send is never blocked by this.
    if (liveChoice === 'yes') {
      try { await api.liveStream.refresh(); } catch { /* best-effort; display send already succeeded */ }
    }
    return true;
  }
  // Unexpected non-error non-success response — be silent (server logged it).
  return false;
}
