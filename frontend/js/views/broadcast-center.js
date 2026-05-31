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

let data = { devices: [], groups: [], presentations: [], playlists: [], content: [] };
let sel = { type: 'presentation', id: null, label: '' };
let targets = new Set();
let blanked = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function asArray(v) { return Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []); }
function isOnline(d) { return String(d.status || '').toLowerCase() === 'online'; }

const ROW = 'display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid var(--mc-border-light);background:var(--mc-surface);margin-bottom:6px';
const ROW_SEL = 'display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid var(--mc-primary);background:var(--mc-live-dim,#FEE2E2);margin-bottom:6px';

const SOURCE_TABS = [
  { key: 'presentation', label: 'Presentations' },
  { key: 'playlist', label: 'Playlists' },
  { key: 'media', label: 'Media' },
];

function sourceItems() {
  if (sel.type === 'presentation') return data.presentations.map((p) => ({ id: p.id, label: p.title || '(untitled)', sub: (p.slide_count != null ? p.slide_count + ' slides' : '') }));
  if (sel.type === 'playlist') return data.playlists.map((p) => ({ id: p.id, label: p.name || '(untitled)', sub: p.description || '' }));
  return data.content.map((c) => ({ id: c.id, label: c.filename || '(file)', sub: c.mime_type || '' }));
}

function renderSources() {
  const wrap = document.getElementById('bcSources');
  if (!wrap) return;
  const items = sourceItems();
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
  if (!data.devices.length) {
    wrap.innerHTML = `<div class="mc-panel-empty">No displays paired yet. Pair one from <a class="mc-panel-empty-cta" href="#/">Displays</a>, then broadcast here.</div>`;
    return;
  }
  const groupChips = data.groups.length ? `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <button type="button" data-all="1" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:var(--mc-font-size-xs);color:var(--mc-text-primary)">Select all</button>
      ${data.groups.map((g) => `<button type="button" data-group="${esc(g.id)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:var(--mc-font-size-xs);color:var(--mc-text-primary)">${esc(g.name)}</button>`).join('')}
    </div>` : `
    <div style="margin-bottom:10px"><button type="button" data-all="1" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:var(--mc-font-size-xs);color:var(--mc-text-primary)">Select all</button></div>`;
  wrap.innerHTML = groupChips + data.devices.map((d) => `
    <label data-dev="${esc(d.id)}" style="${targets.has(d.id) ? ROW_SEL : ROW}">
      <input type="checkbox" ${targets.has(d.id) ? 'checked' : ''} style="margin:0">
      <span style="width:8px;height:8px;border-radius:50%;background:${isOnline(d) ? 'var(--mc-online,#16A34A)' : 'var(--mc-text-tertiary,#9CA3AF)'};flex:0 0 auto"></span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mc-text-primary)">${esc(d.name || 'Display')}</span>
      <span style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary)">${isOnline(d) ? 'online' : 'offline'}</span>
    </label>`).join('');
}

function updateBar() {
  const btn = document.getElementById('bcGo');
  const info = document.getElementById('bcInfo');
  if (info) info.textContent = `${targets.size} display${targets.size === 1 ? '' : 's'} · ${sel.id ? '1 source' : 'no source'}`;
  if (btn) btn.disabled = !(sel.id && targets.size);
  // Live-control buttons act on the selected displays (independent of source).
  document.querySelectorAll('.bc-ctl').forEach((b) => { b.disabled = !targets.size; b.style.opacity = targets.size ? '1' : '.45'; b.style.cursor = targets.size ? 'pointer' : 'not-allowed'; });
  const ci = document.getElementById('bcCtlInfo');
  if (ci) ci.textContent = targets.size ? `${targets.size} display${targets.size === 1 ? '' : 's'} selected` : 'select displays above';
}

async function broadcast() {
  if (!sel.id || !targets.size) return;
  const btn = document.getElementById('bcGo');
  if (btn) btn.disabled = true;
  const device_ids = [...targets];
  const payload = { device_ids };
  if (sel.type === 'presentation') payload.remote_url = `${location.origin}/player/deck/${sel.id}`;
  else if (sel.type === 'playlist') payload.playlist_id = sel.id;
  else payload.content_id = sel.id;
  try {
    let r = await api.broadcast(payload);
    if (r && r.code === 'CONFIRM_ALL_REQUIRED') {
      const ok = await confirmDialog({ title: 'Broadcast to ALL displays?', message: `This takes over all ${r.count} displays in this workspace.`, confirmLabel: 'Broadcast to all', tone: 'danger' });
      if (!ok) { updateBar(); return; }
      r = await api.broadcast({ ...payload, confirm_all: true });
    }
    showToast(`Broadcasting "${sel.label}" to ${r.sent != null ? r.sent : device_ids.length} display(s)`, 'success');
  } catch (e) {
    showToast(e.message || 'Broadcast failed', 'error');
  } finally {
    updateBar();
  }
}

export async function render(app) {
  sel = { type: 'presentation', id: null, label: '' };
  targets = new Set();
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

  const [devices, groups, presentations, playlists, content] = await Promise.all([
    api.getDevices().catch(() => []),
    api.getGroups().catch(() => []),
    api.presentations.list().catch(() => []),
    api.getPlaylists().catch(() => []),
    api.getContent().catch(() => []),
  ]);
  data = { devices: asArray(devices), groups: asArray(groups), presentations: asArray(presentations), playlists: asArray(playlists), content: asArray(content) };

  renderSources();
  renderTargets();
  updateBar();

  document.getElementById('bcTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    sel = { type: b.dataset.tab, id: null, label: '' };
    renderTabs(); renderSources(); updateBar();
  });
  document.getElementById('bcSources').addEventListener('click', (e) => {
    const row = e.target.closest('[data-src]'); if (!row) return;
    sel.id = row.dataset.src; sel.label = row.dataset.label;
    renderSources(); updateBar();
  });
  document.getElementById('bcTargets').addEventListener('click', async (e) => {
    const all = e.target.closest('[data-all]');
    const grp = e.target.closest('[data-group]');
    const dev = e.target.closest('[data-dev]');
    if (all) {
      if (targets.size === data.devices.length) targets.clear();
      else data.devices.forEach((d) => targets.add(d.id));
      renderTargets(); updateBar(); return;
    }
    if (grp) {
      try {
        const members = asArray(await api.getGroupDevices(grp.dataset.group));
        members.forEach((m) => targets.add(m.id || m.device_id));
      } catch { showToast('Could not load group displays', 'error'); }
      renderTargets(); updateBar(); return;
    }
    if (dev) {
      const id = dev.dataset.dev;
      if (targets.has(id)) targets.delete(id); else targets.add(id);
      renderTargets(); updateBar();
    }
  });
  document.getElementById('bcGo').addEventListener('click', broadcast);

  // Live-control bar: base styling + send transport/blank to selected displays.
  document.querySelectorAll('.bc-ctl').forEach((b) => {
    b.style.cssText += ';background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:8px 13px;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm)';
  });
  document.getElementById('bcCtl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctl]'); if (!b || b.disabled) return;
    if (!targets.size) { showToast('Select one or more displays first', 'info'); return; }
    const ids = [...targets];
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
