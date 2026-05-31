// MBFD Media Control Studio — Audit Log (Phase 9a).
// Read-only activity trail from /api/activity (the activity_log table; the
// activityLogger middleware auto-records POST/PUT/DELETE mutations). Renders on
// the light studio surface. CSP-safe (static innerHTML; no inline scripts).

import { api } from '../api.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function when(row) {
  const t = row.created_at || row.timestamp || row.ts;
  if (!t) return '';
  try { return new Date((typeof t === 'number' ? t * 1000 : Date.parse(t))).toLocaleString(); }
  catch { return String(t); }
}

function who(row) {
  return row.user_name || row.user_email || row.actor || row.user_id || 'system';
}

function details(row) {
  let d = row.details;
  if (d && typeof d === 'object') { try { d = JSON.stringify(d); } catch { d = ''; } }
  return d || row.after_state || '';
}

export async function render(app) {
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap">
        <div class="mc-studio-header">
          <div class="mc-studio-title">Audit Log</div>
          <div class="mc-studio-sub">Recent activity — broadcasts, content changes, AI generations, and admin actions.</div>
        </div>
        <div class="mc-panel"><div class="mc-panel-body" id="auditBody" style="padding:0">
          <div class="mc-panel-empty">Loading activity…</div>
        </div></div>
      </div>
    </div>`;

  const body = document.getElementById('auditBody');
  let rows = [];
  try { rows = await api.getActivity(150); if (!Array.isArray(rows)) rows = rows.items || []; }
  catch (e) {
    body.innerHTML = `<div class="mc-panel-empty">Could not load the activity log${e && e.message ? ' (' + esc(e.message) + ')' : ''}.</div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="mc-panel-empty">No activity recorded yet. Actions you take in the studio will appear here.</div>';
    return;
  }

  const head = `
    <div style="display:grid;grid-template-columns:200px 160px 1fr;gap:0;padding:10px var(--mc-space-lg);border-bottom:1px solid var(--mc-border-light);font-size:var(--mc-font-size-xs);font-weight:var(--mc-fw-bold);text-transform:uppercase;letter-spacing:.05em;color:var(--mc-text-secondary)">
      <div>When</div><div>Who</div><div>Action</div>
    </div>`;
  const list = rows.map((r) => `
    <div style="display:grid;grid-template-columns:200px 160px 1fr;gap:0;padding:10px var(--mc-space-lg);border-bottom:1px solid var(--mc-border-light);font-size:var(--mc-font-size-sm);align-items:baseline">
      <div style="color:var(--mc-text-secondary);font-variant-numeric:tabular-nums">${esc(when(r))}</div>
      <div style="color:var(--mc-text-primary);font-weight:var(--mc-fw-medium);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(who(r))}</div>
      <div style="color:var(--mc-text-primary)"><span style="font-weight:var(--mc-fw-semibold)">${esc(r.action || r.action_type || 'action')}</span>${details(r) ? ` <span style="color:var(--mc-text-secondary)">— ${esc(details(r))}</span>` : ''}</div>
    </div>`).join('');
  body.innerHTML = head + list;
}
