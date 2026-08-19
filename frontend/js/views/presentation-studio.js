import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { confirmDialog } from '../components/confirm.js';
import { showToast } from '../components/toast.js';
import { openTargetPicker } from '../components/target-picker.js';
import { waitForTargetCatalog } from '../services/target-catalog-runtime.js';

const PROFILE_TWO = 'wall-2x4k-7680x2160';
const PROFILE_THREE = 'wall-3x4k-11520x2160';
let pollTimer = null;
let renderGeneration = 0;

const state = {
  registry: null,
  presentations: [],
  presentation: null,
  deck: null,
  selectedSlide: 0,
  content: [],
  guides: { boundaries: true, seamSafe: false, critical: false },
  dirty: false,
  undo: [],
  redo: [],
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function newId(prefix = 'slide') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${id}`;
}
function query() {
  const hash = window.location.hash || '';
  const suffix = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return new URLSearchParams(suffix);
}
function profileFor(id) { return state.registry?.profiles?.find((profile) => profile.id === id) || null; }
function layoutFor(deck, slide) { return profileFor(deck?.wall_profile)?.layouts?.find((layout) => layout.layout_id === slide?.template_id) || null; }
function slideLabel(slide, index) {
  const first = Object.entries(slide?.slots || {}).find(([name, value]) => /TITLE/.test(name) && typeof value === 'string' && value.trim());
  return first ? first[1] : t('studio.slide', { n: index + 1 });
}
function isMediaName(name) { return /(_MEDIA(?:_[A-Z])?|_VIDEO|FULL_BLEED_MEDIA|_DIAGRAM)$/.test(name); }
function isEditableText(name, object) {
  if (name.startsWith('GLOBAL_') || !object?.placeholder_text || /BACKGROUND|PANEL|BOX|BLOCK|WATERMARK|LOGO|PLACEHOLDER_(?:ICON|LABEL)|BULLET_MARK/.test(name)) return false;
  return true;
}
const AI_ACTIONS = [
  'generate_slide', 'suggest_layout', 'improve', 'shorten', 'expand',
  'paragraph_to_bullets', 'bullets_to_prose', 'speaker_notes',
  'key_takeaway', 'reorganize', 'split',
];
function saveBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename || 'presentation.pptx';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function status(message, alert = false) {
  const element = document.getElementById('studioStatus');
  if (!element) return;
  element.textContent = message || '';
  if (alert) element.setAttribute('role', 'alert'); else element.removeAttribute('role');
}
function pushUndo() {
  if (!state.deck) return;
  state.undo.push(clone(state.deck));
  if (state.undo.length > 30) state.undo.shift();
  state.redo = [];
}
function restoreHistory(app, direction) {
  const from = direction === 'undo' ? state.undo : state.redo;
  const to = direction === 'undo' ? state.redo : state.undo;
  if (!from.length || !state.deck) return;
  to.push(clone(state.deck)); state.deck = from.pop(); state.dirty = true;
  state.selectedSlide = Math.min(state.selectedSlide, Math.max(0, state.deck.slides.length - 1));
  renderEditor(app);
}

function renderShell(app, body, mode = 'library') {
  app.innerHTML = `<section class="presentation-studio" data-studio-mode="${esc(mode)}">
    <header class="studio-topbar">
      <div class="studio-heading"><h1>${esc(t('studio.title'))}</h1><p>${esc(t('studio.subtitle'))}</p></div>
      <div class="studio-actions">
        <a class="studio-button" href="#/presentation-converter">${esc(t('studio.converter'))}</a>
      </div>
    </header>
    <nav class="studio-mode-tabs" aria-label="${esc(t('studio.title'))}">
      <a class="studio-tab" aria-selected="${mode === 'library'}" href="#/presentation-studio">${esc(t('studio.library'))}</a>
      <a class="studio-tab" aria-selected="${mode === 'ai'}" href="#/presentation-studio?mode=ai">${esc(t('studio.ai'))}</a>
    </nav>
    ${body}
    <div id="studioStatus" class="studio-status" aria-live="polite"></div>
  </section>`;
}

function profileOptions(selected) {
  return `<option value="${PROFILE_THREE}" ${selected === PROFILE_THREE ? 'selected' : ''}>${esc(t('studio.profile_three'))}</option>
    <option value="${PROFILE_TWO}" ${selected === PROFILE_TWO ? 'selected' : ''}>${esc(t('studio.profile_two'))}</option>`;
}

async function renderLibrary(app) {
  state.presentation = null; state.deck = null; state.dirty = false; state.undo = []; state.redo = [];
  const cards = state.presentations.map((item) => {
    let legacy = true; try { legacy = JSON.parse(item.deck_json || '{}').version !== 'mbfd-deck-v2'; } catch { /* legacy recovery path */ }
    const openUrl = legacy ? `#/slide-editor?id=${encodeURIComponent(item.id)}&legacy=1` : `#/presentation-studio?id=${encodeURIComponent(item.id)}`;
    return `<article class="studio-card" data-presentation-card="${esc(item.id)}">
    <div><h2>${esc(item.title)}</h2><div class="studio-meta">${esc(item.canvas_profile)} · ${Number(item.slide_count) || 0} slides</div></div>
    <div class="studio-card-actions">
      <a class="studio-button studio-button-primary" href="${openUrl}">${esc(t('studio.open'))}${legacy ? ' · v1' : ''}</a>
      <button class="studio-button studio-present" data-library-present="${esc(item.id)}">${esc(t('studio.present'))}</button>
      <button class="studio-button" data-preview="${esc(item.id)}">${esc(t('studio.preview'))}</button>
      <button class="studio-button" data-duplicate="${esc(item.id)}">${esc(t('studio.duplicate'))}</button>
      <button class="studio-button studio-danger" data-delete="${esc(item.id)}">${esc(t('studio.delete'))}</button>
    </div>
  </article>`;
  }).join('');
  renderShell(app, `<div class="studio-panel"><div class="studio-panel-heading">${esc(t('studio.new'))}</div>
    <div class="studio-panel-body"><div class="studio-inline">
      <label class="studio-label">${esc(t('studio.name'))}<input class="studio-input" id="studioNewTitle" maxlength="120"></label>
      <label class="studio-label">${esc(t('studio.profile'))}<select class="studio-select" id="studioNewProfile">${profileOptions(PROFILE_THREE)}</select></label>
      <button class="studio-button studio-button-primary" id="studioCreate">${esc(t('studio.create'))}</button>
    </div></div></div>
    <div class="studio-library-grid">${cards || `<div class="studio-panel studio-empty">${esc(t('studio.empty'))}</div>`}</div>`, 'library');

  document.getElementById('studioCreate')?.addEventListener('click', async () => {
    const title = document.getElementById('studioNewTitle').value.trim();
    if (!title) { document.getElementById('studioNewTitle').focus(); return; }
    try {
      const created = await api.presentations.create({
        title, deck_version: 'mbfd-deck-v2', canvas_profile: document.getElementById('studioNewProfile').value,
      });
      window.location.hash = `#/presentation-studio?id=${encodeURIComponent(created.id)}`;
    } catch (error) { showToast(error.message || t('studio.load_failed'), 'error'); }
  });
  app.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', () => {
    window.open(`/player/deck/${encodeURIComponent(button.dataset.preview)}`, '_blank', 'noopener');
  }));
  app.querySelectorAll('[data-library-present]').forEach((button) => button.addEventListener('click', () => broadcastPresentation(button.dataset.libraryPresent, button)));
  app.querySelectorAll('[data-duplicate]').forEach((button) => button.addEventListener('click', async () => {
    try { await api.presentations.duplicate(button.dataset.duplicate); await loadAndRender(app); }
    catch (error) { showToast(error.message, 'error'); }
  }));
  app.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: t('studio.confirm_delete_title'), message: t('studio.confirm_delete_body'),
      confirmLabel: t('studio.delete'), cancelLabel: t('studio.cancel'), tone: 'danger',
    });
    if (!confirmed) return;
    try { await api.presentations.remove(button.dataset.delete); await loadAndRender(app); }
    catch (error) { showToast(error.message, 'error'); }
  }));
}

