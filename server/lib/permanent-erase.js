'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

function safeUnlink(filePath) {
  if (!filePath) return false;
  try {
    const root = path.resolve(require('../config').contentDir);
    const resolved = path.resolve(root, path.basename(filePath));
    if (path.dirname(resolved) !== root) return false;
    if (fs.existsSync(resolved)) { fs.unlinkSync(resolved); return true; }
    return false;
  } catch { return false; }
}

function contentUsage(db, contentId) {
  const playlists = db.prepare(`SELECT DISTINCT p.id, p.name, p.workspace_id
    FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.content_id = ?`).all(contentId);
  const assignments = db.prepare(`SELECT a.id, a.device_id, d.name AS device_name, d.workspace_id
    FROM assignments a LEFT JOIN devices d ON d.id = a.device_id WHERE a.content_id = ?`).all(contentId);
  const references = [
    ...db.prepare(`SELECT id, title AS name, 'schedule' AS type FROM schedules WHERE content_id = ?`).all(contentId),
    ...db.prepare(`SELECT id, name, 'video_wall' AS type FROM video_walls WHERE content_id = ?`).all(contentId),
    ...db.prepare(`SELECT id, activity_id AS name, 'scene' AS type FROM activity_asset_placements WHERE content_id = ?`).all(contentId),
    ...db.prepare(`SELECT id, presentation_id AS name, 'presentation' AS type FROM presentation_assets WHERE content_id = ?`).all(contentId),
    ...db.prepare(`SELECT id, label AS name, 'advanced_canvas' AS type FROM advanced_canvas_layers
      WHERE source_json LIKE ?`).all(`%"content_id":"${contentId}"%`),
    ...db.prepare(`SELECT id, name, 'device_default' AS type FROM devices WHERE default_content_id = ?`).all(contentId),
    ...db.prepare(`SELECT id, name, 'widget' AS type FROM widgets
      WHERE config LIKE ?`).all(`%/api/content/${contentId}/%`),
  ];
  return {
    content_id: contentId,
    usage_count: playlists.length + assignments.length + references.length,
    playlists,
    assignments,
    references,
  };
}

function previewPermanentErase(db, contentId) {
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(contentId);
  if (!content) return { found: false };
  const usage = contentUsage(db, contentId);
  const jobs = db.prepare(`SELECT id, job_type, status, stage FROM media_jobs WHERE content_id = ? AND status NOT IN ('completed','failed','cancelled')`).all(contentId);
  const assets = db.prepare(`SELECT id, filename, filepath, mime_type, file_size FROM content WHERE source_content_id = ? OR id = ?`).all(contentId, contentId);
  return {
    found: true,
    content: { ...content, library_scope: content.library_scope || 'library' },
    usage,
    jobs,
    assets,
    files: [content.filepath, content.original_filepath, content.thumbnail_path].filter(Boolean),
  };
}

function detachReferences(db, contentId) {
  const detached = [];
  const tx = db.transaction(() => {
    for (const pl of db.prepare(`SELECT id FROM playlist_items WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM playlist_items WHERE id = ?').run(pl.id);
      detached.push({ type: 'playlist_item', id: pl.id });
    }
    for (const a of db.prepare(`SELECT id FROM assignments WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
      detached.push({ type: 'assignment', id: a.id });
    }
    for (const s of db.prepare(`SELECT id FROM schedules WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
      detached.push({ type: 'schedule', id: s.id });
    }
    for (const vw of db.prepare(`SELECT id FROM video_walls WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM video_walls WHERE id = ?').run(vw.id);
      detached.push({ type: 'video_wall', id: vw.id });
    }
    for (const aap of db.prepare(`SELECT id FROM activity_asset_placements WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM activity_asset_placements WHERE id = ?').run(aap.id);
      detached.push({ type: 'scene', id: aap.id });
    }
    for (const pa of db.prepare(`SELECT id FROM presentation_assets WHERE content_id = ?`).all(contentId)) {
      db.prepare('DELETE FROM presentation_assets WHERE id = ?').run(pa.id);
      detached.push({ type: 'presentation_asset', id: pa.id });
    }
    db.prepare(`UPDATE advanced_canvas_layers SET source_json = json_remove(source_json, '$."${contentId}"') WHERE source_json LIKE ?`).run(`%"content_id":"${contentId}"%`);
    db.prepare(`UPDATE devices SET default_content_id = NULL WHERE default_content_id = ?`).run(contentId);
    db.prepare(`UPDATE widgets SET config = REPLACE(config, ?, ?) WHERE config LIKE ?`).run(`/api/content/${contentId}/`, '', `%/api/content/${contentId}/%`);
  });
  tx();
  return detached;
}

function cancelJobs(db, contentId) {
  const cancelled = [];
  for (const job of db.prepare(`SELECT id FROM media_jobs WHERE content_id = ? AND status NOT IN ('completed','failed','cancelled')`).all(contentId)) {
    db.prepare(`UPDATE media_jobs SET status='cancelled', stage='cancelled', cancel_requested=1, error_code='content_permanently_erased', error_message='Content was permanently erased', updated_at=strftime('%s','now') WHERE id = ?`).run(job.id);
    cancelled.push(job.id);
  }
  for (const job of db.prepare(`SELECT id FROM download_jobs WHERE content_id = ? AND status NOT IN ('done','error')`).all(contentId)) {
    db.prepare(`UPDATE download_jobs SET status='cancelled', error_msg='Content was permanently erased', updated_at=strftime('%s','now') WHERE id = ?`).run(job.id);
    cancelled.push(job.id);
  }
  return cancelled;
}

function eraseFiles(content) {
  const erased = [];
  for (const rel of [content.filepath, content.original_filepath, content.thumbnail_path]) {
    if (rel && safeUnlink(rel)) erased.push(rel);
  }
  return erased;
}

function invalidateCaches(db, contentId) {
  db.prepare('DELETE FROM asset_checksums WHERE content_id = ?').run(contentId);
  db.prepare('DELETE FROM content_media_metadata WHERE content_id = ?').run(contentId);
  db.prepare('DELETE FROM content_captions WHERE content_id = ?').run(contentId);
  db.prepare('DELETE FROM content_favorites WHERE content_id = ?').run(contentId);
}

function permanentlyEraseContent(db, contentId) {
  const preview = previewPermanentErase(db, contentId);
  if (!preview.found) return { erased: false, reason: 'not_found' };
  const tx = db.transaction(() => {
    detachReferences(db, contentId);
    cancelJobs(db, contentId);
    invalidateCaches(db, contentId);
    const files = eraseFiles(preview.content);
    db.prepare('DELETE FROM content WHERE id = ?').run(contentId);
  });
  tx();
  return { erased: true, preview, files_erased: preview.files.length };
}

module.exports = {
  previewPermanentErase,
  permanentlyEraseContent,
  detachReferences,
  cancelJobs,
  eraseFiles,
  invalidateCaches,
};
