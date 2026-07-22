// MBFD Media Control Studio — Broadcast Center.
// Pick a source (a presentation, a playlist, or a media item), pick target
// displays (individually, by group, or all), and push it live to those screens
// via POST /api/broadcast (the same path Present-to-displays uses). A
// presentation is broadcast as its public deck-player URL; playlists/media use
// their ids. The "all displays" confirm gate is honored.
//
// Honest scope: /api/broadcast is a one-shot push (the player loops decks/
// playlists on its own), so there is no fake Loop/Schedule toggle here —
// recurring windows live in Schedules. CSP-safe: addEventListener + inline
// styles only.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm.js';
import { sendCommand } from '../socket.js';
import { openTargetPicker } from '../components/target-picker.js';
import { waitForTargetCatalog } from '../services/target-catalog-runtime.js';
import { expandTargetsToDeviceIds, findCatalogTarget } from '../services/target-catalog.js';

let data = { catalog: null, presentations: [], playlists: [], content: [], ncFiles: [], ncPath: '' };
let sel = { type: 'presentation', id: null, label: '' };
let targets = new Set();
let targetReferences = [];
let blanked = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function asArray(v) { return Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []); }
function targetKey(target) { return `${target.type}:${target.id}`; }
function selectedDeviceIds() {
  return data.catalog ? expandTargetsToDeviceIds([...targets], data.catalog) : [];
}
function selectedTypedTargets() {
  return targetReferences.filter((target) => target.type !== 'live-program');
}
function liveProgramSelected() {
  return [...targets].some((key) => key.startsWith('live-program:'));
}

const ROW = 'display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid var(--mc-border-light);background:var(--mc-surface);margin-bottom:6px';
const ROW_SEL = 'display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid var(--mc-primary);background:var(--mc-live-dim,#FEE2E2);margin-bottom:6px';

const SOURCE_TABS = [
  { key: 'presentation', label: 'Presentations' },
  { key: 'playlist', label: 'Playlists' },
  { key: 'media', label: 'Media' },
  { key: 'nc_file', label: 'Nextcloud' },
];

// MIME types broadcastable from Nextcloud (image/* and video/* only — per plan spec).
const NC_BROADCASTABLE = /^(image|video)\//;

// Load the current NC directory into data.ncFiles (called when switching to the
// Nextcloud tab or navigating within it). Silently sets an error row on failure.
async function loadNcFiles() {
  const wrap = document.getElementById('bcSources');
  if (wrap) wrap.innerHTML = '<div class="mc-panel-empty">Loading Nextcloud files…</div>';
  try {
    let health;
    try { health = await api.files.health(); } catch { health = { enabled: true, connected: false, error: 'unreachable' }; }
    if (health.enabled === false || !health.connected) {
      data.ncFiles = [];
      if (wrap) wrap.innerHTML = `<div class="mc-panel-empty">${esc(health.error || 'Nextcloud is not connected.')}</div>`;
      return;
    }
    const items = await api.files.list(data.ncPath || '');
    data.ncFiles = Array.isArray(items) ? items : [];
  } catch (e) {
    data.ncFiles = [];
    if (wrap) wrap.innerHTML = `<div class="mc-panel-empty">Could not load Nextcloud files: ${esc(e?.message || '')}</div>`;
  }
}

function sourceItems() {
  if (sel.type === 'presentation') return data.presentations.map((p) => ({ id: p.id, label: p.title || '(untitled)', sub: (p.slide_count != null ? p.slide_count + ' slides' : ''), isDir: false }));
  if (sel.type === 'playlist') return data.playlists.map((p) => ({ id: p.id, label: p.name || '(untitled)', sub: p.description || '', isDir: false }));
  if (sel.type === 'nc_file') {
    // NC items include folders (for navigation) + broadcastable files.
    return data.ncFiles.map((f) => ({
      id: f.path,
      label: f.name,
      sub: f.is_dir ? 'Folder' : (f.mime_type || ''),
      isDir: !!f.is_dir,
      isBroadcastable: !f.is_dir && NC_BROADCASTABLE.test(f.mime_type || ''),
    }));
  }
  return data.content.map((c) => ({ id: c.id, label: c.filename || '(file)', sub: c.mime_type || '', isDir: false }));
}

