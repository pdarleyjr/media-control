// MBFD Media Control Studio — Slide Editor (Phase 3).
// Structured editor for the simple mbfd-deck-v1 slide shape (title/subtitle/
// bullets/body/speaker_notes/layout/duration). Loads a presentation's deck_json,
// edits in memory, saves the whole deck via PUT /api/presentations/:id. (A
// positional canvas editor with x/y/w/h blocks is a future enhancement; this
// covers create/edit/reorder of AI- and hand-authored decks.)
// CSP-safe: addEventListener + inline style attrs only.

import { api } from '../api.js';
import { confirmDialog } from '../components/confirm.js';
import { showToast } from '../components/toast.js';
import { createImageEditor } from './slide-image-canvas.js';

let deck = null;
let presId = null;
let sel = 0;
let dirty = false;
let imgEditor = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function idFromHash() {
  const m = (window.location.hash || '').match(/[?&]id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function blankSlide(i) {
  return { id: 'slide_' + String(i + 1).padStart(3, '0'), layout: i === 0 ? 'title' : 'content', title: '', subtitle: '', bullets: [], body: '', speaker_notes: '', duration_seconds: 12 };
}

const FIELD = 'width:100%;padding:9px 12px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);font-size:var(--mc-font-size-base);background:var(--mc-surface);color:var(--mc-text-primary);font-family:var(--mc-font-family-sans);box-sizing:border-box';
const LABEL = 'display:block;font-size:var(--mc-font-size-xs);font-weight:var(--mc-fw-semibold);color:var(--mc-text-secondary);text-transform:uppercase;letter-spacing:.04em;margin:0 0 5px';

function renderShell(app) {
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap" style="max-width:1400px">
        <div style="display:flex;align-items:center;gap:var(--mc-space-md);flex-wrap:wrap;margin-bottom:var(--mc-space-lg)">
          <a href="#/presentations" style="color:var(--mc-text-secondary);text-decoration:none;font-size:var(--mc-font-size-sm)">← Presentations</a>
          <input id="deckTitle" type="text" placeholder="Untitled" style="flex:1;min-width:200px;font-size:var(--mc-font-size-xl);font-weight:var(--mc-fw-bold);border:1px solid transparent;border-radius:var(--mc-radius-sm);padding:6px 10px;background:transparent;color:var(--mc-text-primary)">
          <span id="seStatus" style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary)"></span>
          <button id="seSave" class="mc-action-btn-primary" style="border:none;border-radius:var(--mc-radius-sm);padding:9px 18px;font-weight:var(--mc-fw-semibold);cursor:pointer">Save</button>
          <button id="sePreview" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:9px 14px;cursor:pointer;color:var(--mc-text-primary)">Preview</button>
        </div>
        <div style="display:grid;grid-template-columns:240px 1fr;gap:var(--mc-space-lg);align-items:start">
          <div class="mc-panel" style="padding:var(--mc-space-md)">
            <div id="seList" style="display:flex;flex-direction:column;gap:6px"></div>
            <button id="seAdd" style="margin-top:var(--mc-space-md);width:100%;background:var(--mc-surface);border:1px dashed var(--mc-border-strong);border-radius:var(--mc-radius-sm);padding:10px;cursor:pointer;color:var(--mc-text-secondary);font-weight:var(--mc-fw-semibold)">+ Add slide</button>
          </div>
          <div class="mc-panel" id="seForm" style="padding:var(--mc-space-xl)"></div>
        </div>
      </div>
    </div>`;
}

function renderList() {
  const list = document.getElementById('seList');
  if (!list) return;
  list.innerHTML = deck.slides.map((s, i) => `
    <button data-slide="${i}" style="text-align:left;display:flex;gap:10px;align-items:center;padding:9px 11px;border-radius:var(--mc-radius-sm);cursor:pointer;border:1px solid ${i === sel ? 'var(--mc-primary)' : 'var(--mc-border-light)'};background:${i === sel ? 'var(--mc-live-dim)' : 'var(--mc-surface)'}">
      <span style="font-variant-numeric:tabular-nums;color:var(--mc-text-tertiary);font-size:var(--mc-font-size-xs);font-weight:var(--mc-fw-bold)">${i + 1}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--mc-font-size-sm);font-weight:${i === sel ? 'var(--mc-fw-semibold)' : 'var(--mc-fw-regular)'};color:var(--mc-text-primary)">${esc(s.title || '(untitled)')}</span>
      <span style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary)">${esc(s.layout || 'content')}</span>
    </button>`).join('');
}

function renderForm() {
  const wrap = document.getElementById('seForm');
  if (!wrap) return;
  if (imgEditor) { imgEditor.destroy(); imgEditor = null; }
  const s = deck.slides[sel];
  if (!s) { wrap.innerHTML = '<div class="mc-panel-empty">No slide selected.</div>'; return; }
  wrap.innerHTML = `
    <div style="display:flex;gap:var(--mc-space-lg);flex-wrap:wrap;margin-bottom:var(--mc-space-lg)">
      <div style="flex:1;min-width:160px"><label style="${LABEL}">Layout</label>
        <select id="fLayout" style="${FIELD}">
          ${['title', 'section', 'content', 'quote'].map((l) => `<option value="${l}" ${s.layout === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div style="width:120px"><label style="${LABEL}">Seconds</label>
        <input id="fDur" type="number" min="2" max="600" value="${esc(s.duration_seconds || 12)}" style="${FIELD}"></div>
    </div>
    <div style="margin-bottom:var(--mc-space-lg)"><label style="${LABEL}">Title</label>
      <input id="fTitle" type="text" value="${esc(s.title || '')}" style="${FIELD}"></div>
    <div style="margin-bottom:var(--mc-space-lg)"><label style="${LABEL}">Subtitle</label>
      <input id="fSub" type="text" value="${esc(s.subtitle || '')}" style="${FIELD}"></div>
    <div style="margin-bottom:var(--mc-space-lg)"><label style="${LABEL}">Bullets (one per line)</label>
      <textarea id="fBullets" rows="6" style="${FIELD};resize:vertical">${esc((s.bullets || []).join('\n'))}</textarea></div>
    <div style="margin-bottom:var(--mc-space-lg)"><label style="${LABEL}">Body (used when there are no bullets)</label>
      <textarea id="fBody" rows="3" style="${FIELD};resize:vertical">${esc(s.body || '')}</textarea></div>
    <div style="margin-bottom:var(--mc-space-lg)"><label style="${LABEL}">Speaker notes</label>
      <textarea id="fNotes" rows="3" style="${FIELD};resize:vertical">${esc(s.speaker_notes || '')}</textarea></div>
    <div style="margin-bottom:var(--mc-space-lg);border-top:1px solid var(--mc-border-light);padding-top:var(--mc-space-lg)">
      <label style="${LABEL}">Images</label>
      <div id="seImagesMount"></div>
    </div>
    <div style="display:flex;gap:var(--mc-space-sm);border-top:1px solid var(--mc-border-light);padding-top:var(--mc-space-lg)">
      <button id="seUp" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 12px;cursor:pointer;color:var(--mc-text-primary)">↑ Move up</button>
      <button id="seDown" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 12px;cursor:pointer;color:var(--mc-text-primary)">↓ Move down</button>
      <button id="seDel" style="margin-left:auto;background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:7px 12px;cursor:pointer;color:var(--mc-danger)">Delete slide</button>
    </div>`;

  const mark = () => { dirty = true; setStatus('Unsaved changes'); };
  const g = (id) => document.getElementById(id);
  g('fLayout').addEventListener('change', (e) => { s.layout = e.target.value; mark(); renderList(); });
  g('fDur').addEventListener('input', (e) => { s.duration_seconds = Math.max(2, parseInt(e.target.value) || 12); mark(); });
  g('fTitle').addEventListener('input', (e) => { s.title = e.target.value; mark(); renderList(); });
  g('fSub').addEventListener('input', (e) => { s.subtitle = e.target.value; mark(); });
  g('fBullets').addEventListener('input', (e) => { s.bullets = e.target.value.split('\n').map((b) => b.trim()).filter(Boolean); mark(); });
  g('fBody').addEventListener('input', (e) => { s.body = e.target.value; mark(); });
  g('fNotes').addEventListener('input', (e) => { s.speaker_notes = e.target.value; mark(); });
  g('seUp').addEventListener('click', () => { if (sel > 0) { [deck.slides[sel - 1], deck.slides[sel]] = [deck.slides[sel], deck.slides[sel - 1]]; sel--; mark(); renderList(); renderForm(); } });
  g('seDown').addEventListener('click', () => { if (sel < deck.slides.length - 1) { [deck.slides[sel + 1], deck.slides[sel]] = [deck.slides[sel], deck.slides[sel + 1]]; sel++; mark(); renderList(); renderForm(); } });
  g('seDel').addEventListener('click', async () => {
    if (deck.slides.length <= 1) { showToast('A deck needs at least one slide', 'info'); return; }
    const ok = await confirmDialog({ title: 'Delete slide?', message: 'Remove this slide from the deck.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    deck.slides.splice(sel, 1); sel = Math.max(0, sel - 1); mark(); renderList(); renderForm();
  });

  // Image placement canvas for this slide (drag/resize, mutates s.images[]).
  const imgMount = document.getElementById('seImagesMount');
  if (imgMount && presId) imgEditor = createImageEditor({ mount: imgMount, slide: s, presId, onChange: mark });
}

function setStatus(msg) { const el = document.getElementById('seStatus'); if (el) el.textContent = msg; }

async function save() {
  const btn = document.getElementById('seSave');
  if (btn) btn.disabled = true;
  setStatus('Saving…');
  try {
    deck.title = document.getElementById('deckTitle').value.trim() || deck.title || 'Untitled';
    await api.presentations.update(presId, { deck_json: deck, title: deck.title });
    dirty = false; setStatus('Saved');
    showToast('Saved', 'success');
  } catch (e) { setStatus('Save failed'); showToast(e.message || 'Save failed', 'error'); }
  finally { if (btn) btn.disabled = false; }
}

export async function render(app) {
  presId = idFromHash();
  deck = null; sel = 0; dirty = false;
  renderShell(app);
  if (!presId) {
    document.getElementById('seForm').innerHTML = '<div class="mc-panel-empty">No presentation selected. Open one from <a class="mc-panel-empty-cta" href="#/presentations">Presentations</a>.</div>';
    return;
  }
  let p;
  try { p = await api.presentations.get(presId); }
  catch (e) { document.getElementById('seForm').innerHTML = `<div class="mc-panel-empty">Could not load presentation (${esc(e.message || '')}).</div>`; return; }
  try { deck = p.deck_json ? JSON.parse(p.deck_json) : null; } catch { deck = null; }
  if (!deck || !Array.isArray(deck.slides)) deck = { version: 'mbfd-deck-v1', deck_id: presId, title: p.title, theme: p.theme || 'mbfd-command', canvas_profile: p.canvas_profile || '16x9', slides: [], assets: [] };
  if (!deck.slides.length) deck.slides.push(blankSlide(0));

  document.getElementById('deckTitle').value = deck.title || p.title || '';
  setStatus(p.status === 'published' ? 'Published' : 'Draft');
  renderList();
  renderForm();

  document.getElementById('deckTitle').addEventListener('input', () => { dirty = true; setStatus('Unsaved changes'); });
  document.getElementById('seSave').addEventListener('click', save);
  document.getElementById('sePreview').addEventListener('click', async () => {
    if (dirty) await save();
    window.open(`/player/deck/${presId}`, '_blank', 'noopener');
  });
  document.getElementById('seAdd').addEventListener('click', () => {
    deck.slides.push(blankSlide(deck.slides.length)); sel = deck.slides.length - 1; dirty = true; setStatus('Unsaved changes'); renderList(); renderForm();
  });
  document.getElementById('seList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-slide]'); if (!b) return; sel = parseInt(b.dataset.slide); renderList(); renderForm();
  });
}

export function cleanup() { if (imgEditor) { imgEditor.destroy(); imgEditor = null; } }
