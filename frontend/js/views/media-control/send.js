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
import { t, tn } from '../../i18n.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';

// YouTube URL detection (same regex as present.js).
const YT_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;

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

  let result;
  try {
    result = await api.broadcast({ ...resolvedSource, device_ids: targetIds });
  } catch (e) {
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
      result = await api.broadcast({ ...resolvedSource, device_ids: targetIds, confirm_all: true });
    } catch (e) {
      showToast(e?.message || t('mc.send.failed'), 'error');
      return false;
    }
  }

  if (result && result.success) {
    sentToast(label, result.sent, result.total);
    return true;
  }
  // Unexpected non-error non-success response — be silent (server logged it).
  return false;
}