function renderSources() {
  const wrap = document.getElementById('bcSources');
  if (!wrap) return;
  const items = sourceItems();

  // Nextcloud tab: show breadcrumb + file list (folders navigable, files selectable).
  if (sel.type === 'nc_file') {
    const parts = (data.ncPath || '').split('/').filter(Boolean);
    let acc = '';
    const crumbs = ['<span data-bc-nc-nav="" style="color:var(--mc-primary);cursor:pointer">Files</span>']
      .concat(parts.map((p) => { acc += '/' + p; return `<span data-bc-nc-nav="${esc(acc)}" style="color:var(--mc-primary);cursor:pointer">${esc(p)}</span>`; }));
    const crumbHtml = `<div style="font-size:var(--mc-font-size-xs);color:var(--mc-text-secondary);margin-bottom:8px">${crumbs.join('<span style="margin:0 4px;color:var(--mc-text-tertiary)">/</span>')}</div>`;

    if (!items.length) {
      wrap.innerHTML = crumbHtml + '<div class="mc-panel-empty">This folder is empty.</div>';
    } else {
      wrap.innerHTML = crumbHtml + items.map((it) => {
        const isSelected = !it.isDir && sel.id === it.id;
        const style = isSelected ? ROW_SEL : ROW;
        const icon = it.isDir ? '📁' : (NC_BROADCASTABLE.test(it.sub) ? '🖼' : '📄');
        const notBroadcastableHint = !it.isDir && !it.isBroadcastable ? '<span style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary)">(not broadcastable)</span>' : '';
        return `<div ${it.isDir ? `data-bc-nc-dir="${esc(it.id)}"` : (it.isBroadcastable ? `data-src="${esc(it.id)}" data-label="${esc(it.label)}"` : '')} style="${style};${it.isDir ? 'cursor:pointer' : ''};${!it.isBroadcastable && !it.isDir ? 'opacity:.5' : ''}">
          <span style="flex:0 0 auto">${icon}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--mc-fw-semibold);color:var(--mc-text-primary)">${esc(it.label)}</span>
          ${notBroadcastableHint}
          <span style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary);white-space:nowrap">${esc(it.sub)}</span>
        </div>`;
      }).join('');
    }

    // Breadcrumb nav
    wrap.querySelectorAll('[data-bc-nc-nav]').forEach((el) => {
      el.addEventListener('click', () => {
        data.ncPath = el.dataset.bcNcNav || '';
        sel.id = null; sel.label = '';
        loadNcFiles().then(() => { renderSources(); updateBar(); });
      });
    });
    // Folder drill-down
    wrap.querySelectorAll('[data-bc-nc-dir]').forEach((el) => {
      el.addEventListener('click', () => {
        data.ncPath = el.dataset.bcNcDir;
        sel.id = null; sel.label = '';
        loadNcFiles().then(() => { renderSources(); updateBar(); });
      });
    });
    return;
  }

  if (!items.length) {
    const where = sel.type === 'presentation' ? 'Presentations' : sel.type === 'playlist' ? 'Playlists' : 'Media Library';
    wrap.innerHTML = `<div class="mc-panel-empty">No ${sel.type === 'media' ? 'media' : sel.type + 's'} yet. Add some in <b>${where}</b>.</div>`;
    return;
  }
  wrap.innerHTML = items.map((it) => `
    <div data-src="${esc(it.id)}" data-label="${esc(it.label)}" style="${sel.id === it.id ? ROW_SEL : ROW}">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--mc-fw-semibold);color:var(--mc-text-primary)">${esc(it.label)}</span>
      <span style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary);white-space:nowrap">${esc(it.sub)}</span>
    </div>`).join('');
}

