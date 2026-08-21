import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { t } from '../i18n.js';
import { on as socketOn, off as socketOff } from '../socket.js';
import { openTargetPicker as openAuthoritativeTargetPicker } from '../components/target-picker.js';
import { waitForTargetCatalog } from '../services/target-catalog-runtime.js';
import { applyContentUpdate, getContentReadiness } from '../services/content-readiness.js';
import { sendToDisplays } from './media-control/send.js';

// Auto-send is deliberately opt-in and tab-scoped. The route and typed
// topology references are captured when the instructor opts in, then reused
// exactly once after the server publishes the final canonical generation.
const queuedAutoSends = new Map();
const classroomPreparationById = new Map();
let contentUpdatedHandler = null;
let contentPreparationHandler = null;
let viewMounted = false;

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '--';
  if (Number(bytes) === 0) return '0 B';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function friendlyErrorMessage(error, fallbackKey = 'content.error_generic') {
  if (error?.status === 401) return t('content.error_session');
  if (error?.status === 403) return t('content.error_permission');
  if (error?.status === 413) return t('content.error_too_large');
  if (error?.status === 429) return t('content.error_rate_limited');
  if (error?.code === 'CONTENT_IN_USE') return t('content.error_in_use');
  return t(fallbackKey);
}

function dialogFocusableElements(dialog) {
  return [...dialog.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function trapDialogFocus(dialog, { restoreFocus, close }) {
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = dialogFocusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener('keydown', onKeydown);
  queueMicrotask(() => (dialogFocusableElements(dialog)[0] || dialog).focus());
  return () => {
    dialog.removeEventListener('keydown', onKeydown);
    if (restoreFocus?.isConnected) restoreFocus.focus();
  };
}

function mountTransientDialog(overlay, restoreFocus = document.activeElement, onDismiss = null) {
  const dialog = overlay.querySelector('[role="dialog"]');
  let releaseFocus = null;
  let closed = false;
  const close = ({ notify = true } = {}) => {
    if (closed) return;
    closed = true;
    releaseFocus?.();
    overlay.remove();
    if (notify) onDismiss?.();
  };
  overlay.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', close);
  });
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });
  document.body.appendChild(overlay);
  releaseFocus = trapDialogFocus(dialog, { restoreFocus, close });
  return close;
}