function renderStage() {
  const viewport = document.getElementById('studioStageViewport');
  if (!viewport) return;
  const slide = state.deck?.slides?.[state.selectedSlide];
  const layout = layoutFor(state.deck, slide);
  const profile = profileFor(state.deck?.wall_profile);
  if (!slide || !layout || !profile) {
    viewport.className = 'studio-stage-viewport';
    viewport.innerHTML = `<div class="studio-empty">${esc(t('studio.no_slide'))}</div>`;
    return;
  }
  const width = Number(profile.canvas_px?.w) || 11520;
  const height = Number(profile.canvas_px?.h) || 2160;
  viewport.className = `studio-stage-viewport${width === 7680 ? ' is-two-display' : ''}`;
  const renderObject = ([name, object]) => {
    const box = object?.bbox_px;
    if (!box) return '';
    const value = slide.slots?.[name];
    const style = `left:${(box.x / width) * 100}%;top:${(box.y / height) * 100}%;width:${(box.w / width) * 100}%;height:${(box.h / height) * 100}%`;
    if (name === 'GLOBAL_MBFD_LOGO' || name === 'GLOBAL_MBFD_WATERMARK') {
      return `<div class="studio-stage-object" style="${style}"><img src="/player/template-asset/${encodeURIComponent(state.deck.wall_profile)}/${encodeURIComponent(name)}" alt=""></div>`;
    }
    const globalText = {
      GLOBAL_HEADER_MIAMI_BEACH: 'MIAMI BEACH', GLOBAL_HEADER_FIRE_DEPARTMENT: 'FIRE DEPARTMENT',
      GLOBAL_FOOTER_MARK: '✦', GLOBAL_COURSE_SECTION: state.deck.course_section || 'COURSE / SECTION',
      GLOBAL_PRESENTATION_TITLE: state.deck.title || '', GLOBAL_SLIDE_LABEL: 'SLIDE #',
      GLOBAL_SLIDE_NUMBER: String(state.selectedSlide + 1).padStart(2, '0'),
    }[name];
    if (globalText !== undefined) return `<div class="studio-stage-object${/TITLE|HEADER/.test(name) ? ' is-title' : ''}" style="${style}">${esc(globalText)}</div>`;
    if (/BACKGROUND$/.test(name) || /PANEL$/.test(name) || /TAKEAWAY_BOX|SLIDE_NUMBER_BLOCK/.test(name)) {
      const kind = /BACKGROUND$/.test(name) ? 'background' : (/TAKEAWAY_BOX|SLIDE_NUMBER_BLOCK/.test(name) ? 'takeaway' : 'panel');
      return `<div class="studio-stage-object studio-template-${kind}" style="${style}"></div>`;
    }
    if (!isMediaName(name) && !isEditableText(name, object)) return '';
    if (isMediaName(name)) {
      const contentId = value && typeof value === 'object' ? value.content_id : null;
      const mime = value && typeof value === 'object' ? String(value.type || '') : '';
      let content = esc(value?.caption || object.placeholder_text || t('studio.media'));
      if (contentId && mime === 'image') content = `<img src="/player/asset/${encodeURIComponent(contentId)}" alt="">`;
      else if (contentId && (mime === 'video' || mime === 'audio')) content = `<span>▶ ${esc(value.caption || t('studio.media'))}</span>`;
      return `<div class="studio-stage-object is-media" style="${style}" data-stage-slot="${esc(name)}">${content}</div>`;
    }
    const text = typeof value === 'string' ? value : (value?.caption || (value?.type === 'table' ? value.rows?.map((row) => row.join(' | ')).join('\n') : ''));
    return `<div class="studio-stage-object${/TITLE/.test(name) ? ' is-title' : ''}" style="${style}" data-stage-slot="${esc(name)}">${esc(text || object.placeholder_text || '')}</div>`;
  };
  const boundaries = state.guides.boundaries ? (profile.seams_px || []).map((x) => `<span class="studio-stage-seam" style="left:${(x / width) * 100}%"></span>`).join('') : '';
  const gutters = state.guides.seamSafe ? (profile.critical_content_exclusion_gutters_px || []).map((gutter) => `<span class="studio-stage-gutter" style="left:${(gutter.x1 / width) * 100}%;width:${((gutter.x2 - gutter.x1) / width) * 100}%"></span>`).join('') : '';
  const critical = state.guides.critical ? (profile.displays || []).map((display) => `<span class="studio-stage-critical" style="left:${((display.x + display.w * .08) / width) * 100}%;top:8%;width:${(display.w * .84 / width) * 100}%;height:84%"></span>`).join('') : '';
  viewport.innerHTML = `<div class="studio-stage${width === 7680 ? ' is-two-display' : ''}">${Object.entries(layout.named_objects || {}).map(renderObject).join('')}${gutters}${critical}${boundaries}</div>`;
  const caption = document.getElementById('studioStageCaption');
  if (caption) caption.innerHTML = `<span>${esc(layout.layout_id)}</span><span>${width} × ${height}</span>`;
}

