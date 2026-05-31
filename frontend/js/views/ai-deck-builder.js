// MBFD Media Control Studio — AI Deck Builder (Phase 5).
// Prompt the local Qwen model to generate a full mbfd-deck-v1 deck. Generation
// is async (server returns a job id; we poll). CSP-safe: addEventListener +
// inline style attrs only; the browser never talks to Ollama — only our API.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';

let pollTimer = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const FIELD = 'width:100%;padding:10px 14px;border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);font-size:var(--mc-font-size-base);background:var(--mc-surface);color:var(--mc-text-primary);font-family:var(--mc-font-family-sans);box-sizing:border-box';
const LABEL = 'display:block;font-size:var(--mc-font-size-sm);font-weight:var(--mc-fw-semibold);color:var(--mc-text-secondary);margin-bottom:6px';

export function cleanup() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export async function render(app) {
  cleanup();
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap" style="max-width:760px">
        <div class="mc-studio-header">
          <div class="mc-studio-title">AI Deck Builder</div>
          <div class="mc-studio-sub">Describe a training topic and the local Qwen model drafts a full deck — on-prem, private.</div>
        </div>
        <div id="aiHealth" style="margin-bottom:var(--mc-space-lg)"></div>
        <div class="mc-panel" style="padding:var(--mc-space-xl)">
          <div style="margin-bottom:var(--mc-space-lg)">
            <label style="${LABEL}" for="aiPrompt">What should this presentation cover?</label>
            <textarea id="aiPrompt" rows="4" placeholder="e.g. A refresher on aerial apparatus setup and safety for driver-engineers, covering positioning, stabilization, and common mistakes." style="${FIELD};resize:vertical"></textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--mc-space-lg);margin-bottom:var(--mc-space-lg)">
            <div>
              <label style="${LABEL}" for="aiTitle">Title (optional)</label>
              <input id="aiTitle" type="text" maxlength="120" placeholder="Auto from topic" style="${FIELD}">
            </div>
            <div>
              <label style="${LABEL}" for="aiSlides">Slides</label>
              <input id="aiSlides" type="number" min="3" max="20" value="8" style="${FIELD}">
            </div>
          </div>
          <div style="margin-bottom:var(--mc-space-xl)">
            <label style="${LABEL}" for="aiAudience">Audience (optional)</label>
            <input id="aiAudience" type="text" maxlength="120" placeholder="e.g. Driver-engineers, recruit class, command staff" style="${FIELD}">
          </div>
          <div style="display:flex;align-items:center;gap:var(--mc-space-lg)">
            <button id="aiGenerate" class="mc-action-btn-primary" style="border:none;border-radius:var(--mc-radius-sm);padding:12px 28px;font-weight:var(--mc-fw-bold);font-size:var(--mc-font-size-base);cursor:pointer">Generate deck</button>
            <span id="aiStatus" style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary)"></span>
          </div>
        </div>
      </div>
    </div>`;

  // Health badge (non-blocking).
  api.ai.health().then((h) => {
    const el = document.getElementById('aiHealth');
    if (!el) return;
    if (h.enabled === false) { el.innerHTML = `<div class="mc-panel-empty" style="text-align:left">AI Deck Builder is disabled on this server.</div>`; return; }
    if (h.ok) el.innerHTML = `<span class="mc-live-badge" style="background:#DCFCE7;color:var(--mc-success)">● model ready · ${esc(h.model)}</span>`;
    else el.innerHTML = `<span class="mc-live-badge">● local model unreachable</span><div style="font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary);margin-top:6px">${esc(h.error || '')}</div>`;
  }).catch(() => {});

  const btn = document.getElementById('aiGenerate');
  const statusEl = document.getElementById('aiStatus');

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  btn?.addEventListener('click', async () => {
    const prompt = document.getElementById('aiPrompt').value.trim();
    if (!prompt) { document.getElementById('aiPrompt').focus(); return; }
    const title = document.getElementById('aiTitle').value.trim();
    const audience = document.getElementById('aiAudience').value.trim();
    const slide_count = parseInt(document.getElementById('aiSlides').value) || 8;

    btn.disabled = true;
    setStatus('Sending to the local model…');
    let jobId;
    try {
      const r = await api.ai.generateDeck({ prompt, title, audience, slide_count });
      jobId = r.job_id;
    } catch (e) {
      btn.disabled = false; setStatus('');
      showToast(e.message || 'Could not start generation', 'error');
      return;
    }

    setStatus('Generating… this can take up to a couple of minutes for a full deck.');
    let elapsed = 0;
    cleanup();
    pollTimer = setInterval(async () => {
      elapsed += 3;
      try {
        const job = await api.ai.job(jobId);
        if (job.status === 'done') {
          cleanup();
          showToast('Deck generated', 'success');
          // Land on the deck library so the new draft is visible (and openable).
          window.location.hash = '#/presentations';
        } else if (job.status === 'error') {
          cleanup();
          btn.disabled = false;
          setStatus('');
          showToast('Generation failed: ' + (job.error || 'unknown error'), 'error');
        } else {
          setStatus(`Generating… (${elapsed}s)`);
        }
      } catch (e) {
        // transient poll error — keep trying a few times, then give up
        if (elapsed > 240) { cleanup(); btn.disabled = false; setStatus(''); showToast('Lost contact with the generation job', 'error'); }
      }
    }, 3000);
  });
}
