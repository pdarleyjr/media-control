'use strict';

const express = require('express');
const router = express.Router();
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const { db } = require('../db/database');
const { getMediaPipeline } = require('../lib/media-pipeline');
const { listPresentationSources, presentationSourceDecision } = require('../services/presentation-source-access');
const { ELEVATED_ROLES } = require('../middleware/auth');
const { PROFILE_IDS } = require('../lib/presentation-template-registry');
const { MODES } = require('../services/presentation-converter');
const { PPTX_MIME } = require('../services/presentation-conversion-job');
const { refreshPresentationConversionReadiness } = require('../services/presentation-conversion-readiness');
const upload = require('../middleware/upload');
const { sanitizeString } = require('../middleware/sanitize');

function requireFeature(_req, res, next) {
  if (!config.features.presentationConverter) return res.status(404).json({ error: 'Presentation Converter is disabled' });
  next();
}

function visibilityContext(req) {
  return {
    userId: req.user.id,
    userRole: req.user.role,
    workspaceId: req.workspaceId,
    organizationId: req.organizationId,
    workspaceRole: req.workspaceRole,
    orgRole: req.orgRole,
    isPlatformAdmin: req.isPlatformAdmin === true || ELEVATED_ROLES.includes(req.user.role),
  };
}

function canWrite(req) {
  const ctx = visibilityContext(req);
  return ctx.isPlatformAdmin
    || ['org_owner', 'org_admin'].includes(ctx.orgRole)
    || ['workspace_admin', 'workspace_editor'].includes(ctx.workspaceRole);
}

function requireConverterWrite(req, res, next) {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  return next();
}

function ownedJob(req, res) {
  const job = getMediaPipeline({ db }).store.get(req.params.id);
  if (!job || job.job_type !== 'presentation_convert') { res.status(404).json({ error: 'Conversion job not found' }); return null; }
  const elevated = ELEVATED_ROLES.includes(req.user.role) || req.isPlatformAdmin === true;
  if (job.workspace_id !== req.workspaceId || (!elevated && job.user_id !== req.user.id)) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return job;
}

router.use(requireFeature);

router.get('/sources', requireConverterWrite, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(listPresentationSources(db, req.workspaceId, visibilityContext(req)));
});

router.post('/sources', requireConverterWrite, upload.single('file'), (req, res) => {
  const file = req.file;
  const uploadedPath = upload.resolveUploadedFilePath(file);
  const isPptx = file
    && uploadedPath
    && (file.mimetype === PPTX_MIME || /\.pptx$/i.test(file.originalname || ''))
    && Number(file.size) > 0;
  if (!isPptx) {
    upload.discardUploadedFile(file);
    return res.status(400).json({ error: 'Presentation Converter currently accepts non-empty PPTX source files' });
  }
  const id = randomUUID();
  const filename = sanitizeString(path.basename(String(file.originalname || 'presentation.pptx')).normalize('NFC'));
  try {
    db.prepare(`INSERT INTO content
      (id,user_id,workspace_id,filename,filepath,mime_type,file_size,content_type,
       access_level,processing_status,library_scope)
      VALUES (?,?,?,?,?,?,?,'presentation_source','private','ready','internal')`)
      .run(id, req.user.id, req.workspaceId, filename, file.filename, PPTX_MIME, file.size);
    return res.status(201).json({ id, content_id: id, filename, library_scope: 'internal' });
  } catch (error) {
    upload.discardUploadedFile(file);
    console.warn('[presentation-converter] internal source upload failed:', error.message);
    return res.status(500).json({ error: 'Could not store presentation source' });
  }
});

router.post('/jobs', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canWrite(req)) return res.status(403).json({ error: 'Read-only access' });
  const contentId = String(req.body.content_id || '').trim();
  const wallProfile = String(req.body.wall_profile || '');
  const mode = req.body.mode === MODES.OPTIMIZED ? MODES.OPTIMIZED : MODES.FAITHFUL;
  if (!contentId) return res.status(400).json({ error: 'content_id required' });
  if (!Object.values(PROFILE_IDS).includes(wallProfile)) return res.status(400).json({ error: 'invalid wall_profile' });
  const decision = presentationSourceDecision(db, contentId, req.workspaceId, visibilityContext(req));
  if (!decision.allowed) return res.status(403).json({ error: decision.reason || 'Source is not available in this workspace' });
  const source = decision.content;
  if (source.mime_type !== PPTX_MIME && !/\.pptx$/i.test(source.filename || '')) {
    return res.status(400).json({ error: 'Presentation Converter currently accepts PPTX source files' });
  }
  const pipeline = getMediaPipeline({ db });
  const queued = pipeline.enqueuePresentationConversion({
    contentId,
    workspaceId: req.workspaceId,
    userId: req.user.id,
    wallProfile,
    mode,
    useAi: req.body.use_ai !== false,
    title: req.body.title,
  });
  res.status(202).json({
    id: queued.job.id,
    status: queued.job.status,
    stage: queued.job.stage,
    progress_pct: queued.job.progress_pct,
    created: queued.created,
  });
});

router.get('/jobs/:id', (req, res) => {
  let job = ownedJob(req, res);
  if (!job) return;
  job = refreshPresentationConversionReadiness(db, job);
  const latestEvent = getMediaPipeline({ db }).store.latestEvent(job.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress_pct: job.progress_pct,
    mode: job.payload?.mode || MODES.FAITHFUL,
    wall_profile: job.payload?.wall_profile || null,
    use_ai: job.payload?.use_ai !== false,
    attempts: job.attempts,
    detail: latestEvent?.detail || null,
    result: job.result,
    error: job.error_message ? { code: job.error_code, message: job.error_message, retryable: job.retryable === 1 } : null,
    cancel_requested: job.cancel_requested === 1,
    created_at: job.created_at,
    started_at: job.started_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  });
});

router.post('/jobs/:id/cancel', requireConverterWrite, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  const updated = getMediaPipeline({ db }).store.requestCancel(job.id);
  res.json({ id: updated.id, status: updated.status, cancel_requested: updated.cancel_requested === 1 });
});

router.post('/jobs/:id/retry', requireConverterWrite, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (job.status !== 'failed') return res.status(409).json({ error: 'Only failed jobs can be retried' });
  const pipeline = getMediaPipeline({ db });
  const updated = pipeline.store.retry(job.id, { resetAttempts: true });
  pipeline.schedule();
  res.status(202).json({ id: updated.id, status: updated.status, progress_pct: updated.progress_pct });
});

router.post('/jobs/:id/retry-faithful', requireConverterWrite, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (job.status !== 'failed' || job.payload?.mode !== MODES.OPTIMIZED) {
    return res.status(409).json({ error: 'Only a failed Instructor Optimized conversion can retry as Faithful.' });
  }
  const decision = presentationSourceDecision(db, job.content_id, req.workspaceId, visibilityContext(req));
  if (!decision.allowed) return res.status(409).json({ error: 'The original source is no longer available.' });
  const pipeline = getMediaPipeline({ db });
  const queued = pipeline.enqueuePresentationConversion({
    contentId: job.content_id,
    workspaceId: job.workspace_id,
    userId: job.user_id,
    wallProfile: job.payload.wall_profile,
    mode: MODES.FAITHFUL,
    useAi: false,
    title: job.payload.title,
    idempotencyKey: `presentation-faithful-retry:${job.id}`,
  });
  res.status(202).json({
    id: queued.job.id,
    status: queued.job.status,
    stage: queued.job.stage,
    progress_pct: queued.job.progress_pct,
    mode: MODES.FAITHFUL,
    retry_of: job.id,
    created: queued.created,
  });
});

module.exports = router;
