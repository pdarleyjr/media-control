'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

class MediaJobArtifactStore {
  constructor(db, contentDir, options = {}) {
    this.db = db;
    this.contentDir = path.resolve(contentDir);
    this.now = options.now || (() => Math.floor(Date.now() / 1000));
    this.uuid = options.uuid || randomUUID;
  }

  safePath(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (path.dirname(resolved) !== this.contentDir) {
      const error = new Error('media_job_artifact_outside_content_root');
      error.code = 'path_outside_content_directory';
      error.retryable = false;
      throw error;
    }
    return resolved;
  }

  register(job, filePath) {
    const safe = this.safePath(filePath);
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare('SELECT content_id,cancel_requested FROM media_jobs WHERE id=?').get(job.id);
      if (!current || String(current.content_id || '') !== String(job.content_id || '')
          || Number(current.cancel_requested) === 1) {
        const error = new Error('media_job_cancelled');
        error.code = 'media_job_cancelled';
        error.retryable = false;
        throw error;
      }
      if (!this.db.prepare('SELECT 1 FROM content WHERE id=?').get(job.content_id)) {
        const error = new Error('content_missing');
        error.code = 'content_missing';
        error.retryable = false;
        throw error;
      }
      if (tableExists(this.db, 'content_erase_operations')) {
        const erasing = this.db.prepare(`SELECT 1 FROM content_erase_operations
          WHERE content_id=? AND state IN ('prepared','staged','catalog_committed','cleanup_pending','recovery_failed')
          LIMIT 1`).get(job.content_id);
        if (erasing) {
          const error = new Error('content_erase_in_progress');
          error.code = 'media_job_cancelled';
          error.retryable = false;
          throw error;
        }
      }
      this.db.prepare(`INSERT OR IGNORE INTO media_job_artifacts
        (id,job_id,content_id,file_path,created_at) VALUES (?,?,?,?,?)`)
        .run(this.uuid(), job.id, job.content_id, safe, this.now());
    });
    transaction();
    return safe;
  }

  release(jobId, filePath) {
    const safe = this.safePath(filePath);
    this.db.prepare('DELETE FROM media_job_artifacts WHERE job_id=? AND file_path=?').run(jobId, safe);
  }

  pathsForContent(contentId) {
    return this.db.prepare('SELECT file_path FROM media_job_artifacts WHERE content_id=? ORDER BY created_at,id')
      .all(contentId).map((row) => row.file_path);
  }

  isAuthoritativePath(filePath) {
    const values = [filePath, path.basename(filePath)];
    const checks = [
      `SELECT 1 FROM content WHERE filepath IN (?,?) OR original_filepath IN (?,?)
        OR thumbnail_path IN (?,?) LIMIT 1`,
      'SELECT 1 FROM asset_variants WHERE file_path IN (?,?) LIMIT 1',
      `SELECT 1 FROM asset_checksums WHERE canonical_path IN (?,?)
        OR poster_path IN (?,?) LIMIT 1`,
      'SELECT 1 FROM content_media_metadata WHERE thumbnail_source_filepath IN (?,?) LIMIT 1',
      'SELECT 1 FROM download_jobs WHERE local_path IN (?,?) AND status <> \'error\' LIMIT 1',
    ];
    for (const sql of checks) {
      const count = (sql.match(/\?/g) || []).length;
      const params = Array.from({ length: count }, (_, index) => values[index % 2]);
      try { if (this.db.prepare(sql).get(...params)) return true; } catch (error) {
        if (!/no such table|no such column/i.test(error.message)) throw error;
      }
    }
    return false;
  }

  async cleanupJob(jobId) {
    const artifacts = this.db.prepare('SELECT id,file_path FROM media_job_artifacts WHERE job_id=? ORDER BY created_at,id')
      .all(jobId);
    for (const artifact of artifacts) {
      let safe;
      try { safe = this.safePath(artifact.file_path); } catch { continue; }
      if (this.isAuthoritativePath(safe)) {
        this.db.prepare('DELETE FROM media_job_artifacts WHERE id=?').run(artifact.id);
        continue;
      }
      if (path.basename(safe).endsWith('.part.mp4')) {
        const prefix = `${path.parse(safe).name}.`;
        let siblings = [];
        try { siblings = await fs.promises.readdir(this.contentDir); } catch { siblings = []; }
        let siblingFailure = false;
        for (const sibling of siblings.filter((name) => name.startsWith(prefix))) {
          try { await fs.promises.unlink(path.join(this.contentDir, sibling)); } catch (error) {
            if (error.code !== 'ENOENT') siblingFailure = true;
          }
        }
        if (siblingFailure) continue;
      }
      try { await fs.promises.unlink(safe); } catch (error) { if (error.code !== 'ENOENT') continue; }
      this.db.prepare('DELETE FROM media_job_artifacts WHERE id=?').run(artifact.id);
    }
  }

  async cleanupOrphans() {
    const jobs = this.db.prepare(`SELECT DISTINCT a.job_id
      FROM media_job_artifacts a
      LEFT JOIN content c ON c.id=a.content_id
      LEFT JOIN media_jobs j ON j.id=a.job_id
      WHERE c.id IS NULL OR j.id IS NULL OR j.status <> 'running'
        OR j.lease_expires_at IS NULL OR j.lease_expires_at <= ?`).all(this.now());
    for (const job of jobs) await this.cleanupJob(job.job_id);
    return jobs.length;
  }
}

module.exports = { MediaJobArtifactStore };
