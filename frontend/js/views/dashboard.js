import { api } from '../api.js';
import { on, off, requestScreenshot } from '../socket.js';
import { showToast } from '../components/toast.js';
import { openTargetPicker } from '../components/target-picker.js';
import { waitForTargetCatalog } from '../services/target-catalog-runtime.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

const DESTRUCTIVE_COMMANDS = ['reboot', 'shutdown'];
// Command types only — labels resolved through t('dashboard.cmd.<type>')
const GROUP_COMMANDS = [
  { type: 'screen_on' },
  { type: 'screen_off' },
  { type: 'launch' },
  { type: 'update' },
  { type: 'reboot', destructive: true },
  { type: 'shutdown', destructive: true },
];
const CMD_LABEL_KEY = {
  screen_on: 'dashboard.cmd.screen_on',
  screen_off: 'dashboard.cmd.screen_off',
  launch: 'dashboard.cmd.restart_app',
  update: 'dashboard.cmd.check_update',
  reboot: 'dashboard.cmd.reboot',
  shutdown: 'dashboard.cmd.shutdown',
};

let statusHandler = null;
let screenshotHandler = null;
let refreshInterval = null;
let playbackHandler = null;
let progressTickInterval = null;
let wallChangedHandler = null;
// device_id -> { content_name, duration_sec, started_at }
const playbackByDevice = new Map();
// Multi-select state for the "Create Video Wall" gesture. Holds device_ids
// the user has ticked via checkboxes on the dashboard cards.
const selectedDeviceIds = new Set();

