// inspector.js — the slide-in detail panel for a selected stage display (Task 4.4).
//
// Shows the display's name + geometry, a "Partition into regions" action that
// creates/loads a layout for the display and mounts the region editor, and the
// per-display Whiteboard / Share-my-screen-here actions.
//
// NOTE: the player protocol (player-protocol.js) is FROZEN and has no command to
// set a display-level fit or to mute/unmute a region's audio — the deployed TVs
// never react to such an event. The former display-level "fit" select and
// per-region "audio" toggle therefore controlled nothing, so they were removed.
// Real per-region fit + content assignment persist inside the region editor.
//
// GUARD: a display that is a member of a video wall cannot be partitioned — the
// player ignores per-display zones for wall members — so Partition is disabled
// and a clear message is shown. The caller (media-control.js) knows wall
// membership (it already builds the wallMemberIds set) and passes isWallMember.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { COMMAND_TYPES } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import { renderRegionEditor } from './region-editor.js';
import * as displayState from '../../services/display-state.js';
import {
  identifyDevice,
  requestScreenshot,
  sendCommand,
  startRemote,
  stopRemote,
  getNodeStatus,
  on as socketOn,
  off as socketOff,
} from '../../socket.js';
import * as engine from '../../services/screen-share-engine.js';

function geometryLabel(display) {
  if (display.width && display.height) return `${display.width} × ${display.height}`;
  return t('mc.insp.unknown_res');
}

