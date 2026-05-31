// MBFD Media Control Studio — Schedules.
// Plan content/playlist windows on a display or group, with optional recurrence
// (daily / weekly by weekday → RRULE). Backed by /api/schedules. List + create +
// enable-toggle + delete. A focused, functional v1 (table + form), not a full
// calendar. CSP-safe: addEventListener + inline styles only.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm.js';
import { renderWeekInto } from './schedule-week.js';

let data = { schedules: [], devices: [], groups: [], content: [], playlists: [] };
let mode = 'list'; // 'list' | 'week'

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function asArray(v) { return Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []); }

const FIELD = 'width:100%;padding:9px 12px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);font-size:var(--mc-font-size-base);background:var(--mc-surface);color:var(--mc-text-primary);box-sizing:border-box';
const LABEL = 'display:block;font-size:var(--mc-font-size-xs);font-weight:var(--mc-fw-semibold);color:var(--mc-text-secondary);text-transform:uppercase;letter-spacing:.04em;margin:0 0 5px';
const WEEKDAYS = [['MO', 'Mon'], ['TU', 'Tue'], ['WE', 'Wed'], ['TH', 'Thu'], ['FR', 'Fri'], ['SA', 'Sat'], ['SU', 'Sun']];

function deviceName(id) { const d = data.devices.find((x) => x.id === id); return d ? (d.name || 'Display') : id; }

function targetLabel(s) {
  if (s.group_id) return `Group: ${esc(s.group_name || 'group')}`;
  if (s.device_id) return `Display: ${esc(deviceName(s.device_id))}`;
  return '—';
}
function sourceLabel(s) {
  if (s.playlist_name) return `Playlist: ${esc(s.playlist_name)}`;
  if (s.content_name) return `Media: ${esc(s.content_name)}`;
  if (s.widget_name) return `Widget: ${esc(s.widget_name)}`;
  return '—';
}
function whenLabel(s) {
  const fmt = (t) => { if (!t) return '?'; return String(t).replace('T', ' ').slice(0, 16); };
  let r = `${fmt(s.start_time)} → ${fmt(s.end_time)}`;
  if (s.recurrence) r += `  ·  ${recurrenceLabel(s.recurrence)}`;
  return r;
}
function recurrenceLabel(rrule) {
  if (!rrule) return 'once';
  if (/FREQ=DAILY/.test(rrule)) return 'daily';
  if (/FREQ=WEEKLY/.test(rrule)) {
    const m = /BYDAY=([^;]+)/.exec(rrule);
    if (m) { const map = Object.fromEntries(WEEKDAYS); return 'weekly: ' + m[1].split(',').map((d) => map[d] || d).join(' '); }
    return 'weekly';
  }
  if (/FREQ=MONTHLY/.test(rrule)) return 'monthly';
  return 'recurring';
}

