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
//   • Routine routing is pre-authorized by the shared API; callers never prompt.
//   • Returns true on success, false on cancel/error (so callers can update UI).

import { api } from '../../api.js';
import { t, tn } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { performanceMetrics } from '../../services/ui-runtime-v1.js';
import { isYouTubeContentBroadcastReady } from './youtube-readiness.js';

// YouTube URL detection (same regex as present.js).
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

const DELIVERY_TERMINAL = new Set(['confirmed', 'partial', 'failed', 'timed_out']);

/**
 * Show and refresh the authoritative server/player result for one broadcast.
 * HTTP 202 is only acceptance; success is announced only after every player
 * reports the exact playlist revision as rendered.
 */
export async function trackBroadcastDelivery(requestId, label, initial = null, options = {}) {
  void options;
  let request = initial;
  const startedAt = Date.now();
  let localCeilingMs = 52000;
  let lastPollError = null;
  const updateLocalCeiling = () => {
    const serverWindow = Number(request?.expires_at) - Number(request?.created_at);
    if (Number.isFinite(serverWindow) && serverWindow > 0) {
      localCeilingMs = Math.max(22000, Math.min(120000, serverWindow + 7000));
    }
  };
  updateLocalCeiling();
  while (!request || !DELIVERY_TERMINAL.has(request.status)) {
    if (Date.now() - startedAt >= localCeilingMs) break;
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      request = await api.broadcastStatus(requestId);
      lastPollError = null;
      updateLocalCeiling();
    } catch (error) {
      lastPollError = error;
      if (Date.now() - startedAt >= localCeilingMs) {
        break;
      }
    }
  }

  if (request?.status === 'confirmed') {
    // Success is reflected in the authoritative stage/target state. Broadcast
    // confirmation panels and success popups are permanently disabled.
  } else if (request && DELIVERY_TERMINAL.has(request.status)) {
    const devices = Array.isArray(request.devices) ? request.devices : [];
    const confirmed = devices.filter((device) => device.state === 'confirmed').length;
    showToast(`${label}: ${confirmed}/${request.expected_target_count || devices.length} players confirmed`, 'error', 9000);
  } else {
    showToast(lastPollError?.message || 'Could not verify player delivery', 'error', 9000);
  }
  return request;
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
  // Fail-closed: only broadcast a YouTube source that already has a usable local
  // asset. A content row without a ready local path/asset must not be treated as
  // broadcast-ready — that would ship a stale iframe and leave a black wall.
  if (!isYouTubeContentBroadcastReady(content)) {
    showToast(t('mc.send.yt_unavailable'), 'error');
    return null;
  }
  return { content_id: content.id };
}

/**
 * Send `source` to every display in `targetIds` under the saved no-confirmation
 * routing policy.
 *
 * @param {object} source       broadcast payload (content_id | playlist_id |
 *                              presentation_id | remote_url)
 * @param {string[]} targetIds  device ids to broadcast to
 * @param {string}  [label]     human-readable label for toasts
 * @param {{targets?:object[],quietSuccess?:boolean}} [options] authoritative
 *        typed picker references and optional silent-success delivery feedback
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

  const typedTargets = Array.isArray(options.targets) ? options.targets : [];
  const targetPayload = typedTargets.length ? { targets: typedTargets } : { device_ids: targetIds };
  const idempotencyKey = globalThis.crypto?.randomUUID?.()
    || `broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result;
  try {
    result = await api.broadcast({
      ...resolvedSource,
      ...targetPayload,
      confirm_all: true,
      confirm_wall_replace: true,
      include_live_stream: false,
      idempotency_key: idempotencyKey,
    });
  } catch (e) {
    finishDispatchMetric();
    showToast(e?.message || t('mc.send.failed'), 'error');
    return false;
  }

  finishDispatchMetric();

  if (result && result.success) {
    if (result.request_id) {
      const delivery = await trackBroadcastDelivery(
        result.request_id,
        label,
        result.delivery || null,
        { quietSuccess: options.quietSuccess === true },
      );
      if (delivery?.status !== 'confirmed') return false;
      return true;
    }
    // Compatibility for an older server during a rolling deployment. This is
    // never used by a server that supports persistent player confirmation.
    if (options.quietSuccess !== true) {
      sentToast(label, Number(result.sent) || 0, Number(result.total) || 0);
    }
    return true;
  }
  // Unexpected non-error non-success response — be silent (server logged it).
  return false;
}
