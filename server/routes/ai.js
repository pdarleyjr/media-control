const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const config = require('../config');
const ai = require('../services/ai');

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
    } catch (e) {
      db.prepare(`UPDATE ai_generation_jobs SET status = 'error', error_msg = ?, completed_at = strftime('%s','now') WHERE id = ?`)
        .run(String(e.message || e).slice(0, 500), jobId);
    }
  })();
});

// Poll a job. Workspace-scoped.
router.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM ai_generation_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.workspace_id !== req.workspaceId) return res.status(403).json({ error: 'Access denied' });
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
