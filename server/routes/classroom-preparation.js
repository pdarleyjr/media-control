'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const {
  cancelPreparation,
  preparationStatus,
  queuePreparation,
} = require('../lib/classroom-preparation');
const nodeRegistry = require('../lib/node-registry');
const { contentUseDecision, contextFromRequest } = require('../lib/content-visibility');
const { audit } = require('../lib/audit');
const { getClientIp } = require('../services/activity');

const router = express.Router();

function canWrite(req, res) {
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' });
    return false;
  }
  return true;
}

function preparationContent(req, contentId) {
  return contentUseDecision(
    db,
    String(contentId || ''),
    req.workspaceId,
    contextFromRequest(req),
  );
}

function auditPreparation(req, action, contentId, details = {}) {
  audit({
    actorType: 'user',
    actorId: req.user.id,
    action,
    targetType: 'content',
    targetId: contentId,
    workspaceId: req.workspaceId,
    sourceIp: getClientIp(req),
    details,
  });
}

function queueOne(req, contentId) {
  const decision = preparationContent(req, contentId);
  if (!decision.content) return { status: 404, body: { error: 'Content not found' } };
  if (!decision.allowed) return { status: 403, body: { error: decision.reason } };
  const classroomCache = config.classroomCache || {};
  if (!classroomCache.enabled) {
    return { status: 503, body: { error: 'Classroom cache is disabled', code: 'CACHE_DISABLED' } };
  }
  const queued = queuePreparation(db, {
    contentId: decision.content.id,
    workspaceId: req.workspaceId,
    nodeId: classroomCache.nodeId,
  });
  if (!queued.ok) {
    const status = queued.reason === 'content_not_ready' ? 409 : 503;
    return {
      status,
      body: {
        error: queued.reason === 'content_not_ready'
          ? 'Server processing must finish before preparing this item for class.'
          : 'The classroom node is not ready for preparation.',
        code: String(queued.reason || 'PREPARATION_FAILED').toUpperCase(),
      },
    };
  }
  const emitted = nodeRegistry.emitContentPrewarm(req.app.get('io'), db, {
    item: queued.item,
    classroomCache,
    allowWorkspaceOwned: true,
  });
  if (!emitted.requested) {
    db.prepare(`
      UPDATE node_assets
      SET sync_status = 'failed', error_message = ?, updated_at = strftime('%s','now')
      WHERE asset_id = ? AND node_id = ? AND generation = ?
    `).run(
      String(emitted.reason || 'prewarm_unavailable').slice(0, 512),
      queued.item.asset_id,
      classroomCache.nodeId,
      queued.item.generation,
    );
    return {
      status: 503,
      body: {
        error: 'The classroom node could not accept this preparation request.',
        code: String(emitted.reason || 'PREWARM_UNAVAILABLE').toUpperCase(),
      },
    };
  }
  auditPreparation(req, 'content.prepare_for_class', decision.content.id, {
    generation: queued.item.generation,
    node_id: classroomCache.nodeId,
  });
  return {
    status: 202,
    body: preparationStatus(db, {
      contentId: decision.content.id,
      workspaceId: req.workspaceId,
    }),
  };
}

router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canWrite(req, res)) return undefined;
  const ids = [...new Set(
    (Array.isArray(req.body?.content_ids) ? req.body.content_ids : [req.body?.content_id])
      .filter(Boolean)
      .map(String),
  )].slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: 'content_id or content_ids is required' });
  const results = ids.map((contentId) => ({
    content_id: contentId,
    ...queueOne(req, contentId),
  }));
  const accepted = results.filter((result) => result.status === 202).length;
  return res.status(accepted > 0 ? 202 : Math.max(...results.map((result) => result.status))).json({
    accepted,
    total: results.length,
    results: results.map(({ content_id, status, body }) => ({
      content_id,
      status,
      ...body,
    })),
  });
});

router.get('/:contentId', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const decision = preparationContent(req, req.params.contentId);
  if (!decision.content) return res.status(404).json({ error: 'Content not found' });
  if (!decision.allowed) return res.status(403).json({ error: decision.reason });
  res.set('Cache-Control', 'no-store');
  return res.json(preparationStatus(db, {
    contentId: decision.content.id,
    workspaceId: req.workspaceId,
  }));
});

router.post('/:contentId/retry', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canWrite(req, res)) return undefined;
  const result = queueOne(req, req.params.contentId);
  return res.status(result.status).json(result.body);
});

router.delete('/:contentId', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canWrite(req, res)) return undefined;
  const decision = preparationContent(req, req.params.contentId);
  if (!decision.content) return res.status(404).json({ error: 'Content not found' });
  if (!decision.allowed) return res.status(403).json({ error: decision.reason });
  const result = cancelPreparation(db, {
    contentId: decision.content.id,
    workspaceId: req.workspaceId,
  });
  if (!result.cancelled) {
    return res.status(result.reason === 'already_started' ? 409 : 404).json({
      error: result.reason === 'already_started'
        ? 'Preparation has already started and can no longer be cancelled safely.'
        : 'No pending preparation request was found.',
      code: String(result.reason || 'CANCEL_FAILED').toUpperCase(),
    });
  }
  auditPreparation(req, 'content.prepare_for_class.cancel', decision.content.id);
  return res.json(result);
});

module.exports = router;
