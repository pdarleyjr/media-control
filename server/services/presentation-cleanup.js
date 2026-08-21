'use strict';

const { randomUUID } = require('node:crypto');
const { migratePresentationCleanupLedger } = require('../db/migrations/presentation-cleanup-ledger');
const { eraseContent, eraseImpact } = require('./content-permanent-erase');

function parseIds(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

function pendingEraseOperation(db, contentId) {
  try {
    const operation = db.prepare(`SELECT id,state FROM content_erase_operations
      WHERE content_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(contentId);
    if (!operation || ['completed', 'rolled_back'].includes(operation.state)) return null;
    return operation;
  } catch {
    return null;
  }
}

function beginPresentationCleanup(db, { presentationId, workspaceId, operationId = randomUUID() }) {
  migratePresentationCleanupLedger(db);
  const assetIds = db.prepare(`SELECT DISTINCT content_id FROM presentation_assets
    WHERE presentation_id=? AND content_id IS NOT NULL`).all(presentationId).map((row) => row.content_id);
  const sourceIds = db.prepare(`SELECT DISTINCT source_content_id FROM presentation_conversion_runs
    WHERE presentation_id=? AND source_content_id IS NOT NULL`).all(presentationId).map((row) => row.source_content_id);
  const contentIds = [...new Set([...assetIds, ...sourceIds].map(String).filter(Boolean))];
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare(`INSERT INTO presentation_cleanup_operations
      (id,presentation_id,workspace_id,state,remaining_content_ids_json,created_at,updated_at)
      VALUES (?,?,?,'pending',?,?,?)`).run(
      operationId, presentationId, workspaceId, JSON.stringify(contentIds), now, now,
    );
    const deleted = db.prepare('DELETE FROM presentations WHERE id=? AND workspace_id=?')
      .run(presentationId, workspaceId);
    if (deleted.changes !== 1) throw new Error('Presentation changed before deletion.');
  })();
  return operationId;
}

function processPresentationCleanup(db, operationId, options = {}) {
  migratePresentationCleanupLedger(db);
  const operation = db.prepare('SELECT * FROM presentation_cleanup_operations WHERE id=?').get(operationId);
  if (!operation) return null;
  if (operation.state === 'completed') {
    return { operation_id: operation.id, state: 'completed', erased: [], skipped_shared: [], errors: [] };
  }
  const erase = options.eraseContent || eraseContent;
  const remaining = [];
  const erased = [];
  const skippedShared = [];
  const errors = [];
  for (const contentId of parseIds(operation.remaining_content_ids_json)) {
    const content = db.prepare(`SELECT * FROM content
      WHERE id=? AND workspace_id=? AND library_scope='internal'`).get(contentId, operation.workspace_id);
    if (!content) {
      const eraseOperation = pendingEraseOperation(db, contentId);
      if (eraseOperation) {
        remaining.push(contentId);
        errors.push({ content_id: contentId, code: 'PRESENTATION_ASSET_ERASE_PENDING', erase_operation_id: eraseOperation.id });
      }
      continue;
    }
    const stillAsset = db.prepare('SELECT 1 FROM presentation_assets WHERE content_id=? LIMIT 1').get(contentId);
    const stillSource = db.prepare(`SELECT 1 FROM presentation_conversion_runs
      WHERE source_content_id=? AND presentation_id IS NOT NULL LIMIT 1`).get(contentId);
    if (stillAsset || stillSource) {
      skippedShared.push(contentId);
      continue;
    }
    let nonPresentationImpact;
    try {
      nonPresentationImpact = eraseImpact(db, contentId, { contentDir: options.contentDir });
    } catch {
      remaining.push(contentId);
      errors.push({ content_id: contentId, code: 'PRESENTATION_ASSET_REFERENCE_CHECK_FAILED' });
      continue;
    }
    if (nonPresentationImpact && nonPresentationImpact.dependency_count > 0) {
      skippedShared.push(contentId);
      continue;
    }
    try {
      const result = erase(db, contentId, { contentDir: options.contentDir });
      if (!result || result.success !== true) {
        remaining.push(contentId);
        errors.push({
          content_id: contentId,
          code: 'PRESENTATION_ASSET_ERASE_PENDING',
          erase_operation_id: result?.operation_id || null,
        });
      } else erased.push({
        content_id: contentId,
        asset_id: result.impact.cache.asset_id,
        generation: result.impact.cache.generation,
        node_ids: result.impact.cache.node_ids,
      });
    } catch (error) {
      remaining.push(contentId);
      errors.push({ content_id: contentId, code: error.code || 'PRESENTATION_CLEANUP_FAILED' });
    }
  }
  const state = remaining.length ? 'cleanup_pending' : 'completed';
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE presentation_cleanup_operations
    SET state=?,remaining_content_ids_json=?,error_json=?,updated_at=?,completed_at=? WHERE id=?`).run(
    state,
    JSON.stringify(remaining),
    errors.length ? JSON.stringify(errors) : null,
    now,
    state === 'completed' ? now : null,
    operationId,
  );
  return {
    operation_id: operationId,
    state,
    erased,
    skipped_shared: skippedShared,
    errors,
  };
}

function reconcilePresentationCleanupOperations(db, options = {}) {
  migratePresentationCleanupLedger(db);
  return db.prepare(`SELECT id FROM presentation_cleanup_operations
    WHERE state IN ('pending','cleanup_pending') ORDER BY created_at,id`).all()
    .map((row) => processPresentationCleanup(db, row.id, options));
}

module.exports = {
  beginPresentationCleanup,
  processPresentationCleanup,
  reconcilePresentationCleanupOperations,
};
