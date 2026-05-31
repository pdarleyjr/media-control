// MBFD Media Control Studio — Schedules weekly calendar.
// Renders a 7-day × 24h time grid of a chosen display's scheduled events, using
// the server's recurrence-expanded GET /api/schedules/week (RRULEs already
// resolved into instances). Read-with-delete: click an event to remove its
// schedule. CSP-safe: addEventListener + inline styles only.
//
// Note on time: non-recurring instances are stored naive-local; recurring
// instances come back as UTC ISO — both are parsed with the browser Date and
// placed by local hour. Minor recurring-event tz shift is a known v1 rough edge.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm.js';

const HH = 42;            // px per hour
const DAY_MS = 86400000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function sundayOf(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }
function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

let state = { deviceId: null, weekStart: sundayOf(new Date()), events: [] };

function eventSource(ev) {
  if (ev.playlist_name) return ev.playlist_name;
  if (ev.content_name) return ev.content_name;
  if (ev.widget_name) return ev.widget_name;
  return '';
}

function gridHtml() {
  const ws = state.weekStart;
  const today = startOfDay(new Date()).getTime();
  // Hour gutter labels.
  let hours = '';
  for (let h = 0; h < 24; h++) {
    hours += `<div style="height:${HH}px;position:relative"><span style="position:absolute;top:-7px;right:6px;font-size:10px;color:var(--mc-text-tertiary)">${String(h).padStart(2, '0')}:00</span></div>`;
  }
  // Day columns header.
  let head = '<div style="width:52px;flex:0 0 52px"></div>';
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws); d.setDate(d.getDate() + i);
    const isToday = startOfDay(d).getTime() === today;
    head += `<div style="flex:1;text-align:center;padding:6px 0;border-left:1px solid var(--mc-border-light);${isToday ? 'background:var(--mc-live-dim,#FEE2E2);border-radius:6px 6px 0 0' : ''}">
      <div style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary);text-transform:uppercase">${DAYS[i]}</div>
      <div style="font-weight:var(--mc-fw-bold);color:${isToday ? 'var(--mc-primary,#DC2626)' : 'var(--mc-text-primary)'}">${d.getDate()}</div>
    </div>`;
  }
  // Build per-day event blocks.
  const cols = [];
  for (let i = 0; i < 7; i++) cols.push('');
  for (const ev of state.events) {
    const s = new Date(ev.instance_start || ev.start_time);
    const e = new Date(ev.instance_end || ev.end_time);
    if (isNaN(s) || isNaN(e)) continue;
    const dayIdx = Math.round((startOfDay(s).getTime() - ws.getTime()) / DAY_MS);
    if (dayIdx < 0 || dayIdx > 6) continue;
    const startMin = s.getHours() * 60 + s.getMinutes();
    const durMin = Math.max(20, (e - s) / 60000);
    const top = (startMin / 60) * HH;
    const height = Math.min((24 * HH) - top, (durMin / 60) * HH);
    const color = ev.color || '#3B82F6';
    cols[dayIdx] += `<div data-sched="${esc(ev.id)}" title="Click to delete" style="position:absolute;left:3px;right:3px;top:${top}px;height:${height}px;background:${esc(color)};opacity:.92;color:#fff;border-radius:5px;padding:3px 6px;overflow:hidden;cursor:pointer;font-size:11px;line-height:1.25;box-shadow:0 1px 3px rgba(0,0,0,.2)">
      <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(ev.title || '(untitled)')}</div>
      <div style="opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${hhmm(s)} · ${esc(eventSource(ev))}</div>
    </div>`;
  }
  let body = '<div style="width:52px;flex:0 0 52px">' + hours + '</div>';
  for (let i = 0; i < 7; i++) {
    const lines = Array.from({ length: 24 }, () => `<div style="height:${HH}px;border-top:1px solid var(--mc-border-light)"></div>`).join('');
    body += `<div style="flex:1;position:relative;border-left:1px solid var(--mc-border-light)">${lines}${cols[i]}</div>`;
  }
  return `
    <div style="display:flex;position:sticky;top:0;background:var(--mc-surface);z-index:2;border-bottom:1px solid var(--mc-border-medium)">${head}</div>
    <div style="display:flex">${body}</div>`;
}