function renderSlideList() {
  const list = document.getElementById('studioSlideList');
  if (!list) return;
  list.innerHTML = (state.deck.slides || []).map((slide, index) => `<button class="studio-slide-row" draggable="true" data-slide-index="${index}" aria-current="${index === state.selectedSlide}">
    <strong>${index + 1}</strong><span class="studio-slide-name">${esc(slideLabel(slide, index))}</span></button>`).join('');
  list.querySelectorAll('[data-slide-index]').forEach((button) => button.addEventListener('click', () => {
    state.selectedSlide = Number(button.dataset.slideIndex); renderSlideList(); renderInspector(); renderStage();
  }));
  list.querySelectorAll('[data-slide-index]').forEach((button) => {
    button.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', button.dataset.slideIndex));
    button.addEventListener('dragover', (event) => event.preventDefault());
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData('text/plain')); const to = Number(button.dataset.slideIndex);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || !state.deck.slides[from]) return;
      pushUndo(); const [moved] = state.deck.slides.splice(from, 1); state.deck.slides.splice(to, 0, moved);
      state.selectedSlide = to; state.dirty = true; renderSlideList(); renderInspector(); renderStage();
    });
  });
}

function mediaOptions(selected = '') {
  const supported = state.content.filter((item) => /^(image|video|audio)\//i.test(item.mime_type || '') && !item.archived_at);
  return `<option value="">—</option>${supported.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.filename || item.name || item.id)}</option>`).join('')}`;
}

function renderInspector() {
  const panel = document.getElementById('studioInspectorFields');
  if (!panel) return;
  const slide = state.deck.slides[state.selectedSlide];
  const layout = layoutFor(state.deck, slide);
  if (!slide || !layout) { panel.innerHTML = `<div class="studio-empty">${esc(t('studio.no_slide'))}</div>`; return; }
  const fields = [];
  const mediaNames = Object.keys(layout.named_objects || {}).filter(isMediaName);
  for (const [name, object] of Object.entries(layout.named_objects || {})) {
    if (isEditableText(name, object)) {
      const current = slide.slots?.[name];
      const currentText = typeof current === 'string'
        ? current
        : current?.type === 'table' ? (current.rows || []).map((row) => row.join('\t')).join('\n') : (current?.caption || '');
      fields.push(`<label class="studio-label"><span>${esc(name.replaceAll('_', ' '))}</span><span class="studio-field-kind">${esc(object.placeholder_text || '')}</span>
        <textarea class="studio-textarea" rows="2" data-slot-text="${esc(name)}">${esc(currentText)}</textarea></label>`);
    } else if (isMediaName(name)) {
      const value = slide.slots?.[name];
      fields.push(`<div class="studio-label"><span>${esc(name.replaceAll('_', ' '))}</span>
        <select class="studio-select" data-slot-media="${esc(name)}">${mediaOptions(value?.content_id || '')}</select>
        <button class="studio-button" data-link-slot="${esc(name)}">${esc(t('studio.link_media'))}</button></div>`);
    }
  }
  if (mediaNames.length) fields.push(`<div class="studio-label"><span>${esc(t('studio.youtube_url'))}</span>
    <select class="studio-select" data-url-slot>${mediaNames.map((name) => `<option value="${esc(name)}">${esc(name.replaceAll('_', ' '))}</option>`).join('')}</select>
    <input class="studio-input" data-video-url type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…">
    <button class="studio-button" data-add-video-url>${esc(t('studio.add_url'))}</button></div>`);
  fields.push(`<label class="studio-label">${esc(t('studio.duration'))}<input class="studio-input" data-slide-duration type="number" min="2" max="3600" value="${Number(slide.duration_seconds) || 12}"></label>`);
  fields.push(`<label class="studio-label">${esc(t('studio.notes'))}<textarea class="studio-textarea" data-speaker-notes>${esc(slide.speaker_notes || '')}</textarea></label>`);
  fields.push(`<section class="studio-panel-body"><strong>${esc(t('studio.ai_slide'))}</strong>
    <select class="studio-select" data-ai-action>${AI_ACTIONS.map((action) => `<option value="${action}">${esc(t(`studio.ai_action_${action}`))}</option>`).join('')}</select>
    <textarea class="studio-textarea" data-ai-instruction placeholder="${esc(t('studio.ai_instruction'))}"></textarea>
    <button class="studio-button studio-button-primary" data-ai-apply>${esc(t('studio.ai_apply'))}</button></section>`);
  fields.push(`<section class="studio-validation" data-studio-validation><strong>${esc(t('studio.validation'))}</strong>
    <div class="studio-validation-ok">✓ ${esc(t('studio.validation_safe'))}</div>
    ${(slide.review_flags || []).map((flag) => `<div class="studio-callout">${esc(flag)}</div>`).join('')}</section>`);
  panel.innerHTML = fields.join('');
  panel.querySelectorAll('[data-slot-text]').forEach((field) => {
    field.addEventListener('focus', () => { if (!field.dataset.history) { pushUndo(); field.dataset.history = '1'; } });
    field.addEventListener('input', () => {
    const prior = slide.slots[field.dataset.slotText];
    if (prior?.type === 'table') prior.rows = field.value.split('\n').map((row) => row.split('\t'));
    else if (prior?.type === 'linked_text') prior.caption = field.value;
    else slide.slots[field.dataset.slotText] = field.value;
    state.dirty = true; renderStage(); renderSlideList();
    });
  });
  panel.querySelector('[data-speaker-notes]')?.addEventListener('focus', (event) => { if (!event.target.dataset.history) { pushUndo(); event.target.dataset.history = '1'; } });
  panel.querySelector('[data-speaker-notes]')?.addEventListener('input', (event) => {
    slide.speaker_notes = event.target.value; state.dirty = true;
  });
  panel.querySelector('[data-slide-duration]')?.addEventListener('change', (event) => {
    pushUndo(); slide.duration_seconds = Math.max(2, Math.min(3600, Number(event.target.value) || 12)); state.dirty = true;
  });
  panel.querySelectorAll('[data-link-slot]').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.linkSlot;
    const select = panel.querySelector(`[data-slot-media="${CSS.escape(name)}"]`);
    if (!select?.value) return;
    try {
      const linked = await api.presentations.linkAsset(state.presentation.id, select.value);
      pushUndo();
      const type = String(linked.mime_type || '').split('/')[0];
      slide.slots[name] = { type, content_id: linked.content_id, fit: 'contain', caption: '' };
      if (!state.deck.assets.some((asset) => asset.content_id === linked.content_id)) state.deck.assets.push({ id: newId('asset'), content_id: linked.content_id, type });
      state.dirty = true; renderStage();
    } catch (error) { showToast(error.message, 'error'); }
  }));
  panel.querySelector('[data-add-video-url]')?.addEventListener('click', () => {
    const url = panel.querySelector('[data-video-url]')?.value.trim(); const name = panel.querySelector('[data-url-slot]')?.value;
    if (!url || !/^https?:\/\//i.test(url) || !name) return;
    pushUndo(); slide.slots[name] = { type: /(?:youtube\.com|youtu\.be)/i.test(url) ? 'youtube' : 'video', url, fit: 'contain', caption: url };
    state.dirty = true; renderStage();
  });
  panel.querySelector('[data-ai-apply]')?.addEventListener('click', (event) => runSlideAssist(event.currentTarget));
}

function emptySlide(templateId) {
  return { id: newId(), template_id: templateId, slots: {}, speaker_notes: '', duration_seconds: 12, source_refs: [], review_flags: [] };
}
function slotKind(name, value) {
  if (isMediaName(name) || ['image', 'media', 'video', 'audio', 'youtube'].includes(value?.type)) return 'media';
  if (value?.type === 'table' || /TABLE_TEXT/.test(name)) return 'table';
  if (/BULLET_\d+$/.test(name)) return 'bullet';
  if (/SUBTITLE/.test(name)) return 'subtitle';
  if (/TAKEAWAY_(?:TEXT|LABEL)/.test(name)) return 'takeaway';
  if (/CAPTION/.test(name)) return 'caption';
  if (/TITLE/.test(name)) return 'title';
  return 'body';
}
function remapDeckProfile(nextProfileId) {
  if (nextProfileId === state.deck.wall_profile) return;
  const nextProfile = profileFor(nextProfileId); if (!nextProfile) return;
  const output = [];
  for (const sourceSlide of state.deck.slides) {
    const targetLayout = nextProfile.layouts.find((layout) => layout.layout_id === sourceSlide.template_id) || nextProfile.layouts[0];
    const allowed = Object.entries(targetLayout.named_objects || {}).filter(([name, object]) => isMediaName(name) || isEditableText(name, object));
    const slots = {}; const leftovers = [];
    for (const [name, value] of Object.entries(sourceSlide.slots || {})) {
      if (targetLayout.named_objects[name]) { slots[name] = clone(value); continue; }
      const kind = slotKind(name, value);
      const target = allowed.find(([candidate]) => slots[candidate] === undefined && slotKind(candidate, value) === kind);
      if (target) slots[target[0]] = clone(value); else leftovers.push({ name, value: clone(value), kind });
    }
    const remapped = { ...clone(sourceSlide), template_id: targetLayout.layout_id, slots };
    if (leftovers.length) remapped.review_flags = [...new Set([...(remapped.review_flags || []), 'Wall profile changed; review deterministic continuation mapping'])];
    output.push(remapped);
    let continuation = null;
    for (const item of leftovers) {
      if (item.kind === 'media') {
        const layout = nextProfile.layouts.find((candidate) => candidate.layout_id === 'FULL_IMAGE');
        const mediaSlot = Object.keys(layout.named_objects).find(isMediaName);
        const added = emptySlide('FULL_IMAGE'); added.slots[mediaSlot] = item.value;
        added.review_flags = ['Media moved to a continuation slide during wall-profile change']; output.push(added); continue;
      }
      const layout = nextProfile.layouts.find((candidate) => candidate.layout_id === 'CONTINUATION');
      const bodies = Object.entries(layout.named_objects).filter(([name, object]) => isEditableText(name, object) && slotKind(name) === 'body').map(([name]) => name);
      let body = continuation && bodies.find((name) => continuation.slots[name] === undefined);
      if (!continuation || !body) {
        continuation = emptySlide('CONTINUATION');
        const title = Object.entries(layout.named_objects).find(([name, object]) => isEditableText(name, object) && slotKind(name) === 'title')?.[0];
        if (title) continuation.slots[title] = `${slideLabel(sourceSlide, output.length - 1)} — Continued`;
        continuation.review_flags = ['Content preserved on continuation after wall-profile change']; output.push(continuation);
        body = bodies[0];
      }
      if (body) continuation.slots[body] = item.value;
    }
  }
  state.deck.wall_profile = nextProfileId; state.deck.slides = output; state.selectedSlide = Math.min(state.selectedSlide, output.length - 1); state.dirty = true;
}
function selectLayout(templateId) {
  const index = state.selectedSlide;
  const slide = state.deck.slides[index];
  if (!slide) return;
  const nextLayout = profileFor(state.deck.wall_profile)?.layouts?.find((layout) => layout.layout_id === templateId);
  if (!nextLayout) return;
  const editable = Object.entries(nextLayout.named_objects || {}).filter(([name, object]) => isMediaName(name) || isEditableText(name, object));
  const slots = {}; const leftovers = [];
  for (const [name, value] of Object.entries(slide.slots || {})) {
    if (nextLayout.named_objects[name]) { slots[name] = clone(value); continue; }
    const kind = slotKind(name, value);
    const target = editable.find(([candidate]) => slots[candidate] === undefined && slotKind(candidate, value) === kind);
    if (target) slots[target[0]] = clone(value); else leftovers.push({ value: clone(value), kind });
  }
  const remapped = { ...clone(slide), template_id: templateId, slots };
  const continuations = [];
  if (leftovers.length) {
    remapped.review_flags = [...new Set([...(remapped.review_flags || []), t('studio.layout_content_preserved')])];
    let continuation = null;
    for (const item of leftovers) {
      if (item.kind === 'media') {
        const fullImage = profileFor(state.deck.wall_profile).layouts.find((layout) => layout.layout_id === 'FULL_IMAGE');
        const mediaSlot = Object.keys(fullImage.named_objects).find(isMediaName);
        const added = emptySlide('FULL_IMAGE'); added.slots[mediaSlot] = item.value;
        added.review_flags = [t('studio.layout_media_continuation')]; continuations.push(added); continue;
      }
      const continuationLayout = profileFor(state.deck.wall_profile).layouts.find((layout) => layout.layout_id === 'CONTINUATION');
      const bodies = Object.entries(continuationLayout.named_objects)
        .filter(([name, object]) => isEditableText(name, object) && slotKind(name) === 'body').map(([name]) => name);
      let body = continuation && bodies.find((name) => continuation.slots[name] === undefined);
      if (!continuation || !body) {
        continuation = emptySlide('CONTINUATION');
        const title = Object.entries(continuationLayout.named_objects)
          .find(([name, object]) => isEditableText(name, object) && slotKind(name) === 'title')?.[0];
        if (title) continuation.slots[title] = `${slideLabel(slide, index)} — ${t('studio.continued')}`;
        continuation.review_flags = [t('studio.layout_text_continuation')]; continuations.push(continuation);
        body = bodies[0];
      }
      if (body) continuation.slots[body] = item.value;
    }
  }
  state.deck.slides.splice(index, 1, remapped, ...continuations);
  state.dirty = true; renderInspector(); renderStage(); renderSlideList();
}

async function savePresentation() {
  if (!state.presentation || !state.deck) return;
  state.deck.title = document.getElementById('studioDeckTitle')?.value.trim() || state.deck.title;
  state.deck.course_section = document.getElementById('studioCourseSection')?.value.trim() || '';
  status(t('studio.status_saving'));
  const saved = await api.presentations.update(state.presentation.id, {
    title: state.deck.title, canvas_profile: state.deck.wall_profile, deck_json: state.deck,
  });
  state.presentation = saved; state.dirty = false; status(t('studio.saved')); return saved;
}

async function runSlideAssist(button) {
  const slide = state.deck?.slides?.[state.selectedSlide];
  if (!slide || !state.presentation) return;
  button.disabled = true;
  const panel = document.getElementById('studioInspectorFields');
  const action = panel?.querySelector('[data-ai-action]')?.value || 'improve';
  const instruction = panel?.querySelector('[data-ai-instruction]')?.value.trim() || '';
  try {
    const queued = await api.ai.assistSlideV2({
      presentation_id: state.presentation.id, slide_id: slide.id, action, instruction,
    });
    status(t('studio.ai_working'));
    cleanupPollOnly();
    pollTimer = setInterval(async () => {
      try {
        const job = await api.ai.job(queued.job_id);
        if (!['done', 'error'].includes(job.status)) return;
        cleanupPollOnly();
        if (job.status === 'error') throw new Error(job.error || 'Slide assistance failed');
        const suggestion = job.result?.suggestion; const target = state.deck.slides.find((item) => item.id === job.result?.slide_id);
        if (!suggestion || !target) throw new Error('Slide assistance result no longer matches this deck');
        pushUndo();
        if (suggestion.template_id !== target.template_id) {
          target.template_id = suggestion.template_id; target.slots = clone(suggestion.slots || {});
        } else target.slots = { ...target.slots, ...(suggestion.slots || {}) };
        if (suggestion.speaker_notes || action === 'speaker_notes') target.speaker_notes = suggestion.speaker_notes || '';
        if (suggestion.split_recommended) target.review_flags = [...new Set([...(target.review_flags || []), 'Local Qwen recommends a continuation slide; instructor review required'])];
        state.dirty = true; renderEditor(document.getElementById('app')); status(suggestion.rationale || t('studio.ai_ready'));
      } catch (error) { cleanupPollOnly(); status(error.message, true); button.disabled = false; }
    }, 2500);
  } catch (error) { status(error.message, true); button.disabled = false; }
}

function cleanupPollOnly() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function broadcastPresentation(presentationId, button) {
  button.disabled = true;
  try {
    const catalog = await waitForTargetCatalog({ includeVirtualDisplays: false }, { requireFresh: true });
    const selection = await openTargetPicker({
      catalog, capability: 'content', selection: 'multiple', allowOffline: false,
      allowIndividualWallMembers: false, allowLiveProgram: true,
    });
    if (!selection) return;
    const physicalTargets = selection.references.filter((target) => target.type !== 'live-program');
    if (!physicalTargets.length && !selection.includesLiveProgram) { showToast(t('studio.choose_destination'), 'info'); return; }
    status(t('studio.status_presenting'));
    const result = await api.broadcast({
      ...(physicalTargets.length ? { targets: physicalTargets } : { device_ids: selection.deviceIds }),
      presentation_id: presentationId,
      include_live_stream: selection.includesLiveProgram,
    });
    status(t('studio.present_success', { n: result.sent ?? selection.deviceIds.length }));
    showToast(t('studio.present_success', { n: result.sent ?? selection.deviceIds.length }), 'success');
  } catch (error) { status(error.message, true); showToast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function presentDeck(button) {
  try { await savePresentation(); }
  catch (error) { status(error.message, true); showToast(error.message, 'error'); return; }
  await broadcastPresentation(state.presentation.id, button);
}

function bindEditor(app) {
  const profile = profileFor(state.deck.wall_profile);
  document.getElementById('studioUndo')?.addEventListener('click', () => restoreHistory(app, 'undo'));
  document.getElementById('studioRedo')?.addEventListener('click', () => restoreHistory(app, 'redo'));
  document.getElementById('studioSave')?.addEventListener('click', () => savePresentation().catch((error) => status(error.message, true)));
  document.getElementById('studioPreview')?.addEventListener('click', async () => {
    try { if (state.dirty) await savePresentation(); window.open(`/player/deck/${encodeURIComponent(state.presentation.id)}`, '_blank', 'noopener'); }
    catch (error) { status(error.message, true); }
  });
  document.getElementById('studioDownload')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { if (state.dirty) await savePresentation(); saveBlob(await api.presentations.downloadPptx(state.presentation.id)); }
    catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; }
  });
  document.getElementById('studioExportLibrary')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { if (state.dirty) await savePresentation(); await api.presentations.exportToLibrary(state.presentation.id); showToast(t('studio.save_library'), 'success'); }
    catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; }
  });
  document.querySelector('[data-studio-present]')?.addEventListener('click', (event) => presentDeck(event.currentTarget));
  document.querySelectorAll('[data-guide]').forEach((input) => input.addEventListener('change', () => { state.guides[input.dataset.guide] = input.checked; renderStage(); }));
  document.getElementById('studioDeckTitle')?.addEventListener('focus', (event) => { if (!event.target.dataset.history) { pushUndo(); event.target.dataset.history = '1'; } });
  document.getElementById('studioDeckTitle')?.addEventListener('input', () => { state.dirty = true; });
  document.getElementById('studioCourseSection')?.addEventListener('focus', (event) => { if (!event.target.dataset.history) { pushUndo(); event.target.dataset.history = '1'; } });
  document.getElementById('studioCourseSection')?.addEventListener('input', () => { state.dirty = true; });
  document.getElementById('studioWallProfile')?.addEventListener('change', (event) => {
    pushUndo(); remapDeckProfile(event.target.value); renderEditor(app);
  });
  document.getElementById('studioLayout')?.addEventListener('change', (event) => { pushUndo(); selectLayout(event.target.value); });
  document.querySelector('[data-slide-add]')?.addEventListener('click', () => {
    pushUndo(); state.deck.slides.push(emptySlide(profile.layouts[0].layout_id)); state.selectedSlide = state.deck.slides.length - 1; state.dirty = true;
    renderEditor(app);
  });
  document.querySelector('[data-slide-duplicate]')?.addEventListener('click', () => {
    const current = state.deck.slides[state.selectedSlide]; if (!current) return; pushUndo();
    const copy = { ...clone(current), id: newId() }; state.deck.slides.splice(state.selectedSlide + 1, 0, copy); state.selectedSlide += 1; state.dirty = true; renderEditor(app);
  });
  document.querySelector('[data-slide-delete]')?.addEventListener('click', () => {
    if (!state.deck.slides[state.selectedSlide]) return; pushUndo();
    state.deck.slides.splice(state.selectedSlide, 1); state.selectedSlide = Math.max(0, Math.min(state.selectedSlide, state.deck.slides.length - 1)); state.dirty = true; renderEditor(app);
  });
  document.querySelector('[data-slide-up]')?.addEventListener('click', () => {
    if (state.selectedSlide <= 0) return; pushUndo();
    [state.deck.slides[state.selectedSlide - 1], state.deck.slides[state.selectedSlide]] = [state.deck.slides[state.selectedSlide], state.deck.slides[state.selectedSlide - 1]];
    state.selectedSlide -= 1; state.dirty = true; renderEditor(app);
  });
  document.querySelector('[data-slide-down]')?.addEventListener('click', () => {
    if (state.selectedSlide >= state.deck.slides.length - 1) return; pushUndo();
    [state.deck.slides[state.selectedSlide + 1], state.deck.slides[state.selectedSlide]] = [state.deck.slides[state.selectedSlide], state.deck.slides[state.selectedSlide + 1]];
    state.selectedSlide += 1; state.dirty = true; renderEditor(app);
  });
  document.getElementById('studioImageUpload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; const slide = state.deck.slides[state.selectedSlide];
    const layout = layoutFor(state.deck, slide); const slot = Object.keys(layout?.named_objects || {}).find(isMediaName);
    if (!file || !slide) return;
    if (!slot) { showToast(t('studio.no_media_slot'), 'info'); return; }
    try {
      let contentId; let type = String(file.type || '').split('/')[0];
      if (type === 'image') {
        const uploaded = await api.presentations.uploadAsset(state.presentation.id, file, (pct) => status(`${pct}%`));
        contentId = uploaded.content_id;
      } else {
        const uploaded = await api.uploadContent(file, (pct) => status(`${pct}%`));
        contentId = uploaded.id || uploaded.content_id;
        const linked = await api.presentations.linkAsset(state.presentation.id, contentId);
        type = String(linked.mime_type || file.type || '').split('/')[0];
      }
      pushUndo(); slide.slots[slot] = { type, content_id: contentId, fit: 'contain', caption: file.name };
      if (!state.deck.assets.some((asset) => asset.content_id === contentId)) state.deck.assets.push({ id: newId('asset'), content_id: contentId, type });
      state.dirty = true; state.content = await api.getContent(); renderEditor(app);
    } catch (error) { showToast(error.message, 'error'); }
  });
}

function renderEditor(app) {
  const slide = state.deck.slides[state.selectedSlide];
  const layouts = profileFor(state.deck.wall_profile)?.layouts || [];
  renderShell(app, `<div class="studio-toolbar">
      <a class="studio-button" href="#/presentation-studio">← ${esc(t('studio.library'))}</a>
      <label class="studio-label">${esc(t('studio.name'))}<input class="studio-input" id="studioDeckTitle" maxlength="120" value="${esc(state.deck.title || state.presentation.title)}"></label>
      <label class="studio-label">${esc(t('studio.course_section'))}<input class="studio-input" id="studioCourseSection" maxlength="120" value="${esc(state.deck.course_section || '')}"></label>
      <label class="studio-label">${esc(t('studio.profile'))}<select class="studio-select" id="studioWallProfile">${profileOptions(state.deck.wall_profile)}</select></label>
      <div class="studio-actions">
        <button class="studio-button" id="studioUndo" ${state.undo.length ? '' : 'disabled'}>${esc(t('studio.undo'))}</button>
        <button class="studio-button" id="studioRedo" ${state.redo.length ? '' : 'disabled'}>${esc(t('studio.redo'))}</button>
        <button class="studio-button studio-button-primary" id="studioSave">${esc(t('studio.save'))}</button>
        <button class="studio-button" id="studioPreview">${esc(t('studio.preview'))}</button>
        <button class="studio-button" id="studioDownload">${esc(t('studio.download'))}</button>
        <button class="studio-button" id="studioExportLibrary">${esc(t('studio.save_library'))}</button>
        <button class="studio-button studio-present" data-studio-present>${esc(t('studio.present'))}</button>
      </div>
    </div>
    <div class="studio-editor-grid">
      <aside class="studio-panel"><div class="studio-panel-heading">${esc(t('studio.slides'))}</div>
        <div id="studioSlideList" class="studio-slide-list"></div>
        <div class="studio-panel-body studio-actions">
          <button class="studio-icon-button" data-slide-add title="${esc(t('studio.add_slide'))}" aria-label="${esc(t('studio.add_slide'))}">＋</button>
          <button class="studio-icon-button" data-slide-duplicate title="${esc(t('studio.duplicate_slide'))}" aria-label="${esc(t('studio.duplicate_slide'))}">⧉</button>
          <button class="studio-icon-button studio-danger" data-slide-delete title="${esc(t('studio.delete_slide'))}" aria-label="${esc(t('studio.delete_slide'))}">⌫</button>
          <button class="studio-icon-button" data-slide-up title="${esc(t('studio.move_up'))}" aria-label="${esc(t('studio.move_up'))}">↑</button>
          <button class="studio-icon-button" data-slide-down title="${esc(t('studio.move_down'))}" aria-label="${esc(t('studio.move_down'))}">↓</button>
        </div></aside>
      <main class="studio-stage-shell">
        <div id="studioStageViewport" class="studio-stage-viewport"></div>
        <div id="studioStageCaption" class="studio-stage-caption"></div>
        <div class="studio-actions" aria-label="${esc(t('studio.review_guides'))}">
          <label class="studio-checkbox"><input data-guide="boundaries" type="checkbox" ${state.guides.boundaries ? 'checked' : ''}>${esc(t('studio.display_boundaries'))}</label>
          <label class="studio-checkbox"><input data-guide="seamSafe" type="checkbox" ${state.guides.seamSafe ? 'checked' : ''}>${esc(t('studio.seam_safe'))}</label>
          <label class="studio-checkbox"><input data-guide="critical" type="checkbox" ${state.guides.critical ? 'checked' : ''}>${esc(t('studio.critical_safe'))}</label>
        </div>
      </main>
      <details class="studio-panel studio-inspector" open><summary class="studio-panel-heading">${esc(t('studio.content'))}</summary>
        <div class="studio-panel-body">
          <label class="studio-label">${esc(t('studio.layout'))}<select class="studio-select" id="studioLayout">${layouts.map((layout) => `<option value="${esc(layout.layout_id)}" ${layout.layout_id === slide?.template_id ? 'selected' : ''}>${esc(layout.layout_id.replaceAll('_', ' '))}</option>`).join('')}</select></label>
          <label class="studio-button" for="studioImageUpload">${esc(t('studio.upload_media'))}<input id="studioImageUpload" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/bmp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg" hidden></label>
          <div id="studioInspectorFields" class="studio-inspector-fields"></div>
        </div></details>
    </div>`, 'editor');
  renderSlideList(); renderInspector(); renderStage(); bindEditor(app);
}

async function renderAi(app) {
  renderShell(app, `<div class="studio-panel"><div class="studio-panel-heading">${esc(t('studio.ai'))}</div><div class="studio-panel-body">
    <div class="studio-callout">${esc(t('studio.ai_private'))}</div>
    <label class="studio-label">${esc(t('studio.ai_prompt'))}<textarea class="studio-textarea" id="studioAiPrompt" rows="5"></textarea></label>
    <div class="studio-inline">
      <label class="studio-label">${esc(t('studio.name'))}<input class="studio-input" id="studioAiTitle" maxlength="120"></label>
      <label class="studio-label">${esc(t('studio.ai_audience'))}<input class="studio-input" id="studioAiAudience" maxlength="120"></label>
      <label class="studio-label">${esc(t('studio.ai_count'))}<input class="studio-input" id="studioAiCount" type="number" min="3" max="20" value="8"></label>
      <label class="studio-label">${esc(t('studio.profile'))}<select class="studio-select" id="studioAiProfile">${profileOptions(PROFILE_THREE)}</select></label>
    </div>
    <button class="studio-button studio-button-primary" id="studioAiGenerate">${esc(t('studio.ai_generate'))}</button>
  </div></div>`, 'ai');
  document.getElementById('studioAiGenerate')?.addEventListener('click', async (event) => {
    const prompt = document.getElementById('studioAiPrompt').value.trim();
    if (!prompt) { document.getElementById('studioAiPrompt').focus(); return; }
    const button = event.currentTarget; button.disabled = true;
    try {
      const queued = await api.ai.generateDeckV2({
        prompt,
        title: document.getElementById('studioAiTitle').value.trim(),
        audience: document.getElementById('studioAiAudience').value.trim(),
        slide_count: Number(document.getElementById('studioAiCount').value) || 8,
        wall_profile: document.getElementById('studioAiProfile').value,
      });
      status(t('studio.ai_working'));
      pollTimer = setInterval(async () => {
        try {
          const job = await api.ai.job(queued.job_id);
          if (!['done', 'error'].includes(job.status)) return;
          cleanup();
          if (job.status === 'error') throw new Error(job.error || 'Generation failed');
          status(t('studio.ai_ready'));
          window.location.hash = `#/presentation-studio?id=${encodeURIComponent(job.presentation_id || job.result?.presentation_id)}`;
        } catch (error) { cleanup(); status(error.message, true); button.disabled = false; }
      }, 2500);
    } catch (error) { button.disabled = false; status(error.message, true); }
  });
}