function assetCacheLabel(display) {
  return display?.asset_cache?.mode === 'local'
    ? t('mc.insp.cache_local')
    : t('mc.insp.cache_direct');
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatClock(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '--';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatAge(ms) {
  if (!Number.isFinite(Number(ms))) return '--';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function previewStatusLabel(ageMs, online) {
  if (!online) return 'Offline';
  if (!Number.isFinite(Number(ageMs))) return 'Preview unavailable';
  if (ageMs > 10000) return 'Preview stale';
  if (ageMs > 5000) return 'Preview stale';
  return `Live, updated ${formatAge(ageMs)} ago`;
}

function wallStateLabel(ageMs, commandState, online) {
  if (!online) return 'Offline';
  if (commandState?.status === 'pending') return 'Out of Sync';
  if (commandState?.status === 'failed' || commandState?.status === 'timeout') return 'Out of Sync';
  if (!Number.isFinite(Number(ageMs))) return 'Online, preview pending';
  if (ageMs > 10000) return 'Online, preview stale';
  if (ageMs > 5000) return 'Online, preview stale';
  return 'Synced';
}

function formatTransportConnection(node) {
  const path = String(node?.server_path || node?.network?.server_path || '').toLowerCase();
  if (path === 'lan' || path === 'ethernet') return 'LAN';
  if (path === 'tailnet' || path === 'tailscale') return 'Tailnet';
  if (path === 'cloudflare') return 'Cloudflare';
  return 'Unknown';
}

function formatP3Link(node) {
  const transport = String(node?.network?.primary_transport || node?.network?.primaryTransport || '').toLowerCase();
  if (transport === 'ethernet') return 'Ethernet';
  if (transport === 'wifi') return 'Wi-Fi';
  return 'Unknown';
}

function commandLabel(type) {
  const labels = {
    reboot: t('mc.insp.cmd_reboot'),
    shutdown: t('mc.insp.cmd_shutdown'),
    update: t('mc.insp.cmd_update'),
    [COMMAND_TYPES.SCREEN_OFF]: t('mc.insp.cmd_screen_off'),
    [COMMAND_TYPES.SCREEN_ON]: t('mc.insp.cmd_screen_on'),
    [COMMAND_TYPES.LAUNCH]: t('mc.insp.cmd_launch'),
  };
  return labels[type] || type;
}

function sendCommandWithToast(deviceId, type, payload = {}) {
  const label = commandLabel(type);
  sendCommand(deviceId, type, payload, (ack) => {
    if (ack?.delivered) showToast(t('mc.insp.cmd_sent', { cmd: label }), 'success');
    else if (ack?.queued) showToast(t('mc.insp.cmd_queued', { cmd: label }), 'warning');
    else showToast(t('mc.insp.cmd_failed', { cmd: label }), 'error');
  });
}

function promptTextDialog({ title, label, value = '', submitLabel }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'mc-dialog mc-insp-prompt';
  dlg.setAttribute('aria-labelledby', 'mcInspPromptTitle');
  dlg.innerHTML = `
    <form method="dialog" class="mc-dialog-card">
      <h3 id="mcInspPromptTitle" class="mc-dialog-title">${esc(title)}</h3>
      <label class="mc-insp-field"><span>${esc(label)}</span>
        <input class="input mc-insp-input" type="text" autocomplete="off" value="${esc(value)}">
      </label>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-cancel>${esc(t('mc.insp.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-submit>${esc(submitLabel || t('mc.insp.save'))}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('input');
  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(val);
    };
    dlg.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    dlg.querySelector('[data-submit]').addEventListener('click', () => finish((input.value || '').trim()));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish((input.value || '').trim()); } });
    dlg.showModal();
    input.focus();
    input.select();
  });
}

async function loadInspectorData(deviceId) {
  const [device, contentRes, playlistsRes, layoutsRes] = await Promise.all([
    api.getDevice(deviceId).catch(() => null),
    api.getContent().catch(() => []),
    api.getPlaylists().catch(() => []),
    listLayouts().catch(() => []),
  ]);
  const content = Array.isArray(contentRes) ? contentRes : (contentRes && Array.isArray(contentRes.content) ? contentRes.content : []);
  const playlists = Array.isArray(playlistsRes) ? playlistsRes : (playlistsRes && Array.isArray(playlistsRes.playlists) ? playlistsRes.playlists : []);
  const layouts = Array.isArray(layoutsRes) ? layoutsRes : [];
  return { device, content, playlists, layouts };
}

async function listLayouts() {
  if (api.layouts && typeof api.layouts.list === 'function') {
    return api.layouts.list();
  }

  // Defensive fallback for mixed browser caches: a freshly-loaded inspector.js
  // can run with an older cached api.js that does not expose layouts.list yet.
  const token = localStorage.getItem('token');
  const res = await fetch('/api/layouts', {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error('Could not load layouts');
  return res.json();
}

function optionsHtml(items, selectedId, emptyLabel, labelFn) {
  const opts = [`<option value="">${esc(emptyLabel)}</option>`];
  for (const item of items || []) {
    const name = labelFn ? labelFn(item) : (item.name || item.filename || item.id);
    opts.push(`<option value="${esc(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${esc(name)}</option>`);
  }
  return opts.join('');
}

/**
 * Render the inspector into `container` (the #mc-inspector <aside>) and reveal it.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object} opts.display          the selected display state row
 * @param {object} [opts.wall]           the selected display's wall, if any
 * @param {boolean} [opts.isWallMember]  true → Partition disabled (wall member)
 * @param {()=>void} [opts.onClose]      called when the panel is dismissed
 */
export async function renderInspector(container, { display, wall = null, isWallMember = false, onClose, onDeviceChanged } = {}) {
  if (!container || !display) return;
  container.hidden = false;
  const renderToken = Symbol('inspector-render');
  container.__renderToken = renderToken;
  if (typeof container.__classroomMonitorCleanup === 'function') {
    try { container.__classroomMonitorCleanup(); } catch (_) {}
    container.__classroomMonitorCleanup = null;
  }

  const [inspectorData, systemVersion] = await Promise.all([
    loadInspectorData(display.id),
    api.getSystemVersion().catch(() => null),
  ]);
  if (container.__renderToken !== renderToken) return;
  const device = { ...display, ...(inspectorData.device || {}) };
  const classroomWall = wall && /classroom\s*1/i.test(String(wall.name || ''));
  const classroomPreviewId = classroomWall
    ? (wall.leader_device_id || (Array.isArray(wall.devices) && wall.devices[0] && wall.devices[0].device_id) || device.id)
    : null;
  const latestTelemetry = device.telemetry?.[0] || {};
  const content = inspectorData.content || [];
  const playlists = inspectorData.playlists || [];
  const layouts = inspectorData.layouts || [];
  const status = device.status || (device.online ? 'online' : 'offline');
  const playerType = device.android_version && !device.android_version.startsWith('Web/')
    ? (device.android_version || '--')
    : t('mc.insp.web_player');

  container.innerHTML = `
    <div class="mc-insp">
      <header class="mc-insp-head">
        <div>
          <h2 class="mc-insp-title" data-insp-title>${esc(device.name)}</h2>
          <p class="mc-insp-geo">${esc(geometryLabel(device))}</p>
        </div>
        <button type="button" class="mc-insp-close" data-insp-close aria-label="${esc(t('mc.insp.close'))}">×</button>
      </header>

      <section class="mc-insp-section mc-insp-top-actions">
        <button type="button" class="mc-btn mc-btn-secondary" data-insp-rename>${esc(t('mc.insp.rename'))}</button>
        <button type="button" class="mc-btn mc-btn-secondary" data-insp-screenshot>${esc(t('mc.insp.screenshot'))}</button>
        <button type="button" class="mc-btn-danger-sm" data-insp-remove>${esc(t('mc.insp.remove'))}</button>
      </section>

      <section class="mc-insp-section">
        ${isWallMember
          ? `<p class="mc-insp-walled">${esc(t('mc.insp.walled'))}</p>`
          : `<button type="button" class="mc-btn mc-btn-primary mc-insp-partition" data-insp-partition>${esc(t('mc.insp.partition'))}</button>`}
      </section>

      <section class="mc-insp-section mc-insp-actions" id="mc-insp-actions">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.actions'))}</h3>
        <div class="mc-insp-action-row">
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-wb-start>${esc(t('mc.insp.wb_start'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-ss-start>${esc(t('mc.insp.ss_start'))}</button>
          <button type="button" class="mc-btn mc-btn-danger-sm" data-insp-ss-stop hidden>${esc(t('mc.insp.ss_stop'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-calibrate>${esc(t('mc.insp.calibrate'))}</button>
        </div>
        <a class="mc-insp-link" href="#/device/${esc(device.id)}">${esc(t('mc.insp.full_settings'))}</a>
      </section>

      <section class="mc-insp-section">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.device_info'))}</h3>
        <div class="mc-insp-info-grid">
          <p class="mc-insp-kv"><span>${esc(t('mc.insp.status'))}</span><strong>${esc(status)}</strong></p>
          <p class="mc-insp-kv"><span>${esc(t('mc.insp.ip'))}</span><strong>${esc(device.ip_address || '--')}</strong></p>
          <p class="mc-insp-kv"><span>${esc(t('mc.insp.player_type'))}</span><strong>${esc(playerType)}</strong></p>
          <p class="mc-insp-kv"><span>${esc(t('mc.insp.uptime'))}</span><strong>${esc(formatUptime(latestTelemetry.uptime_seconds))}</strong></p>
          <p class="mc-insp-kv"><span>${esc(t('mc.insp.resolution'))}</span><strong>${esc(geometryLabel(device))}</strong></p>
          <p class="mc-insp-kv"><span>Server</span><strong>${esc(systemVersion?.api_version || '--')} · ${esc(systemVersion?.git_commit?.slice(0, 8) || '--')}</strong></p>
          <p class="mc-insp-kv"><span>Frontend / Player</span><strong>${esc(systemVersion?.frontend_bundle_hash || '--')} / ${esc(systemVersion?.player_bundle_hash || '--')}</strong></p>
          <p class="mc-insp-kv"><span>Command Contract</span><strong>v${esc(systemVersion?.command_contract_version || '--')}</strong></p>
        </div>
      </section>

      ${classroomWall ? `
      <section class="mc-insp-section mc-insp-classroom-wall" data-classroom-monitor-section>
        <h3 class="mc-insp-subhead">Classroom 1 Video Wall</h3>
        <div data-classroom-monitor-host></div>
      </section>` : ''}

      <section class="mc-insp-section mc-insp-playback">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.playback_setup'))}</h3>
        <label class="mc-insp-field"><span>${esc(t('mc.insp.layout'))}</span>
          <select class="input mc-insp-input" data-insp-layout>
            ${optionsHtml(layouts, device.layout_id || '', t('mc.insp.layout_fullscreen'), l => t(l.is_template ? 'mc.insp.layout_template_label' : 'mc.insp.layout_label', { name: l.name, n: l.zones?.length || 0 }))}
          </select>
        </label>
        <button type="button" class="mc-btn mc-btn-secondary" data-insp-apply-layout>${esc(t('mc.insp.apply_layout'))}</button>
        <label class="mc-insp-field"><span>${esc(t('mc.insp.playlist'))}</span>
          <select class="input mc-insp-input" data-insp-playlist>
            ${optionsHtml(playlists, device.playlist_id || '', t('mc.insp.no_playlist'), p => p.is_auto_generated ? t('mc.insp.playlist_auto_label', { name: p.name, n: p.item_count || 0 }) : t('mc.insp.playlist_label', { name: p.name, n: p.item_count || 0 }))}
          </select>
        </label>
        <button type="button" class="mc-btn mc-btn-secondary" data-insp-add-content>${esc(t('mc.insp.add_content'))}</button>
      </section>

      <section class="mc-insp-section mc-insp-settings">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.settings'))}</h3>
        <label class="mc-insp-field"><span>${esc(t('mc.insp.orientation'))}</span>
          <select class="input mc-insp-input" data-insp-orientation>
            <option value="landscape" ${(device.orientation || 'landscape') === 'landscape' ? 'selected' : ''}>${esc(t('mc.insp.orientation_landscape'))}</option>
            <option value="portrait" ${device.orientation === 'portrait' ? 'selected' : ''}>${esc(t('mc.insp.orientation_portrait'))}</option>
            <option value="landscape-flipped" ${device.orientation === 'landscape-flipped' ? 'selected' : ''}>${esc(t('mc.insp.orientation_landscape_flipped'))}</option>
            <option value="portrait-flipped" ${device.orientation === 'portrait-flipped' ? 'selected' : ''}>${esc(t('mc.insp.orientation_portrait_flipped'))}</option>
          </select>
        </label>
        <label class="mc-insp-field"><span>${esc(t('mc.insp.default_content'))}</span>
          <select class="input mc-insp-input" data-insp-default-content>
            ${optionsHtml(content, device.default_content_id || '', t('mc.insp.default_content_none'), c => c.filename || c.name || c.id)}
          </select>
        </label>
        <label class="mc-insp-field"><span>${esc(t('mc.insp.notes'))}</span>
          <textarea class="input mc-insp-input mc-insp-notes" rows="3" data-insp-notes placeholder="${esc(t('mc.insp.notes_placeholder'))}">${esc(device.notes || '')}</textarea>
        </label>
        <button type="button" class="mc-btn mc-btn-primary" data-insp-save-settings>${esc(t('mc.insp.save_settings'))}</button>
      </section>

      <section class="mc-insp-section mc-insp-controls">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.device_controls'))}</h3>
        <div class="mc-insp-control-grid">
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-command="reboot">${esc(t('mc.insp.cmd_reboot'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-command="screen_off">${esc(t('mc.insp.cmd_screen_off'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-command="screen_on">${esc(t('mc.insp.cmd_screen_on'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-command="launch">${esc(t('mc.insp.cmd_launch'))}</button>
          <button type="button" class="mc-btn mc-btn-secondary" data-insp-command="update">${esc(t('mc.insp.cmd_update'))}</button>
          <button type="button" class="mc-btn-danger-sm" data-insp-command="shutdown">${esc(t('mc.insp.cmd_shutdown'))}</button>
        </div>
      </section>

      <section class="mc-insp-section">
        <h3 class="mc-insp-subhead">${esc(t('mc.insp.delivery'))}</h3>
        <p class="mc-insp-kv"><span>${esc(t('mc.insp.cache_status'))}</span><strong>${esc(assetCacheLabel(device))}</strong></p>
      </section>

      <section class="mc-insp-section mc-insp-regions" id="mc-insp-regions"></section>
    </div>`;

  const monitorHost = container.querySelector('[data-classroom-monitor-host]');
  const classroomRoomId = 'classroom-1';
  const monitorState = {
    node: getNodeStatus(classroomRoomId),
    command: null,
    commandTimer: null,
    previewDeviceId: classroomPreviewId,
  };
  const monitorMembers = new Set([
    ...(Array.isArray(wall?.devices) ? wall.devices.map((m) => m && m.device_id).filter(Boolean) : []),
    wall && wall.id,
    device.id,
    classroomPreviewId,
  ].filter(Boolean));

  function monitorCommandMatches(data) {
    if (!data || !classroomWall) return false;
    const targetId = data.device_id || data.target_id || data.id || data.wall_id || data.room_id || null;
    if (targetId && monitorMembers.has(String(targetId))) return true;
    if (data.command_id && monitorState.command && monitorState.command.command_id && String(data.command_id) === String(monitorState.command.command_id)) return true;
    return false;
  }

  function monitorCommandState(data, status) {
    const payload = data && typeof data.payload === 'object' ? data.payload : {};
    const action = String(data && (data.action || data.type || payload.action || payload.command || '')).trim();
    const targetId = data && (data.device_id || data.target_id || data.id || classroomPreviewId || device.id || null);
    return {
      command_id: data && (data.command_id || null) || (monitorState.command && monitorState.command.command_id) || null,
      action: action || (monitorState.command && monitorState.command.action) || null,
      label: commandLabel(action || (monitorState.command && monitorState.command.action) || ''),
      status: status || (data && data.status) || 'pending',
      error: (data && data.error) || null,
      target_id: targetId || null,
      target_type: (data && data.target_type) || (targetId ? 'display' : null),
      sent_at: (data && data.sent_at) || (monitorState.command && monitorState.command.sent_at) || Date.now(),
      ack_at: status && status !== 'pending' ? Date.now() : null,
      state: data && data.state ? data.state : null,
    };
  }

  function renderClassroomMonitor() {
    if (!monitorHost || !classroomWall || container.__renderToken !== renderToken) return;
    const live = displayState.get(monitorState.previewDeviceId) || displayState.get(device.id) || device;
    const telemetry = {
      ...(latestTelemetry || {}),
      ...(live && live.telemetry && typeof live.telemetry === 'object' ? live.telemetry : {}),
    };
    const node = getNodeStatus(classroomRoomId) || monitorState.node || null;
    const online = live?.online !== false;
    const previewAgeMs = Number.isFinite(Number(telemetry.preview_age_ms))
      ? Number(telemetry.preview_age_ms)
      : (live?.screenshot_at ? Math.max(0, (Date.now() / 1000 - Number(live.screenshot_at)) * 1000) : NaN);
    const mediaTitle = telemetry.media_title || live?.now_playing?.label || live?.name || device.name || '--';
    const mediaType = telemetry.media_type || live?.content_type || live?.now_playing?.kind || 'unknown';
    const playback = telemetry.playback || telemetry.status || live?.render_state || (live?.now_playing?.paused ? 'Paused' : 'Playing');
    const position = telemetry.current_time != null || live?.current_time != null
      ? `${formatClock(telemetry.current_time != null ? telemetry.current_time : live.current_time)} / ${formatClock(telemetry.duration != null ? telemetry.duration : live?.duration)}`
      : '--';
    const slide = telemetry.slide_index != null || live?.slide_index != null
      ? `${telemetry.slide_index != null ? telemetry.slide_index : live.slide_index}${(telemetry.slide_total != null || live?.slide_total != null) ? ` / ${telemetry.slide_total != null ? telemetry.slide_total : live.slide_total}` : ''}`
      : '--';
    const command = monitorState.command;
    const commandText = command
      ? `${command.label || command.action || command.type || 'Command'} · ${command.status === 'pending' ? 'Pending' : (command.status === 'timeout' ? 'Timeout' : (command.status === 'failed' ? 'Failed' : 'Success'))}`
      : 'Idle';
    const connection = telemetry.connection || formatTransportConnection(node);
    const p3Link = telemetry.p3_link || formatP3Link(node);
    const cache = telemetry.cache_status || telemetry.sync_status || node?.sync_status || 'Unknown';
    const wallState = telemetry.wall_state || wallStateLabel(previewAgeMs, command, online);
    const previewLabel = previewStatusLabel(previewAgeMs, online);
    const previewSrc = live?.screenshot_url || device.screenshot_url || null;
    const fallback = `
      <div class="mc-wall-preview-fallback">
        <strong>${esc(mediaTitle)}</strong>
        <span>${esc(mediaType)} · ${esc(playback)}</span>
        <span>${esc(slide !== '--' ? `Slide ${slide}` : 'Slide --')}</span>
        <span>${esc(position !== '--' ? `Position ${position}` : 'Position --')}</span>
      </div>`;
    monitorHost.innerHTML = `
      <div class="mc-wall-monitor-shell">
        <div class="mc-wall-preview-card">
          <div class="mc-wall-preview-head">
            <strong>Preview</strong>
            <span>${esc(previewLabel)}</span>
          </div>
          <div class="mc-wall-preview-stage">
            ${previewSrc && online && Number.isFinite(Number(previewAgeMs)) && previewAgeMs <= 10000
              ? `<img class="mc-wall-preview-img" src="${esc(previewSrc)}" alt="${esc(mediaTitle)}" loading="eager">`
              : fallback}
          </div>
        </div>
        <div class="mc-insp-info-grid mc-wall-monitor-grid">
          <p class="mc-insp-kv"><span>Status</span><strong>${esc(online ? 'Online' : 'Offline')}</strong></p>
          <p class="mc-insp-kv"><span>Currently Playing</span><strong>${esc(mediaTitle)}</strong></p>
          <p class="mc-insp-kv"><span>Media Type</span><strong>${esc(mediaType)}</strong></p>
          <p class="mc-insp-kv"><span>Playback</span><strong>${esc(playback)}</strong></p>
          <p class="mc-insp-kv"><span>Position</span><strong>${esc(position)}</strong></p>
          <p class="mc-insp-kv"><span>Slide</span><strong>${esc(slide)}</strong></p>
          <p class="mc-insp-kv"><span>Last Command</span><strong>${esc(commandText)}</strong></p>
          <p class="mc-insp-kv"><span>Connection</span><strong>${esc(connection)}</strong></p>
          <p class="mc-insp-kv"><span>P3 Link</span><strong>${esc(p3Link)}</strong></p>
          <p class="mc-insp-kv"><span>Cache</span><strong>${esc(cache)}</strong></p>
          <p class="mc-insp-kv"><span>Wall State</span><strong>${esc(wallState)}</strong></p>
        </div>
      </div>`;
  }

  if (classroomWall) {
    renderClassroomMonitor();
    const unsubDisplayState = displayState.subscribe(() => {
      renderClassroomMonitor();
    });
    const commandSentHandler = (data) => {
      if (!monitorCommandMatches(data)) return;
      monitorState.command = monitorCommandState(data, 'pending');
      renderClassroomMonitor();
    };
    const commandAckHandler = (data) => {
      if (!monitorCommandMatches(data)) return;
      const ackState = monitorCommandState(data, data && data.status ? String(data.status) : (data && data.ok === false ? 'failed' : 'acked'));
      ackState.status = data && data.status ? String(data.status) : (data && data.ok === false ? 'failed' : 'acked');
      ackState.error = data && data.error ? data.error : null;
      monitorState.command = ackState;
      renderClassroomMonitor();
    };
    const nodeStatusHandler = (data) => {
      const node = getNodeStatus(classroomRoomId) || data || null;
      if (node) {
        monitorState.node = node;
        renderClassroomMonitor();
      }
    };
    socketOn('command-sent', commandSentHandler);
    socketOn('command-ack', commandAckHandler);
    socketOn('node-status', nodeStatusHandler);
    container.__classroomMonitorCleanup = () => {
      try { unsubDisplayState(); } catch (_) {}
      try { socketOff('command-sent', commandSentHandler); } catch (_) {}
      try { socketOff('command-ack', commandAckHandler); } catch (_) {}
      try { socketOff('node-status', nodeStatusHandler); } catch (_) {}
      try {
        if (monitorState.previewDeviceId) stopRemote(monitorState.previewDeviceId);
      } catch (_) {}
      if (monitorState.commandTimer) {
        clearTimeout(monitorState.commandTimer);
        monitorState.commandTimer = null;
      }
    };
    if (monitorState.previewDeviceId) {
      try { requestScreenshot(monitorState.previewDeviceId); } catch (_) {}
      try { startRemote(monitorState.previewDeviceId); } catch (_) {}
    }
  } else {
    container.__classroomMonitorCleanup = null;
  }

  const closeBtn = container.querySelector('[data-insp-close]');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeInspector(container);
      if (typeof onClose === 'function') onClose();
    });
  }

  // ---- Whiteboard + Screen-share per-display actions ----
  //
  // "Turn into Whiteboard": opens the interactive controller for this exact
  // display. The controller starts/replays the display overlay and preserves
  // strokes server-side, so leaving and re-entering does not erase the board.
  //
  // "Share My Screen here": starts a screen-share broadcast via the persistent
  // engine singleton (capture is demand-triggered inside startBroadcastTo).
  // The Stop button tears down just this display's peer connection.

  const wbStartBtn = container.querySelector('[data-insp-wb-start]');
  const ssStartBtn = container.querySelector('[data-insp-ss-start]');
  const ssStopBtn  = container.querySelector('[data-insp-ss-stop]');
  const calibrateBtn = container.querySelector('[data-insp-calibrate]');

  // Sync the Start/Stop button visibility to the engine state for this display.
  function syncSsButtons() {
    const active = engine.isActive() && engine.getActiveTargets().includes(device.id);
    if (ssStartBtn) ssStartBtn.hidden = active;
    if (ssStopBtn)  ssStopBtn.hidden  = !active;
  }
  syncSsButtons();

  // Subscribe to engine changes so the buttons update if the broadcast
  // starts/stops from another surface (chip Stop-all, screen-share view, etc.).
  const unsubEngine = engine.onChange(() => syncSsButtons());
  // Store on container so renderInspector can clean up on subsequent opens.
  if (container.__unsubEngine) { container.__unsubEngine(); }
  container.__unsubEngine = unsubEngine;

  if (wbStartBtn) {
    wbStartBtn.addEventListener('click', () => {
      window.location.hash = `#/smartboard?device=${encodeURIComponent(device.id)}`;
    });
  }

  if (ssStartBtn) {
    ssStartBtn.addEventListener('click', async () => {
      ssStartBtn.disabled = true;
      try {
        await engine.init();
        await engine.startBroadcastTo(device.id);
        syncSsButtons();
      } catch (e) {
        showToast(e?.message || t('mc.insp.ss_failed'), 'error');
      } finally {
        ssStartBtn.disabled = false;
      }
    });
  }

  if (ssStopBtn) {
    ssStopBtn.addEventListener('click', async () => {
      ssStopBtn.disabled = true;
      try {
        await engine.stopBroadcastTo(device.id);
        syncSsButtons();
      } catch (e) {
        showToast(e?.message || t('mc.insp.ss_stop_failed'), 'error');
      } finally {
        ssStopBtn.disabled = false;
      }
    });
  }

  if (calibrateBtn) {
    calibrateBtn.addEventListener('click', () => {
      identifyDevice(device.id, { mode: 'calibration', duration_ms: 30000 });
      showToast(t('mc.insp.calibrate_sent', { name: device.name }), 'success');
    });
  }

  // Partition: ensure the display has a layout, assign it, mount the editor.
  const partitionBtn = container.querySelector('[data-insp-partition]');
  if (partitionBtn) {
    partitionBtn.addEventListener('click', async () => {
      partitionBtn.disabled = true;
      try {
        const layoutId = await ensureDisplayLayout(device);
        const regionsEl = container.querySelector('#mc-insp-regions');
        await renderRegionEditor(regionsEl, {
          layoutId,
          deviceId: device.id,
        });
      } catch (e) {
        showToast(e?.message || t('mc.insp.partition_failed'), 'error');
      } finally {
        partitionBtn.disabled = false;
      }
    });
  }

  container.querySelector('[data-insp-rename]')?.addEventListener('click', async () => {
    const name = await promptTextDialog({ title: t('mc.insp.rename_title'), label: t('mc.insp.rename_label'), value: device.name, submitLabel: t('mc.insp.rename') });
    if (!name || name === device.name) return;
    try {
      await api.updateDevice(device.id, { name });
      device.name = name;
      const title = container.querySelector('[data-insp-title]');
      if (title) title.textContent = name;
      showToast(t('mc.insp.renamed'), 'success');
      if (typeof onDeviceChanged === 'function') onDeviceChanged();
    } catch (e) {
      showToast(e?.message || t('mc.insp.rename_failed'), 'error');
    }
  });

  container.querySelector('[data-insp-screenshot]')?.addEventListener('click', () => {
    requestScreenshot(device.id);
    showToast(t('mc.insp.screenshot_requested'), 'info');
  });

  container.querySelector('[data-insp-remove]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('mc.insp.remove_title'),
      message: t('mc.insp.remove_msg', { name: device.name }),
      confirmLabel: t('mc.insp.remove'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.deleteDevice(device.id);
      showToast(t('mc.insp.removed'), 'success');
      closeInspector(container);
      if (typeof onDeviceChanged === 'function') onDeviceChanged();
    } catch (e) {
      showToast(e?.message || t('mc.insp.remove_failed'), 'error');
    }
  });

  container.querySelector('[data-insp-apply-layout]')?.addEventListener('click', async () => {
    const layoutId = container.querySelector('[data-insp-layout]')?.value || null;
    try {
      await api.layouts.assignToDevice(device.id, layoutId);
      device.layout_id = layoutId;
      showToast(layoutId ? t('mc.insp.layout_applied') : t('mc.insp.layout_cleared'), 'success');
      if (typeof onDeviceChanged === 'function') onDeviceChanged();
    } catch (e) {
      showToast(e?.message || t('mc.insp.layout_failed'), 'error');
    }
  });

  container.querySelector('[data-insp-playlist]')?.addEventListener('change', async (e) => {
    const playlistId = e.target.value;
    if (!playlistId) return;
    try {
      await api.assignPlaylistToDevice(playlistId, device.id);
      device.playlist_id = playlistId;
      showToast(t('mc.insp.playlist_assigned'), 'success');
      if (typeof onDeviceChanged === 'function') onDeviceChanged();
    } catch (err) {
      showToast(err?.message || t('mc.insp.playlist_failed'), 'error');
    }
  });

  container.querySelector('[data-insp-add-content]')?.addEventListener('click', async () => {
    const added = await openAddContentDialog(device, content);
    if (added && typeof onDeviceChanged === 'function') onDeviceChanged();
  });

  container.querySelector('[data-insp-save-settings]')?.addEventListener('click', async () => {
    try {
      await api.updateDevice(device.id, {
        orientation: container.querySelector('[data-insp-orientation]')?.value || 'landscape',
        default_content_id: container.querySelector('[data-insp-default-content]')?.value || null,
        notes: container.querySelector('[data-insp-notes]')?.value || '',
      });
      showToast(t('mc.insp.settings_saved'), 'success');
      if (typeof onDeviceChanged === 'function') onDeviceChanged();
    } catch (e) {
      showToast(e?.message || t('mc.insp.settings_failed'), 'error');
    }
  });

  container.querySelectorAll('[data-insp-command]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.inspCommand;
      if (type === 'reboot' || type === 'shutdown') {
        const ok = await confirmDialog({
          title: t(type === 'shutdown' ? 'mc.insp.shutdown_title' : 'mc.insp.reboot_title'),
          message: t('mc.insp.command_confirm_msg', { name: device.name }),
          confirmLabel: commandLabel(type),
          tone: type === 'shutdown' ? 'danger' : 'default',
          hold: type === 'shutdown',
        });
        if (!ok) return;
      }
      sendCommandWithToast(device.id, type, {});
    });
  });
}