function formatTimeAgo(timestamp) {
  if (!timestamp) return t('common.never');
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return t('common.just_now');
  if (seconds < 3600) return t('common.minutes_ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('common.hours_ago', { n: Math.floor(seconds / 3600) });
  return t('common.days_ago', { n: Math.floor(seconds / 86400) });
}

function formatBytes(mb) {
  if (mb === null || mb === undefined) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// Build a compact "1920x1080 - landscape - @2x" descriptor from whatever
// viewport/screen telemetry a display has reported. Prefers CSS viewport
// dimensions (what the player actually renders into), falling back to the raw
// screen resolution. Returns '' when nothing useful is available so the meta
// item can be omitted entirely.
function formatDisplayInfo(device) {
  const w = device.viewport_css_w || device.screen_width;
  const h = device.viewport_css_h || device.screen_height;
  const parts = [];
  if (w && h) parts.push(`${w}x${h}`);
  if (device.orientation) parts.push(device.orientation);
  const dpr = device.device_pixel_ratio;
  if (dpr && Number(dpr) > 0 && Number(dpr) !== 1) {
    // Trim trailing zeros: 2 -> "@2x", 1.5 -> "@1.5x"
    const n = Number(dpr);
    parts.push(`@${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}x`);
  }
  return parts.join(' - ');
}

function renderProgressFor(deviceId) {
  const state = playbackByDevice.get(deviceId);
  document.querySelectorAll(`#progress-${CSS.escape(deviceId)}`).forEach(el => {
    if (!state) { el.style.display = 'none'; return; }
    const elapsed = Math.max(0, (Date.now() - state.started_at) / 1000);
    const name = state.content_name || '';
    const fill = el.querySelector('.device-card-progress-fill');
    const nameEl = el.querySelector('.dcp-name');
    const timeEl = el.querySelector('.dcp-time');
    if (state.duration_sec && state.duration_sec > 0) {
      const remaining = Math.max(0, Math.ceil(state.duration_sec - elapsed));
      const pct = Math.min(100, (elapsed / state.duration_sec) * 100);
      fill.style.width = pct + '%';
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = remaining + 's';
    } else {
      // Unknown duration (e.g. video plays to end) — show indeterminate state
      fill.style.width = '100%';
      fill.classList.add('indeterminate');
      if (nameEl) nameEl.textContent = name;
      if (timeEl) timeEl.textContent = '';
    }
    el.style.display = 'block';
  });
}

function renderDeviceCard(device) {
  const screenshotUrl = device.screenshot_path
    ? `/api/devices/${device.id}/screenshot?t=${device.screenshot_at || ''}`
    : null;

  const checked = selectedDeviceIds.has(device.id);
  const displayInfo = formatDisplayInfo(device);
  return `
    <div class="device-card${checked ? ' selected' : ''}" draggable="true" data-device-id="${device.id}" data-device-name="${esc(device.name)}" onclick="window.location.hash='/device/${device.id}'">
      <label class="device-card-select" title="Select for wall" onclick="event.stopPropagation()">
        <input type="checkbox" class="device-select-cb" data-device-id="${device.id}"${checked ? ' checked' : ''}>
      </label>
      <div class="device-card-preview" id="preview-${device.id}">
        ${screenshotUrl
          ? `<img src="${screenshotUrl}" alt="Screenshot" loading="lazy">`
          : `<div class="no-preview">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <span>${t('dashboard.no_preview')}</span>
            </div>`
        }
        <div class="device-card-status">
          <span class="status-dot ${device.status}"></span>
          <span>${device.status === 'provisioning' ? t('dashboard.awaiting_pairing') : device.status}</span>
        </div>
        ${device.status === 'provisioning' && device.pairing_code ? `
        <div style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f59e0b;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;letter-spacing:2px;font-family:monospace">
          ${device.pairing_code}
        </div>` : ''}
        <div class="device-card-progress" id="progress-${device.id}" style="display:none">
          <div class="device-card-progress-label"><span class="dcp-name"></span><span class="dcp-time"></span></div>
          <div class="device-card-progress-track"><div class="device-card-progress-fill"></div></div>
        </div>
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(device.name)}</div>
        ${device.owner_name || device.owner_email ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          ${esc(device.owner_name || device.owner_email)}
        </div>` : ''}
        <div class="device-card-meta">
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${formatTimeAgo(device.last_heartbeat)}
          </div>
          ${displayInfo ? `
          <div class="meta-item" title="${esc(displayInfo)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            ${esc(displayInfo)}
          </div>` : ''}
          ${device.battery_level !== null && device.battery_level !== undefined ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/>
            </svg>
            ${device.battery_level}%
          </div>` : ''}
          ${device.wifi_rssi ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
            ${device.wifi_rssi} dBm
          </div>` : ''}
          ${device.storage_free_mb ? `
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            ${formatBytes(device.storage_free_mb)} free
          </div>` : ''}
        </div>
        ${device.status !== 'provisioning' ? `
        <div class="device-card-actions" style="margin-top:8px">
          <button class="btn btn-sm device-identify-btn" data-identify-id="${device.id}" data-identify-name="${esc(device.name)}" title="Flash a marker on this display" style="padding:4px 10px;font-size:12px" onclick="event.stopPropagation()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            Identify
          </button>
        </div>` : ''}
      </div>
    </div>
  `;
}

function renderWallCard(wall) {
  // Compose a tiny grid preview using the wall's actual cols×rows. Each cell
  // is filled (assigned) or hollow (empty slot).
  const cells = [];
  for (let r = 0; r < wall.grid_rows; r++) {
    for (let c = 0; c < wall.grid_cols; c++) {
      const dev = (wall.devices || []).find(d => d.grid_col === c && d.grid_row === r);
      cells.push(`<div class="wall-card-cell${dev ? ' filled' : ''}" title="${dev ? esc(dev.device_name) : '[' + c + ',' + r + ']'}"></div>`);
    }
  }
  const onlineCount = (wall.devices || []).filter(d => d.device_status === 'online').length;
  return `
    <div class="device-card wall-card" data-wall-id="${wall.id}" onclick="window.location.hash='#/wall/${wall.id}'">
      <div class="device-card-preview wall-card-preview">
        <div class="wall-card-grid" style="grid-template-columns:repeat(${wall.grid_cols},1fr);grid-template-rows:repeat(${wall.grid_rows},1fr)">${cells.join('')}</div>
        <div class="device-card-status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
          <span>${wall.grid_cols}×${wall.grid_rows} wall</span>
        </div>
      </div>
      <div class="device-card-body">
        <div class="device-card-name">${esc(wall.name)}</div>
        <div class="device-card-meta">
          <div class="meta-item">${(wall.devices || []).length} ${(wall.devices || []).length === 1 ? 'tile' : 'tiles'}</div>
          <div class="meta-item" style="color:${onlineCount === (wall.devices || []).length ? 'var(--success)' : 'var(--text-muted)'}">${onlineCount} online</div>
          ${wall.is_locked ? `<div class="meta-item" style="color:#f59e0b">Locked</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function getGroupPlaylistLabel(devices, playlists) {
  const playlistMap = new Map((playlists || []).map(p => [p.id, p]));
  const assigned = devices.filter(d => d.playlist_id).map(d => d.playlist_id);
  if (assigned.length === 0) return '';
  const unique = [...new Set(assigned)];
  if (unique.length === 1) {
    const pl = playlistMap.get(unique[0]);
    return pl ? esc(pl.name) : t('dashboard.unknown_playlist');
  }
  return t('dashboard.mixed_playlists');
}

function renderGroupSection(group, devices, playlists) {
  const onlineCount = devices.filter(d => d.status === 'online').length;
  const playlistLabel = getGroupPlaylistLabel(devices, playlists);
  return `
    <div class="group-section" data-group-id="${group.id}" style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid ${esc(group.color || '#3B82F6')}">
        <div style="display:flex;align-items:center;gap:10px">
          <strong style="font-size:15px">${esc(group.name)}</strong>
          <span style="color:var(--text-muted);font-size:12px">${tn('dashboard.devices_count', devices.length)} &middot; ${t('dashboard.online_count', { n: onlineCount })}</span>
          ${playlistLabel ? `<span style="font-size:11px;color:var(--text-secondary);background:var(--bg-primary);padding:2px 8px;border-radius:10px">${t('dashboard.playlist_label', { name: playlistLabel })}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${devices.length > 0 ? `
          <select class="input group-playlist-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" style="width:160px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.set_playlist_placeholder')}</option>
            ${(playlists || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.status === 'draft' ? ' ' + t('dashboard.draft_suffix') : ''}</option>`).join('')}
          </select>
          <select class="input group-cmd-select" data-group-id="${group.id}" data-group-name="${esc(group.name)}" data-device-count="${devices.length}" style="width:150px;padding:4px 8px;font-size:12px;background:var(--bg-input)">
            <option value="">${t('dashboard.send_command_placeholder')}</option>
            ${GROUP_COMMANDS.map(c => `<option value="${c.type}" ${c.destructive ? 'style="color:var(--danger)"' : ''}>${t(CMD_LABEL_KEY[c.type])}</option>`).join('')}
          </select>
          ` : ''}
          <button class="btn" data-group-manage="${group.id}" style="padding:4px 10px;font-size:12px" title="${t('dashboard.manage_tooltip')}">${t('dashboard.manage')}</button>
          <button class="btn" data-group-delete="${group.id}" style="padding:4px 8px;font-size:12px;color:var(--danger)" title="${t('dashboard.delete_group_tooltip')}">&#x2715;</button>
        </div>
      </div>
      <div class="device-grid">
        ${devices.length > 0 ? devices.map(renderDeviceCard).join('') : `<div style="color:var(--text-muted);font-size:13px;padding:8px 12px">${t('dashboard.no_devices_in_group')}</div>`}
      </div>
    </div>
  `;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('dashboard.title')} <span class="help-tip" data-tip="${t('dashboard.help_tip')}">?</span></h1>
        <div class="subtitle">${t('dashboard.subtitle')}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="broadcastBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>
          </svg>
          ${t('mc.target_picker.title')}
        </button>
        <button class="btn" id="createGroupBtn">${t('dashboard.create_group')}</button>
        <button class="btn btn-primary" id="addDeviceBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          ${t('dashboard.add')}
        </button>
      </div>
    </div>
    <div id="selectionBar" style="display:none;align-items:center;gap:10px;padding:8px 12px;margin-bottom:12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px">
      <span id="selectionCount" style="font-weight:500;font-size:13px"></span>
      <button class="btn btn-sm" id="createWallBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px">
          <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/>
        </svg>
        Create Video Wall
      </button>
      <button class="btn btn-sm" id="clearSelectionBtn">Clear</button>
    </div>
    <div id="dashStats" class="dash-stats-row" style="display:flex;gap:12px;margin-bottom:16px"></div>
    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
      <input type="text" id="deviceSearch" class="input" placeholder="${t('dashboard.search')}" style="max-width:300px">
      <select id="deviceFilter" class="input" style="width:140px;background:var(--bg-input)">
        <option value="">${t('dashboard.all_status')}</option>
        <option value="online">${t('dashboard.online')}</option>
        <option value="offline">${t('dashboard.offline')}</option>
      </select>
    </div>
    <div id="groupedDevices"></div>
  `;

  const addBtn = container.querySelector('#addDeviceBtn');
  addBtn.addEventListener('click', () => {
    document.getElementById('addDeviceModal').style.display = 'flex';
    document.getElementById('pairingCodeInput').value = '';
    document.getElementById('deviceNameInput').value = '';
    document.getElementById('pairingCodeInput').focus();
  });

  // Search and filter
  document.getElementById('deviceSearch').oninput = () => filterDevices();
  document.getElementById('deviceFilter').onchange = () => filterDevices();

  function filterDevices() {
    const search = document.getElementById('deviceSearch').value.toLowerCase();
    const status = document.getElementById('deviceFilter').value;
    document.querySelectorAll('.device-card').forEach(card => {
      const name = card.querySelector('.device-card-name')?.textContent.toLowerCase() || '';
      const deviceStatus = card.querySelector('.device-card-status span:last-child')?.textContent || '';
      const matchSearch = !search || name.includes(search);
      const matchStatus = !status || deviceStatus === status;
      card.style.display = (matchSearch && matchStatus) ? '' : 'none';
    });
  }

  // Setup pairing
  const pairBtn = document.getElementById('pairDeviceBtn');
  pairBtn.onclick = async () => {
    const code = document.getElementById('pairingCodeInput').value.trim();
    const name = document.getElementById('deviceNameInput').value.trim();
    if (!code || code.length !== 6) {
      showToast(t('dashboard.error_pairing_code'), 'error');
      return;
    }
    try {
      await api.pairDevice(code, name || undefined);
      document.getElementById('addDeviceModal').style.display = 'none';
      showToast(t('dashboard.toast.display_paired'), 'success');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Create group
  container.querySelector('#createGroupBtn').addEventListener('click', async () => {
    const name = prompt(t('dashboard.prompt_group_name'));
    if (!name) return;
    try {
      await api.createGroup(name);
      showToast(t('dashboard.toast.group_created'), 'success');
      loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
  });

  // Multi-select: a checkbox on each device card adds to selectedDeviceIds.
  // The selection bar shows when 1+ are selected; "Create Video Wall" is the
  // primary action — it creates the wall, removes devices from any group,
  // assigns them, and navigates to the editor.
  container.addEventListener('change', (ev) => {
    const cb = ev.target.closest?.('.device-select-cb');
    if (!cb) return;
    const id = cb.dataset.deviceId;
    if (cb.checked) selectedDeviceIds.add(id); else selectedDeviceIds.delete(id);
    cb.closest('.device-card')?.classList.toggle('selected', cb.checked);
    refreshSelectionBar();
  });

  // "Identify" flashes a marker on the chosen physical display so an operator
  // can match a card to a screen on the wall. Delegated on the container so it
  // keeps working across loadDashboard() re-renders of #groupedDevices.
  container.addEventListener('click', async (ev) => {
    const btn = ev.target.closest?.('.device-identify-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = btn.dataset.identifyId;
    const name = btn.dataset.identifyName || id;
    if (!id) return;
    showToast(`Identifying ${name}...`, 'info');
    try {
      await api.identify(id);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    selectedDeviceIds.clear();
    document.querySelectorAll('.device-select-cb').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.device-card.selected').forEach(c => c.classList.remove('selected'));
    refreshSelectionBar();
  });

  document.getElementById('createWallBtn').addEventListener('click', () => createWallFromSelection());
  document.getElementById('broadcastBtn').addEventListener('click', () => openBroadcastPicker());

  // Load everything
  loadDashboard();

  // Real-time updates
  statusHandler = (data) => {
    const cards = document.querySelectorAll(`[data-device-id="${data.device_id}"]`);
    cards.forEach(card => {
      const statusEl = card.querySelector('.device-card-status');
      if (statusEl) statusEl.innerHTML = `<span class="status-dot ${data.status}"></span><span>${data.status}</span>`;
    });
  };

  screenshotHandler = (data) => {
    document.querySelectorAll(`#preview-${data.device_id}`).forEach(preview => {
      // Use image_data (base64) if available, otherwise the raw URL without
      // the JWT — the server sends image_data via socket for this reason.
      const imgSrc = data.image_data || data.url;
      const img = preview.querySelector('img');
      if (img) {
        img.src = imgSrc;
      } else {
        const statusHtml = preview.querySelector('.device-card-status')?.outerHTML || '';
        preview.innerHTML = `<img src="${imgSrc}" alt="Screenshot" loading="lazy">${statusHtml}`;
      }
    });
  };

  const deviceAddedHandler = () => loadDashboard();
  const deviceRemovedHandler = () => loadDashboard();

  playbackHandler = (data) => {
    if (!data?.device_id) return;
    playbackByDevice.set(data.device_id, {
      content_name: data.content_name || '',
      duration_sec: data.duration_sec || null,
      started_at: data.started_at || Date.now(),
    });
    renderProgressFor(data.device_id);
  };

  wallChangedHandler = () => loadDashboard();

  on('device-status', statusHandler);
  on('screenshot-ready', screenshotHandler);
  on('device-added', deviceAddedHandler);
  on('device-removed', deviceRemovedHandler);
  on('playback-progress', playbackHandler);
  on('wall-changed', wallChangedHandler);

  progressTickInterval = setInterval(() => {
    for (const id of playbackByDevice.keys()) renderProgressFor(id);
  }, 1000);

  // Request fresh screenshots on load
  setTimeout(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 2000);

  refreshInterval = setInterval(() => {
    document.querySelectorAll('.device-card').forEach(card => {
      requestScreenshot(card.dataset.deviceId);
    });
  }, 30000);
}

function refreshSelectionBar() {
  const bar = document.getElementById('selectionBar');
  const count = document.getElementById('selectionCount');
  if (!bar || !count) return;
  const n = selectedDeviceIds.size;
  if (n === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  // Need at least 2 to make a wall - surface the constraint inline so the
  // greyed-out button isn't just silently unresponsive.
  count.textContent = n < 2
    ? `${n} display selected - pick 1 more to create a wall`
    : `${n} displays selected`;
  const btn = document.getElementById('createWallBtn');
  btn.disabled = n < 2;
  btn.title = n < 2 ? 'Select at least 2 displays to create a video wall' : '';
}

// Pick a sensible default grid for n devices: prefer near-square layouts,
// breaking ties toward more columns (more common physical wall layout).
function defaultGridForCount(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n === 6) return { cols: 3, rows: 2 };
  if (n === 8) return { cols: 4, rows: 2 };
  if (n === 9) return { cols: 3, rows: 3 };
  // Generic fallback — square-ish, columns >= rows
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

// Phase 3: fast broadcast. Opens a small picker so the operator can pick a
// piece of content (or paste a URL) plus a fit_mode, then pushes it to every
// selected display in ~2 taps. Reuses the existing "push content to a device"
// path via the server's /broadcast endpoint (which fans out the same way the
// per-device assignment path does). The server gates a workspace-wide blast
// behind a 409 { code:'CONFIRM_ALL_REQUIRED', count } envelope, which
// api.broadcast() surfaces (rather than throwing); we then prompt and retry
// with confirm_all:true.
const VALID_FIT_MODES = ['cover', 'contain', 'fill', 'none', 'scale-down'];

async function openBroadcastPicker() {
  let selection;
  try {
    const catalog = await waitForTargetCatalog({ includeVirtualDisplays: false }, { requireFresh: true });
    selection = await openTargetPicker({
      catalog,
      capability: 'content',
      selection: 'multiple',
      allowOffline: false,
      allowIndividualWallMembers: false,
      allowLiveProgram: false,
    });
  } catch (err) {
    showToast(err?.message || 'Live room topology is unavailable.', 'error');
    return;
  }
  if (!selection) return;
  const ids = selection.deviceIds;
  if (!ids.length) {
    showToast('Choose at least one physical wall, group, or standalone display.', 'info');
    return;
  }
  const destinationNames = selection.targets.map((target) => target.name).filter(Boolean);
  const destinationSummary = destinationNames.join(', ');

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;max-width:560px;width:95vw;max-height:85vh;display:flex;flex-direction:column">
      <h3 style="margin-bottom:4px;color:var(--text-primary)">Send to ${selection.targets.length} ${selection.targets.length === 1 ? 'destination' : 'destinations'}</h3>
      <p style="margin:0 0 4px;font-size:12px;color:var(--text-secondary)">${esc(destinationSummary)}</p>
      <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">${ids.length} physical display${ids.length === 1 ? '' : 's'} · Pick content from your library, or paste a URL to show right now.</p>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn btn-primary btn-sm bc-tab active" data-tab="content">Library</button>
        <button class="btn btn-secondary btn-sm bc-tab" data-tab="url">URL</button>
      </div>
      <div id="bcContentPane">
        <input type="text" id="bcSearch" class="input" placeholder="Search content..." style="width:100%;margin-bottom:12px">
        <div id="bcList" style="overflow-y:auto;min-height:180px;max-height:320px;border:1px solid var(--border);border-radius:var(--radius)"></div>
      </div>
      <div id="bcUrlPane" style="display:none">
        <input type="text" id="bcUrl" class="input" placeholder="https://example.com/page-or-media" style="width:100%;margin-bottom:12px">
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 4px">The displays will load this URL immediately.</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:16px">
        <label style="font-size:13px;color:var(--text-secondary)">Fit</label>
        <select id="bcFitMode" class="input" style="width:160px;padding:4px 8px;font-size:13px;background:var(--bg-input)">
          <option value="">Default</option>
          <option value="cover">Cover (fill, crop)</option>
          <option value="contain">Contain (letterbox)</option>
          <option value="fill">Fill (stretch)</option>
          <option value="none">None (actual size)</option>
          <option value="scale-down">Scale down</option>
        </select>
        <div style="flex:1"></div>
        <button class="btn btn-secondary" id="bcCancel">Cancel</button>
        <button class="btn btn-primary" id="bcSend" disabled>Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let activeTab = 'content';
  let selectedContentId = null;
  let allContent = [];

  const listEl = modal.querySelector('#bcList');
  const sendBtn = modal.querySelector('#bcSend');
  const urlInput = modal.querySelector('#bcUrl');

  function close() { modal.remove(); }
  modal.querySelector('#bcCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  function refreshSendEnabled() {
    if (activeTab === 'url') {
      sendBtn.disabled = !urlInput.value.trim();
    } else {
      sendBtn.disabled = !selectedContentId;
    }
  }

  try {
    allContent = await api.getContent();
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">Couldn't load content: ${esc(err.message)}</div>`;
  }

  function renderContentList() {
    const search = (modal.querySelector('#bcSearch')?.value || '').toLowerCase();
    const filtered = (allContent || []).filter(c => (c.filename || c.name || '').toLowerCase().includes(search));
    if (!filtered.length) {
      listEl.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">No content found</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(c => {
      const name = c.filename || c.name || 'Untitled';
      const thumb = c.thumbnail_path ? `/api/content/${esc(c.id)}/thumbnail` : null;
      return `
        <div class="bc-row" data-id="${esc(c.id)}" style="display:flex;align-items:center;gap:12px;padding:10px;cursor:pointer;border-bottom:1px solid var(--border)">
          <div style="width:40px;height:30px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : '<div style="color:var(--text-muted);opacity:0.4"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(c.mime_type || '')}</div>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.bc-row').forEach(row => {
      row.addEventListener('click', () => {
        selectedContentId = row.dataset.id;
        listEl.querySelectorAll('.bc-row').forEach(r => { r.style.background = ''; });
        row.style.background = 'var(--bg-secondary)';
        refreshSendEnabled();
      });
    });
  }

  modal.querySelectorAll('.bc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      modal.querySelectorAll('.bc-tab').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
        b.classList.toggle('btn-secondary', b.dataset.tab !== activeTab);
        b.classList.toggle('active', b.dataset.tab === activeTab);
      });
      modal.querySelector('#bcContentPane').style.display = activeTab === 'content' ? '' : 'none';
      modal.querySelector('#bcUrlPane').style.display = activeTab === 'url' ? '' : 'none';
      refreshSendEnabled();
    });
  });

  modal.querySelector('#bcSearch').addEventListener('input', renderContentList);
  urlInput.addEventListener('input', refreshSendEnabled);

  sendBtn.addEventListener('click', async () => {
    const fitRaw = modal.querySelector('#bcFitMode').value;
    const fit_mode = VALID_FIT_MODES.includes(fitRaw) ? fitRaw : undefined;
    const payload = { targets: selection.references };
    if (fit_mode) payload.fit_mode = fit_mode;
    if (activeTab === 'url') {
      const url = urlInput.value.trim();
      if (!url) return;
      payload.url = url;
    } else {
      if (!selectedContentId) return;
      payload.content_id = selectedContentId;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    try {
      const ok = await doBroadcast(payload);
      if (ok) close();
      else { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    } catch (err) {
      showToast(err.message, 'error');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });

  renderContentList();
}

// Executes a broadcast and handles the confirm-all gate. Returns true when the
// broadcast completed (success path) so the caller can close its modal, false
// when the operator declined the all-displays confirmation.
async function doBroadcast(payload) {
  const result = await api.broadcast(payload);
  if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
    const count = result.count;
    if (!confirm(`Broadcast to ALL ${count} display${count === 1 ? '' : 's'} in this workspace?`)) {
      return false;
    }
    const confirmed = await api.broadcast({ ...payload, confirm_all: true });
    if (confirmed && confirmed.code === 'CONFIRM_ALL_REQUIRED') {
      // Server still wants confirmation despite the flag - surface as an error
      // rather than looping a confirm dialog.
      showToast('Broadcast not confirmed', 'error');
      return false;
    }
    reportBroadcast(confirmed);
    return true;
  }
  reportBroadcast(result);
  return true;
}

function reportBroadcast(result) {
  const n = result && (result.devices_updated ?? result.sent ?? result.count);
  const offline = result && result.offline;
  if (n != null && offline) {
    showToast(`Sent to ${n} display${n === 1 ? '' : 's'} (${offline} offline)`, 'warning');
  } else if (n != null) {
    showToast(`Sent to ${n} display${n === 1 ? '' : 's'}`, 'success');
  } else {
    showToast('Broadcast sent', 'success');
  }
}

async function createWallFromSelection() {
  const ids = [...selectedDeviceIds];
  if (ids.length < 2) { showToast('Select at least 2 displays', 'error'); return; }
  const name = prompt('Name this video wall:', `Wall ${new Date().toLocaleString()}`);
  if (!name) return;
  const { cols, rows } = defaultGridForCount(ids.length);
  try {
    const wall = await api.createWall({ name, grid_cols: cols, grid_rows: rows });
    // Pack selected devices into row-major order. The user can reposition in
    // the editor; this just gives every selection a sensible starting tile.
    const placement = ids.slice(0, cols * rows).map((id, i) => ({
      device_id: id,
      grid_col: i % cols,
      grid_row: Math.floor(i / cols),
    }));
    await api.setWallDevices(wall.id, placement);
    selectedDeviceIds.clear();
    showToast('Video wall created', 'success');
    window.location.hash = `#/wall/${wall.id}`;
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadDashboard() {
  const main = document.getElementById('groupedDevices');
  if (!main) return;

  try {
    const [rawDevices, groups, playlists, walls] = await Promise.all([
      api.getDevices(), api.getGroups(), api.getPlaylists(), api.getWalls(),
    ]);

    // Deduplicate devices by id — a stale reconnect race can briefly cause the same
    // device to appear twice in the list. Last-write-wins keeps the freshest state.
    const seen = new Map();
    for (const d of rawDevices) seen.set(d.id, d);
    const devices = Array.from(seen.values());

    // Stats
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const provisioning = devices.filter(d => d.status === 'provisioning').length;
    const statsEl = document.getElementById('dashStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.total_displays')}</div>
          <div class="info-card-value">${devices.length}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.online')}</div>
          <div class="info-card-value" style="color:var(--success)">${online}</div>
        </div>
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.offline')}</div>
          <div class="info-card-value" style="color:${offline > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${offline}</div>
        </div>
        ${provisioning > 0 ? `
        <div class="info-card" style="flex:1;min-width:120px">
          <div class="info-card-label">${t('dashboard.awaiting_pairing')}</div>
          <div class="info-card-value" style="color:var(--warning,#f59e0b)">${provisioning}</div>
        </div>` : ''}
      `;
    }

    if (devices.length === 0 && groups.length === 0) {
      main.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <h3>${t('dashboard.no_displays')}</h3>
          <p>${t('dashboard.no_displays_desc')}</p>
        </div>
      `;
      return;
    }

    // Devices that belong to a wall are owned by that wall — they don't appear
    // as their own cards anywhere on the dashboard. The wall's card stands in.
    const walledDeviceIds = new Set();
    for (const w of (walls || [])) for (const d of (w.devices || [])) walledDeviceIds.add(d.device_id);
    const dashboardDevices = devices.filter(d => !walledDeviceIds.has(d.id));

    // Fetch group memberships
    const groupsWithDevices = await Promise.all(groups.map(async g => {
      const members = await api.getGroupDevices(g.id);
      const memberIds = new Set(members.map(m => m.id));
      // Use full device data from the main devices list (has telemetry/screenshots)
      // and exclude any wall members.
      const fullDevices = dashboardDevices.filter(d => memberIds.has(d.id));
      return { ...g, devices: fullDevices, memberIds };
    }));

    // Render each device exactly once: the first group it belongs to wins.
    // memberIds is preserved for the Manage modal so multi-group membership info stays accurate.
    const renderedIds = new Set();
    for (const g of groupsWithDevices) {
      g.devices = g.devices.filter(d => {
        if (renderedIds.has(d.id)) return false;
        renderedIds.add(d.id);
        return true;
      });
    }
    const ungrouped = dashboardDevices.filter(d => !renderedIds.has(d.id));

    let html = '';

    // Walls render before groups: they're a higher-level construct (multiple
    // physical screens acting as one logical display).
    if ((walls || []).length > 0) {
      html += `
        <div class="wall-section" style="margin-bottom:24px">
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid #8b5cf6">
            <strong style="font-size:15px">Video Walls</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${walls.length} wall${walls.length === 1 ? '' : 's'}</span>
          </div>
          <div class="device-grid">${walls.map(renderWallCard).join('')}</div>
        </div>
      `;
    }

    // Render each group with its devices
    for (const g of groupsWithDevices) {
      html += renderGroupSection(g, g.devices, playlists);
    }

    // Render ungrouped devices. The wrapper is tagged data-ungrouped="1" so
    // attachGroupHandlers can wire it as a drop target — dropping a device here
    // removes it from every group it currently belongs to.
    if (ungrouped.length > 0) {
      html += `
        <div class="ungrouped-section" data-ungrouped="1" style="margin-bottom:24px">
          ${groups.length > 0 ? `
          <div style="display:flex;align-items:center;margin-bottom:10px;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;border-left:4px solid var(--text-muted)">
            <strong style="font-size:15px;color:var(--text-muted)">${t('dashboard.ungrouped')}</strong>
            <span style="color:var(--text-muted);font-size:12px;margin-left:10px">${tn('dashboard.devices_count', ungrouped.length)}</span>
          </div>` : ''}
          <div class="device-grid">
            ${ungrouped.map(renderDeviceCard).join('')}
          </div>
        </div>
      `;
    }

    main.innerHTML = html;
    attachGroupHandlers(groupsWithDevices, dashboardDevices);

    // Drop any selections for devices that have since been absorbed into a
    // wall, and update the toolbar.
    for (const id of [...selectedDeviceIds]) {
      if (walledDeviceIds.has(id)) selectedDeviceIds.delete(id);
    }
    refreshSelectionBar();

  } catch (err) {
    main.innerHTML = `<div class="empty-state"><h3>${t('dashboard.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function attachGroupHandlers(groupsWithDevices, allDevices) {
  // Drag-and-drop: device cards are draggable; group sections + the Ungrouped
  // wrapper are drop targets. Drop on a group adds membership (mirrors the
  // Manage modal). Drop on Ungrouped removes the device from every group it's
  // currently a member of.
  const groupsByDeviceId = new Map();
  for (const g of groupsWithDevices) {
    g.memberIds.forEach(id => {
      if (!groupsByDeviceId.has(id)) groupsByDeviceId.set(id, []);
      groupsByDeviceId.get(id).push({ id: g.id, name: g.name });
    });
  }

  document.querySelectorAll('.device-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/device-id', card.dataset.deviceId);
      e.dataTransfer.setData('text/device-name', card.dataset.deviceName || '');
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  function highlightOn(el) { el.style.outline = '2px solid var(--primary)'; el.style.outlineOffset = '2px'; }
  function highlightOff(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

  document.querySelectorAll('.group-section').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      // Avoid flicker when moving across child elements
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const groupId = section.dataset.groupId;
      const targetGroup = groupsWithDevices.find(g => g.id === groupId);
      if (!targetGroup) return;
      // Already in this group — no-op.
      if (targetGroup.memberIds.has(deviceId)) {
        showToast(t('dashboard.toast.already_in_group', { name: deviceName, group: targetGroup.name }), 'info');
        return;
      }
      // If the device is in another group, mirror the Manage modal's confirm.
      const others = (groupsByDeviceId.get(deviceId) || []).map(g => g.name);
      if (others.length > 0) {
        if (!confirm(t('dashboard.confirm_add_to_group', { name: deviceName, groups: others.join(', '), target: targetGroup.name }))) return;
      }
      try {
        await api.addDeviceToGroup(groupId, deviceId);
        showToast(t('dashboard.toast.moved_device', { name: deviceName, group: targetGroup.name }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Ungrouped wrapper: remove device from every group it's in.
  document.querySelectorAll('[data-ungrouped="1"]').forEach(section => {
    section.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/device-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightOn(section);
    });
    section.addEventListener('dragleave', (e) => {
      if (e.target === section) highlightOff(section);
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      highlightOff(section);
      const deviceId = e.dataTransfer.getData('text/device-id');
      const deviceName = e.dataTransfer.getData('text/device-name') || 'this device';
      if (!deviceId) return;
      const memberships = groupsByDeviceId.get(deviceId) || [];
      if (memberships.length === 0) return; // already ungrouped
      try {
        await Promise.all(memberships.map(m => api.removeDeviceFromGroup(m.id, deviceId)));
        showToast(tn('dashboard.toast.removed_device', memberships.length, { name: deviceName }), 'success');
        loadDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  // Playlist assignment handlers
  document.querySelectorAll('.group-playlist-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const playlistId = e.target.value;
      if (!playlistId) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const playlistName = e.target.options[e.target.selectedIndex].textContent;

      if (!confirm(t('dashboard.confirm_assign_playlist', { playlist: playlistName, group: groupName }))) {
        e.target.value = '';
        return;
      }

      try {
        const result = await api.groupAssignPlaylist(groupId, playlistId);
        showToast(tn('dashboard.toast.playlist_assigned', result.devices_updated), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Command select handlers
  document.querySelectorAll('.group-cmd-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const type = e.target.value;
      if (!type) return;
      const groupId = e.target.dataset.groupId;
      const groupName = e.target.dataset.groupName;
      const count = e.target.dataset.deviceCount;
      const cmdLabel = t(CMD_LABEL_KEY[type] || type);

      if (DESTRUCTIVE_COMMANDS.includes(type)) {
        if (!confirm(t('dashboard.confirm_destructive_command', { cmd: cmdLabel.toUpperCase(), n: count, group: groupName }))) {
          e.target.value = '';
          return;
        }
      }

      try {
        const result = await api.sendGroupCommand(groupId, type);
        const msg = result.offline > 0
          ? t('dashboard.toast.command_sent_with_offline', { cmd: cmdLabel, sent: result.sent, total: result.total, offline: result.offline })
          : t('dashboard.toast.command_sent', { cmd: cmdLabel, sent: result.sent, total: result.total });
        showToast(msg, result.offline > 0 ? 'warning' : 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
      e.target.value = '';
    });
  });

  // Delete group
  document.querySelectorAll('[data-group-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.groupDelete;
      if (!confirm(t('dashboard.confirm_delete_group'))) return;
      try {
        await api.deleteGroup(id);
        showToast(t('dashboard.toast.group_deleted'), 'success');
        loadDashboard();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  // Manage group (add/remove devices)
  document.querySelectorAll('[data-group-manage]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupManage;
      const group = groupsWithDevices.find(g => g.id === groupId);
      const memberIds = new Set(group.devices.map(d => d.id));

      // Get all groups for multi-group warning
      const otherGroups = groupsWithDevices.filter(g => g.id !== groupId);

      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
      modal.innerHTML = `
        <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto">
          <h3 style="margin:0 0 4px">${esc(group.name)}</h3>
          <p style="margin:0 0 16px;font-size:12px;color:var(--text-muted)">${t('dashboard.manage_group_subtitle')}</p>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${allDevices.filter(d => d.status !== 'provisioning').map(d => {
              const inOther = otherGroups.filter(g => g.memberIds.has(d.id)).map(g => g.name);
              return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:var(--bg-secondary)">
                  <input type="checkbox" data-device-id="${d.id}" data-in-groups="${inOther.join(',')}" ${memberIds.has(d.id) ? 'checked' : ''}>
                  <span class="status-dot ${d.status}" style="width:8px;height:8px"></span>
                  <span style="font-size:13px;flex:1">${esc(d.name)}</span>
                  ${inOther.length > 0 ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-primary);padding:1px 6px;border-radius:8px">${esc(inOther.join(', '))}</span>` : ''}
                </label>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
            <button class="btn" id="manageGroupClose">${t('common.done')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#manageGroupClose').onclick = () => { modal.remove(); loadDashboard(); };
      modal.addEventListener('click', (ev) => { if (ev.target === modal) { modal.remove(); loadDashboard(); } });

      modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const deviceId = cb.dataset.deviceId;
          const existingGroups = cb.dataset.inGroups;
          const cbName = cb.closest('label')?.querySelector('span:not(.status-dot)')?.textContent || '';
          try {
            if (cb.checked && existingGroups) {
              if (!confirm(t('dashboard.confirm_add_to_group', { name: cbName, groups: existingGroups, target: group.name }))) {
                cb.checked = false;
                return;
              }
            }
            if (cb.checked) {
              await api.addDeviceToGroup(groupId, deviceId);
            } else {
              await api.removeDeviceFromGroup(groupId, deviceId);
            }
          } catch (err) {
            showToast(err.message, 'error');
            cb.checked = !cb.checked;
          }
        });
      });
    });
  });
}

export function cleanup() {
  if (statusHandler) off('device-status', statusHandler);
  if (screenshotHandler) off('screenshot-ready', screenshotHandler);
  if (playbackHandler) off('playback-progress', playbackHandler);
  if (wallChangedHandler) off('wall-changed', wallChangedHandler);
  off('device-added', () => {});
  off('device-removed', () => {});
  if (refreshInterval) clearInterval(refreshInterval);
  if (progressTickInterval) clearInterval(progressTickInterval);
  statusHandler = null;
  screenshotHandler = null;
  playbackHandler = null;
  wallChangedHandler = null;
  refreshInterval = null;
  progressTickInterval = null;
  playbackByDevice.clear();
}