async function loadAndRender(app) {
  const generation = ++renderGeneration;
  try {
    const [registry, presentations] = await Promise.all([api.presentations.registry(), api.presentations.list()]);
    if (generation !== renderGeneration) return;
    state.registry = registry; state.presentations = Array.isArray(presentations) ? presentations : [];
    const params = query();
    if (params.get('mode') === 'ai' || window.location.hash === '#/ai-deck') return renderAi(app);
    const id = params.get('id');
    if (!id) return renderLibrary(app);
    const [presentation, content] = await Promise.all([api.presentations.get(id), api.getContent().catch(() => [])]);
    if (generation !== renderGeneration) return;
    const deck = typeof presentation.deck_json === 'string' ? JSON.parse(presentation.deck_json) : presentation.deck_json;
    if (deck.version !== 'mbfd-deck-v2') {
      showToast(t('studio.legacy_editor'), 'info');
      window.location.hash = `#/slide-editor?id=${encodeURIComponent(id)}&legacy=1`;
      return;
    }
    state.presentation = presentation; state.deck = deck; state.content = Array.isArray(content) ? content : [];
    state.selectedSlide = Math.min(state.selectedSlide, Math.max(0, deck.slides.length - 1)); state.dirty = false; state.undo = []; state.redo = [];
    renderEditor(app);
  } catch (error) {
    if (generation === renderGeneration) {
      renderShell(app, `<div class="studio-panel studio-empty" role="alert">${esc(t('studio.load_failed'))}<br>${esc(error.message || '')}</div>`);
    }
  }
}

export function cleanup() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; renderGeneration += 1; }
export async function render(app) { cleanup(); await loadAndRender(app); }