function renderTabs() {
  const t = document.getElementById('bcTabs');
  if (!t) return;
  t.innerHTML = SOURCE_TABS.map((tab) => `
    <button type="button" data-tab="${tab.key}" style="background:${sel.type === tab.key ? 'var(--mc-primary,#DC2626)' : 'var(--mc-surface)'};color:${sel.type === tab.key ? '#fff' : 'var(--mc-text-primary)'};border:1px solid ${sel.type === tab.key ? 'var(--mc-primary,#DC2626)' : 'var(--mc-border-medium)'};border-radius:var(--mc-radius-sm);padding:7px 14px;cursor:pointer;font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm)">${tab.label}</button>`).join('');
}

function renderTargets() {
  const wrap = document.getElementById('bcTargets');
  if (!wrap) return;
  if (!data.catalog) {
    wrap.innerHTML = '<div class="mc-panel-empty">Live room topology is unavailable. Check the server connection.</div>';
    return;
  }
  const selectedRows = [...targets].map((key) => {
    const target = findCatalogTarget(data.catalog, key);
    if (!target) return '';
    const live = target.type === 'live-program';
    const detail = target.topologyLabel || `${target.name} · ${target.status || ''} · ${target.dimensionsLabel || ''}`;
    return `<div class="mc-target-picker-choice${live ? ' is-live-program' : ''}" style="cursor:default">
      <span class="mc-target-picker-choice-body">
        <span class="mc-target-picker-choice-heading"><strong>${esc(target.name)}</strong>${live ? '<span class="mc-target-picker-status is-live">ON-AIR PATH</span>' : ''}</span>
        <span class="mc-target-picker-meta">${esc(detail)}</span>
      </span>
    </div>`;
  }).filter(Boolean).join('');
  const physicalCount = selectedDeviceIds().length;
  wrap.innerHTML = `
    <button type="button" data-choose-targets class="mc-action-btn-primary" style="width:100%;border:0;border-radius:var(--mc-radius-sm);padding:11px 16px;font-weight:var(--mc-fw-bold);cursor:pointer">
      ${targets.size ? 'Change destinations' : 'Choose walls and displays'}
    </button>
    <p style="margin:8px 0 12px;color:var(--mc-text-tertiary);font-size:var(--mc-font-size-xs)">
      ${physicalCount} physical display${physicalCount === 1 ? '' : 's'}${liveProgramSelected() ? ' · Live Program explicitly selected' : ' · Live Program not selected'}
    </p>
    ${selectedRows || '<div class="mc-panel-empty">No destinations selected.</div>'}`;
}

function updateBar() {
  const btn = document.getElementById('bcGo');
  const info = document.getElementById('bcInfo');
  const ids = selectedDeviceIds();
  const destinationCount = ids.length + (liveProgramSelected() ? 1 : 0);
  if (info) info.textContent = `${destinationCount} destination${destinationCount === 1 ? '' : 's'} · ${sel.id ? '1 source' : 'no source'}`;
  if (btn) btn.disabled = !(sel.id && targets.size);
  // Live-control buttons act on the selected displays (independent of source).
  document.querySelectorAll('.bc-ctl').forEach((b) => { b.disabled = !ids.length; b.style.opacity = ids.length ? '1' : '.45'; b.style.cursor = ids.length ? 'pointer' : 'not-allowed'; });
  const ci = document.getElementById('bcCtlInfo');
  if (ci) ci.textContent = ids.length ? `${ids.length} physical display${ids.length === 1 ? '' : 's'} selected` : 'select a physical wall or display above';
}

