'use strict';

function ensurePreparationSchema(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(node_assets)').all().map((column) => column.name),
  );
  if (!columns.has('generation')) {
    db.exec('ALTER TABLE node_assets ADD COLUMN generation INTEGER');
  }
  if (!columns.has('updated_at')) {
    db.exec('ALTER TABLE node_assets ADD COLUMN updated_at INTEGER');
  }
}

function boundedError(value) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, 512) : null;
}

function manifestForContent(db, contentId, workspaceId) {
  return db.prepare(`
    SELECT ac.asset_id, ac.content_id, ac.generation, ac.sha256, ac.size_bytes,
           ac.canonical_path, ac.canonical_url, c.processing_status, c.workspace_id
    FROM asset_checksums ac
    JOIN content c ON c.id = ac.content_id
    WHERE ac.content_id = ? AND c.workspace_id = ?
  `).get(String(contentId || ''), String(workspaceId || '')) || null;
}

function queuePreparation(db, options = {}) {
  ensurePreparationSchema(db);
  const contentId = String(options.contentId || '');
  const workspaceId = String(options.workspaceId || '');
  const nodeId = String(options.nodeId || '');
  if (!contentId || !workspaceId || !nodeId) {
    return { ok: false, reason: 'invalid_request' };
  }
  const node = db.prepare(
    'SELECT node_id FROM managed_nodes WHERE node_id = ? AND workspace_id = ?',
  ).get(nodeId, workspaceId);
  if (!node) return { ok: false, reason: 'node_not_in_workspace' };
  const manifest = manifestForContent(db, contentId, workspaceId);
  if (!manifest
    || manifest.processing_status !== 'ready'
    || !/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ''))
    || Number(manifest.size_bytes) <= 0
    || Number(manifest.generation) < 1) {
    return { ok: false, reason: 'content_not_ready' };
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO node_assets (
      asset_id, node_id, desired, sync_status, generation, checksum_verified,
      bytes_downloaded, last_attempt_at, error_message, updated_at
    ) VALUES (?, ?, 1, 'pending', ?, 0, 0, ?, NULL, ?)
    ON CONFLICT(asset_id, node_id) DO UPDATE SET
      desired = 1,
      sync_status = CASE
        WHEN node_assets.generation = excluded.generation
         AND node_assets.checksum_verified = 1 THEN node_assets.sync_status
        ELSE 'pending'
      END,
      generation = excluded.generation,
      checksum_verified = CASE
        WHEN node_assets.generation = excluded.generation
          THEN node_assets.checksum_verified
        ELSE 0
      END,
      bytes_downloaded = CASE
        WHEN node_assets.generation = excluded.generation
          THEN node_assets.bytes_downloaded
        ELSE 0
      END,
      last_attempt_at = excluded.last_attempt_at,
      error_message = NULL,
      updated_at = excluded.updated_at
  `).run(
    manifest.asset_id,
    nodeId,
    Number(manifest.generation),
    now,
    now,
  );
  return {
    ok: true,
    state: 'queued',
    node_id: nodeId,
    item: {
      asset_id: manifest.asset_id,
      content_id: manifest.content_id,
      generation: Number(manifest.generation),
      sha256: String(manifest.sha256).toLowerCase(),
      size: Number(manifest.size_bytes),
      size_bytes: Number(manifest.size_bytes),
      canonical_path: manifest.canonical_path || null,
      canonical_url: manifest.canonical_url || `/api/content/${encodeURIComponent(contentId)}/file`,
    },
  };
}

function recordPreparationResult(db, nodeId, payload = {}) {
  ensurePreparationSchema(db);
  const contentId = String(payload.content_id || '');
  const normalizedNodeId = String(nodeId || '');
  const generation = Number(payload.generation);
  if (!contentId || !normalizedNodeId || !Number.isInteger(generation) || generation < 1) {
    return { applied: false, reason: 'invalid_result' };
  }
  const row = db.prepare(`
    SELECT na.asset_id, na.generation, na.desired
    FROM node_assets na
    JOIN asset_checksums ac ON ac.asset_id = na.asset_id
    WHERE ac.content_id = ? AND na.node_id = ?
  `).get(contentId, normalizedNodeId);
  if (!row) return { applied: false, reason: 'not_requested' };
  if (Number(row.generation) !== generation) {
    return { applied: false, reason: 'generation_mismatch' };
  }
  if (Number(row.desired) !== 1) {
    return { applied: false, reason: 'cancelled' };
  }

  const ok = payload.ok === true;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE node_assets
    SET sync_status = ?,
        checksum_verified = ?,
        last_success_at = ?,
        error_message = ?,
        updated_at = ?
    WHERE asset_id = ? AND node_id = ? AND generation = ?
  `).run(
    ok ? 'ready' : 'failed',
    ok ? 1 : 0,
    ok ? now : null,
    ok ? null : boundedError(payload.error || payload.reason || 'prewarm_failed'),
    now,
    row.asset_id,
    normalizedNodeId,
    generation,
  );
  return { applied: true, state: ok ? 'classroom_ready' : 'failed' };
}

