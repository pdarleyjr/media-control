// MBFD Media Control Studio — Presentations (deck library). Phase 2b.
// Workspace-scoped list of mbfd-deck-v1 decks with inline create + open/
// duplicate/delete. Renders on the light `.mc-studio-surface`. CSP-safe:
// static innerHTML + addEventListener (no inline scripts); inline style attrs
// are permitted by the dashboard CSP and used for the deck-card grid.

import { api } from '../api.js';
import { confirmDialog } from '../components/confirm.js';
import { showToast } from '../components/toast.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDate(epoch) {
  if (!epoch) return '';
  try { return new Date(epoch * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return ''; }
}

function deckCard(p) {
  const live = p.status === 'published';
  return `
    <div class="mc-stat-card" style="display:flex;flex-direction:column;gap:var(--mc-space-sm)" data-deck="${esc(p.id)}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:var(--mc-space-sm)">
        <div style="font-weight:var(--mc-fw-bold);font-size:var(--mc-font-size-lg);line-height:1.2;word-break:break-word">${esc(p.title)}</div>
        <span style="flex-shrink:0;font-size:var(--mc-font-size-xs);font-weight:var(--mc-fw-bold);padding:2px 10px;border-radius:var(--mc-radius-full);${live ? 'background:var(--mc-live-dim);color:var(--mc-live)' : 'background:var(--mc-bg-secondary);color:var(--mc-text-secondary)'}">${live ? 'Published' : 'Draft'}</span>
      </div>
      <div style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary)">${p.slide_count || 0} slide${(p.slide_count || 0) === 1 ? '' : 's'} · ${esc(p.canvas_profile || '16x9')}${p.updated_at ? ' · ' + esc(fmtDate(p.updated_at)) : ''}</div>
      ${p.description ? `<div style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.description)}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:var(--mc-space-sm);margin-top:auto;padding-top:var(--mc-space-sm)">
        <button class="mc-action-btn-primary" data-present="${esc(p.id)}" style="border:none;border-radius:var(--mc-radius-sm);padding:6px 14px;font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm);cursor:pointer">▶ Present</button>
        <button data-preview="${esc(p.id)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:6px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;color:var(--mc-text-primary)">Preview</button>
        <button data-dup="${esc(p.id)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:6px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;color:var(--mc-text-primary)">Duplicate</button>
        <button data-del="${esc(p.id)}" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:6px 12px;font-size:var(--mc-font-size-sm);cursor:pointer;color:var(--mc-danger);margin-left:auto">Delete</button>
      </div>
    </div>`;
}

async function load(app) {
  let decks = [];
  let errored = false;
  try { decks = await api.presentations.list(); if (!Array.isArray(decks)) decks = []; }
  catch (e) { errored = true; }

  const grid = decks.length
    ? `<div class="mc-stat-grid" id="deckGrid">${decks.map(deckCard).join('')}</div>`
    : `<div class="mc-panel"><div class="mc-panel-empty">${errored ? 'Could not load presentations.' : 'No presentations yet. Create your first deck above, or generate one with the AI Deck Builder.'}${errored ? '' : ' <a class="mc-panel-empty-cta" href="#/ai-deck">Open AI Deck Builder →</a>'}</div></div>`;

  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap">
        <div class="mc-studio-header" style="display:flex;align-items:flex-end;justify-content:space-between;gap:var(--mc-space-lg);flex-wrap:wrap">
          <div>
            <div class="mc-studio-title">Presentations</div>
            <div class="mc-studio-sub">Your deck library — create, manage, and broadcast presentations.</div>
          </div>
        </div>
        <div style="display:flex;gap:var(--mc-space-sm);margin-bottom:var(--mc-space-xl);max-width:560px">
          <input id="newDeckTitle" type="text" placeholder="New presentation title…" maxlength="120"
            style="flex:1;padding:10px 14px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);font-size:var(--mc-font-size-base);background:var(--mc-surface);color:var(--mc-text-primary);font-family:var(--mc-font-family-sans)">
          <button id="createDeckBtn" class="mc-action-btn-primary" style="border:none;border-radius:var(--mc-radius-sm);padding:0 20px;font-weight:var(--mc-fw-semibold);cursor:pointer">+ New Presentation</button>
        </div>
        ${grid}
      </div>
    </div>`;

  // Create
  const titleEl = document.getElementById('newDeckTitle');
  const createBtn = document.getElementById('createDeckBtn');
  async function create() {
    const title = (titleEl.value || '').trim();
    if (!title) { titleEl.focus(); return; }
    createBtn.disabled = true;
    try {
      await api.presentations.create({ title });
      showToast('Presentation created', 'success');
      await load(app);
    } catch (e) {
      showToast(e.message || 'Could not create presentation', 'error');
      createBtn.disabled = false;
    }
  }
  createBtn?.addEventListener('click', create);
  titleEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  // Card actions (event delegation)
  app.querySelector('.mc-studio-wrap')?.addEventListener('click', async (e) => {
    const present = e.target.closest('[data-present]');
    const preview = e.target.closest('[data-preview]');
    const dup = e.target.closest('[data-dup]');
    const del = e.target.closest('[data-del]');
    if (preview) { window.open(`/player/deck/${encodeURIComponent(preview.dataset.preview)}`, '_blank', 'noopener'); return; }
    if (present) {
      const pid = present.dataset.present;
      let devices = [];
      try { devices = await api.getDevices(); if (!Array.isArray(devices)) devices = []; } catch (_) { /* */ }
      const ids = devices.map((d) => d.id);
      if (!ids.length) { showToast('No displays paired yet — pair one from Displays first.', 'info'); return; }
      const url = `${location.origin}/player/deck/${pid}`;
      try {
        let r = await api.broadcast({ device_ids: ids, remote_url: url });
        if (r && r.code === 'CONFIRM_ALL_REQUIRED') {
          const ok = await confirmDialog({
            title: 'Present to ALL displays?',
            message: `This takes over all ${r.count} display(s) in this workspace with the presentation.`,
            confirmLabel: 'Present to all', cancelLabel: 'Cancel', tone: 'danger',
          });
          if (!ok) return;
          r = await api.broadcast({ device_ids: ids, remote_url: url, confirm_all: true });
        }
        showToast(`Presenting to ${r.sent != null ? r.sent : ids.length} display(s)`, 'success');
      } catch (err) { showToast(err.message || 'Broadcast failed', 'error'); }
      return;
    }
    if (dup) {
      try { await api.presentations.duplicate(dup.dataset.dup); showToast('Duplicated', 'success'); await load(app); }
      catch (err) { showToast(err.message || 'Duplicate failed', 'error'); }
      return;
    }
    if (del) {
      const ok = await confirmDialog({
        title: 'Delete presentation?',
        message: 'This permanently deletes the deck and its slides. This cannot be undone.',
        confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger',
      });
      if (!ok) return;
      try { await api.presentations.remove(del.dataset.del); showToast('Deleted', 'success'); await load(app); }
      catch (err) { showToast(err.message || 'Delete failed', 'error'); }
    }
  });
}

export async function render(app) {
  await load(app);
}