async function broadcast() {
  if (!sel.id || !targets.size) return;
  const btn = document.getElementById('bcGo');
  if (btn) btn.disabled = true;
  const device_ids = selectedDeviceIds();
  const include_live_stream = liveProgramSelected();

  try {
    // Nextcloud file: import bytes → content row → broadcast via /api/files/broadcast.
    // GUARDRAIL: sel.id is the NC path (string); email comes from req.user.email
    // server-side — never sent from the client.
    if (sel.type === 'nc_file') {
      let r = await api.files.broadcast(sel.id, undefined, { targets: selectedTypedTargets() });
      if (r && r.code === 'CONFIRM_ALL_REQUIRED') {
        const ok = await confirmDialog({ title: 'Broadcast to ALL displays?', message: `This takes over all ${r.count} displays in this workspace.`, confirmLabel: 'Broadcast to all', tone: 'danger' });
        if (!ok) { updateBar(); return; }
        r = await api.files.broadcast(sel.id, undefined, { targets: selectedTypedTargets(), confirm_all: true });
      }
      showToast(`Broadcasting "${esc(sel.label)}" to ${r.sent != null ? r.sent : device_ids.length} display(s)`, 'success');
      return;
    }

    const typedTargets = selectedTypedTargets();
    const payload = {
      ...(typedTargets.length ? { targets: typedTargets } : { device_ids }),
      include_live_stream,
    };
    if (sel.type === 'presentation') payload.remote_url = `${location.origin}/player/deck/${sel.id}`;
    else if (sel.type === 'playlist') payload.playlist_id = sel.id;
    else payload.content_id = sel.id;
    let r = await api.broadcast(payload);
    if (r && r.code === 'CONFIRM_ALL_REQUIRED') {
      const ok = await confirmDialog({ title: 'Broadcast to ALL displays?', message: `This takes over all ${r.count} displays in this workspace.`, confirmLabel: 'Broadcast to all', tone: 'danger' });
      if (!ok) { updateBar(); return; }
      r = await api.broadcast({ ...payload, confirm_all: true });
    }
    showToast(`Broadcasting "${esc(sel.label)}" to ${r.sent != null ? r.sent : device_ids.length} display(s)`, 'success');
  } catch (e) {
    showToast(e.message || 'Broadcast failed', 'error');
  } finally {
    updateBar();
  }
}