function requestText({ title, label, value = '', confirmLabel, required = true }) {
  return new Promise(resolve => {
    const restoreFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay media-library-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal media-library-prompt" role="dialog" aria-modal="true" aria-labelledby="mediaLibraryPromptTitle">
        <div class="modal-header">
          <h3 id="mediaLibraryPromptTitle">${esc(title)}</h3>
          <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
        </div>
        <form class="modal-body" data-prompt-form>
          <label class="form-group" for="mediaLibraryPromptInput">
            <span>${esc(label)}</span>
            <input class="input" id="mediaLibraryPromptInput" value="${esc(value)}" ${required ? 'required' : ''}>
          </label>
          <div class="modal-footer media-library-dialog-actions">
            <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
            <button type="submit" class="btn btn-primary">${esc(confirmLabel)}</button>
          </div>
        </form>
      </div>`;
    let settled = false;
    let close = () => {};
    const finish = result => {
      if (settled) return;
      settled = true;
      close({ notify: false });
      resolve(result);
    };
    close = mountTransientDialog(overlay, restoreFocus, () => finish(null));
    overlay.querySelector('[data-prompt-form]').addEventListener('submit', event => {
      event.preventDefault();
      const input = overlay.querySelector('#mediaLibraryPromptInput');
      if (!input.reportValidity()) return;
      finish(input.value.trim());
    });
  });
}

function requestConfirmation({ title, message, confirmLabel, destructive = false }) {
  return new Promise(resolve => {
    const restoreFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay media-library-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal media-library-confirm" role="dialog" aria-modal="true" aria-labelledby="mediaLibraryConfirmTitle" aria-describedby="mediaLibraryConfirmMessage">
        <div class="modal-header">
          <h3 id="mediaLibraryConfirmTitle">${esc(title)}</h3>
          <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
        </div>
        <div class="modal-body">
          <p id="mediaLibraryConfirmMessage">${esc(message)}</p>
        </div>
        <div class="modal-footer media-library-dialog-actions">
          <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
          <button type="button" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" data-confirm-dialog>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    let settled = false;
    let close = () => {};
    const finish = result => {
      if (settled) return;
      settled = true;
      close({ notify: false });
      resolve(result);
    };
    close = mountTransientDialog(overlay, restoreFocus, () => finish(false));
    overlay.querySelector('[data-confirm-dialog]').addEventListener('click', () => finish(true), { once: true });
  });
}

function requestPermanentEraseConfirmation({ title, itemLabel, impacts }) {
  return new Promise(resolve => {
    const restoreFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay media-library-dialog-overlay';
    const totals = {};
    for (const impact of impacts) {
      for (const [category, count] of Object.entries(impact?.categories || {})) {
        totals[category] = (totals[category] || 0) + Number(count || 0);
      }
    }
    const dependencyRows = Object.entries(totals)
      .filter(([, count]) => count > 0)
      .map(([category, count]) => `<li><span>${esc(category.replaceAll('_', ' '))}</span><strong>${count}</strong></li>`)
      .join('');
    overlay.innerHTML = `
      <div class="modal media-library-confirm content-erase-dialog" role="dialog" aria-modal="true" aria-labelledby="contentEraseTitle" aria-describedby="contentEraseWarning">
        <div class="modal-header">
          <h3 id="contentEraseTitle">${esc(title)}</h3>
          <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
        </div>
        <div class="modal-body">
          <p id="contentEraseWarning" class="content-erase-warning">${esc(t('content.erase_irreversible_warning', { name: itemLabel }))}</p>
          ${dependencyRows ? `<div class="content-erase-impact"><h4>${t('content.erase_detach_heading')}</h4><ul>${dependencyRows}</ul></div>` : `<p>${t('content.erase_unused')}</p>`}
          <p>${esc(t('content.erase_file_count', { count: impacts.reduce((sum, impact) => sum + Number(impact?.files?.length || 0), 0) }))}</p>
          <label class="content-erase-confirm-check">
            <input type="checkbox" data-erase-ack>
            <span>${t('content.erase_acknowledge')}</span>
          </label>
        </div>
        <div class="modal-footer media-library-dialog-actions">
          <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
          <button type="button" class="btn btn-danger" data-confirm-erase disabled>${t('content.btn_permanent_erase')}</button>
        </div>
      </div>`;
    let settled = false;
    let close = () => {};
    const finish = result => {
      if (settled) return;
      settled = true;
      close({ notify: false });
      resolve(result);
    };
    close = mountTransientDialog(overlay, restoreFocus, () => finish(false));
    const acknowledge = overlay.querySelector('[data-erase-ack]');
    const confirm = overlay.querySelector('[data-confirm-erase]');
    acknowledge.addEventListener('change', () => { confirm.disabled = !acknowledge.checked; });
    confirm.addEventListener('click', () => finish(true), { once: true });
  });
}

// Document classification for the tile fallback. A PDF/Office/ODF row without a
// thumbnail must NOT render <img src=/file> (that points an image element at
// raw document bytes → broken image); show a type glyph + label instead. Once a
// background-generated thumbnail attaches, the thumbnail_path <img> path is used.
function isDocMime(mt) {
  return /pdf|presentation|powerpoint|word|spreadsheet|excel|opendocument/.test(mt || '');
}
function docGlyph(mt) {
  if (/pdf/.test(mt)) return '📕';
  if (/presentation|powerpoint/.test(mt)) return '📊';
  if (/spreadsheet|excel/.test(mt)) return '📈';
  if (/word|opendocument\.text/.test(mt)) return '📄';
  return '📄';
}
function docLabel(mt) {
  if (/pdf/.test(mt)) return t('content.type_pdf');
  if (/presentation|powerpoint/.test(mt)) return t('content.type_slides');
  if (/spreadsheet|excel/.test(mt)) return t('content.type_sheet');
  if (/word|opendocument\.text/.test(mt)) return t('content.type_doc');
  return t('content.type_document');
}

const VISIBILITIES = ['private', 'workspace_shared', 'organization_shared', 'platform_template'];

function visibilityLabel(level) {
  return t(`content.visibility.${VISIBILITIES.includes(level) ? level : 'private'}`);
}

function contentTypeLabel(content) {
  if (content.mime_type === 'video/youtube') return t('content.type_youtube');
  if (content.remote_url) return t('content.type_remote');
  if (content.mime_type?.startsWith('video/')) return t('content.type_video');
  if (isDocMime(content.mime_type)) return docLabel(content.mime_type);
  return t('content.type_image');
}

function readinessLabel(readiness) {
  if (readiness.state === 'preparing') return t('content.status_preparing');
  if (readiness.state === 'failed') return t('content.status_failed');
  return t('content.status_ready');
}

function readinessMarkup(content) {
  const readiness = getContentReadiness(content);
  const reason = readiness.reason || t('content.status_failed_fallback');
  const progress = readiness.state === 'preparing'
    ? `<progress class="content-readiness-progress" max="100" ${readiness.progress === null ? '' : `value="${readiness.progress}"`} aria-label="${esc(t('content.status_preparing'))}"></progress>`
    : '';
  const failedReason = readiness.state === 'failed'
    ? `<span class="content-readiness-reason">${esc(t('content.status_failed_reason', { reason }))}</span>`
    : '';
  return `
    <div class="content-readiness is-${readiness.state}" role="status" id="content-readiness-${esc(content.id)}">
      <span class="content-readiness-dot" aria-hidden="true"></span>
      <span class="content-readiness-label">${esc(readinessLabel(readiness))}</span>
      ${progress}
      ${failedReason}
    </div>
  `;
}

function classroomPreparationMarkup(content) {
  const status = classroomPreparationById.get(String(content.id));
  if (!status) {
    return getContentReadiness(content).state === 'ready'
      ? `<div class="content-classroom-status is-server-only">${t('content.classroom_server_only')}</div>`
      : '';
  }

  const state = String(status.state || 'not_requested');
  const progress = state === 'downloading' && Number.isFinite(Number(status.progress_pct))
    ? `<progress max="100" value="${Math.max(0, Math.min(100, Number(status.progress_pct)))}" aria-label="${esc(t('content.classroom_downloading'))}"></progress>`
    : '';
  const cacheTruth = state === 'classroom_ready' && status.cache_hit_observed !== true
    ? `<span class="content-classroom-cache-note">${t('content.classroom_cache_hit_pending')}</span>`
    : '';
  const labelKey = {
    server_not_ready: 'content.classroom_server_not_ready',
    not_requested: 'content.classroom_not_requested',
    queued: 'content.classroom_queued',
    downloading: 'content.classroom_downloading',
    classroom_ready: 'content.classroom_ready_verified',
    failed: 'content.classroom_failed',
    cancelled: 'content.classroom_cancelled',
  }[state] || 'content.classroom_not_requested';
  return `
    <div class="content-classroom-status is-${esc(state)}" role="status">
      <span>${t(labelKey)}</span>
      ${progress}
      ${cacheTruth}
    </div>
  `;
}

function sendActions(content) {
  const readiness = getContentReadiness(content);
  const queued = queuedAutoSends.has(String(content.id));
  return `
    <button
      type="button"
      class="btn btn-primary btn-sm content-send-control"
      data-send-content="${esc(content.id)}"
      aria-describedby="content-readiness-${esc(content.id)}"
      ${readiness.sendEnabled ? '' : 'disabled'}
    >${t('content.send_btn')}</button>
    ${readiness.state === 'preparing' ? `
      <label class="content-auto-send">
        <input type="checkbox" data-auto-send-ready="${esc(content.id)}" aria-describedby="content-readiness-${esc(content.id)}">
        <span>${t('content.send_when_ready')}</span>
      </label>
      <small class="content-auto-send-warning">${t('content.auto_send_temporary_warning')}</small>
      ${queued ? `<span class="content-auto-send-queued">${t('content.auto_send_queued')}</span>` : ''}
    ` : ''}
  `;
}

function governedActions(content) {
  const permissions = content.permissions || {};
  const pending = content.visibility?.publication_request_status === 'pending';
  const readiness = getContentReadiness(content);
  const repairable = permissions?.can_edit && (readiness.state === 'failed' || Number(content.file_size) === 0);
  const inWallpaperMenu = content.is_wallpaper_menu === true;
  const canUseAsWallpaper = permissions?.can_edit && (
    inWallpaperMenu
    || (
      Boolean(content.filepath)
      && String(content.mime_type || '').toLowerCase().startsWith('image/')
      && content.archived_at == null
    )
  );
  return `
    ${sendActions(content)}
    ${readiness.state === 'ready' ? `<button type="button" class="btn btn-secondary btn-sm" data-prepare-content="${esc(content.id)}">${t('content.prepare_for_class')}</button>` : ''}
    ${content.filepath ? `<button type="button" class="btn btn-secondary btn-sm" data-download-content="${content.id}" data-download-name="${esc(content.original_filename || content.filename || '')}">${t('content.btn_download')}</button>` : ''}
    ${permissions?.can_edit ? `<button type="button" class="btn btn-secondary btn-sm" data-edit-content="${content.id}">${t('content.btn_edit')}</button>` : ''}
    ${permissions?.can_edit && content.filepath ? `<button type="button" class="btn btn-secondary btn-sm" data-thumbnail-studio="${content.id}">${t('content.thumbnail_studio')}</button>` : ''}
    ${canUseAsWallpaper ? `<button type="button" class="btn btn-secondary btn-sm content-wallpaper-control" data-wallpaper-menu-content="${content.id}" aria-pressed="${inWallpaperMenu ? 'true' : 'false'}">${inWallpaperMenu ? t('content.wallpaper_menu_remove') : t('content.wallpaper_menu_add')}</button>` : ''}
    ${repairable ? `<button type="button" class="btn btn-secondary btn-sm content-repair-control" data-repair-content="${content.id}">${t('content.btn_repair')}</button>` : ''}
    ${permissions?.can_edit ? `<button type="button" class="btn btn-secondary btn-sm" data-move-content="${content.id}">${t('content.btn_move')}</button>` : ''}
    ${permissions?.can_request_organization && !pending ? `<button type="button" class="btn btn-secondary btn-sm" data-request-publication="${content.id}">${t('content.btn_request_org')}</button>` : ''}
    ${pending ? `<span class="content-request-status">${t('content.request_pending')}</span>` : ''}
    ${permissions?.can_duplicate ? `<button type="button" class="btn btn-secondary btn-sm" data-duplicate-content="${content.id}">${t('content.btn_duplicate')}</button>` : ''}
    ${permissions?.can_transfer ? `<button type="button" class="btn btn-secondary btn-sm" data-transfer-content="${content.id}">${t('content.btn_transfer')}</button>` : ''}
    ${permissions?.can_change_visibility && content.visibility?.access_level === 'platform_template' ? `<button type="button" class="btn btn-secondary btn-sm" data-template-assignments="${content.id}">${t('content.btn_assign_workspaces')}</button>` : ''}
    ${permissions?.can_archive ? `<button type="button" class="btn btn-secondary btn-sm" data-archive-content="${content.id}" data-archived="${content.visibility?.archived_at ? 'true' : 'false'}">${content.visibility?.archived_at ? t('content.btn_restore') : t('content.btn_archive')}</button>` : ''}
    ${permissions?.can_delete ? `<button type="button" class="btn btn-danger btn-sm" data-delete-content="${content.id}">${t('content.btn_permanent_erase')}</button>` : ''}
  `;
}

async function chooseContentTargets(label) {
  let catalog;
  try {
    catalog = await waitForTargetCatalog(
      { includeVirtualDisplays: false },
      { requireFresh: true },
    );
  } catch (error) {
    showToast(error?.message || t('mc.send.no_displays'), 'error');
    return null;
  }

  const result = await openAuthoritativeTargetPicker({
    catalog,
    capability: 'content',
    selection: 'multiple',
    allowOffline: false,
    availability: 'any',
    allowIndividualWallMembers: false,
    allowSplitWallTargets: true,
    allowLiveProgram: false,
    title: label,
  });
  if (!result?.deviceIds?.length) return null;
  return {
    deviceIds: [...new Set(result.deviceIds.map(String))],
    references: Array.isArray(result.references) ? result.references : [],
    targets: Array.isArray(result.targets) ? result.targets : [],
  };
}

async function showBroadcastPreflight(content, route) {
  let preflight;
  try {
    preflight = await api.broadcastPreflight({
      content_id: content.id,
      device_ids: route.deviceIds,
      targets: route.references,
    });
  } catch (error) {
    showToast(friendlyErrorMessage(error, 'content.preflight_failed'), 'error');
    return false;
  }

  const targets = Array.isArray(preflight.targets) ? preflight.targets : [];
  const layouts = Array.isArray(preflight.layout_revisions) ? preflight.layout_revisions : [];
  const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
  const expectedTargetCount = Number(preflight.expected_target_count) || 0;
  const p3 = preflight.p3 || {};
  const media = preflight.content || {};
  const audio = media.audio || {};
  const targetMarkup = targets.map(target => `
    <li class="${target.online ? 'is-online' : 'is-offline'}">
      <strong>${esc(target.name || target.id || t('content.preflight_unknown_target'))}</strong>
      <span>${target.online ? t('content.preflight_online') : t('content.preflight_offline')}</span>
      <span>${t('content.preflight_renderer', { state: target.renderer_compatibility || 'unknown' })}</span>
    </li>
  `).join('');
  const layoutMarkup = layouts.length
    ? layouts.map(layout => `<li>${esc(layout.wall_id)} · ${t('content.preflight_revision', { revision: layout.layout_revision })}</li>`).join('')
    : `<li>${t('content.preflight_no_layout_revision')}</li>`;
  const warningMarkup = warnings.length
    ? `<ul class="broadcast-preflight-warnings">${warnings.map(warning => `<li>${esc(warning.message || warning.code || '')}</li>`).join('')}</ul>`
    : `<p class="broadcast-preflight-clear">${t('content.preflight_no_warnings')}</p>`;

  return new Promise(resolve => {
    const restoreFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay media-library-dialog-overlay';
    overlay.innerHTML = `
      <section class="modal broadcast-preflight-dialog" role="dialog" aria-modal="true" aria-labelledby="broadcastPreflightTitle">
        <div class="modal-header">
          <div>
            <h3 id="broadcastPreflightTitle">${t('content.broadcast_preflight_title')}</h3>
            <p>${esc(content.filename || media.filename || t('content.type_video'))}</p>
          </div>
          <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
        </div>
        <div class="modal-body broadcast-preflight-body">
          <p class="broadcast-preflight-summary">${t('content.preflight_target_count', { count: expectedTargetCount })}</p>
          <section>
            <h4>${t('content.preflight_targets')}</h4>
            <ul class="broadcast-preflight-targets">${targetMarkup || `<li>${t('content.preflight_no_targets')}</li>`}</ul>
          </section>
          <dl class="broadcast-preflight-facts">
            <div><dt>${t('content.preflight_layout')}</dt><dd><ul>${layoutMarkup}</ul></dd></div>
            <div><dt>${t('content.preflight_generation')}</dt><dd>${esc(media.generation || '--')} · ${media.server_ready ? t('content.status_ready') : t('content.classroom_server_not_ready')}</dd></div>
            <div><dt>${t('content.preflight_p3')}</dt><dd>${esc(p3.state || 'not_requested')} · ${p3.checksum_verified ? t('content.preflight_checksum_verified') : t('content.preflight_checksum_unverified')} · ${p3.cache_hit_observed === true ? t('content.preflight_cache_hit_observed') : t('content.classroom_cache_hit_pending')}</dd></div>
            <div><dt>${t('content.preflight_audio')}</dt><dd>${esc(audio.codec || t('content.preflight_unknown'))} · ${esc(audio.channels || t('content.preflight_unknown'))}</dd></div>
            <div><dt>${t('content.preflight_cold_transfer')}</dt><dd>${formatFileSize(preflight.estimated_cold_transfer_bytes)}</dd></div>
          </dl>
          <section>
            <h4>${t('content.preflight_warnings')}</h4>
            ${warningMarkup}
          </section>
        </div>
        <div class="modal-footer media-library-dialog-actions">
          <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
          ${preflight.can_send === true
            ? `<button type="button" class="btn btn-primary" data-confirm-preflight>${t('content.preflight_send')}</button>`
            : `<span class="broadcast-preflight-blocked" role="alert">${t('content.preflight_blocked')}</span>`}
        </div>
      </section>`;
    let settled = false;
    let close = () => {};
    const finish = approved => {
      if (settled) return;
      settled = true;
      close({ notify: false });
      resolve(approved);
    };
    close = mountTransientDialog(overlay, restoreFocus, () => finish(false));
    overlay.querySelector('[data-confirm-preflight]')?.addEventListener(
      'click',
      () => finish(true),
      { once: true },
    );
  });
}

async function sendContentToTargets(content, route) {
  if (!content || !route?.deviceIds?.length) return false;
  const approved = await showBroadcastPreflight(content, route);
  if (!approved) return false;
  return sendToDisplays(
    { content_id: content.id },
    route.deviceIds,
    content.filename || t('content.type_video'),
    { targets: route.references },
  );
}

function syncQueuedAutoSendControls() {
  document.querySelectorAll('[data-auto-send-ready]').forEach((checkbox) => {
    checkbox.checked = queuedAutoSends.has(String(checkbox.dataset.autoSendReady));
  });
}

function findContentItem(id) {
  return state.contentById.get(String(id)) || null;
}

function storedContentItems() {
  return [...state.contentById.values()];
}

function storeContentPage(items, { replace = false } = {}) {
  if (replace) state.contentById.clear();
  for (const item of items || []) {
    if (!item?.id) continue;
    state.contentById.set(String(item.id), item);
  }
  return storedContentItems();
}

function updateStoredContent(update) {
  const id = String(update?.content_id || update?.id || '');
  const current = findContentItem(id);
  if (!current) return null;
  const next = applyContentUpdate(current, update);
  state.contentById.set(id, next);
  return next;
}

function maybeDetachContentUpdatedListener() {
  if (!viewMounted && queuedAutoSends.size === 0 && contentUpdatedHandler) {
    socketOff('content-updated', contentUpdatedHandler);
    contentUpdatedHandler = null;
  }
}

function ensureContentUpdatedListener() {
  if (contentUpdatedHandler) return;
  contentUpdatedHandler = async (update) => {
    const contentId = String(update?.content_id || '');
    if (!contentId) return;

    const updatedItem = updateStoredContent(update);
    const queued = queuedAutoSends.get(contentId);
    const readiness = updatedItem
      ? getContentReadiness(updatedItem)
      : { state: String(update?.processing_status || '') };

    if (queued && readiness.state === 'ready') {
      queuedAutoSends.delete(contentId);
      await sendContentToTargets(
        updatedItem || { id: contentId, filename: queued.label },
        queued.route,
      );
    } else if (queued && readiness.state === 'failed') {
      queuedAutoSends.delete(contentId);
      showToast(t('content.auto_send_failed', {
        name: queued.label,
        reason: updatedItem?.processing_error || t('content.status_failed_fallback'),
      }), 'error');
    }

    if (viewMounted && document.getElementById('contentGrid')) {
      await loadContent();
    }
    maybeDetachContentUpdatedListener();
  };
  socketOn('content-updated', contentUpdatedHandler);
}

function ensureContentPreparationListener() {
  if (contentPreparationHandler) return;
  contentPreparationHandler = async (update) => {
    const contentId = String(update?.content_id || '');
    if (!contentId) return;
    try {
      const status = await api.getClassroomPreparation(contentId);
      classroomPreparationById.set(contentId, status);
      if (viewMounted && document.getElementById('contentGrid')) renderContentResults();
    } catch {
      // The next explicit action or page load will retry without presenting stale certainty.
      classroomPreparationById.delete(contentId);
    }
  };
  socketOn('content-preparation', contentPreparationHandler);
}

export function render(container) {
  viewMounted = true;
  const hashQuery = new URLSearchParams((window.location.hash.split('?')[1] || ''));
  state.focusContentId = hashQuery.get('focus') || null;
  state.focusPreview = hashQuery.get('preview') === '1';
  state.focusHandled = false;
  if (state.focusContentId) {
    state.currentFolderId = null;
    state.filters = defaultContentFilters();
    state.sort = 'newest';
    state.selectedIds.clear();
  }
  ensureContentUpdatedListener();
  ensureContentPreparationListener();
  let currentUser = {};
  try { currentUser = JSON.parse(localStorage.getItem('user') || '{}'); } catch { /* keep empty identity */ }
  container.innerHTML = `
    <section class="media-library-page" aria-labelledby="mediaLibraryHeading">
    <div class="page-header media-library-header">
      <div>
        <h1 id="mediaLibraryHeading">${t('content.title')} <span class="help-tip" data-tip="${t('content.help_tip')}">?</span></h1>
        <div class="subtitle">${t('content.subtitle')}</div>
      </div>
      <div class="media-library-header-actions">
        <button type="button" class="btn btn-secondary media-library-processing-button" data-processing-center>
          ${t('content.processing_center')}
        </button>
        <button type="button" class="btn btn-cta media-library-add-button" id="openAddMedia">
          <span aria-hidden="true">＋</span>
          <span>${t('content.add_media')}</span>
        </button>
      </div>
    </div>

    <div class="media-library-scope" aria-label="${t('content.scope_label')}">
      <button type="button" class="media-library-scope-button is-active" data-library-scope="all" aria-pressed="true">${t('content.all_media')}</button>
      <button type="button" class="media-library-scope-button" data-library-scope="unfiled" aria-pressed="false">${t('content.unfiled')}</button>
      <button type="button" class="media-library-scope-button" data-library-scope="favorites" aria-pressed="false">${t('content.filter_favorites')}</button>
      <button type="button" class="media-library-scope-button" data-library-scope="recent" aria-pressed="false">${t('content.recent_media')}</button>
    </div>

    <div class="content-governance-toolbar" aria-label="${t('content.filters_label')}">
      <input type="search" id="contentSearch" class="input" placeholder="${t('content.search_placeholder')}" value="${esc(state.filters.search)}">
      <select id="contentVisibilityFilter" class="input" aria-label="${t('content.filter_visibility')}">
        <option value="">${t('content.filter_all_visibility')}</option>
        ${VISIBILITIES.map(level => `<option value="${level}" ${state.filters.visibility === level ? 'selected' : ''}>${visibilityLabel(level)}</option>`).join('')}
      </select>
      <select id="contentTypeFilter" class="input" aria-label="${t('content.filter_type')}">
        <option value="">${t('content.filter_all_types')}</option>
        <option value="video" ${state.filters.type === 'video' ? 'selected' : ''}>${t('content.type_video')}</option>
        <option value="image" ${state.filters.type === 'image' ? 'selected' : ''}>${t('content.type_image')}</option>
        <option value="application" ${state.filters.type === 'application' ? 'selected' : ''}>${t('content.type_document')}</option>
      </select>
      <label class="content-filter-check"><input type="checkbox" id="contentMineFilter" ${state.filters.mine ? 'checked' : ''}> ${t('content.filter_mine')}</label>
      <label class="content-filter-check"><input type="checkbox" id="contentArchivedFilter" ${state.filters.archived ? 'checked' : ''}> ${t('content.filter_archived')}</label>
      <label class="media-library-sort-label" for="contentSort">${t('content.sort_label')}</label>
      <select id="contentSort" class="input">
        <option value="newest">${t('content.sort_newest')}</option>
        <option value="oldest">${t('content.sort_oldest')}</option>
        <option value="name">${t('content.sort_name')}</option>
        <option value="type">${t('content.sort_type')}</option>
        <option value="duration">${t('content.sort_duration')}</option>
        <option value="size">${t('content.sort_size')}</option>
        <option value="readiness">${t('content.sort_readiness')}</option>
        <option value="recent">${t('content.sort_recent')}</option>
      </select>
      <div class="media-library-view-switch" role="group" aria-label="${t('content.view_label')}">
        <button type="button" class="btn-icon is-active" data-content-view="grid" aria-label="${t('content.view_grid')}" aria-pressed="true">▦</button>
        <button type="button" class="btn-icon" data-content-view="list" aria-label="${t('content.view_list')}" aria-pressed="false">☷</button>
      </div>
      <button class="btn btn-secondary btn-sm" id="newFolderBtn">${t('content.new_folder_btn')}</button>
      ${isPlatformAdmin(currentUser) || ['org_owner', 'org_admin'].includes(currentUser.current_org_role || currentUser.org_role)
        ? `<button class="btn btn-secondary btn-sm" data-review-publications>${t('content.review_requests')}</button>` : ''}
    </div>
    <details class="media-library-advanced-filters">
      <summary>${t('content.more_filters')}</summary>
      <div>
        <div class="media-library-saved-views">
          <label for="contentSavedView">${t('content.saved_views')}</label>
          <select id="contentSavedView" class="input" data-saved-view>
            <option value="">${t('content.saved_view_choose')}</option>
          </select>
          <button type="button" class="btn btn-secondary btn-sm" data-save-view>${t('content.saved_view_save')}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-delete-view disabled>${t('content.saved_view_delete')}</button>
        </div>
        <select id="contentProcessingFilter" class="input" aria-label="${t('content.filter_processing')}">
            <option value="">${t('content.filter_all_processing')}</option>
            <option value="ready">${t('content.filter_processing_ready')}</option>
            <option value="processing">${t('content.filter_processing_active')}</option>
            <option value="failed">${t('content.filter_processing_failed')}</option>
            <option value="uploaded">${t('content.filter_processing_uploaded')}</option>
          </select>
          <select id="contentCodecFilter" class="input" aria-label="${t('content.filter_codec')}">
            <option value="">${t('content.filter_all_codecs')}</option>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC</option>
            <option value="vp9">VP9</option>
            <option value="av1">AV1</option>
            <option value="aac">AAC</option>
            <option value="eac3">E-AC-3</option>
          </select>
          <select id="contentDimensionsFilter" class="input" aria-label="${t('content.filter_dimensions')}">
            <option value="">${t('content.filter_all_dimensions')}</option>
            <option value="4k">4K+</option>
            <option value="hd">HD+</option>
            <option value="landscape">${t('content.filter_landscape')}</option>
            <option value="portrait">${t('content.filter_portrait')}</option>
            <option value="unknown">${t('content.filter_dimensions_unknown')}</option>
          </select>
          <select id="contentSourceFilter" class="input" aria-label="${t('content.filter_source')}">
            <option value="">${t('content.filter_all_sources')}</option>
            <option value="local">${t('content.filter_source_local')}</option>
            <option value="remote">${t('content.filter_source_remote')}</option>
            <option value="upload">${t('content.source_upload')}</option>
            <option value="youtube">${t('content.source_youtube')}</option>
            <option value="peertube">${t('content.source_peertube')}</option>
            <option value="nextcloud">${t('content.source_cloud')}</option>
          </select>
          <select id="contentThumbnailFilter" class="input" aria-label="${t('content.filter_thumbnail')}">
            <option value="">${t('content.filter_all_thumbnails')}</option>
            <option value="ready">${t('content.filter_thumbnail_ready')}</option>
            <option value="missing">${t('content.filter_thumbnail_missing')}</option>
          </select>
          <select id="contentP3Filter" class="input" aria-label="${t('content.filter_p3')}">
            <option value="">${t('content.filter_all_p3')}</option>
            <option value="ready">${t('content.filter_p3_ready')}</option>
            <option value="pending">${t('content.filter_p3_pending')}</option>
          </select>
        <button type="button" class="btn btn-secondary btn-sm" data-reset-filters>${t('content.reset_filters')}</button>
      </div>
    </details>

    <div class="media-library-summary" id="contentLibrarySummary" role="status" aria-live="polite">
      ${t('content.storage_summary_loading')}
    </div>

    <div class="media-library-bulk-toolbar" id="contentBulkToolbar" hidden aria-live="polite">
      <strong id="contentSelectedCount">${t('content.selected_count', { count: 0 })}</strong>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk-prepare>${t('content.bulk_prepare')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk-move>${t('content.bulk_move')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk-tags>${t('content.bulk_tags')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk-archive>${t('content.bulk_archive')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk-restore>${t('content.bulk_restore')}</button>
      <button type="button" class="btn btn-danger btn-sm" data-bulk-erase>${t('content.bulk_permanent_erase')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-clear-selection>${t('content.clear_selection')}</button>
    </div>

    <nav id="folderBreadcrumb" class="media-library-breadcrumb" aria-label="${t('content.folder_breadcrumb_label')}"></nav>
    <div id="folderGrid" class="media-library-folder-grid"></div>
    <div class="content-grid" id="contentGrid" aria-busy="true" aria-live="polite">
      <div class="empty-state media-library-grid-message"><h3>${t('common.loading')}</h3></div>
    </div>
    </section>

    <div class="modal-overlay media-library-add-overlay" id="addMediaDialog" hidden>
      <section class="modal media-library-add-sheet" role="dialog" aria-modal="true" aria-labelledby="addMediaTitle" tabindex="-1">
        <div class="modal-header">
          <div>
            <h2 id="addMediaTitle">${t('content.add_media_title')}</h2>
            <p class="content-modal-subtitle">${t('content.add_media_desc')}</p>
          </div>
          <button type="button" class="btn-icon" data-close-add-media aria-label="${t('common.close')}">&times;</button>
        </div>
        <div class="media-library-source-tabs" role="tablist" aria-label="${t('content.add_media_sources')}">
          <button type="button" role="tab" aria-selected="true" aria-controls="addSourceUpload" data-add-source="upload">${t('content.source_upload')}</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="addSourceRemote" data-add-source="remote">${t('content.source_remote')}</button>
          <button type="button" role="tab" aria-selected="false" aria-controls="addSourceYoutube" data-add-source="youtube">${t('content.source_youtube')}</button>
          <a class="media-library-source-link" href="#/replays">${t('content.source_peertube')}</a>
          <a class="media-library-source-link" href="#/files">${t('content.source_cloud')}</a>
        </div>
        <div class="modal-body media-library-add-body">
          <section role="tabpanel" id="addSourceUpload" data-add-panel="upload">
            <button type="button" class="upload-area" id="uploadArea">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span class="upload-area-title">${t('content.drop')}</span>
              <span class="upload-hint">${t('content.upload_hint')}</span>
            </button>
            <input class="visually-hidden" type="file" id="fileInput" multiple accept="video/*,image/*,audio/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation">
            <div class="upload-progress" id="uploadProgress" hidden role="status" aria-live="polite">
              <div class="upload-progress-bar" aria-hidden="true"><div class="upload-progress-fill" id="uploadProgressFill"></div></div>
              <p id="uploadProgressText">${t('content.upload_progress')}</p>
            </div>
          </section>
          <form id="remoteMediaForm" role="tabpanel" data-add-panel="remote" hidden>
            <p class="content-field-hint">${t('content.remote_desc')}</p>
            <label class="form-group" for="remoteUrlInput"><span>${t('content.remote_url')}</span><input type="url" id="remoteUrlInput" class="input" placeholder="${t('content.remote_url_placeholder')}" required></label>
            <label class="form-group" for="remoteNameInput"><span>${t('content.display_name_optional')}</span><input type="text" id="remoteNameInput" class="input" placeholder="${t('content.remote_name_placeholder')}"></label>
            <label class="form-group" for="remoteMimeType"><span>${t('content.media_type')}</span>
              <select id="remoteMimeType" class="input">
                <option value="video/mp4">${t('content.mime.video_mp4')}</option>
                <option value="video/webm">${t('content.mime.video_webm')}</option>
                <option value="image/jpeg">${t('content.mime.image_jpeg')}</option>
                <option value="image/png">${t('content.mime.image_png')}</option>
              </select>
            </label>
            <button class="btn btn-primary" id="addRemoteBtn" type="submit">${t('content.remote_add_btn')}</button>
          </form>
          <form id="youtubeMediaForm" role="tabpanel" data-add-panel="youtube" hidden>
            <p class="content-field-hint">${t('content.youtube_desc')}</p>
            <label class="form-group" for="youtubeUrlInput"><span>${t('content.youtube_url_label')}</span><input type="url" id="youtubeUrlInput" class="input" placeholder="${t('content.youtube_url_placeholder')}" required></label>
            <label class="form-group" for="youtubeNameInput"><span>${t('content.display_name_optional')}</span><input type="text" id="youtubeNameInput" class="input" placeholder="${t('content.youtube_name_placeholder')}"></label>
            <button class="btn btn-primary" id="addYoutubeBtn" type="submit">${t('content.youtube_add_btn')}</button>
          </form>
        </div>
      </section>
    </div>
  `;

  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const addDialog = document.getElementById('addMediaDialog');
  const addSheet = addDialog.querySelector('[role="dialog"]');
  let releaseAddMediaFocus = null;
  let addMediaRestoreFocus = null;

  const closeAddMedia = () => {
    if (addDialog.hidden) return;
    addDialog.hidden = true;
    document.body.classList.remove('media-library-dialog-open');
    releaseAddMediaFocus?.();
    releaseAddMediaFocus = null;
  };
  const openAddMedia = () => {
    addMediaRestoreFocus = document.getElementById('openAddMedia') || document.activeElement;
    addDialog.hidden = false;
    document.body.classList.add('media-library-dialog-open');
    releaseAddMediaFocus = trapDialogFocus(addSheet, {
      restoreFocus: addMediaRestoreFocus,
      close: closeAddMedia,
    });
  };

  document.getElementById('openAddMedia').addEventListener('click', openAddMedia);
  addDialog.querySelector('[data-close-add-media]').addEventListener('click', closeAddMedia);
  addDialog.addEventListener('click', event => {
    if (event.target === addDialog) closeAddMedia();
  });
  addDialog.querySelectorAll('[data-add-source]').forEach(tab => {
    tab.addEventListener('click', () => {
      addDialog.querySelectorAll('[data-add-source]').forEach(button => {
        button.setAttribute('aria-selected', String(button === tab));
      });
      addDialog.querySelectorAll('[data-add-panel]').forEach(panel => {
        panel.hidden = panel.dataset.addPanel !== tab.dataset.addSource;
      });
    });
  });

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  document.getElementById('remoteMediaForm').addEventListener('submit', async event => {
    event.preventDefault();
    const url = document.getElementById('remoteUrlInput').value.trim();
    const name = document.getElementById('remoteNameInput').value.trim();
    const mimeType = document.getElementById('remoteMimeType').value;
    if (!url) {
      showToast(t('content.error_enter_url'), 'error');
      return;
    }
    const button = document.getElementById('addRemoteBtn');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await api.addRemoteContent(url, name, mimeType);
      showToast(t('content.toast.remote_added'), 'success');
      document.getElementById('remoteUrlInput').value = '';
      document.getElementById('remoteNameInput').value = '';
      await loadContent();
    } catch (err) {
      showToast(friendlyErrorMessage(err, 'content.error_remote_failed'), 'error');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });

  document.getElementById('youtubeMediaForm').addEventListener('submit', async event => {
    event.preventDefault();
    const url = document.getElementById('youtubeUrlInput').value.trim();
    const name = document.getElementById('youtubeNameInput').value.trim();
    if (!url) {
      showToast(t('content.error_enter_youtube_url'), 'error');
      return;
    }
    const button = document.getElementById('addYoutubeBtn');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await api.addYoutubeContent(url, name);
      showToast(t('content.toast.youtube_added'), 'success');
      document.getElementById('youtubeUrlInput').value = '';
      document.getElementById('youtubeNameInput').value = '';
      await loadContent();
    } catch (err) {
      showToast(friendlyErrorMessage(err, 'content.error_youtube_failed'), 'error');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });

  // Governed filters execute server-side so shared/template/archived results are
  // never inferred from whatever happened to be loaded in the current grid.
  let searchTimer;
  document.getElementById('contentSearch').oninput = (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.search = event.target.value.trim(); loadContent(); }, 250);
  };
  document.getElementById('contentVisibilityFilter').onchange = (event) => { state.filters.visibility = event.target.value; loadContent(); };
  document.getElementById('contentTypeFilter').onchange = (event) => { state.filters.type = event.target.value; loadContent(); };
  document.getElementById('contentMineFilter').onchange = (event) => { state.filters.mine = event.target.checked; loadContent(); };
  document.getElementById('contentArchivedFilter').onchange = (event) => { state.filters.archived = event.target.checked; loadContent(); };
  for (const [id, filter] of [
    ['contentProcessingFilter', 'processing'],
    ['contentCodecFilter', 'codec'],
    ['contentDimensionsFilter', 'dimensions'],
    ['contentSourceFilter', 'source'],
    ['contentThumbnailFilter', 'thumbnail'],
    ['contentP3Filter', 'p3'],
  ]) {
    document.getElementById(id).onchange = event => {
      state.filters[filter] = event.target.value;
      loadContent();
    };
  }
  container.querySelector('[data-reset-filters]').addEventListener('click', () => {
    state.filters = defaultContentFilters();
    state.currentFolderId = null;
    state.sort = 'newest';
    syncContentFilterControls();
    loadContent();
  });
  syncContentFilterControls();
  document.getElementById('contentSort').value = state.sort;
  document.getElementById('contentSort').onchange = event => {
    state.sort = event.target.value;
    renderContentResults();
  };
  container.querySelectorAll('[data-content-view]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.contentView === state.viewMode);
    button.setAttribute('aria-pressed', String(button.dataset.contentView === state.viewMode));
    button.addEventListener('click', () => {
      state.viewMode = button.dataset.contentView;
      container.querySelectorAll('[data-content-view]').forEach(candidate => {
        candidate.classList.toggle('is-active', candidate === button);
        candidate.setAttribute('aria-pressed', String(candidate === button));
      });
      renderContentResults();
    });
  });
  container.querySelectorAll('[data-library-scope]').forEach(button => {
    const currentScope = state.filters.favorite
      ? 'favorites'
      : state.currentFolderId === '__unfiled__'
        ? 'unfiled'
        : state.sort === 'recent' ? 'recent' : 'all';
    const active = button.dataset.libraryScope === currentScope;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      const scope = button.dataset.libraryScope;
      state.filters.favorite = scope === 'favorites' ? '1' : '';
      state.currentFolderId = scope === 'unfiled' ? '__unfiled__' : null;
      if (scope === 'recent') state.sort = 'recent';
      else if (state.sort === 'recent') state.sort = 'newest';
      const sortControl = document.getElementById('contentSort');
      if (sortControl) sortControl.value = state.sort;
      container.querySelectorAll('[data-library-scope]').forEach(candidate => {
        candidate.classList.toggle('is-active', candidate === button);
        candidate.setAttribute('aria-pressed', String(candidate === button));
      });
      loadContent();
    });
  });
  container.querySelector('[data-processing-center]').addEventListener('click', showProcessingCenter);
  container.querySelector('[data-review-publications]')?.addEventListener('click', showPublicationReviewModal);
  container.querySelector('[data-clear-selection]').addEventListener('click', () => {
    state.selectedIds.clear();
    renderContentResults();
  });
  container.querySelector('[data-bulk-move]').addEventListener('click', showBulkMoveDialog);
  container.querySelector('[data-bulk-prepare]').addEventListener('click', bulkPrepareSelection);
  container.querySelector('[data-bulk-tags]').addEventListener('click', bulkTagSelection);
  container.querySelector('[data-bulk-archive]').addEventListener('click', bulkArchiveSelection);
  container.querySelector('[data-bulk-restore]').addEventListener('click', bulkRestoreSelection);
  container.querySelector('[data-bulk-erase]').addEventListener('click', bulkEraseSelection);

  const savedViewSelect = container.querySelector('[data-saved-view]');
  savedViewSelect.addEventListener('change', () => {
    const view = state.savedViews.find(candidate => String(candidate.id) === savedViewSelect.value);
    container.querySelector('[data-delete-view]').disabled = !view;
    if (!view) return;
    const query = view.query || {};
    state.filters = {
      ...defaultContentFilters(),
      search: query.search || '',
      visibility: query.visibility || '',
      type: query.type || '',
      mine: query.owner === 'me',
      archived: query.archived === 'include' || query.archived === 'only',
      processing: query.processing || '',
      codec: query.codec || '',
      dimensions: query.dimensions || '',
      source: query.source || '',
      thumbnail: query.thumbnail || '',
      p3: query.p3 || '',
      favorite: query.favorite ? '1' : '',
    };
    state.sort = query.sort || 'newest';
    state.currentFolderId = null;
    syncContentFilterControls();
    loadContent();
  });
  container.querySelector('[data-save-view]').addEventListener('click', async () => {
    const name = await requestText({
      title: t('content.saved_view_save_title'),
      label: t('content.saved_view_name'),
      confirmLabel: t('content.saved_view_save'),
    });
    if (!name) return;
    try {
      const created = await api.createContentSavedView(name, savedViewQuery());
      await loadSavedViews();
      savedViewSelect.value = created.id;
      container.querySelector('[data-delete-view]').disabled = false;
      showToast(t('content.saved_view_saved'), 'success');
    } catch (error) {
      showToast(error?.message || t('content.saved_view_failed'), 'error');
    }
  });
  container.querySelector('[data-delete-view]').addEventListener('click', async event => {
    const deleteButton = event.currentTarget;
    const view = state.savedViews.find(candidate => String(candidate.id) === savedViewSelect.value);
    if (!view) return;
    const accepted = await requestConfirmation({
      title: t('content.saved_view_delete'),
      message: t('content.saved_view_delete_confirm', { name: view.name }),
      confirmLabel: t('content.saved_view_delete'),
      destructive: true,
    });
    if (!accepted) return;
    deleteButton.disabled = true;
    try {
      await api.deleteContentSavedView(view.id);
      await loadSavedViews();
      showToast(t('content.saved_view_deleted'), 'success');
    } catch (error) {
      showToast(error?.message || t('content.saved_view_failed'), 'error');
      deleteButton.disabled = false;
    }
  });

  document.getElementById('newFolderBtn').onclick = async () => {
    const name = await requestText({
      title: t('content.new_folder_title'),
      label: t('content.folder_name_label'),
      confirmLabel: t('content.create_folder'),
    });
    if (!name || !name.trim()) return;
    try {
      const parentId = state.currentFolderId === '__unfiled__' ? null : state.currentFolderId;
      await api.createFolder(name.trim(), parentId);
      showToast(t('content.toast.folder_created_named', { name }), 'success');
      await loadFolders({ force: true });
      await loadContent();
    } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_folder_failed'), 'error'); }
  };

  Promise.allSettled([loadFolders(), loadSavedViews(), loadLibrarySummary()])
    .then(() => loadContent());
}

// View state — current folder navigation. Lives at module scope so the back button
// and other handlers can read it without threading it through every callback.
const state = {
  currentFolderId: null, // null = root
  folders: [],           // all folders for this user (flat tree)
  foldersLoaded: false,
  foldersRequest: null,
  filters: {
    search: '',
    visibility: '',
    type: '',
    mine: false,
    archived: false,
    processing: '',
    codec: '',
    dimensions: '',
    source: '',
    thumbnail: '',
    p3: '',
    favorite: '',
  },
  savedViews: [],
  librarySummary: null,
  contentById: new Map(),
  contentHasMore: true,
  contentLoading: false,
  contentRequestGeneration: 0,
  selectedIds: new Set(),
  focusContentId: null,
  focusPreview: false,
  focusHandled: false,
  viewMode: 'grid',
  sort: 'newest',
};

function defaultContentFilters() {
  return {
    search: '',
    visibility: '',
    type: '',
    mine: false,
    archived: false,
    processing: '',
    codec: '',
    dimensions: '',
    source: '',
    thumbnail: '',
    p3: '',
    favorite: '',
  };
}

function savedViewQuery() {
  return {
    search: state.filters.search,
    visibility: state.filters.visibility,
    type: state.filters.type,
    owner: state.filters.mine ? 'me' : '',
    archived: state.filters.archived ? 'include' : '',
    processing: state.filters.processing,
    codec: state.filters.codec,
    dimensions: state.filters.dimensions,
    source: state.filters.source,
    thumbnail: state.filters.thumbnail,
    p3: state.filters.p3,
    favorite: state.filters.favorite === true || state.filters.favorite === '1',
    sort: state.sort,
  };
}

function syncContentFilterControls() {
  const values = {
    contentSearch: state.filters.search,
    contentVisibilityFilter: state.filters.visibility,
    contentTypeFilter: state.filters.type,
    contentProcessingFilter: state.filters.processing,
    contentCodecFilter: state.filters.codec,
    contentDimensionsFilter: state.filters.dimensions,
    contentSourceFilter: state.filters.source,
    contentThumbnailFilter: state.filters.thumbnail,
    contentP3Filter: state.filters.p3,
    contentSort: state.sort,
  };
  for (const [id, value] of Object.entries(values)) {
    const control = document.getElementById(id);
    if (control) control.value = value || '';
  }
  const mine = document.getElementById('contentMineFilter');
  const archived = document.getElementById('contentArchivedFilter');
  if (mine) mine.checked = state.filters.mine;
  if (archived) archived.checked = state.filters.archived;
}

async function loadLibrarySummary() {
  const target = document.getElementById('contentLibrarySummary');
  if (!target) return;
  try {
    const summary = await api.getContentLibrarySummary();
    state.librarySummary = summary;
    target.textContent = t('content.storage_summary', {
      count: Number(summary.total_items) || 0,
      size: formatFileSize(Number(summary.storage_bytes) || 0),
      archived: Number(summary.archived_items) || 0,
      favorites: Number(summary.favorite_items) || 0,
      duplicates: Number(summary.duplicate_items) || 0,
      originals: Number(summary.retained_originals) || 0,
    });
  } catch {
    target.textContent = t('content.storage_summary_failed');
  }
}

async function loadSavedViews() {
  const select = document.querySelector('[data-saved-view]');
  if (!select) return;
  try {
    state.savedViews = await api.getContentSavedViews();
    select.innerHTML = `
      <option value="">${t('content.saved_view_choose')}</option>
      ${state.savedViews.map(view => `<option value="${esc(view.id)}">${esc(view.name)}</option>`).join('')}
    `;
  } catch {
    state.savedViews = [];
    select.innerHTML = `<option value="">${t('content.saved_view_failed')}</option>`;
  }
  document.querySelector('[data-delete-view]')?.toggleAttribute('disabled', !select.value);
}

function contentTags(content) {
  try {
    const parsed = JSON.parse(content.tags_json || '[]');
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

async function handleFiles(files) {
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  for (const file of files) {
    progress.hidden = false;
    progressFill.style.width = '0%';
    progressText.textContent = t('content.upload_progress_named', { name: file.name });

    try {
      // Large files (>90MB) go through the resumable tus path so they clear
      // Cloudflare's ~100MB per-request edge limit; smaller files use the
      // simple multipart POST. Falls back to multipart if tus isn't loaded.
      const useResumable = !!(window.tus && window.tus.Upload) && file.size > 90 * 1024 * 1024;
      const uploader = useResumable ? api.uploadContentResumable : api.uploadContent;
      await uploader(file, (pct) => {
        progressFill.style.width = pct + '%';
        progressText.textContent = t('content.upload_progress_named_pct', { name: file.name, pct });
      });
      progressText.textContent = t('content.upload_processing_named', { name: file.name });
      showToast(t('content.toast.uploaded_processing_named', { name: file.name }), 'success');
    } catch (err) {
      showToast(t('content.toast.upload_failed_named', {
        name: file.name,
        error: friendlyErrorMessage(err, 'content.error_upload_failed'),
      }), 'error');
    }
  }

  progress.hidden = true;
  await loadContent();
}

const CONTENT_PAGE_SIZE = 60;

async function loadFolders({ force = false } = {}) {
  if (state.foldersLoaded && !force) return state.folders;
  if (state.foldersRequest && !force) return state.foldersRequest;
  state.foldersRequest = api.getFolders()
    .then(folders => {
      state.folders = Array.isArray(folders) ? folders : [];
      state.foldersLoaded = true;
      return state.folders;
    })
    .finally(() => { state.foldersRequest = null; });
  return state.foldersRequest;
}

function sortedContentItems() {
  const items = storedContentItems();
  const number = (item, key) => {
    const raw = item?.[key];
    if (raw === null || raw === undefined || raw === '') return 0;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : Date.parse(raw) || 0;
  };
  const name = (a, b) => String(a.filename || '').localeCompare(String(b.filename || ''), undefined, { sensitivity: 'base' });
  return items.sort((a, b) => {
    if (state.sort === 'oldest') return number(a, 'created_at') - number(b, 'created_at') || name(a, b);
    if (state.sort === 'name') return name(a, b);
    if (state.sort === 'type') return contentTypeLabel(a).localeCompare(contentTypeLabel(b)) || name(a, b);
    if (state.sort === 'duration') return number(b, 'duration_sec') - number(a, 'duration_sec') || name(a, b);
    if (state.sort === 'size') return number(b, 'file_size') - number(a, 'file_size') || name(a, b);
    if (state.sort === 'readiness') return readinessLabel(getContentReadiness(a)).localeCompare(readinessLabel(getContentReadiness(b))) || name(a, b);
    if (state.sort === 'recent') return number(b, 'last_used_at') - number(a, 'last_used_at') || number(b, 'created_at') - number(a, 'created_at');
    return number(b, 'created_at') - number(a, 'created_at') || name(a, b);
  });
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('contentBulkToolbar');
  if (!toolbar) return;
  toolbar.hidden = state.selectedIds.size === 0;
  const count = document.getElementById('contentSelectedCount');
  if (count) count.textContent = t('content.selected_count', { count: state.selectedIds.size });
}

function renderContentResults() {
  loadContent({ renderOnly: true });
}

async function loadContent({ append = false, renderOnly = false } = {}) {
  const requestGeneration = renderOnly ? state.contentRequestGeneration : ++state.contentRequestGeneration;
  if (!renderOnly) state.contentLoading = true;
  const grid = document.getElementById('contentGrid');
  const folderGrid = document.getElementById('folderGrid');
  const breadcrumb = document.getElementById('folderBreadcrumb');
  if (!grid || !folderGrid || !breadcrumb) { state.contentLoading = false; return; }
  document.querySelectorAll('[data-library-scope]').forEach(button => {
    const active = (button.dataset.libraryScope === 'favorites' && Boolean(state.filters.favorite))
      || (!state.filters.favorite && button.dataset.libraryScope === 'all' && state.currentFolderId === null)
      || (!state.filters.favorite && button.dataset.libraryScope === 'unfiled' && state.currentFolderId === '__unfiled__');
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (!renderOnly) grid.setAttribute('aria-busy', 'true');
  const offset = append ? state.contentById.size : 0;

  try {
    const content = renderOnly ? null : await api.getGovernedContent({
        folderId: state.currentFolderId === null
          ? undefined
          : state.currentFolderId === '__unfiled__' ? null : state.currentFolderId,
        visibility: state.filters.visibility,
        type: state.filters.type,
        search: state.filters.search,
        mine: state.filters.mine,
        archived: state.filters.archived ? 'include' : '',
        processing: state.filters.processing,
        codec: state.filters.codec,
        dimensions: state.filters.dimensions,
        source: state.filters.source,
        thumbnail: state.filters.thumbnail,
        p3: state.filters.p3,
        favorite: state.filters.favorite,
        limit: CONTENT_PAGE_SIZE,
        offset,
      });
    if (!renderOnly && requestGeneration !== state.contentRequestGeneration) return;
    const folders = state.folders;
    if (!renderOnly) {
      storeContentPage(content, { replace: !append });
      if (state.focusContentId && !state.contentById.has(String(state.focusContentId))) {
        const focused = await api.getContentItem(state.focusContentId).catch(() => null);
        if (focused && requestGeneration === state.contentRequestGeneration) storeContentPage([focused]);
      }
      state.contentHasMore = content.length >= CONTENT_PAGE_SIZE;
      state.selectedIds = new Set([...state.selectedIds].filter(id => state.contentById.has(id)));
    }

    // Breadcrumb path: walk parent_id chain from current folder up to root.
    const folderById = new Map(folders.map(f => [f.id, f]));
    const path = [];
    let cursor = state.currentFolderId && state.currentFolderId !== '__unfiled__'
      ? folderById.get(state.currentFolderId)
      : null;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parent_id ? folderById.get(cursor.parent_id) : null;
    }
    breadcrumb.innerHTML = `
      <button type="button" class="media-library-breadcrumb-button" data-folder-nav="">${t('content.breadcrumb_root')}</button>
      ${state.currentFolderId === '__unfiled__' ? `<span aria-hidden="true">/</span><span aria-current="page">${t('content.unfiled')}</span>` : ''}
      ${path.map(f => `
        <span aria-hidden="true">/</span>
        <button type="button" class="media-library-breadcrumb-button" data-folder-nav="${f.id}">${esc(f.name)}</button>
      `).join('')}
      ${path.length ? `<span class="media-library-folder-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="renameFolderBtn">${t('content.rename_btn')}</button>
        <button type="button" class="btn btn-danger btn-sm" id="deleteFolderBtn">${t('content.delete_folder_btn')}</button>
      </span>` : ''}
    `;
    breadcrumb.querySelectorAll('[data-folder-nav]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.dataset.folderNav;
        state.currentFolderId = id || null;
        loadContent();
      });
      // Make breadcrumb segments drop targets too — otherwise the only way to move
      // a file out of a folder is via the edit modal. Dropping on "All Content"
      // moves to root; dropping on a parent name moves there.
      a.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/content-id')) return;
        e.preventDefault();
        a.classList.add('folder-drop-active');
      });
      a.addEventListener('dragleave', () => a.classList.remove('folder-drop-active'));
      a.addEventListener('drop', async (e) => {
        e.preventDefault();
        a.classList.remove('folder-drop-active');
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        const targetFolderId = a.dataset.folderNav || null; // empty string = root
        try {
          await api.moveContent(contentId, targetFolderId);
          showToast(targetFolderId ? t('content.toast.moved') : t('content.toast.moved_to_root'), 'success');
          await loadContent();
        } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_move_failed'), 'error'); }
      });
    });
    const renameBtn = breadcrumb.querySelector('#renameFolderBtn');
    if (renameBtn) renameBtn.onclick = async () => {
      const current = folderById.get(state.currentFolderId);
      const name = await requestText({
        title: t('content.rename_folder_title'),
        label: t('content.folder_name_label'),
        value: current?.name || '',
        confirmLabel: t('content.rename_btn'),
      });
      if (!name || !name.trim() || name === current?.name) return;
      try {
        await api.renameFolder(state.currentFolderId, name.trim());
        showToast(t('content.toast.folder_renamed'), 'success');
        await loadFolders({ force: true });
        await loadContent();
      } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_folder_failed'), 'error'); }
    };
    const deleteBtn = breadcrumb.querySelector('#deleteFolderBtn');
    if (deleteBtn) deleteBtn.onclick = async () => {
      const accepted = await requestConfirmation({
        title: t('content.delete_folder_title'),
        message: t('content.confirm_delete_folder'),
        confirmLabel: t('content.delete_folder_btn'),
        destructive: true,
      });
      if (!accepted) return;
      try {
        const parentId = folderById.get(state.currentFolderId)?.parent_id || null;
        await api.deleteFolder(state.currentFolderId);
        showToast(t('content.toast.folder_deleted'), 'success');
        state.currentFolderId = parentId;
        await loadFolders({ force: true });
        await loadContent();
      } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_folder_failed'), 'error'); }
    };

    // Render subfolders of the current folder.
    const folderParent = state.currentFolderId === '__unfiled__' ? null : state.currentFolderId;
    const subfolders = folders.filter(f => (f.parent_id || null) === folderParent);
    folderGrid.innerHTML = subfolders.map(f => `
      <button type="button" class="folder-card" data-folder-id="${f.id}" data-name="${esc(f.name)}" data-drop-folder="${f.id}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="folder-card-name">${esc(f.name)}</span>
        ${f.content_count === undefined ? '' : `<span class="folder-card-count">${esc(f.content_count)}</span>`}
      </button>
    `).join('');
    folderGrid.querySelectorAll('.folder-card').forEach(card => {
      card.addEventListener('click', () => {
        state.currentFolderId = card.dataset.folderId;
        loadContent();
      });
      // Drop target for dragging content items into this folder.
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('folder-drop-active'); });
      card.addEventListener('dragleave', () => card.classList.remove('folder-drop-active'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('folder-drop-active');
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        try {
          await api.moveContent(contentId, card.dataset.folderId);
          showToast(t('content.toast.moved'), 'success');
          await loadContent();
        } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_move_failed'), 'error'); }
      });
    });

    const visibleContent = sortedContentItems();
    grid.classList.toggle('is-list-view', state.viewMode === 'list');
    if (!visibleContent.length) {
      grid.innerHTML = subfolders.length ? '' : `
        <div class="empty-state media-library-grid-message">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3>${state.currentFolderId && state.currentFolderId !== '__unfiled__' ? t('content.empty_folder_title') : t('content.no_content')}</h3>
          <p>${state.currentFolderId && state.currentFolderId !== '__unfiled__' ? t('content.empty_folder_desc') : t('content.no_content_desc')}</p>
          <button type="button" class="btn btn-primary" data-open-add-media>${t('content.add_media')}</button>
        </div>
      `;
      grid.querySelector('[data-open-add-media]')?.addEventListener('click', () => document.getElementById('openAddMedia')?.click());
      return;
    }

    grid.innerHTML = visibleContent.map(c => `
      <article class="content-item ${c.visibility?.archived_at ? 'is-archived' : ''} ${state.selectedIds.has(String(c.id)) ? 'is-selected' : ''} ${String(c.id) === String(state.focusContentId) ? 'is-focus-target' : ''}" tabindex="-1" draggable="${c.permissions?.can_edit ? 'true' : 'false'}" data-content-id="${c.id}" data-folder="${c.folder || ''}">
        <label class="content-select-control" aria-label="${esc(t('content.select_named', { name: c.filename }))}">
          <input type="checkbox" data-select-content="${esc(c.id)}" ${state.selectedIds.has(String(c.id)) ? 'checked' : ''}>
          <span aria-hidden="true"></span>
        </label>
        <button
          type="button"
          class="content-favorite-control ${c.is_favorite ? 'is-favorite' : ''}"
          data-favorite-content="${esc(c.id)}"
          aria-label="${esc(c.is_favorite ? t('content.favorite_remove_named', { name: c.filename }) : t('content.favorite_add_named', { name: c.filename }))}"
          aria-pressed="${c.is_favorite ? 'true' : 'false'}"
        ><span aria-hidden="true">${c.is_favorite ? '★' : '☆'}</span></button>
        <button type="button" class="content-item-preview" data-preview-content="${esc(c.id)}" aria-label="${esc(t('content.preview_named', { name: c.filename }))}">
          ${c.mime_type === 'video/youtube'
            ? `<span class="media-youtube-preview">
                ${c.thumbnail_url || c.thumbnail_path ? `<img src="${esc(c.thumbnail_url || c.thumbnail_path)}" alt="" loading="lazy">` : ''}
                <span class="media-youtube-mark" aria-hidden="true">▶</span>
              </span>`
          : c.remote_url
            ? `<span class="content-type-fallback" aria-hidden="true">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <small>${t('content.type_remote_short')}</small>
              </span>`
            : c.thumbnail_url || c.thumbnail_path
              ? `<img src="${esc(c.thumbnail_url || c.thumbnail_path)}" alt="" loading="lazy">`
              : c.mime_type?.startsWith('video/')
                ? `<span class="content-type-fallback" aria-hidden="true">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </span>`
                : c.mime_type?.startsWith('audio/')
                  ? '<span class="content-type-fallback" aria-hidden="true">♪</span>'
                : isDocMime(c.mime_type)
                  ? `<span class="content-type-fallback" aria-hidden="true">${docGlyph(c.mime_type)}<small>${esc(docLabel(c.mime_type))}</small></span>`
                : `<img src="${esc(c.file_url || `/api/content/${c.id}/file`)}" alt="" loading="lazy">`
          }
        </button>
        <div class="content-item-body">
          <div class="content-item-heading">
            <div class="content-item-name" title="${esc(c.filename)}">${esc(c.filename)}</div>
            <span class="content-visibility-badge visibility-${esc(c.visibility?.access_level || 'private')}">${visibilityLabel(c.visibility?.access_level)}</span>
          </div>
          <div class="content-item-size">
            ${contentTypeLabel(c)}
            ${c.duration_sec ? ` &middot; ${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : ''}
            ${c.file_size === null || c.file_size === undefined ? '' : ' &middot; ' + formatFileSize(c.file_size)}
            ${c.width && c.height ? ` &middot; ${c.width}×${c.height}` : ''}
          </div>
          <div class="content-governance-meta">
            <span>${t('content.owner')}: ${esc(c.visibility?.owner_name || t('content.owner_unknown'))}</span>
            <span>${t('content.version', { version: c.version || 1 })}</span>
            ${c.source_content_id ? `<span>${t('content.source_copy')}</span>` : ''}
            ${c.usage_count ? `<span>${t('content.in_use', { count: c.usage_count })}</span>` : ''}
            ${c.duplicate_count ? `<span class="content-duplicate-warning">${t('content.duplicate_warning', { count: c.duplicate_count })}</span>` : ''}
            ${contentTags(c).length ? `<span>${t('content.tags')}: ${contentTags(c).map(esc).join(', ')}</span>` : ''}
          </div>
          ${readinessMarkup(c)}
          ${classroomPreparationMarkup(c)}
        </div>
        <div class="content-item-actions">
          ${governedActions(c)}
        </div>
      </article>
    `).join('');
    if (state.focusContentId && !state.focusHandled) {
      const focused = grid.querySelector(`[data-content-id="${CSS.escape(String(state.focusContentId))}"]`);
      if (focused) {
        state.focusHandled = true;
        requestAnimationFrame(() => {
          focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
          focused.focus({ preventScroll: true });
          if (state.focusPreview) {
            const content = findContentItem(state.focusContentId);
            if (content) showPreview(content);
          }
        });
      }
    }
    syncQueuedAutoSendControls();
    updateBulkToolbar();

    // Drag-to-move: each content item exposes its id; folder cards are the drop targets.
    grid.querySelectorAll('.content-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/content-id', item.dataset.contentId);
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    // Delete handler via event delegation
    grid.onclick = async (e) => {
      const wallpaperBtn = e.target.closest('[data-wallpaper-menu-content]');
      if (wallpaperBtn) {
        e.preventDefault();
        e.stopPropagation();
        const item = findContentItem(wallpaperBtn.dataset.wallpaperMenuContent);
        if (!item) return;
        const wasInMenu = item.is_wallpaper_menu === true;
        wallpaperBtn.disabled = true;
        wallpaperBtn.setAttribute('aria-busy', 'true');
        try {
          const updated = await api.setWallpaperMenu(item.id, !wasInMenu, item.version || 1);
          state.contentById.set(String(item.id), updated);
          showToast(
            wasInMenu ? t('content.wallpaper_menu_removed') : t('content.wallpaper_menu_added'),
            'success',
          );
          renderContentResults();
        } catch (error) {
          showToast(error?.message || t('content.wallpaper_menu_failed'), 'error');
          if (wallpaperBtn.isConnected) {
            wallpaperBtn.disabled = false;
            wallpaperBtn.removeAttribute('aria-busy');
          }
        }
        return;
      }
      const favoriteBtn = e.target.closest('[data-favorite-content]');
      if (favoriteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const item = findContentItem(favoriteBtn.dataset.favoriteContent);
        if (!item) return;
        favoriteBtn.disabled = true;
        try {
          await api.setContentFavorite(item.id, !item.is_favorite);
          item.is_favorite = !item.is_favorite;
          await loadLibrarySummary();
          if (state.filters.favorite && !item.is_favorite) await loadContent();
          else renderContentResults();
        } catch (error) {
          showToast(error?.message || t('content.favorite_failed'), 'error');
          if (favoriteBtn.isConnected) favoriteBtn.disabled = false;
        }
        return;
      }
      const loadMoreButton = e.target.closest('#contentLoadMore');
      if (loadMoreButton) {
        loadMoreButton.disabled = true;
        loadMoreButton.setAttribute('aria-busy', 'true');
        await loadContent({ append: true });
        return;
      }
      const sendBtn = e.target.closest('[data-send-content]');
      if (sendBtn) {
        e.preventDefault();
        e.stopPropagation();
        const item = findContentItem(sendBtn.dataset.sendContent);
        if (!item || !getContentReadiness(item).sendEnabled) return;
        sendBtn.disabled = true;
        try {
          const route = await chooseContentTargets(item.filename || t('content.type_video'));
          if (route) await sendContentToTargets(item, route);
        } finally {
          if (sendBtn.isConnected) sendBtn.disabled = false;
        }
        return;
      }

      // Preview on click (not on delete button)
      const previewTarget = e.target.closest('[data-preview-content]');
      if (previewTarget) {
        const item = findContentItem(previewTarget.dataset.previewContent);
        if (item) showPreview(item);
        return;
      }

      const prepareBtn = e.target.closest('[data-prepare-content]');
      if (prepareBtn) {
        e.preventDefault();
        e.stopPropagation();
        const contentId = String(prepareBtn.dataset.prepareContent || '');
        if (!contentId) return;
        prepareBtn.disabled = true;
        try {
          const response = await api.prepareContentForClass(contentId);
          const result = response?.results?.find(item => String(item.content_id) === contentId);
          if (!result || Number(result.status) !== 202) {
            throw new Error(result?.error || t('content.prepare_failed'));
          }
          classroomPreparationById.set(contentId, result);
          showToast(t('content.prepare_queued'), 'success');
          renderContentResults();
        } catch (error) {
          showToast(error?.message || t('content.prepare_failed'), 'error');
        } finally {
          if (prepareBtn.isConnected) prepareBtn.disabled = false;
        }
        return;
      }

      // Download button — authenticated blob save (never broadcasts/plays/selects)
      const dlBtn = e.target.closest('[data-download-content]');
      if (dlBtn) {
        e.preventDefault();
        e.stopPropagation();
        const id = dlBtn.dataset.downloadContent;
        const name = dlBtn.dataset.downloadName || '';
        dlBtn.disabled = true;
        try {
          const { blob, filename } = await api.downloadContent(id);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = filename || name || 'download';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
          showToast(err?.message || t('content.toast.download_failed'), 'error');
        } finally { dlBtn.disabled = false; }
        return;
      }

      // Edit button
      const editBtn = e.target.closest('[data-edit-content]');
      if (editBtn) {
        const id = editBtn.dataset.editContent;
        const c = findContentItem(id);
        if (c) showEditModal(c, loadContent);
        return;
      }

      const thumbnailStudioBtn = e.target.closest('[data-thumbnail-studio]');
      if (thumbnailStudioBtn) {
        const item = findContentItem(thumbnailStudioBtn.dataset.thumbnailStudio);
        if (item) showPreview(item, { focusThumbnail: true });
        return;
      }

      const repairBtn = e.target.closest('[data-repair-content]');
      if (repairBtn) {
        const c = findContentItem(repairBtn.dataset.repairContent);
        if (c) showEditModal(c, loadContent, { focusReplacement: true });
        return;
      }

      const moveBtn = e.target.closest('[data-move-content]');
      if (moveBtn) {
        const c = findContentItem(moveBtn.dataset.moveContent);
        if (c) showMoveDialog(c);
        return;
      }

      const requestBtn = e.target.closest('[data-request-publication]');
      if (requestBtn) {
        requestBtn.disabled = true;
        try {
          await api.requestContentPublication(requestBtn.dataset.requestPublication);
          showToast(t('content.toast.publication_requested'), 'success');
          loadContent();
        } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_publication_failed'), 'error'); requestBtn.disabled = false; }
        return;
      }

      const duplicateBtn = e.target.closest('[data-duplicate-content]');
      if (duplicateBtn) {
        duplicateBtn.disabled = true;
        try {
          await api.duplicateContent(duplicateBtn.dataset.duplicateContent);
          showToast(t('content.toast.duplicated'), 'success');
          loadContent();
        } catch (err) { showToast(friendlyErrorMessage(err, 'content.error_duplicate_failed'), 'error'); duplicateBtn.disabled = false; }
        return;
      }

      const transferBtn = e.target.closest('[data-transfer-content]');
      if (transferBtn) {
        const item = findContentItem(transferBtn.dataset.transferContent);
        if (item) showTransferModal(item, loadContent);
        return;
      }

      const assignmentsBtn = e.target.closest('[data-template-assignments]');
      if (assignmentsBtn) {
        const item = findContentItem(assignmentsBtn.dataset.templateAssignments);
        if (item) showTemplateAssignmentsModal(item, loadContent);
        return;
      }

      const archiveBtn = e.target.closest('[data-archive-content]');
      if (archiveBtn) {
        const restoring = archiveBtn.dataset.archived === 'true';
        const accepted = await requestConfirmation({
          title: restoring ? t('content.restore_title') : t('content.archive_title'),
          message: restoring ? t('content.confirm_restore') : t('content.confirm_archive'),
          confirmLabel: restoring ? t('content.btn_restore') : t('content.btn_archive'),
          destructive: !restoring,
        });
        if (!accepted) return;
        archiveBtn.disabled = true;
        try {
          await api.archiveContent(archiveBtn.dataset.archiveContent, !restoring);
          showToast(restoring ? t('content.toast.restored') : t('content.toast.archived'), 'success');
          loadContent();
        } catch (err) {
          if (err.code === 'CONTENT_IN_USE') {
            const usage = await api.getContentUsage(archiveBtn.dataset.archiveContent).catch(() => err.details);
            showUsageConflict(usage);
          } else showToast(friendlyErrorMessage(err, 'content.error_archive_failed'), 'error');
          archiveBtn.disabled = false;
        }
        return;
      }

      const btn = e.target.closest('[data-delete-content]');
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.deleteContent;

      const contentItem = findContentItem(id);
      let impact;
      try { impact = await api.getContentEraseImpact(id); }
      catch (err) { showToast(friendlyErrorMessage(err, 'content.error_erase_impact_failed'), 'error'); return; }
      const accepted = await requestPermanentEraseConfirmation({
        title: t('content.erase_title'),
        itemLabel: contentItem?.filename || '',
        impacts: [impact],
      });
      if (!accepted) return;
      try {
        btn.disabled = true;
        btn.textContent = t('content.btn_erasing');
        await api.permanentlyEraseContent(id);
        showToast(t('content.toast.erased'), 'success');
        await loadContent();
      } catch (err) {
        showToast(friendlyErrorMessage(err, 'content.error_erase_failed'), 'error');
        btn.disabled = false;
        btn.textContent = t('content.btn_permanent_erase');
      }
      return;

    };

    grid.onchange = async (event) => {
      const selected = event.target.closest('[data-select-content]');
      if (selected) {
        const id = String(selected.dataset.selectContent);
        if (selected.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        selected.closest('.content-item')?.classList.toggle('is-selected', selected.checked);
        updateBulkToolbar();
        return;
      }
      const checkbox = event.target.closest('[data-auto-send-ready]');
      if (!checkbox) return;
      const contentId = String(checkbox.dataset.autoSendReady || '');
      const item = findContentItem(contentId);
      if (!item) {
        checkbox.checked = false;
        return;
      }

      if (!checkbox.checked) {
        if (queuedAutoSends.delete(contentId)) {
          showToast(t('content.auto_send_cancelled', { name: item.filename }), 'success');
        }
        maybeDetachContentUpdatedListener();
        return;
      }

      checkbox.disabled = true;
      try {
        const route = await chooseContentTargets(item.filename || t('content.type_video'));
        if (!route) {
          checkbox.checked = false;
          return;
        }

        // Close the picker/event race: if finalization finished while targets
        // were being chosen, send now instead of waiting for a past event.
        const latest = await api.getContentItem(contentId).catch(() => item);
        const readiness = getContentReadiness(latest);
        const label = latest.filename || item.filename || t('content.type_video');
        if (readiness.state === 'ready') {
          checkbox.checked = false;
          await sendContentToTargets(latest, route);
          await loadContent();
          return;
        }
        if (readiness.state === 'failed') {
          checkbox.checked = false;
          showToast(t('content.auto_send_failed', {
            name: label,
            reason: readiness.reason || t('content.status_failed_fallback'),
          }), 'error');
          await loadContent();
          return;
        }

        queuedAutoSends.set(contentId, { route, label });
        ensureContentUpdatedListener();
        showToast(t('content.auto_send_queued', { name: label }), 'success');
      } finally {
        if (checkbox.isConnected) checkbox.disabled = false;
      }
    };

    // 316b8e8c9c3c Real pagination (task §10): a Load More affordance after the
    // grid. Fetching the next page does NOT reset the accumulated list.
    const existingMore = grid.querySelector('#contentLoadMore');
    if (existingMore) existingMore.remove();
    if (state.contentHasMore) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.id = 'contentLoadMore';
      moreBtn.className = 'btn btn-secondary media-library-load-more';
      moreBtn.textContent = t('content.load_more');
      grid.appendChild(moreBtn);
    }

  } catch (err) {
    if (!renderOnly && requestGeneration !== state.contentRequestGeneration) return;
    const message = `
      <div class="empty-state media-library-grid-message media-library-error" role="alert">
        <h3>${t('content.failed_to_load')}</h3>
        <p>${friendlyErrorMessage(err, 'content.error_load_failed')}</p>
        <button type="button" class="btn btn-primary" data-retry-content>${t('content.retry')}</button>
      </div>`;
    if (storedContentItems().length) grid.insertAdjacentHTML('afterbegin', message);
    else grid.innerHTML = message;
    grid.querySelector('[data-retry-content]')?.addEventListener('click', () => loadContent());
  } finally {
    if (!renderOnly && requestGeneration === state.contentRequestGeneration) {
      state.contentLoading = false;
      grid.setAttribute('aria-busy', 'false');
    }
  }
}

function moveDialogMarkup({ title, description, selectedFolder = '' }) {
  return `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="moveContentTitle">
      <div class="modal-header">
        <div><h3 id="moveContentTitle">${esc(title)}</h3><p class="content-modal-subtitle">${esc(description)}</p></div>
        <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
      </div>
      <form class="modal-body" data-move-form>
        <label class="form-group" for="moveContentFolder">
          <span>${t('content.label_folder')}</span>
          <select class="input" id="moveContentFolder">
            <option value="">${t('content.folder_root_option')}</option>
            ${state.folders.map(folder => `<option value="${esc(folder.id)}" ${String(selectedFolder) === String(folder.id) ? 'selected' : ''}>${esc(folderPath(folder, state.folders))}</option>`).join('')}
          </select>
        </label>
        <div class="modal-footer media-library-dialog-actions">
          <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('content.move_save')}</button>
        </div>
      </form>
    </div>`;
}

function showMoveDialog(contentItem) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay media-library-dialog-overlay';
  overlay.innerHTML = moveDialogMarkup({
    title: t('content.move_title'),
    description: contentItem.filename,
    selectedFolder: contentItem.folder_id || '',
  });
  const close = mountTransientDialog(overlay);
  overlay.querySelector('[data-move-form]').addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await api.moveContent(contentItem.id, overlay.querySelector('#moveContentFolder').value || null);
      close();
      showToast(t('content.toast.moved'), 'success');
      await loadContent();
    } catch (error) {
      showToast(friendlyErrorMessage(error, 'content.error_move_failed'), 'error');
      event.submitter.disabled = false;
    }
  });
}

function showBulkMoveDialog() {
  if (!state.selectedIds.size) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay media-library-dialog-overlay';
  overlay.innerHTML = moveDialogMarkup({
    title: t('content.bulk_move'),
    description: t('content.selected_count', { count: state.selectedIds.size }),
  });
  const close = mountTransientDialog(overlay);
  overlay.querySelector('[data-move-form]').addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    const folderId = overlay.querySelector('#moveContentFolder').value || null;
    try {
      await Promise.all([...state.selectedIds].map(id => api.moveContent(id, folderId)));
      state.selectedIds.clear();
      close();
      showToast(t('content.toast.bulk_moved'), 'success');
      await loadContent();
    } catch (error) {
      showToast(friendlyErrorMessage(error, 'content.error_move_failed'), 'error');
      event.submitter.disabled = false;
    }
  });
}

