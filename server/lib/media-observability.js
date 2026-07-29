'use strict';

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function safeOne(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || {};
  } catch {
    return {};
  }
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(boundedNumber(value) * factor) / factor;
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index];
}

function parseTelemetry(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mediaObservabilitySnapshot(db, options = {}) {
  const workspaceId = String(options.workspaceId || '');
  if (!workspaceId) throw new Error('workspace_id_required');
  const now = Math.floor(Number(options.now) || Date.now() / 1000);
  const stuckSeconds = Math.max(60, Number(options.stuckSeconds) || 15 * 60);

  const queueRows = safeAll(
    db,
    `SELECT status, COUNT(*) AS count
     FROM media_jobs
     WHERE workspace_id=?
     GROUP BY status`,
    workspaceId,
  );
  const depth = {
    queued: 0,
    running: 0,
    retry_wait: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of queueRows) depth[row.status] = boundedNumber(row.count);
  const oldest = safeOne(
    db,
    `SELECT MIN(created_at) AS created_at
     FROM media_jobs
     WHERE workspace_id=? AND status IN ('queued','running','retry_wait')`,
    workspaceId,
  );
  const oldestActiveAge = oldest.created_at == null
    ? null
    : Math.max(0, now - boundedNumber(oldest.created_at));

  const manifest = safeOne(
    db,
    `SELECT
       COUNT(*) AS eligible,
       SUM(CASE WHEN ac.content_id IS NOT NULL THEN 1 ELSE 0 END) AS covered
     FROM content c
     LEFT JOIN asset_checksums ac ON ac.content_id=c.id
     WHERE c.workspace_id=?
       AND c.archived_at IS NULL
       AND COALESCE(c.filepath, '') <> ''
       AND COALESCE(c.file_size, 0) > 0
       AND COALESCE(c.processing_status, 'ready')='ready'`,
    workspaceId,
  );
  const eligible = boundedNumber(manifest.eligible);
  const covered = boundedNumber(manifest.covered);

  const thumbnailFailures = safeOne(
    db,
    `SELECT COUNT(*) AS count
     FROM media_jobs
     WHERE workspace_id=? AND job_type='thumbnail_finalize' AND status='failed'`,
    workspaceId,
  );
  const thumbnailMissing = safeOne(
    db,
    `SELECT COUNT(*) AS count
     FROM content
     WHERE workspace_id=? AND archived_at IS NULL
       AND processing_status='ready'
       AND mime_type LIKE 'video/%'
       AND COALESCE(thumbnail_path, '')=''`,
    workspaceId,
  );

  const jobDurations = safeAll(
    db,
    `SELECT mj.job_type, mj.created_at, mj.started_at, mj.completed_at,
            mj.reserved_bytes, ac.size_bytes
     FROM media_jobs mj
     LEFT JOIN asset_checksums ac ON ac.content_id=mj.content_id
     WHERE mj.workspace_id=? AND mj.status='completed'
       AND mj.completed_at IS NOT NULL`,
    workspaceId,
  );
  const readinessLatencies = jobDurations
    .map(row => boundedNumber(row.completed_at) - boundedNumber(row.created_at))
    .filter(value => value >= 0);
  const encodeRows = jobDurations.filter(row => (
    row.job_type === 'video_normalize'
    && boundedNumber(row.started_at) > 0
    && boundedNumber(row.completed_at) > boundedNumber(row.started_at)
  ));
  const encodeSeconds = encodeRows.reduce(
    (sum, row) => sum + (boundedNumber(row.completed_at) - boundedNumber(row.started_at)),
    0,
  );
  const encodeBytes = encodeRows.reduce(
    (sum, row) => sum + boundedNumber(row.size_bytes || row.reserved_bytes),
    0,
  );

  const sourceRows = safeAll(
    db,
    `SELECT COALESCE(source_type, 'unknown') AS source_type,
            COUNT(*) AS total,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
     FROM media_jobs
     WHERE workspace_id=?
     GROUP BY COALESCE(source_type, 'unknown')`,
    workspaceId,
  );
  const sources = {};
  for (const row of sourceRows) {
    const total = boundedNumber(row.total);
    const failed = boundedNumber(row.failed);
    sources[row.source_type] = {
      total,
      completed: boundedNumber(row.completed),
      failed,
      failure_rate: total > 0 ? round(failed / total) : 0,
    };
  }

  const telemetryRows = safeAll(
    db,
    `SELECT telemetry_json
     FROM managed_nodes
     WHERE workspace_id=?`,
    workspaceId,
  );
  let cacheHits = 0;
  let cacheMisses = 0;
  let p3ManifestCount = 0;
  for (const row of telemetryRows) {
    const cache = parseTelemetry(row.telemetry_json).cache || {};
    cacheHits += boundedNumber(cache.cache_hits);
    cacheMisses += boundedNumber(cache.cache_misses);
    p3ManifestCount += boundedNumber(cache.manifest_count);
  }
  const cacheRequests = cacheHits + cacheMisses;

  const stuck = safeAll(
    db,
    `SELECT id, content_id, job_type, stage, progress_pct, updated_at
     FROM media_jobs
     WHERE workspace_id=? AND status='running' AND updated_at<=?
     ORDER BY updated_at, id
     LIMIT 100`,
    workspaceId,
    now - stuckSeconds,
  );
  const alerts = [];
  if (stuck.length) {
    alerts.push({
      code: 'MEDIA_JOB_STUCK',
      severity: 'high',
      count: stuck.length,
      message: `${stuck.length} media job(s) have not advanced within ${stuckSeconds} seconds.`,
      job_ids: stuck.map(row => row.id),
    });
  }
  if (eligible > 0 && covered === 0) {
    alerts.push({
      code: 'ZERO_ITEM_MANIFEST',
      severity: 'high',
      count: eligible,
      message: 'Ready local media exists but no checksum manifest rows are present.',
    });
  }
  if (telemetryRows.length && p3ManifestCount === 0 && eligible > 0) {
    alerts.push({
      code: 'P3_ZERO_ITEM_MANIFEST',
      severity: 'high',
      count: eligible,
      message: 'The classroom node reports a zero-item manifest while ready local media exists.',
    });
  }
  if (boundedNumber(thumbnailFailures.count) > 0) {
    alerts.push({
      code: 'THUMBNAIL_FAILURES',
      severity: 'medium',
      count: boundedNumber(thumbnailFailures.count),
      message: 'One or more thumbnail jobs require retry or repair.',
    });
  }

  return {
    generated_at: new Date(now * 1000).toISOString(),
    workspace_id: workspaceId,
    queue: {
      depth,
      active: depth.queued + depth.running + depth.retry_wait,
      oldest_active_age_sec: oldestActiveAge,
      stuck_after_sec: stuckSeconds,
      stuck_jobs: stuck,
    },
    processing: {
      completed_samples: jobDurations.length,
      broadcast_ready_latency_avg_sec: readinessLatencies.length
        ? round(readinessLatencies.reduce((sum, value) => sum + value, 0) / readinessLatencies.length)
        : null,
      broadcast_ready_latency_p95_sec: percentile(readinessLatencies, 0.95),
      encode_samples: encodeRows.length,
      encode_speed_bytes_per_sec: encodeSeconds > 0 ? Math.round(encodeBytes / encodeSeconds) : null,
      encode_speed_note: 'Effective completed-output throughput; not an FFmpeg-reported instantaneous speed.',
    },
    thumbnails: {
      failures: boundedNumber(thumbnailFailures.count),
      ready_video_missing_poster: boundedNumber(thumbnailMissing.count),
    },
    manifest: {
      eligible,
      covered,
      missing: Math.max(0, eligible - covered),
      coverage_pct: eligible > 0 ? round((covered / eligible) * 100, 1) : 100,
      p3_reported_items: p3ManifestCount,
    },
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
      hit_ratio: cacheRequests > 0 ? round(cacheHits / cacheRequests) : null,
      source: 'latest managed-node telemetry counters',
    },
    sources,
    alerts,
  };
}

module.exports = {
  mediaObservabilitySnapshot,
  percentile,
};
