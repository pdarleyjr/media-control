import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

const PROFILE_TWO = 'wall-2x4k-7680x2160';
const PROFILE_THREE = 'wall-3x4k-11520x2160';
let pollTimer = null;
let activeJobId = null;
let sourceContentId = '';

function cleanupPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
function profileOptions() {
  return `<option value="${PROFILE_THREE}">${esc(t('studio.profile_three'))}</option>
    <option value="${PROFILE_TWO}">${esc(t('studio.profile_two'))}</option>`;
}
function setStatus(message, isError = false) {
  const element = document.getElementById('converterStatus');
  if (!element) return;
  element.textContent = message || '';
  if (isError) element.setAttribute('role', 'alert'); else element.removeAttribute('role');
}
function setProgress(percent) {
  const amount = Math.max(0, Math.min(100, Number(percent) || 0));
  const bar = document.querySelector('.studio-progress > span');
  if (bar) bar.style.width = `${amount}%`;
}
function pptxOptions(content) {
  const items = (content || []).filter((item) => /\.pptx$/i.test(item.filename || '') || /presentationml\.presentation/i.test(item.mime_type || ''));
  return `<option value="">—</option>${items.map((item) => `<option value="${esc(item.id)}">${esc(item.filename || item.name || item.id)}</option>`).join('')}`;
}

function renderReview(result) {
  const root = document.getElementById('converterReview');
  if (!root) return;
  const review = Array.isArray(result?.review) ? result.review : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  root.innerHTML = `<div class="studio-panel">
    <div class="studio-panel-heading">${esc(t('converter.review'))}</div>
    <div class="studio-panel-body">
      <div class="studio-callout">${esc(t('converter.review_help'))}</div>
      <strong>${esc(t('converter.accounting', { percent: result?.source_accounting_percent ?? 0 }))}</strong>
      ${review.map((item) => `<article class="studio-review-item">
        <strong>${esc(t('studio.slide', { n: item.source_slide_number }))}: ${esc(item.title || '')}</strong>
        <div class="studio-review-compare">
          <section><h3>${esc(t('converter.source_review'))}</h3>
            ${(item.source_elements || []).map((element) => `<div class="studio-review-element"><span class="studio-field-kind">${esc(element.kind)} · ${esc(element.disposition || 'requires_review')}</span> ${esc(element.text || (element.items || []).join(' · ') || (element.rows || []).map((row) => row.join(' | ')).join(' · ') || '')}</div>`).join('')}
          </section>
          <section><h3>${esc(t('converter.converted_review'))}</h3>
            <div class="studio-muted">${esc(item.template_id || '')} → ${esc((item.output_slide_numbers || []).map((number) => t('converter.output_slide', { n: number })).join(', ') || (item.output_slide_ids || []).join(', '))}</div>
            ${(item.output_slide_numbers || []).slice(0, 1).map((number) => `<iframe class="studio-review-preview" loading="lazy" title="${esc(t('converter.converted_slide', { n: number }))}" src="/player/deck/${encodeURIComponent(result.presentation_id || '')}?preview=1&slide=${encodeURIComponent(number)}"></iframe>`).join('')}
          </section>
        </div>
        ${(item.warnings || []).map((warning) => `<div class="studio-callout">${esc(warning)}</div>`).join('')}
        ${item.speaker_notes_preserved ? `<div class="studio-muted">✓ ${esc(t('studio.notes'))}</div>` : ''}
      </article>`).join('')}
      ${warnings.map((warning) => `<div class="studio-callout">${esc(warning)}</div>`).join('')}
      <div class="studio-actions"><a class="studio-button studio-button-primary" href="#/presentation-studio?id=${encodeURIComponent(result.presentation_id || '')}">${esc(t('converter.open_studio'))}</a></div>
    </div></div>`;
}

async function pollJob(id) {
  try {
    const job = await api.presentationConverter.job(id);
    setProgress(job.progress_pct);
    setStatus(t('converter.progress', { stage: job.stage || job.status, percent: Number(job.progress_pct) || 0 }));
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) return;
    cleanupPoll();
    const start = document.getElementById('converterStart'); if (start) start.disabled = false;
    const cancel = document.getElementById('converterCancel'); if (cancel) cancel.hidden = true;
    if (job.status === 'completed') {
      setStatus(t('converter.complete')); setProgress(100); renderReview(job.result || {});
    } else if (job.status === 'failed') {
      setStatus(`${t('converter.failed')}: ${job.error?.message || ''}`, true);
      const retry = document.getElementById('converterRetry'); if (retry) retry.hidden = false;
    } else setStatus(job.status);
  } catch (error) { cleanupPoll(); setStatus(error.message, true); }
}