function preparationStatus(db, options = {}) {
  ensurePreparationSchema(db);
  const manifest = manifestForContent(db, options.contentId, options.workspaceId);
  if (!manifest) {
    return {
      state: 'server_not_ready',
      checksum_verified: false,
      cache_hit_observed: false,
      retryable: false,
      nodes: [],
    };
  }
  const rows = db.prepare(`
    SELECT na.*, mn.node_name, mn.last_heartbeat
    FROM node_assets na
    JOIN managed_nodes mn ON mn.node_id = na.node_id
    WHERE na.asset_id = ? AND mn.workspace_id = ?
    ORDER BY na.node_id
  `).all(manifest.asset_id, String(options.workspaceId || ''));
  const current = rows.filter((row) => Number(row.generation) === Number(manifest.generation));
  let state = 'not_requested';
  if (current.length && current.every((row) => Number(row.desired) === 0)) state = 'cancelled';
  else if (current.some((row) => row.sync_status === 'failed')) state = 'failed';
  else if (current.length && current.every((row) => Number(row.checksum_verified) === 1)) {
    state = 'classroom_ready';
  } else if (current.some((row) => row.sync_status === 'downloading')) state = 'downloading';
  else if (current.length) state = 'queued';

  const checksumVerified = current.length > 0
    && current.every((row) => Number(row.checksum_verified) === 1);
  const size = Number(manifest.size_bytes) || 0;
  const downloaded = current.reduce(
    (maximum, row) => Math.max(maximum, Number(row.bytes_downloaded) || 0),
    0,
  );
  return {
    state,
    content_id: manifest.content_id,
    generation: Number(manifest.generation),
    checksum_verified: checksumVerified,
    cache_hit_observed: false,
    progress_pct: size > 0 ? Math.min(100, Math.round((downloaded / size) * 100)) : null,
    bytes_downloaded: downloaded,
    size_bytes: size,
    retryable: state === 'failed' || state === 'cancelled' || state === 'not_requested',
    nodes: current.map((row) => ({
      node_id: row.node_id,
      node_name: row.node_name || row.node_id,
      state: row.sync_status,
      desired: Number(row.desired) === 1,
      checksum_verified: Number(row.checksum_verified) === 1,
      bytes_downloaded: Number(row.bytes_downloaded) || 0,
      last_heartbeat: row.last_heartbeat || null,
      error: row.error_message || null,
    })),
    note: checksumVerified
      ? 'Checksum verified on the classroom node; a playback cache hit must still be observed separately.'
      : 'Classroom readiness requires checksum verification and a separately observed playback cache hit.',
  };
}

function cancelPreparation(db, options = {}) {
  ensurePreparationSchema(db);
  const manifest = manifestForContent(db, options.contentId, options.workspaceId);
  if (!manifest) return { cancelled: false, reason: 'not_found' };
  const rows = db.prepare(
    'SELECT node_id, sync_status FROM node_assets WHERE asset_id = ? AND desired = 1',
  ).all(manifest.asset_id);
  if (!rows.length) return { cancelled: false, reason: 'not_requested' };
  if (rows.some((row) => row.sync_status !== 'pending')) {
    return { cancelled: false, reason: 'already_started' };
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE node_assets
    SET desired = 0, sync_status = 'cancelled', updated_at = ?
    WHERE asset_id = ? AND desired = 1 AND sync_status = 'pending'
  `).run(now, manifest.asset_id);
  return { cancelled: true, state: 'cancelled' };
}

module.exports = {
  cancelPreparation,
  ensurePreparationSchema,
  preparationStatus,
  queuePreparation,
  recordPreparationResult,
};