async function openAddContentDialog(device, content) {
  const items = Array.isArray(content) ? content : [];
  if (!items.length) {
    showToast(t('mc.insp.no_content_available'), 'info');
    return false;
  }
  const dlg = document.createElement('dialog');
  dlg.className = 'mc-dialog mc-insp-content-dialog';
  dlg.setAttribute('aria-labelledby', 'mcInspContentTitle');
  const itemHtml = items.slice(0, 60).map(item => {
    const name = item.filename || item.name || t('mc.tile.content_fallback');
    const thumbUrl = item.thumbnail_url || (item.thumbnail_path ? `/api/content/${item.id}/thumbnail` : '');
    const thumb = thumbUrl
      ? `<img src="${esc(thumbUrl)}" alt="" loading="lazy">`
      : `<span class="mc-insp-content-fallback" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>`;
    return `<button type="button" class="mc-insp-content-item" data-content-id="${esc(item.id)}" title="${esc(name)}">
      ${thumb}
      <span>${esc(name)}</span>
    </button>`;
  }).join('');
  dlg.innerHTML = `
    <div class="mc-dialog-card mc-insp-content-card">
      <h3 id="mcInspContentTitle" class="mc-dialog-title">${esc(t('mc.insp.add_content_title'))}</h3>
      <label class="mc-insp-field"><span>${esc(t('mc.insp.duration'))}</span>
        <input class="input mc-insp-input" type="number" min="1" max="3600" value="10" data-duration>
      </label>
      <div class="mc-insp-content-grid">${itemHtml}</div>
      <p class="mc-route-error" data-error hidden>${esc(t('mc.insp.select_content_first'))}</p>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-cancel>${esc(t('mc.insp.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-add>${esc(t('mc.insp.add_content'))}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  return new Promise(resolve => {
    let selectedId = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.querySelectorAll('[data-content-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedId = btn.dataset.contentId;
        dlg.querySelectorAll('[data-content-id]').forEach(el => el.classList.toggle('is-selected', el === btn));
      });
    });
    dlg.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dlg.querySelector('[data-add]').addEventListener('click', async () => {
      if (!selectedId) {
        const err = dlg.querySelector('[data-error]');
        if (err) err.hidden = false;
        return;
      }
      const duration = parseInt(dlg.querySelector('[data-duration]')?.value || '10', 10) || 10;
      try {
        await api.addAssignment(device.id, { content_id: selectedId, duration_sec: duration });
        showToast(t('mc.insp.content_added'), 'success');
        finish(true);
      } catch (e) {
        showToast(e?.message || t('mc.insp.content_add_failed'), 'error');
      }
    });
    dlg.showModal();
  });
}

// Create or reuse a per-display layout, assign it to the device, return its id.
// If the display already has a layout_id, reuse it (so re-opening Partition does
// not orphan the existing zones + content bindings). Otherwise create one named
// after the display and assign it via PUT /api/layouts/device/:deviceId.
async function ensureDisplayLayout(display) {
  if (display.layout_id) return display.layout_id;
  const created = await api.layouts.create({
    name: t('mc.insp.layout_name', { name: display.name }),
    width: display.width || 1920,
    height: display.height || 1080,
  });
  if (!created || !created.id) throw new Error(t('mc.insp.layout_create_failed'));
  await api.layouts.assignToDevice(display.id, created.id);
  return created.id;
}

/** Hide + clear the inspector (used by the caller when selection is cleared). */
export function closeInspector(container) {
  if (!container) return;
  if (typeof container.__classroomMonitorCleanup === 'function') {
    try { container.__classroomMonitorCleanup(); } catch (_) {}
    container.__classroomMonitorCleanup = null;
  }
  // Unsubscribe the engine onChange listener installed by Task 4.5 so it does
  // not accumulate across repeated inspector opens.
  if (typeof container.__unsubEngine === 'function') {
    container.__unsubEngine();
    container.__unsubEngine = null;
  }
  container.__renderToken = null;
  container.hidden = true;
  container.innerHTML = '';
}