async function startConversion() {
  const selected = document.getElementById('converterExisting')?.value;
  const contentId = sourceContentId || selected;
  if (!contentId) { setStatus(t('converter.no_source'), true); return; }
  const button = document.getElementById('converterStart'); button.disabled = true;
  document.getElementById('converterRetry').hidden = true;
  document.getElementById('converterReview').innerHTML = '';
  try {
    const queued = await api.presentationConverter.start({
      content_id: contentId,
      wall_profile: document.getElementById('converterProfile').value,
      mode: document.querySelector('input[name="converterMode"]:checked').value,
      use_ai: document.getElementById('converterUseAi').checked,
      title: document.getElementById('converterTitle').value.trim(),
    });
    activeJobId = queued.id;
    document.getElementById('converterCancel').hidden = false;
    setProgress(queued.progress_pct || 0);
    setStatus(t('converter.progress', { stage: queued.stage || queued.status, percent: queued.progress_pct || 0 }));
    cleanupPoll(); pollTimer = setInterval(() => pollJob(activeJobId), 1500); await pollJob(activeJobId);
  } catch (error) { button.disabled = false; setStatus(error.message, true); }
}

function bind() {
  document.getElementById('converterUpload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!/\.pptx$/i.test(file.name)) { setStatus(t('converter.no_source'), true); return; }
    try {
      const uploaded = await api.uploadContent(file, (percent) => {
        setProgress(percent); setStatus(`${t('converter.upload')} · ${percent}%`);
      });
      sourceContentId = uploaded.id || uploaded.content_id;
      document.getElementById('converterSourceName').textContent = file.name;
      setStatus('');
    } catch (error) { setStatus(error.message, true); }
  });
  document.getElementById('converterExisting')?.addEventListener('change', (event) => {
    if (event.target.value) sourceContentId = '';
  });
  document.getElementById('converterStart')?.addEventListener('click', startConversion);
  document.getElementById('converterCancel')?.addEventListener('click', async () => {
    if (!activeJobId) return;
    try { await api.presentationConverter.cancel(activeJobId); await pollJob(activeJobId); }
    catch (error) { setStatus(error.message, true); }
  });
  document.getElementById('converterRetry')?.addEventListener('click', async () => {
    if (!activeJobId) return;
    try {
      await api.presentationConverter.retry(activeJobId); document.getElementById('converterRetry').hidden = true;
      document.getElementById('converterCancel').hidden = false; cleanupPoll(); pollTimer = setInterval(() => pollJob(activeJobId), 1500);
    } catch (error) { setStatus(error.message, true); }
  });
}

export function cleanup() { cleanupPoll(); activeJobId = null; }

export async function render(app) {
  cleanup(); sourceContentId = '';
  let content = [];
  try { content = await api.getContent(); } catch { content = []; }
  app.innerHTML = `<section class="presentation-studio">
    <header class="studio-topbar">
      <div class="studio-heading"><h1>${esc(t('converter.title'))}</h1><p>${esc(t('converter.subtitle'))}</p></div>
      <a class="studio-button" href="#/presentation-studio">← ${esc(t('studio.title'))}</a>
    </header>
    <div class="studio-panel"><div class="studio-panel-heading">${esc(t('converter.source'))}</div><div class="studio-panel-body">
      <label class="studio-button" for="converterUpload">${esc(t('converter.upload'))}<input id="converterUpload" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden></label>
      <div id="converterSourceName" class="studio-muted"></div>
      <label class="studio-label">${esc(t('converter.choose_existing'))}<select class="studio-select" id="converterExisting">${pptxOptions(content)}</select></label>
      <label class="studio-label">${esc(t('studio.name'))}<input class="studio-input" id="converterTitle" maxlength="120"></label>
      <label class="studio-label">${esc(t('studio.profile'))}<select class="studio-select" id="converterProfile">${profileOptions()}</select></label>
      <fieldset class="studio-panel-body"><legend>${esc(t('converter.mode'))}</legend>
        <label class="studio-checkbox"><input type="radio" name="converterMode" value="faithful" checked><span><strong>${esc(t('converter.faithful'))}</strong><br><span class="studio-muted">${esc(t('converter.faithful_help'))}</span></span></label>
        <label class="studio-checkbox"><input type="radio" name="converterMode" value="instructor_optimized"><span><strong>${esc(t('converter.optimized'))}</strong><br><span class="studio-muted">${esc(t('converter.optimized_help'))}</span></span></label>
      </fieldset>
      <label class="studio-checkbox"><input id="converterUseAi" type="checkbox" checked>${esc(t('converter.use_ai'))}</label>
      <div class="studio-progress" aria-hidden="true"><span></span></div>
      <div id="converterStatus" class="studio-status" aria-live="polite"></div>
      <div class="studio-actions">
        <button class="studio-button studio-button-primary" id="converterStart">${esc(t('converter.start'))}</button>
        <button class="studio-button studio-danger" id="converterCancel" hidden>${esc(t('converter.cancel'))}</button>
        <button class="studio-button" id="converterRetry" hidden>${esc(t('converter.retry'))}</button>
      </div>
    </div></div>
    <div id="converterReview" class="studio-review"></div>
  </section>`;
  bind();
}