async function refresh() {
  const grid = document.getElementById('swGrid');
  if (!state.deviceId) { if (grid) grid.innerHTML = '<div class="mc-panel-empty">Pick a display above to see its weekly schedule.</div>'; return; }
  if (grid) grid.innerHTML = '<div class="mc-panel-empty">Loading…</div>';
  try {
    const dateStr = state.weekStart.toISOString().slice(0, 10);
    const res = await api.schedules.week(state.deviceId, dateStr);
    state.events = Array.isArray(res) ? res : [];
  } catch (e) { if (grid) grid.innerHTML = `<div class="mc-panel-empty">Could not load week (${esc(e.message || '')}).</div>`; return; }
  if (grid) { grid.innerHTML = gridHtml(); grid.scrollTop = 7 * HH; }
  const lbl = document.getElementById('swRange');
  if (lbl) {
    const end = new Date(state.weekStart); end.setDate(end.getDate() + 6);
    lbl.textContent = `${state.weekStart.toLocaleDateString()} – ${end.toLocaleDateString()}`;
  }
}

// Render the week calendar into `mount`. devices = [{id,name}]. Returns nothing.
export function renderWeekInto(mount, devices) {
  state = { deviceId: (devices[0] && devices[0].id) || null, weekStart: sundayOf(new Date()), events: [] };
  if (!devices.length) {
    mount.innerHTML = '<div class="mc-panel-empty">No displays yet — pair a display to use the weekly calendar. (Schedules to groups still show in the List tab.)</div>';
    return;
  }
  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <select id="swDevice" style="padding:8px 11px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);background:var(--mc-surface);color:var(--mc-text-primary)">
        ${devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name || 'Display')}</option>`).join('')}
      </select>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
        <button id="swPrev" type="button" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 12px;cursor:pointer;color:var(--mc-text-primary)">‹</button>
        <button id="swToday" type="button" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 14px;cursor:pointer;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold)">This week</button>
        <button id="swNext" type="button" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 12px;cursor:pointer;color:var(--mc-text-primary)">›</button>
        <span id="swRange" style="margin-left:8px;color:var(--mc-text-secondary);font-size:var(--mc-font-size-sm)"></span>
      </div>
    </div>
    <div id="swGrid" style="max-height:62vh;overflow-y:auto;border:1px solid var(--mc-border-light);border-radius:var(--mc-radius-sm)"></div>`;

  mount.querySelector('#swDevice').addEventListener('change', (e) => { state.deviceId = e.target.value; refresh(); });
  mount.querySelector('#swPrev').addEventListener('click', () => { state.weekStart.setDate(state.weekStart.getDate() - 7); state.weekStart = new Date(state.weekStart); refresh(); });
  mount.querySelector('#swNext').addEventListener('click', () => { state.weekStart.setDate(state.weekStart.getDate() + 7); state.weekStart = new Date(state.weekStart); refresh(); });
  mount.querySelector('#swToday').addEventListener('click', () => { state.weekStart = sundayOf(new Date()); refresh(); });
  mount.querySelector('#swGrid').addEventListener('click', async (e) => {
    const blk = e.target.closest('[data-sched]'); if (!blk) return;
    const ok = await confirmDialog({ title: 'Delete this schedule?', message: 'Removes the schedule (and all its recurring instances).', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try { await api.schedules.remove(blk.dataset.sched); showToast('Schedule deleted', 'success'); refresh(); }
    catch (err) { showToast(err.message || 'Delete failed', 'error'); }
  });

  refresh();
}