async function bulkArchiveSelection() {
  if (!state.selectedIds.size) return;
  const accepted = await requestConfirmation({
    title: t('content.bulk_archive'),
    message: t('content.bulk_archive_confirm', { count: state.selectedIds.size }),
    confirmLabel: t('content.bulk_archive'),
    destructive: true,
  });
  if (!accepted) return;
  try {
    await Promise.all([...state.selectedIds].map(id => api.archiveContent(id, true)));
    state.selectedIds.clear();
    showToast(t('content.toast.bulk_archived'), 'success');
    await loadLibrarySummary();
    await loadContent();
  } catch (error) {
    showToast(friendlyErrorMessage(error, 'content.error_archive_failed'), 'error');
  }
}

async function bulkRestoreSelection() {
  if (!state.selectedIds.size) return;
  try {
    await Promise.all([...state.selectedIds].map(id => api.archiveContent(id, false)));
    state.selectedIds.clear();
    showToast(t('content.toast.bulk_restored'), 'success');
    await loadLibrarySummary();
    await loadContent();
  } catch (error) {
    showToast(friendlyErrorMessage(error, 'content.error_archive_failed'), 'error');
  }
}

async function bulkEraseSelection() {
  if (!state.selectedIds.size) return;
  const ids = [...state.selectedIds];
  const impacts = [];
  try {
    for (const id of ids) impacts.push(await api.getContentEraseImpact(id));
    const accepted = await requestPermanentEraseConfirmation({
      title: t('content.bulk_erase_title'),
      itemLabel: t('content.selected_count', { count: ids.length }),
      impacts,
    });
    if (!accepted) return;
    await api.permanentlyEraseContentBulk(ids);
    state.selectedIds.clear();
    showToast(t('content.toast.bulk_erased', { count: ids.length }), 'success');
    await loadLibrarySummary();
    await loadContent();
  } catch (error) {
    showToast(friendlyErrorMessage(error, 'content.error_erase_failed'), 'error');
  }
}