export async function render(app) {
  sel = { type: 'presentation', id: null, label: '' };
  targets = new Set();
  targetReferences = [];
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap" style="max-width:1200px">
        <div style="margin-bottom:var(--mc-space-lg)">
          <div class="mc-studio-title">Broadcast Center</div>
          <div class="mc-studio-sub">Push a presentation, playlist, or media item live to your displays.</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--mc-space-lg);align-items:start">
          <div class="mc-panel" style="padding:var(--mc-space-lg)">
            <div style="font-weight:var(--mc-fw-bold);color:var(--mc-text-primary);margin-bottom:10px">1 · Choose content</div>
            <div id="bcTabs" style="display:flex;gap:6px;margin-bottom:12px"></div>
            <div id="bcSources" style="max-height:48vh;overflow-y:auto"></div>
          </div>
          <div class="mc-panel" style="padding:var(--mc-space-lg)">
            <div style="font-weight:var(--mc-fw-bold);color:var(--mc-text-primary);margin-bottom:10px">2 · Choose displays</div>
            <div id="bcTargets" style="max-height:48vh;overflow-y:auto"></div>
          </div>
        </div>
        <div class="mc-panel" style="margin-top:var(--mc-space-lg);padding:14px var(--mc-space-lg);display:flex;align-items:center;gap:var(--mc-space-md);flex-wrap:wrap">
          <span id="bcInfo" style="color:var(--mc-text-secondary);font-size:var(--mc-font-size-sm)">no source · 0 displays</span>
          <button id="bcGo" class="mc-action-btn-primary" disabled style="margin-left:auto;border:none;border-radius:var(--mc-radius-sm);padding:11px 22px;font-weight:var(--mc-fw-bold);cursor:pointer">📡 Broadcast now</button>
        </div>
        <div class="mc-panel" id="bcCtl" style="margin-top:var(--mc-space-md);padding:14px var(--mc-space-lg);display:flex;align-items:center;gap:var(--mc-space-md);flex-wrap:wrap">
          <span style="font-weight:var(--mc-fw-bold);color:var(--mc-text-primary)">Live control</span>
          <span id="bcCtlInfo" style="color:var(--mc-text-tertiary);font-size:var(--mc-font-size-sm)">select displays above</span>
          <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap">
            <button type="button" data-ctl="prev" class="bc-ctl">⏮ Prev</button>
            <button type="button" data-ctl="play_pause" class="bc-ctl">⏯ Play / Pause</button>
            <button type="button" data-ctl="next" class="bc-ctl">⏭ Next</button>
            <button type="button" data-ctl="restart" class="bc-ctl">⟲ Restart</button>
            <button type="button" data-ctl="blank" id="bcBlank" class="bc-ctl">⬛ Blank</button>
          </div>
        </div>
        <p style="margin-top:10px;font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary)">Live control sends Next/Previous/Play-Pause to the selected displays. For a broadcast presentation it advances slides; for a playlist or video it steps items / pauses playback.</p>
      </div>
    </div>`;

  renderTabs();
  document.getElementById('bcSources').innerHTML = '<div class="mc-panel-empty">Loading…</div>';
  document.getElementById('bcTargets').innerHTML = '<div class="mc-panel-empty">Loading…</div>';

  const [catalog, presentations, playlists, content] = await Promise.all([
    waitForTargetCatalog({ includeVirtualDisplays: false }).catch(() => null),
    api.presentations.list().catch(() => []),
    api.getPlaylists().catch(() => []),
    api.getContent().catch(() => []),
  ]);
  data = { catalog, presentations: asArray(presentations), playlists: asArray(playlists), content: asArray(content), ncFiles: [], ncPath: '' };

  renderSources();
  renderTargets();
  updateBar();

  document.getElementById('bcTabs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    sel = { type: b.dataset.tab, id: null, label: '' };
    if (sel.type === 'nc_file') {
      for (const key of [...targets]) if (key.startsWith('live-program:')) targets.delete(key);
      targetReferences = targetReferences.filter((target) => target.type !== 'live-program');
      renderTargets();
    }
    renderTabs(); updateBar();
    if (b.dataset.tab === 'nc_file') {
      data.ncPath = '';
      await loadNcFiles();
    }
    renderSources(); updateBar();
  });
  document.getElementById('bcSources').addEventListener('click', (e) => {
    const row = e.target.closest('[data-src]'); if (!row) return;
    sel.id = row.dataset.src; sel.label = row.dataset.label;
    renderSources(); updateBar();
  });
  document.getElementById('bcTargets').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-choose-targets]') || !data.catalog) return;
    try {
      data.catalog = await waitForTargetCatalog(
        { includeVirtualDisplays: false },
        { requireFresh: true },
      );
    } catch (error) {
      showToast(error.message || 'Could not refresh live room topology.', 'error');
      return;
    }
    const selection = await openTargetPicker({
      catalog: data.catalog,
      capability: 'content',
      selection: 'multiple',
      allowOffline: false,
      allowIndividualWallMembers: false,
      allowLiveProgram: sel.type !== 'nc_file',
      selectedTargets: [...targets],
    });
    if (!selection) return;
    targetReferences = selection.references;
    targets = new Set(selection.references.map(targetKey));
    renderTargets();
    updateBar();
  });
  document.getElementById('bcGo').addEventListener('click', broadcast);

  // Live-control bar: base styling + send transport/blank to selected displays.
  document.querySelectorAll('.bc-ctl').forEach((b) => {
    b.style.cssText += ';background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:8px 13px;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm)';
  });
  document.getElementById('bcCtl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctl]'); if (!b || b.disabled) return;
    const ids = selectedDeviceIds();
    if (!ids.length) { showToast('Select one or more physical displays first', 'info'); return; }
    const ctl = b.dataset.ctl;
    if (ctl === 'blank') {
      ids.forEach((id) => sendCommand(id, blanked ? 'screen_on' : 'screen_off'));
      blanked = !blanked;
      const bb = document.getElementById('bcBlank'); if (bb) bb.textContent = blanked ? '◻ Unblank' : '⬛ Blank';
      showToast(`${blanked ? 'Blanked' : 'Unblanked'} ${ids.length} display(s)`, 'success');
      return;
    }
    ids.forEach((id) => sendCommand(id, 'transport', { action: ctl }));
    showToast(`Sent ${ctl.replace('_', '/')} to ${ids.length} display(s)`, 'success');
  });
  updateBar();
}

export function cleanup() { /* in-memory only */ }
