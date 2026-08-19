const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const { ELEVATED_ROLES } = require('../middleware/auth');
const config = require('../config');
const ai = require('../services/ai');
const ncSync = require('../services/nextcloud-sync');
const { PROFILE_IDS } = require('../lib/presentation-template-registry');

// MBFD Media Control Studio — AI Deck Builder API (server-side Ollama bridge).
// Generation is ASYNCHRONOUS: a 35B model can take longer than Cloudflare's
// ~100s edge timeout, so POST returns a job id immediately and the work runs in
// the background; the client polls GET /jobs/:id. AI is never called from the
// browser — only from here.

function workspaceWriteCtx(req, res) {
  if (!config.features.aiDeckBuilder) { res.status(503).json({ error: 'AI Deck Builder is disabled' }); return null; }
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  return ctx;
}

// Kick off a deck generation. Returns 202 + { job_id }.
router.post('/generate-deck', (req, res) => {
  if (!workspaceWriteCtx(req, res)) return;
  const prompt = String(req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const title = req.body.title ? String(req.body.title).trim() : '';
  const audience = req.body.audience ? String(req.body.audience).trim() : '';
  const slideCount = Math.min(20, Math.max(3, parseInt(req.body.slide_count) || 8));
  const canvasProfile = ['16x9', '4x3', 'wall-12372x2160', 'wall-3zone'].includes(req.body.canvas_profile) ? req.body.canvas_profile : '16x9';

  const jobId = uuidv4();
  db.prepare(`INSERT INTO ai_generation_jobs (id, workspace_id, user_id, job_type, model, prompt, status)
              VALUES (?, ?, ?, 'deck', ?, ?, 'pending')`)
    .run(jobId, req.workspaceId, req.user.id, config.ollamaModel, prompt.slice(0, 2000));

  res.status(202).json({ job_id: jobId, status: 'pending' });

  // Fire-and-forget; all outcomes recorded on the job row.
  const wsId = req.workspaceId, userId = req.user.id;
  (async () => {
    try {
      db.prepare("UPDATE ai_generation_jobs SET status = 'running' WHERE id = ?").run(jobId);
      const deck = await ai.generateDeck({ prompt, title, audience, slideCount, canvasProfile });
      const presId = uuidv4();
      deck.deck_id = presId;
      db.prepare(`INSERT INTO presentations (id, workspace_id, user_id, created_by, title, description, theme, canvas_profile, deck_json, status)
                  VALUES (?, ?, ?, ?, ?, ?, 'mbfd-command', ?, ?, 'draft')`)
        .run(presId, wsId, userId, userId, deck.title, `AI-generated · ${prompt.slice(0, 140)}`, canvasProfile, JSON.stringify(deck));
      db.prepare(`UPDATE ai_generation_jobs SET status = 'done', presentation_id = ?, result_json = ?, completed_at = strftime('%s','now') WHERE id = ?`)
        .run(presId, JSON.stringify({ presentation_id: presId, title: deck.title, slides: deck.slides.length }), jobId);
      // Mirror the new AI deck into the user's own Nextcloud (best-effort).
      ncSync.syncSoon(presId);
    } catch (e) {
      db.prepare(`UPDATE ai_generation_jobs SET status = 'error', error_msg = ?, completed_at = strftime('%s','now') WHERE id = ?`)
        .run(String(e.message || e).slice(0, 500), jobId);
    }
  })();
});

// Unified Presentation Studio topic generation. Qwen authors semantic prose /
// bullets under a JSON Schema; deterministic code maps that content into the
// canonical v2 registry. The browser still polls the same async job endpoint.
router.post('/generate-deck-v2', (req, res) => {
  if (!workspaceWriteCtx(req, res)) return;
  if (!config.features.presentationStudioV2) return res.status(404).json({ error: 'Presentation Studio v2 is disabled' });
  const prompt = String(req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const title = req.body.title ? String(req.body.title).trim() : '';
  const audience = req.body.audience ? String(req.body.audience).trim() : '';
  const slideCount = Math.min(20, Math.max(3, parseInt(req.body.slide_count) || 8));
  const wallProfile = Object.values(PROFILE_IDS).includes(req.body.wall_profile)
    ? req.body.wall_profile : PROFILE_IDS.THREE_DISPLAY;
  const jobId = uuidv4();
  db.prepare(`INSERT INTO ai_generation_jobs (id, workspace_id, user_id, job_type, model, prompt, status)
              VALUES (?, ?, ?, 'deck_v2', ?, ?, 'pending')`)
    .run(jobId, req.workspaceId, req.user.id, config.ollamaModel, prompt.slice(0, 2000));
  res.status(202).json({ job_id: jobId, status: 'pending' });
  const wsId = req.workspaceId, userId = req.user.id;
  (async () => {
    try {
      db.prepare("UPDATE ai_generation_jobs SET status='running' WHERE id=?").run(jobId);
      const deck = await ai.generateDeckV2({ prompt, title, audience, slideCount, wallProfile });
      const presId = uuidv4();
      deck.deck_id = presId;
      db.prepare(`INSERT INTO presentations (id, workspace_id, user_id, created_by, title, description, theme, canvas_profile, deck_json, status)
                  VALUES (?, ?, ?, ?, ?, ?, 'mbfd-videowall-v2', ?, ?, 'draft')`)
        .run(presId, wsId, userId, userId, deck.title, `AI-assisted · ${prompt.slice(0, 140)}`, wallProfile, JSON.stringify(deck));
      db.prepare(`UPDATE ai_generation_jobs SET status='done', presentation_id=?, result_json=?, completed_at=strftime('%s','now') WHERE id=?`)
        .run(presId, JSON.stringify({ presentation_id: presId, title: deck.title, slides: deck.slides.length, version: deck.version }), jobId);
      ncSync.syncSoon(presId);
    } catch (error) {
      db.prepare(`UPDATE ai_generation_jobs SET status='error', error_msg=?, completed_at=strftime('%s','now') WHERE id=?`)
        .run(String(error.message || error).slice(0, 500), jobId);
    }
  })();
});

// Selected-slide assistance is suggestion-only. The worker stores a semantic
// patch on the caller-owned async job; it never mutates the presentation row.
// The Studio applies the patch locally after first recording an undo snapshot.
router.post('/assist-slide-v2', (req, res) => {
  const ctx = workspaceWriteCtx(req, res);
  if (!ctx) return;
  if (!config.features.presentationStudioV2) return res.status(404).json({ error: 'Presentation Studio v2 is disabled' });
  const presentationId = String(req.body.presentation_id || '');
  const slideId = String(req.body.slide_id || '');
  const action = String(req.body.action || '');
  if (!ai.SLIDE_ASSIST_ACTIONS.includes(action)) return res.status(400).json({ error: 'unsupported slide assistance action' });
  const presentation = db.prepare('SELECT * FROM presentations WHERE id=? AND workspace_id=?').get(presentationId, req.workspaceId);
  if (!presentation) return res.status(404).json({ error: 'presentation not found' });
  if (!ctx.actingAs && !ELEVATED_ROLES.includes(req.user.role) && presentation.user_id && presentation.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own presentations' });
  }
  let deck;
  try { deck = JSON.parse(presentation.deck_json); } catch { return res.status(422).json({ error: 'Presentation document is invalid' }); }
  if (deck.version !== 'mbfd-deck-v2' || !Object.values(PROFILE_IDS).includes(deck.wall_profile)) return res.status(422).json({ error: 'Slide assistance requires an mbfd-deck-v2 presentation' });
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return res.status(404).json({ error: 'slide not found' });
  const instruction = String(req.body.instruction || '').slice(0, 1200);
  const jobId = uuidv4();
  db.prepare(`INSERT INTO ai_generation_jobs (id, workspace_id, user_id, job_type, model, prompt, presentation_id, status)
              VALUES (?, ?, ?, 'slide_assist_v2', ?, ?, ?, 'pending')`)
    .run(jobId, req.workspaceId, req.user.id, config.ollamaModel, `${action}: ${instruction}`.slice(0, 2000), presentationId);
  res.status(202).json({ job_id: jobId, status: 'pending' });
  (async () => {
    try {
      db.prepare("UPDATE ai_generation_jobs SET status='running' WHERE id=?").run(jobId);
      const suggestion = await ai.assistSlideV2({ slide, wallProfile: deck.wall_profile, action, instruction });
      db.prepare(`UPDATE ai_generation_jobs SET status='done', result_json=?, completed_at=strftime('%s','now') WHERE id=?`)
        .run(JSON.stringify({ presentation_id: presentationId, slide_id: slideId, action, suggestion }), jobId);
    } catch (error) {
      db.prepare(`UPDATE ai_generation_jobs SET status='error', error_msg=?, completed_at=strftime('%s','now') WHERE id=?`)
        .run(String(error.message || error).slice(0, 500), jobId);
    }
  })();
});

// Poll a job. Workspace-scoped + per-user (Phase 2.5): a caller may only poll
// their own generation jobs. Acting-as impersonation and elevated roles pass.
router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM ai_generation_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.workspace_id !== req.workspaceId) return res.status(403).json({ error: 'Access denied' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(job.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && !ELEVATED_ROLES.includes(req.user.role) && job.user_id && job.user_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only access your own AI jobs' });
  }
  let result = null;
  if (job.result_json) { try { result = JSON.parse(job.result_json); } catch { /* */ } }
  res.json({ id: job.id, status: job.status, job_type: job.job_type, presentation_id: job.presentation_id || null, result, error: job.error_msg || null, created_at: job.created_at, completed_at: job.completed_at });
});

// Service health (lets the UI tell the user if the local model is down).
router.get('/health', async (req, res) => {
  if (!config.features.aiDeckBuilder) return res.json({ enabled: false });
  try { const p = await ai.ping(); res.json({ enabled: true, ok: true, model: config.ollamaModel, models: p.models }); }
  catch (e) { res.json({ enabled: true, ok: false, error: String(e.message || e) }); }
});

module.exports = router;