async function bulkTagSelection() {
  if (!state.selectedIds.size) return;
  const value = await requestText({
    title: t('content.bulk_tags'),
    label: t('content.bulk_tags_label'),
    confirmLabel: t('content.bulk_tags_apply'),
  });
  if (!value) return;
  const additions = [...new Set(value.split(',')
    .map(tag => tag.trim())
    .filter(Boolean))]
    .slice(0, 20);
  if (!additions.length) return;
  try {
    await Promise.all([...state.selectedIds].map(id => {
      const item = findContentItem(id);
      if (!item) return Promise.resolve();
      const tags = [...new Set([...contentTags(item), ...additions])].slice(0, 20);
      return api.updateContent(id, { tags, expected_version: item.version || 1 });
    }));
    state.selectedIds.clear();
    showToast(t('content.toast.bulk_tagged'), 'success');
    await loadContent();
  } catch (error) {
    showToast(error?.message || t('content.bulk_tags_failed'), 'error');
  }
}

async function bulkPrepareSelection() {
  if (!state.selectedIds.size) return;
  const ids = [...state.selectedIds];
  const button = document.querySelector('[data-bulk-prepare]');
  if (button) button.disabled = true;
  try {
    const response = await api.prepareContentForClass(ids);
    for (const result of response?.results || []) {
      if (Number(result.status) === 202) {
        classroomPreparationById.set(String(result.content_id), result);
      }
    }
    showToast(t('content.bulk_prepare_queued', {
      accepted: Number(response?.accepted) || 0,
      total: ids.length,
    }), Number(response?.accepted) > 0 ? 'success' : 'error');
    state.selectedIds.clear();
    renderContentResults();
  } catch (error) {
    showToast(error?.message || t('content.prepare_failed'), 'error');
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function formatJobDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return t('content.job_seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder
    ? t('content.job_minutes_seconds', { minutes, seconds: remainder })
    : t('content.job_minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return t('content.job_hours_minutes', { hours, minutes: minutes % 60 });
}

function mediaJobTypeLabel(jobType) {
  const labels = {
    video_normalize: 'content.job_type_video_normalize',
    thumbnail_finalize: 'content.job_type_thumbnail_finalize',
    thumbnail_studio: 'content.job_type_thumbnail_studio',
    youtube_ingest: 'content.job_type_youtube_ingest',
    remote_validate: 'content.job_type_remote_validate',
    url_download: 'content.job_type_url_download',
    peertube_localize: 'content.job_type_peertube_localize',
  };
  return t(labels[jobType] || 'content.job_type_media');
}

function mediaJobStageLabel(stage) {
  const supported = new Set([
    'received', 'validating', 'downloading', 'probing', 'transcoding',
    'optimizing', 'thumbnail', 'checksum', 'finalizing', 'publishing',
    'preparing', 'ready', 'failed', 'cancelled',
  ]);
  return t(`content.job_stage_${supported.has(stage) ? stage : 'working'}`);
}

function mediaJobStatusLabel(status) {
  const supported = new Set(['queued', 'retry_wait', 'running', 'completed', 'failed', 'cancelled']);
  return t(`content.job_status_${supported.has(status) ? status : 'working'}`);
}

function mediaJobErrorLabel(errorCode) {
  const codes = {
    source_missing: 'content.job_error_source_missing',
    source_too_large: 'content.job_error_source_too_large',
    disk_space_unavailable: 'content.job_error_disk_space',
    poster_media_unsupported: 'content.job_error_poster_unsupported',
    timestamp_out_of_range: 'content.job_error_timestamp',
    invalid_poster_position: 'content.job_error_position',
    media_job_cancelled: 'content.job_error_cancelled',
  };
  return t(codes[String(errorCode || '').toLowerCase()] || 'content.job_error_generic');
}

function mediaJobTiming(job) {
  const now = Date.now() / 1000;
  const started = Number(job.started_at);
  const completed = Number(job.completed_at);
  const progress = Math.max(0, Math.min(100, Number(job.progress_pct) || 0));
  if (completed > 0) {
    return t('content.job_completed_at', {
      time: new Date(completed * 1000).toLocaleString(),
    });
  }
  if (job.status === 'queued') return t('content.job_waiting_capacity');
  if (job.status === 'retry_wait') return t('content.job_retry_scheduled');
  if (job.status === 'cancelled') return t('content.job_cancelled');
  if (started > 0 && progress > 0 && progress < 100) {
    const elapsed = Math.max(0, now - started);
    const remaining = elapsed * (100 - progress) / progress;
    return t('content.job_elapsed_eta', {
      elapsed: formatJobDuration(elapsed),
      eta: formatJobDuration(remaining),
    });
  }
  if (started > 0) {
    return t('content.job_elapsed_calculating', {
      elapsed: formatJobDuration(now - started),
    });
  }
  return t('content.job_eta_calculating');
}

function showProcessingCenter() {
  const restoreFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay media-library-dialog-overlay';
  overlay.innerHTML = `
    <section class="modal media-processing-center" role="dialog" aria-modal="true" aria-labelledby="mediaProcessingTitle" tabindex="-1" data-processing-center-dialog>
      <div class="modal-header">
        <div>
          <h2 id="mediaProcessingTitle">${t('content.processing_center')}</h2>
          <p class="content-modal-subtitle">${t('content.processing_center_desc')}</p>
        </div>
        <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body media-processing-center-body" data-media-jobs aria-live="polite" aria-busy="true">
        <div class="empty-state"><h3>${t('common.loading')}</h3></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-refresh-media-jobs>${t('content.processing_refresh')}</button>
        <button type="button" class="btn btn-primary" data-close-dialog>${t('common.close')}</button>
      </div>
    </section>`;

  let pollTimer = null;
  let refreshing = false;
  const jobsTarget = overlay.querySelector('[data-media-jobs]');
  const refreshJobs = async () => {
    if (refreshing || !overlay.isConnected) return;
    refreshing = true;
    jobsTarget.setAttribute('aria-busy', 'true');
    try {
      const jobs = await api.getMediaJobs({ limit: 100 });
      if (!jobs.length) {
        jobsTarget.innerHTML = `
          <div class="empty-state">
            <h3>${t('content.processing_empty')}</h3>
            <p>${t('content.processing_empty_desc')}</p>
          </div>`;
      } else {
        jobsTarget.innerHTML = `<ol class="media-processing-jobs">${jobs.map(job => {
          const progress = Math.max(0, Math.min(100, Number(job.progress_pct) || 0));
          const item = findContentItem(job.content_id);
          const active = ['queued', 'retry_wait', 'running'].includes(job.status);
          return `
            <li class="media-processing-job is-${esc(job.status || 'working')}">
              <div class="media-processing-job-heading">
                <div>
                  <strong>${esc(item?.filename || mediaJobTypeLabel(job.job_type))}</strong>
                  <span>${esc(mediaJobTypeLabel(job.job_type))}</span>
                </div>
                <span class="media-processing-status">${esc(mediaJobStatusLabel(job.status))}</span>
              </div>
              <div class="media-processing-progress">
                <progress max="100" value="${progress}" aria-label="${esc(t('content.processing_progress_label', {
                  stage: mediaJobStageLabel(job.stage),
                  progress,
                }))}"></progress>
                <span>${esc(mediaJobStageLabel(job.stage))} · ${progress}%</span>
              </div>
              <p class="media-processing-timing">${esc(mediaJobTiming(job))}</p>
              <p class="media-processing-attempts">${esc(t('content.job_attempts', {
                attempt: Number(job.attempts) || 0,
                maximum: Number(job.max_attempts) || 1,
              }))}</p>
              ${job.status === 'failed' ? `<p class="content-readiness-reason">${esc(mediaJobErrorLabel(job.error_code))}</p>` : ''}
              <div class="media-processing-actions">
                ${job.status === 'failed' && job.retryable
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-media-job-retry="${esc(job.id)}">${t('content.processing_retry')}</button>`
                  : ''}
                ${active
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-media-job-cancel="${esc(job.id)}">${t('content.processing_cancel')}</button>`
                  : ''}
              </div>
            </li>`;
        }).join('')}</ol>`;
      }

      jobsTarget.querySelectorAll('[data-media-job-retry]').forEach(button => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.retryMediaJob(button.dataset.mediaJobRetry);
            showToast(t('content.processing_retry_queued'), 'success');
            await refreshJobs();
          } catch (error) {
            showToast(friendlyErrorMessage(error, 'content.processing_action_failed'), 'error');
            if (button.isConnected) button.disabled = false;
          }
        });
      });
      jobsTarget.querySelectorAll('[data-media-job-cancel]').forEach(button => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.cancelMediaJob(button.dataset.mediaJobCancel);
            showToast(t('content.processing_cancel_requested'), 'success');
            await refreshJobs();
          } catch (error) {
            showToast(friendlyErrorMessage(error, 'content.processing_action_failed'), 'error');
            if (button.isConnected) button.disabled = false;
          }
        });
      });
    } catch (error) {
      jobsTarget.innerHTML = `
        <div class="empty-state media-library-error" role="alert">
          <h3>${t('content.processing_failed')}</h3>
          <p>${friendlyErrorMessage(error, 'content.processing_failed_desc')}</p>
        </div>`;
    } finally {
      jobsTarget.setAttribute('aria-busy', 'false');
      refreshing = false;
    }
  };

  mountTransientDialog(overlay, restoreFocus, () => {
    if (pollTimer) window.clearInterval(pollTimer);
  });
  overlay.querySelector('[data-refresh-media-jobs]').addEventListener('click', refreshJobs);
  refreshJobs();
  pollTimer = window.setInterval(refreshJobs, 3000);
}

