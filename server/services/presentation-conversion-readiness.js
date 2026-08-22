'use strict';

const { contentBroadcastReadiness } = require('../lib/content-readiness');

function refreshPresentationConversionReadiness(db, job) {
  if (!job || job.status !== 'completed' || !job.result?.presentation_id) return job;
  const videos = db.prepare(`SELECT c.* FROM presentation_assets pa
    JOIN content c ON c.id=pa.content_id
    WHERE pa.presentation_id=? AND LOWER(c.mime_type) LIKE 'video/%'`).all(job.result.presentation_id);
  const checks = videos.map((content) => ({ content, readiness: contentBroadcastReadiness(db, content) }));
  const failed = checks.filter(({ readiness }) => readiness.code === 'CONTENT_PROCESSING_FAILED');
  const readyCount = checks.filter(({ readiness }) => readiness.ready).length;
  const broadcastReady = readyCount === videos.length;
  const embeddedMediaStatus = broadcastReady ? 'ready' : failed.length ? 'failed' : 'preparing';
  const result = {
    ...job.result,
    media_preparing: !broadcastReady && failed.length === 0,
    broadcast_ready: broadcastReady,
    embedded_media_status: embeddedMediaStatus,
    embedded_media_total: videos.length,
    embedded_media_ready: readyCount,
    embedded_media_errors: failed.map(({ content, readiness }) => ({
      content_id: content.id,
      code: readiness.code,
      error: readiness.error,
    })),
  };
  const stage = broadcastReady ? 'ready' : 'preparing';
  const progressPct = broadcastReady ? 100 : 99;
  if (job.stage !== stage || job.progress_pct !== progressPct || JSON.stringify(job.result) !== JSON.stringify(result)) {
    db.prepare(`UPDATE media_jobs SET stage=?,progress_pct=?,result_json=?,updated_at=strftime('%s','now')
      WHERE id=? AND status='completed'`).run(stage, progressPct, JSON.stringify(result), job.id);
  }
  return { ...job, stage, progress_pct: progressPct, result };
}

module.exports = { refreshPresentationConversionReadiness };