function renderList() {
  const wrap = document.getElementById('schList');
  if (!wrap) return;
  if (!data.schedules.length) {
    wrap.innerHTML = '<div class="mc-panel-empty">No schedules yet. Create one with the form on the right.</div>';
    return;
  }
  wrap.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:var(--mc-font-size-sm)">
      <thead><tr style="text-align:left;color:var(--mc-text-tertiary);font-size:var(--mc-font-size-xs);text-transform:uppercase;letter-spacing:.04em">
        <th style="padding:8px 10px">Title</th><th style="padding:8px 10px">Target</th><th style="padding:8px 10px">Source</th>
        <th style="padding:8px 10px">When</th><th style="padding:8px 10px">Pri</th><th style="padding:8px 10px"></th><th style="padding:8px 10px"></th>
      </tr></thead>
      <tbody>${data.schedules.map((s) => `
        <tr style="border-top:1px solid var(--mc-border-light)">
          <td style="padding:8px 10px;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold)">${esc(s.title || '(untitled)')}</td>
          <td style="padding:8px 10px;color:var(--mc-text-secondary)">${targetLabel(s)}</td>
          <td style="padding:8px 10px;color:var(--mc-text-secondary)">${sourceLabel(s)}</td>
          <td style="padding:8px 10px;color:var(--mc-text-secondary);white-space:nowrap">${whenLabel(s)}</td>
          <td style="padding:8px 10px;color:var(--mc-text-secondary)">${esc(s.priority || 0)}</td>
          <td style="padding:8px 10px"><button type="button" data-toggle="${esc(s.id)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:999px;padding:4px 11px;cursor:pointer;font-size:var(--mc-font-size-xs);color:${s.enabled ? 'var(--mc-online,#16A34A)' : 'var(--mc-text-tertiary)'}">${s.enabled ? '● enabled' : '○ disabled'}</button></td>
          <td style="padding:8px 10px"><button type="button" data-del="${esc(s.id)}" style="background:none;border:none;cursor:pointer;color:var(--mc-danger);font-size:16px">🗑</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function renderForm() {
  const wrap = document.getElementById('schForm');
  if (!wrap) return;
  const targetOpts = `
    <optgroup label="Displays">${data.devices.map((d) => `<option value="dev:${esc(d.id)}">${esc(d.name || 'Display')}</option>`).join('')}</optgroup>
    <optgroup label="Groups">${data.groups.map((g) => `<option value="grp:${esc(g.id)}">${esc(g.name)}</option>`).join('')}</optgroup>`;
  const sourceOpts = `
    <optgroup label="Playlists">${data.playlists.map((p) => `<option value="playlist:${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>
    <optgroup label="Media">${data.content.map((c) => `<option value="content:${esc(c.id)}">${esc(c.filename || 'file')}</option>`).join('')}</optgroup>`;
  const noTargets = !data.devices.length && !data.groups.length;
  wrap.innerHTML = `
    <div style="font-weight:var(--mc-fw-bold);color:var(--mc-text-primary);margin-bottom:14px">New schedule</div>
    ${noTargets ? '<div class="mc-panel-empty" style="margin-bottom:12px">Pair a display (or make a group) first — then you can schedule to it.</div>' : ''}
    <div style="margin-bottom:14px"><label style="${LABEL}">Title</label><input id="schTitle" type="text" placeholder="e.g. Morning briefing loop" style="${FIELD}"></div>
    <div style="margin-bottom:14px"><label style="${LABEL}">Target display / group</label><select id="schTarget" style="${FIELD}">${targetOpts}</select></div>
    <div style="margin-bottom:14px"><label style="${LABEL}">Content</label><select id="schSource" style="${FIELD}">${sourceOpts}</select></div>
    <div style="display:flex;gap:12px;margin-bottom:14px">
      <div style="flex:1"><label style="${LABEL}">Start</label><input id="schStart" type="datetime-local" style="${FIELD}"></div>
      <div style="flex:1"><label style="${LABEL}">End</label><input id="schEnd" type="datetime-local" style="${FIELD}"></div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:14px">
      <div style="flex:1"><label style="${LABEL}">Repeat</label>
        <select id="schRepeat" style="${FIELD}"><option value="">Once</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option></select></div>
      <div style="width:120px"><label style="${LABEL}">Priority</label><input id="schPriority" type="number" value="0" min="0" max="100" style="${FIELD}"></div>
    </div>
    <div id="schDays" style="display:none;margin-bottom:14px">
      <label style="${LABEL}">On days</label>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${WEEKDAYS.map(([v, l]) => `<label style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--mc-border-medium);border-radius:999px;padding:5px 10px;cursor:pointer;font-size:var(--mc-font-size-xs)"><input type="checkbox" data-day="${v}" style="margin:0">${l}</label>`).join('')}</div>
    </div>
    <button id="schSave" class="mc-action-btn-primary" ${noTargets ? 'disabled' : ''} style="width:100%;border:none;border-radius:var(--mc-radius-sm);padding:11px;font-weight:var(--mc-fw-bold);cursor:pointer">Create schedule</button>`;

  document.getElementById('schRepeat').addEventListener('change', (e) => {
    document.getElementById('schDays').style.display = e.target.value === 'WEEKLY' ? 'block' : 'none';
  });
  document.getElementById('schSave').addEventListener('click', save);
}

async function save() {
  const g = (id) => document.getElementById(id);
  const target = g('schTarget').value;
  const source = g('schSource').value;
  const start = g('schStart').value;
  const end = g('schEnd').value;
  if (!target) { showToast('Pick a target display or group', 'info'); return; }
  if (!start || !end) { showToast('Start and end time are required', 'info'); return; }
  if (end <= start) { showToast('End must be after start', 'info'); return; }

  const payload = {
    title: g('schTitle').value.trim(),
    start_time: start, end_time: end,
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
    priority: parseInt(g('schPriority').value, 10) || 0,
  };
  const [tType, tId] = target.split(':');
  if (tType === 'dev') payload.device_id = tId; else payload.group_id = tId;
  if (source) { const [sType, sId] = source.split(':'); if (sType === 'playlist') payload.playlist_id = sId; else payload.content_id = sId; }

  const repeat = g('schRepeat').value;
  if (repeat === 'DAILY') payload.recurrence = 'FREQ=DAILY';
  else if (repeat === 'WEEKLY') {
    const days = [...document.querySelectorAll('#schDays input[data-day]:checked')].map((c) => c.dataset.day);
    payload.recurrence = 'FREQ=WEEKLY' + (days.length ? ';BYDAY=' + days.join(',') : '');
  }

  const btn = g('schSave'); if (btn) btn.disabled = true;
  try {
    await api.schedules.create(payload);
    showToast('Schedule created', 'success');
    data.schedules = asArray(await api.schedules.list());
    renderList();
    renderForm();
  } catch (e) { showToast(e.message || 'Could not create schedule', 'error'); if (btn) btn.disabled = false; }
}

function modeBtn(key, label) {
  const on = mode === key;
  return `<button type="button" data-mode="${key}" style="background:${on ? 'var(--mc-primary,#DC2626)' : 'var(--mc-surface)'};color:${on ? '#fff' : 'var(--mc-text-primary)'};border:1px solid ${on ? 'var(--mc-primary,#DC2626)' : 'var(--mc-border-medium)'};border-radius:var(--mc-radius-sm);padding:7px 16px;cursor:pointer;font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm)">${label}</button>`;
}

function attachListEvents() {
  const list = document.getElementById('schList');
  if (!list) return;
  list.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    const tog = e.target.closest('[data-toggle]');
    if (del) {
      const ok = await confirmDialog({ title: 'Delete schedule?', message: 'This removes the scheduled window.', confirmLabel: 'Delete', tone: 'danger' });
      if (!ok) return;
      try { await api.schedules.remove(del.dataset.del); data.schedules = data.schedules.filter((s) => s.id !== del.dataset.del); renderList(); showToast('Deleted', 'success'); }
      catch (err) { showToast(err.message || 'Delete failed', 'error'); }
      return;
    }
    if (tog) {
      const s = data.schedules.find((x) => x.id === tog.dataset.toggle); if (!s) return;
      try { const upd = await api.schedules.update(s.id, { enabled: s.enabled ? 0 : 1 }); Object.assign(s, { enabled: upd.enabled }); renderList(); }
      catch (err) { showToast(err.message || 'Update failed', 'error'); }
    }
  });
}

function renderBody() {
  const body = document.getElementById('schBody');
  if (!body) return;
  if (mode === 'week') {
    body.innerHTML = '<div class="mc-panel" id="schWeekMount" style="padding:var(--mc-space-lg)"></div>';
    renderWeekInto(document.getElementById('schWeekMount'), data.devices);
    return;
  }
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 380px;gap:var(--mc-space-lg);align-items:start">
      <div class="mc-panel" id="schList" style="padding:var(--mc-space-md);overflow-x:auto"><div class="mc-panel-empty">Loading…</div></div>
      <div class="mc-panel" id="schForm" style="padding:var(--mc-space-lg)"></div>
    </div>`;
  renderList();
  renderForm();
  attachListEvents();
}

export async function render(app) {
  mode = 'list';
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap" style="max-width:1300px">
        <div style="display:flex;align-items:flex-end;gap:var(--mc-space-md);flex-wrap:wrap;margin-bottom:var(--mc-space-lg)">
          <div style="flex:1;min-width:200px">
            <div class="mc-studio-title">Schedules</div>
            <div class="mc-studio-sub">Plan content windows across displays and groups, with optional daily/weekly recurrence.</div>
          </div>
          <div id="schModeToggle" style="display:flex;gap:6px">${modeBtn('list', 'List')}${modeBtn('week', 'Week')}</div>
        </div>
        <div id="schBody"><div class="mc-panel-empty">Loading…</div></div>
      </div>
    </div>`;

  const [schedules, devices, groups, content, playlists] = await Promise.all([
    api.schedules.list().catch(() => []),
    api.getDevices().catch(() => []),
    api.getGroups().catch(() => []),
    api.getContent().catch(() => []),
    api.getPlaylists().catch(() => []),
  ]);
  data = { schedules: asArray(schedules), devices: asArray(devices), groups: asArray(groups), content: asArray(content), playlists: asArray(playlists) };

  renderBody();

  document.getElementById('schModeToggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    document.getElementById('schModeToggle').innerHTML = modeBtn('list', 'List') + modeBtn('week', 'Week');
    renderBody();
  });
}

export function cleanup() { /* in-memory only */ }