export function cleanup() {
  viewMounted = false;
  state.contentRequestGeneration += 1;
  if (contentPreparationHandler) {
    socketOff('content-preparation', contentPreparationHandler);
    contentPreparationHandler = null;
  }
  maybeDetachContentUpdatedListener();
}

function showEditModal(contentItem, onSave, { focusReplacement = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay media-library-dialog-overlay';

  const isRemote = !!contentItem.remote_url;

  overlay.innerHTML = `
    <div class="modal media-library-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="editContentTitle">
      <div class="modal-header">
        <h3 id="editContentTitle">${t('content.edit_modal_title')}</h3>
        <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label for="editFilename">${t('content.label_filename')}</label>
          <input type="text" id="editFilename" class="input" value="${esc(contentItem.filename)}">
        </div>
        ${isRemote ? `
        <div class="form-group">
          <label for="editRemoteUrl">${t('content.label_remote_url_field')}</label>
          <input type="text" id="editRemoteUrl" class="input" value="${esc(contentItem.remote_url)}">
        </div>
        ` : ''}
        <div class="form-group">
          <label for="editMimeType">${t('content.label_mime_type')}</label>
          <select id="editMimeType" class="input">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>${t('content.mime.video_mp4')}</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>${t('content.mime.video_webm')}</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>${t('content.mime.image_jpeg')}</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>${t('content.mime.image_png')}</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>${t('content.mime.image_gif')}</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>${t('content.mime.image_webp')}</option>
            <option value="application/pdf" ${contentItem.mime_type === 'application/pdf' ? 'selected' : ''}>${t('content.mime.pdf')}</option>
            <option value="application/vnd.openxmlformats-officedocument.wordprocessingml.document" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'selected' : ''}>${t('content.mime.word')}</option>
            <option value="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? 'selected' : ''}>${t('content.mime.excel')}</option>
            <option value="application/vnd.openxmlformats-officedocument.presentationml.presentation" ${contentItem.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ? 'selected' : ''}>${t('content.mime.powerpoint')}</option>
          </select>
        </div>
        <div class="form-group">
          <label for="editFolderId">${t('content.label_folder')}</label>
          <select id="editFolderId" class="input">
            <option value="">${t('content.folder_root_option')}</option>
            ${state.folders.map(f => `<option value="${f.id}" ${contentItem.folder_id === f.id ? 'selected' : ''}>${esc(folderPath(f, state.folders))}</option>`).join('')}
          </select>
        </div>
        ${contentItem.permissions?.can_change_visibility ? `
        <div class="form-group">
          <label for="editAccessLevel">${t('content.label_visibility')}</label>
          <select id="editAccessLevel" class="input">
            ${(contentItem.permissions.allowed_visibilities || []).map(level => `
              <option value="${level}" ${contentItem.visibility?.access_level === level ? 'selected' : ''}>${visibilityLabel(level)}</option>
            `).join('')}
          </select>
          <p class="content-field-hint">${t('content.visibility_hint')}</p>
        </div>
        ` : ''}
        <div class="form-group">
          <label for="editFitMode">${t('content.default_fit')}</label>
          <select id="editFitMode" class="input">
            <option value="" ${!contentItem.default_fit_mode ? 'selected' : ''}>${t('content.fit_auto')}</option>
            <option value="contain" ${contentItem.default_fit_mode === 'contain' ? 'selected' : ''}>${t('content.fit_contain')}</option>
            <option value="cover" ${contentItem.default_fit_mode === 'cover' ? 'selected' : ''}>${t('content.fit_cover')}</option>
            <option value="fill" ${contentItem.default_fit_mode === 'fill' ? 'selected' : ''}>${t('content.fit_fill')}</option>
          </select>
          <p class="content-field-hint">${t('content.default_fit_hint')}</p>
        </div>
        ${!isRemote ? `
        <div class="form-group">
          <label for="editFileReplace">${t('content.label_replace_file')}</label>
          <input type="file" id="editFileReplace" class="media-library-file-input" accept="video/*,image/*,audio/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation">
          <p class="content-field-hint">${t('content.replace_file_hint')}</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" id="saveEditBtn">${t('content.save_changes')}</button>
      </div>
    </div>
  `;

  const close = mountTransientDialog(overlay);
  if (focusReplacement) queueMicrotask(() => overlay.querySelector('#editFileReplace')?.focus());

  overlay.querySelector('#saveEditBtn').onclick = async () => {
    const filename = overlay.querySelector('#editFilename').value.trim();
    const mimeType = overlay.querySelector('#editMimeType').value;
    const remoteUrl = overlay.querySelector('#editRemoteUrl')?.value.trim();
    const replaceFile = overlay.querySelector('#editFileReplace')?.files[0];

    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: 'Bearer ' + token };

      // Update metadata
      const folderId = overlay.querySelector('#editFolderId')?.value || '';
      const fitMode = overlay.querySelector('#editFitMode')?.value || '';
      const accessLevel = overlay.querySelector('#editAccessLevel')?.value;
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      if ((contentItem.default_fit_mode || '') !== fitMode) updateData.default_fit_mode = fitMode || null;
      if (accessLevel && accessLevel !== contentItem.visibility?.access_level) updateData.access_level = accessLevel;

      let expectedVersion = Number(contentItem.version) || 1;
      if (Object.keys(updateData).length > 0) {
        updateData.expected_version = expectedVersion;
        const updated = await api.updateContent(contentItem.id, updateData);
        expectedVersion = Number(updated?.version) || expectedVersion + 1;
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        formData.append('expected_version', String(expectedVersion));
        const response = await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t('content.error_update_failed'));
        }
      }

      close();
      showToast(t('content.toast.updated'), 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(friendlyErrorMessage(err, 'content.error_update_failed'), 'error');
    }
  };
}

function revokePreviewCaptionUrls(overlay) {
  for (const url of overlay._captionObjectUrls || []) URL.revokeObjectURL(url);
  overlay._captionObjectUrls = [];
}

async function loadPreviewCaptions(overlay, content) {
  const manager = overlay.querySelector('[data-caption-manager]');
  if (!manager) return;
  const list = manager.querySelector('[data-caption-list]');
  try {
    const response = await api.listContentCaptions(content.id, { includeBody: true });
    const captions = Array.isArray(response?.captions) ? response.captions : [];
    revokePreviewCaptionUrls(overlay);
    const video = overlay.querySelector('.media-preview-stage video');
    video?.querySelectorAll('track[data-preview-caption]').forEach(track => track.remove());
    if (video) {
      for (const caption of captions) {
        if (!caption.body_vtt) continue;
        const url = URL.createObjectURL(new Blob([caption.body_vtt], { type: 'text/vtt' }));
        overlay._captionObjectUrls.push(url);
        const track = document.createElement('track');
        track.dataset.previewCaption = String(caption.id);
        track.kind = caption.kind === 'subtitles' ? 'subtitles' : 'captions';
        track.label = caption.label || caption.language_code;
        track.srclang = caption.language_code;
        track.src = url;
        track.default = caption.is_default === true;
        video.appendChild(track);
      }
    }
    list.innerHTML = captions.length
      ? `<ul>${captions.map(caption => `
          <li>
            <span><strong>${esc(caption.label)}</strong> · ${esc(caption.language_code)} · ${t('content.caption_cues', { count: caption.cue_count || 0 })}</span>
            ${caption.is_default ? `<span class="content-caption-default">${t('content.caption_default')}</span>` : ''}
            ${content.permissions?.can_edit && !caption.is_default ? `<button type="button" class="btn btn-secondary btn-sm" data-caption-default="${esc(caption.id)}">${t('content.caption_make_default')}</button>` : ''}
            ${content.permissions?.can_edit ? `<button type="button" class="btn btn-danger btn-sm" data-caption-delete="${esc(caption.id)}">${t('content.caption_delete')}</button>` : ''}
          </li>
        `).join('')}</ul>`
      : `<p class="content-field-hint">${t('content.caption_empty')}</p>`;
    list.querySelectorAll('[data-caption-default]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api.setDefaultContentCaption(button.dataset.captionDefault);
          await loadPreviewCaptions(overlay, content);
        } catch (error) {
          showToast(error?.message || t('content.caption_error'), 'error');
          if (button.isConnected) button.disabled = false;
        }
      });
    });
    list.querySelectorAll('[data-caption-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        const accepted = await requestConfirmation({
          title: t('content.caption_delete'),
          message: t('content.caption_delete_confirm'),
          confirmLabel: t('content.caption_delete'),
          destructive: true,
        });
        if (!accepted) return;
        button.disabled = true;
        try {
          await api.deleteContentCaption(button.dataset.captionDelete);
          showToast(t('content.caption_deleted'), 'success');
          await loadPreviewCaptions(overlay, content);
        } catch (error) {
          showToast(error?.message || t('content.caption_error'), 'error');
          if (button.isConnected) button.disabled = false;
        }
      });
    });
  } catch (error) {
    list.innerHTML = `<p class="content-readiness-reason">${esc(error?.message || t('content.caption_error'))}</p>`;
  }
}

function thumbnailProvenanceLabel(provenance) {
  const value = String(provenance || '');
  if (value.startsWith('custom_upload:')) return t('content.thumbnail_source_custom');
  if (value.startsWith('video_timestamp:')) return t('content.thumbnail_source_video');
  if (value.startsWith('image_crop:')) return t('content.thumbnail_source_image');
  return t('content.thumbnail_source_automatic');
}

function showPreview(content, { focusThumbnail = false } = {}) {
  const isYoutube = content.mime_type === 'video/youtube';
  const isVideo = !isYoutube && content.mime_type?.startsWith('video/');
  const isAudio = content.mime_type?.startsWith('audio/');
  const isPdf = content.mime_type === 'application/pdf' || /pdf/.test(content.mime_type || '');
  const isImage = content.mime_type?.startsWith('image/');
  const isWeb = content.mime_type?.startsWith('text/html') || (!!content.remote_url && !isVideo && !isAudio && !isImage && !isYoutube);
  const src = content.remote_url || content.file_url || `/api/content/${content.id}/file`;
  const thumbnail = content.thumbnail_url || content.thumbnail_path;
  const youtubeSrc = (() => {
    try {
      const url = new URL(src);
      if (!url.searchParams.has('mute')) url.searchParams.set('mute', '1');
      if (!url.searchParams.has('enablejsapi')) url.searchParams.set('enablejsapi', '1');
      if (!url.searchParams.has('origin')) url.searchParams.set('origin', window.location.origin);
      return url.toString();
    } catch {
      return src;
    }
  })();
  const viewer = isYoutube
    ? `<iframe src="${esc(youtubeSrc)}" title="${esc(t('content.youtube_preview_title', { name: content.filename }))}" allow="encrypted-media; fullscreen" allowfullscreen></iframe>`
    : isVideo
      ? `<video src="${esc(src)}" controls preload="metadata"></video>`
      : isAudio
        ? `<div class="media-preview-audio"><span aria-hidden="true">♪</span><audio src="${esc(src)}" controls preload="metadata"></audio></div>`
        : isPdf
          ? `<object data="${esc(src)}" type="application/pdf" aria-label="${esc(t('content.document_preview_title', { name: content.filename }))}">
               <p>${t('content.preview_unavailable')} <a href="${esc(src)}" target="_blank" rel="noopener">${t('content.open_document')}</a></p>
             </object>`
          : isDocMime(content.mime_type)
            ? thumbnail
              ? `<img src="${esc(thumbnail)}" alt="${esc(t('content.document_preview_title', { name: content.filename }))}">`
              : `<div class="media-preview-unavailable"><span aria-hidden="true">${docGlyph(content.mime_type)}</span><p>${t('content.preview_processing')}</p></div>`
            : isWeb
              ? `<iframe src="${esc(src)}" title="${esc(t('content.web_preview_title', { name: content.filename }))}" sandbox="" referrerpolicy="no-referrer"></iframe>`
              : `<img src="${esc(src)}" alt="${esc(content.filename)}">`;
  const readiness = getContentReadiness(content);
  const restoreFocus = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay media-library-dialog-overlay';
  overlay.innerHTML = `
    <section class="media-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="mediaPreviewTitle" tabindex="-1">
      <header class="media-preview-header">
        <div>
          <h2 id="mediaPreviewTitle">${t('content.preview_title')}: ${esc(content.filename)}</h2>
          <p>${esc(contentTypeLabel(content))}</p>
        </div>
        <button type="button" class="btn-icon" data-close-dialog aria-label="${t('common.close')}">&times;</button>
      </header>
      <div class="media-preview-layout">
        <div class="media-preview-stage" aria-busy="${readiness.state === 'preparing'}">
          ${viewer}
        </div>
        <aside class="media-preview-details" aria-label="${t('content.details_title')}">
          <h3>${t('content.details_title')}</h3>
          ${readinessMarkup(content)}
          <dl>
            <div><dt>${t('content.label_mime_type')}</dt><dd>${esc(content.mime_type || t('content.unknown'))}</dd></div>
            <div><dt>${t('content.file_size')}</dt><dd>${formatFileSize(content.file_size)}</dd></div>
            ${content.width && content.height ? `<div><dt>${t('content.dimensions')}</dt><dd>${esc(content.width)}×${esc(content.height)}</dd></div>` : ''}
            ${content.duration_sec ? `<div><dt>${t('content.duration')}</dt><dd>${esc(Math.round(content.duration_sec))} ${t('content.seconds_short')}</dd></div>` : ''}
            <div><dt>${t('content.owner')}</dt><dd>${esc(content.visibility?.owner_name || t('content.owner_unknown'))}</dd></div>
            <div><dt>${t('content.version_label')}</dt><dd>${esc(content.version || 1)}</dd></div>
            <div><dt>${t('content.source_label')}</dt><dd>${esc(content.media?.source_type || (content.filepath ? t('content.filter_source_local') : t('content.filter_source_remote')))}</dd></div>
            ${content.media?.video_codec || content.media?.audio_codec ? `<div><dt>${t('content.codec_label')}</dt><dd>${esc([content.media.video_codec, content.media.audio_codec].filter(Boolean).join(' / '))}</dd></div>` : ''}
            <div><dt>${t('content.retention_label')}</dt><dd>${content.original_filepath ? t('content.retention_original') : t('content.retention_canonical')}</dd></div>
            <div><dt>${t('content.lifecycle_created')}</dt><dd>${esc(new Date(Number(content.created_at) * 1000).toLocaleString())}</dd></div>
            ${content.updated_at ? `<div><dt>${t('content.lifecycle_updated')}</dt><dd>${esc(new Date(Number(content.updated_at) * 1000).toLocaleString())}</dd></div>` : ''}
            ${content.visibility?.archived_at ? `<div><dt>${t('content.lifecycle_archived')}</dt><dd>${esc(new Date(Number(content.visibility.archived_at) * 1000).toLocaleString())}</dd></div>` : ''}
            ${contentTags(content).length ? `<div><dt>${t('content.tags')}</dt><dd>${contentTags(content).map(esc).join(', ')}</dd></div>` : ''}
            ${content.duplicate_count ? `<div><dt>${t('content.duplicates')}</dt><dd class="content-duplicate-warning">${t('content.duplicate_warning', { count: content.duplicate_count })}</dd></div>` : ''}
          </dl>
          <p class="content-field-hint">${readiness.state === 'ready' ? t('content.classroom_ready_server') : readiness.state === 'preparing' ? t('content.classroom_preparing') : t('content.classroom_not_ready')}</p>
          ${content.permissions?.can_edit && content.filepath ? `
            <section class="content-thumbnail-studio" data-thumbnail-studio-panel>
              <div>
                <h3>${t('content.thumbnail_studio_title')}</h3>
                <p class="content-field-hint">${t('content.thumbnail_studio_desc')}</p>
              </div>
              <p class="content-thumbnail-provenance">${t('content.thumbnail_generation', {
                generation: Number(content.media?.thumbnail_generation) || 0,
                source: thumbnailProvenanceLabel(content.media?.thumbnail_provenance),
              })}</p>
              <label class="form-group">
                <span>${t('content.thumbnail_crop_position')}</span>
                <select class="input" data-thumbnail-position>
                  <option value="center">${t('content.thumbnail_position_center')}</option>
                  <option value="top">${t('content.thumbnail_position_top')}</option>
                  <option value="bottom">${t('content.thumbnail_position_bottom')}</option>
                  <option value="left">${t('content.thumbnail_position_left')}</option>
                  <option value="right">${t('content.thumbnail_position_right')}</option>
                  <option value="entropy">${t('content.thumbnail_position_entropy')}</option>
                  <option value="attention">${t('content.thumbnail_position_attention')}</option>
                </select>
              </label>
              ${isVideo ? `
                <label class="form-group">
                  <span>${t('content.thumbnail_video_time')}</span>
                  <input class="input" type="number" min="0" ${Number(content.duration_sec) > 0 ? `max="${esc(content.duration_sec)}"` : ''} step="0.1" value="0" data-thumbnail-timestamp>
                  <small class="content-field-hint">${t('content.thumbnail_video_time_hint')}</small>
                </label>
              ` : ''}
              ${isVideo || isImage ? `
                <button type="button" class="btn btn-secondary" data-thumbnail-generate>
                  ${content.thumbnail_path ? t('content.thumbnail_regenerate') : t('content.thumbnail_generate')}
                </button>
              ` : ''}
              <form data-thumbnail-upload>
                <label class="form-group">
                  <span>${t('content.thumbnail_custom_file')}</span>
                  <input class="input" type="file" name="poster" accept="image/jpeg,image/png,image/webp" required>
                  <small class="content-field-hint">${t('content.thumbnail_custom_hint')}</small>
                </label>
                <button type="submit" class="btn btn-secondary">${t('content.thumbnail_upload')}</button>
              </form>
            </section>
          ` : ''}
          ${isVideo ? `
            <section class="content-caption-manager" data-caption-manager>
              <h3>${t('content.caption_title')}</h3>
              <div data-caption-list aria-live="polite"><p class="content-field-hint">${t('common.loading')}</p></div>
              ${content.permissions?.can_edit ? `
                <form data-caption-upload>
                  <label class="form-group">
                    <span>${t('content.caption_file')}</span>
                    <input class="input" type="file" name="caption_file" accept=".vtt,.srt,text/vtt,application/x-subrip" required>
                  </label>
                  <div class="content-caption-fields">
                    <label class="form-group">
                      <span>${t('content.caption_language')}</span>
                      <input class="input" name="language_code" value="en-US" maxlength="35" required>
                    </label>
                    <label class="form-group">
                      <span>${t('content.caption_label')}</span>
                      <input class="input" name="label" value="${esc(t('content.caption_english'))}" maxlength="80" required>
                    </label>
                  </div>
                  <label class="content-caption-default-control">
                    <input type="checkbox" name="is_default" checked>
                    <span>${t('content.caption_default_control')}</span>
                  </label>
                  <button type="submit" class="btn btn-secondary">${t('content.caption_upload')}</button>
                </form>
              ` : ''}
            </section>
          ` : ''}
        </aside>
      </div>
      <footer class="media-preview-footer">
        ${readiness.sendEnabled ? `<button type="button" class="btn btn-primary" data-preview-send>${t('content.send_btn')}</button>` : ''}
        <button type="button" class="btn btn-secondary" data-close-dialog>${t('common.close')}</button>
      </footer>
    </section>
  `;
  const close = mountTransientDialog(
    overlay,
    restoreFocus,
    () => revokePreviewCaptionUrls(overlay),
  );
  const thumbnailStudio = overlay.querySelector('[data-thumbnail-studio-panel]');
  if (thumbnailStudio) {
    const position = thumbnailStudio.querySelector('[data-thumbnail-position]');
    const timestamp = thumbnailStudio.querySelector('[data-thumbnail-timestamp]');
    const generate = thumbnailStudio.querySelector('[data-thumbnail-generate]');
    const upload = thumbnailStudio.querySelector('[data-thumbnail-upload]');
    const setBusy = busy => {
      thumbnailStudio.querySelectorAll('button, input, select').forEach(control => {
        control.disabled = busy;
      });
      thumbnailStudio.setAttribute('aria-busy', String(busy));
    };
    generate?.addEventListener('click', async () => {
      if (timestamp && !timestamp.reportValidity()) return;
      setBusy(true);
      try {
        await api.updateContentThumbnail(content.id, {
          timestampSeconds: Number(timestamp?.value || 0),
          position: position.value,
        });
        showToast(t('content.thumbnail_queued'), 'success');
      } catch (error) {
        showToast(friendlyErrorMessage(error, 'content.thumbnail_failed'), 'error');
      } finally {
        if (thumbnailStudio.isConnected) setBusy(false);
      }
    });
    upload?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const file = form.elements.poster?.files?.[0];
      if (!file || !form.reportValidity()) return;
      setBusy(true);
      try {
        await api.updateContentThumbnail(content.id, {
          file,
          timestampSeconds: Number(timestamp?.value || 0),
          position: position.value,
        });
        form.elements.poster.value = '';
        showToast(t('content.thumbnail_upload_queued'), 'success');
      } catch (error) {
        showToast(friendlyErrorMessage(error, 'content.thumbnail_failed'), 'error');
      } finally {
        if (thumbnailStudio.isConnected) setBusy(false);
      }
    });
    if (focusThumbnail) {
      queueMicrotask(() => (
        timestamp
        || thumbnailStudio.querySelector('input[name="poster"]')
        || position
      )?.focus());
    }
  }
  if (isVideo) {
    loadPreviewCaptions(overlay, content);
    overlay.querySelector('[data-caption-upload]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const file = form.elements.caption_file?.files?.[0];
      if (!file || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await api.uploadContentCaption(content.id, file, {
          language_code: form.elements.language_code.value.trim(),
          label: form.elements.label.value.trim(),
          kind: 'captions',
          is_default: form.elements.is_default.checked,
        });
        form.elements.caption_file.value = '';
        showToast(t('content.caption_uploaded'), 'success');
        await loadPreviewCaptions(overlay, content);
      } catch (error) {
        showToast(error?.message || t('content.caption_error'), 'error');
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    });
  }
  overlay.querySelector('[data-preview-send]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const route = await chooseContentTargets(content.filename || t('content.type_video'));
      if (route) await sendContentToTargets(content, route);
    } finally {
      if (event.currentTarget.isConnected) event.currentTarget.disabled = false;
    }
  });
  return close;
}

function showUsageConflict(usage = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const playlists = Array.isArray(usage.playlists) ? usage.playlists : [];
  const assignments = Array.isArray(usage.assignments) ? usage.assignments : [];
  const references = Array.isArray(usage.references) ? usage.references : [];
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="usageConflictTitle">
      <div class="modal-header">
        <h3 id="usageConflictTitle">${t('content.in_use_title')}</h3>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body">
        <p>${t('content.in_use_desc', { count: usage.usage_count || playlists.length + assignments.length })}</p>
        ${playlists.length ? `<h4>${t('content.usage_playlists')}</h4><ul>${playlists.map(item => `<li>${esc(item.name || item.id)}</li>`).join('')}</ul>` : ''}
        ${assignments.length ? `<h4>${t('content.usage_displays')}</h4><ul>${assignments.map(item => `<li>${esc(item.device_name || item.device_id || item.id)}</li>`).join('')}</ul>` : ''}
        ${references.length ? `<h4>${t('content.usage_routes')}</h4><ul>${references.map(item => `<li>${esc(item.type)}: ${esc(item.name || item.id)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="modal-footer"><button class="btn btn-primary" data-close-modal>${t('common.close')}</button></div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function showTransferModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="transferContentTitle">
      <div class="modal-header">
        <div><h3 id="transferContentTitle">${t('content.transfer_title')}</h3><p class="content-modal-subtitle">${esc(contentItem.filename)}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-transfer-body><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>${t('common.cancel')}</button>
        <button class="btn btn-primary" data-transfer-save disabled>${t('content.transfer_save')}</button>
      </div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const body = overlay.querySelector('[data-transfer-body]');
  const save = overlay.querySelector('[data-transfer-save]');
  try {
    const members = await api.getWorkspaceMembers(contentItem.workspace_id);
    const eligible = members.filter(member => member.user_id && member.user_id !== contentItem.user_id);
    if (!eligible.length) {
      body.innerHTML = `<div class="empty-state"><h3>${t('content.transfer_empty')}</h3><p>${t('content.transfer_empty_desc')}</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="form-group">
        <label for="transferOwnerId">${t('content.transfer_owner_label')}</label>
        <select id="transferOwnerId" class="input">
          <option value="">${t('content.transfer_owner_placeholder')}</option>
          ${eligible.map(member => `<option value="${esc(member.user_id)}">${esc(member.name || member.email)}${member.name && member.email ? ` — ${esc(member.email)}` : ''}</option>`).join('')}
        </select>
        <p class="content-field-hint">${t('content.transfer_warning')}</p>
      </div>`;
    const select = body.querySelector('#transferOwnerId');
    select.onchange = () => { save.disabled = !select.value; };
    save.onclick = async () => {
      if (!select.value) return;
      save.disabled = true;
      try {
        await api.transferContent(contentItem.id, select.value);
        overlay.remove();
        showToast(t('content.toast.transferred'), 'success');
        if (onSave) onSave();
      } catch (err) {
        showToast(friendlyErrorMessage(err, 'content.transfer_failed'), 'error');
        save.disabled = false;
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${t('content.transfer_failed')}</h3><p>${friendlyErrorMessage(err, 'content.transfer_failed')}</p></div>`;
  }
}

async function showTemplateAssignmentsModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="templateAssignmentsTitle">
      <div class="modal-header">
        <div><h3 id="templateAssignmentsTitle">${t('content.template_assignments_title')}</h3><p class="content-modal-subtitle">${esc(contentItem.filename)}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-template-body><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>${t('common.cancel')}</button>
        <button class="btn btn-primary" data-template-save disabled>${t('content.template_assignments_save')}</button>
      </div>
    </div>`;
  overlay.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => overlay.remove(); });
  overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const body = overlay.querySelector('[data-template-body]');
  const save = overlay.querySelector('[data-template-save]');
  try {
    const [me, assignments] = await Promise.all([
      api.getMe(),
      api.getTemplateAssignments(contentItem.id),
    ]);
    const selected = new Set(assignments.workspace_ids || []);
    const workspaces = me.accessible_workspaces || [];
    body.innerHTML = workspaces.length
      ? `<p class="content-field-hint">${t('content.template_assignments_desc')}</p>
         <div class="content-template-workspaces">${workspaces.map(workspace => `
           <label class="content-template-workspace">
             <input type="checkbox" value="${esc(workspace.id)}" ${selected.has(workspace.id) ? 'checked' : ''}>
             <span><strong>${esc(workspace.name)}</strong><small>${esc(workspace.organization_name || '')}</small></span>
           </label>`).join('')}</div>`
      : `<div class="empty-state"><h3>${t('content.template_assignments_empty')}</h3></div>`;
    save.disabled = !workspaces.length;
    save.onclick = async () => {
      save.disabled = true;
      const workspaceIds = [...body.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
      try {
        await api.updateTemplateAssignments(contentItem.id, workspaceIds);
        overlay.remove();
        showToast(t('content.toast.template_assignments_saved'), 'success');
        if (onSave) onSave();
      } catch (err) {
        if (err.code === 'CONTENT_IN_USE') showUsageConflict(err.details);
        else showToast(friendlyErrorMessage(err, 'content.template_assignments_failed'), 'error');
        save.disabled = false;
      }
    };
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>${t('content.template_assignments_failed')}</h3><p>${friendlyErrorMessage(err, 'content.template_assignments_failed')}</p></div>`;
  }
}

async function showPublicationReviewModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal content-governance-modal" role="dialog" aria-modal="true" aria-labelledby="publicationReviewTitle">
      <div class="modal-header">
        <div><h3 id="publicationReviewTitle">${t('content.review_title')}</h3><p class="content-modal-subtitle">${t('content.review_desc')}</p></div>
        <button class="btn-icon" data-close-modal aria-label="${t('common.close')}">&times;</button>
      </div>
      <div class="modal-body" data-review-list><div class="empty-state"><h3>${t('common.loading')}</h3></div></div>
    </div>`;
  overlay.querySelector('[data-close-modal]').onclick = () => overlay.remove();
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  const list = overlay.querySelector('[data-review-list]');
  try {
    const requests = await api.getPublicationRequests();
    if (!requests.length) {
      list.innerHTML = `<div class="empty-state"><h3>${t('content.review_empty')}</h3><p>${t('content.review_empty_desc')}</p></div>`;
      return;
    }
    list.innerHTML = requests.map(request => `
      <article class="content-review-row" data-request-id="${esc(request.id)}">
        <div>
          <strong>${esc(request.filename)}</strong>
          <div class="content-governance-meta">${t('content.owner')}: ${esc(request.owner_name || request.owner_user_id || t('content.owner_unknown'))}</div>
        </div>
        <div class="content-review-actions">
          <button class="btn btn-danger btn-sm" data-review-decision="rejected">${t('content.reject')}</button>
          <button class="btn btn-primary btn-sm" data-review-decision="approved">${t('content.approve')}</button>
        </div>
      </article>`).join('');
    list.onclick = async (event) => {
      const button = event.target.closest('[data-review-decision]');
      if (!button) return;
      const row = button.closest('[data-request-id]');
      const decision = button.dataset.reviewDecision;
      const reason = await requestText({
        title: t('content.review_reason_title'),
        label: t('content.review_reason_prompt'),
        confirmLabel: t('content.continue'),
        required: false,
      });
      if (reason === null) return;
      row.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        await api.reviewPublicationRequest(row.dataset.requestId, decision, reason.trim());
        row.remove();
        showToast(decision === 'approved' ? t('content.toast.approved') : t('content.toast.rejected'), 'success');
        if (!list.querySelector('[data-request-id]')) list.innerHTML = `<div class="empty-state"><h3>${t('content.review_empty')}</h3></div>`;
        loadContent();
      } catch (err) {
        showToast(friendlyErrorMessage(err, 'content.error_review_failed'), 'error');
        row.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    };
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><h3>${t('content.review_failed')}</h3><p>${friendlyErrorMessage(err, 'content.error_review_failed')}</p></div>`;
  }
}

// Build a "Parent / Child / Leaf" path for a folder so the move-to dropdown is unambiguous
// when two folders share a name in different branches.
function folderPath(folder, all) {
  const byId = new Map(all.map(f => [f.id, f]));
  const parts = [folder.name];
  let cursor = folder;
  while (cursor.parent_id && byId.has(cursor.parent_id)) {
    cursor = byId.get(cursor.parent_id);
    parts.unshift(cursor.name);
  }
  return parts.join(' / ');
}
