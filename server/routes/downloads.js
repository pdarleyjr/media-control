const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const { ownedContentScope } = require('../lib/content-scope');
const { finalizeDownload } = require('../lib/finalize-download');
const { getMediaPipeline } = require('../lib/media-pipeline');
const { assertRemoteUrlSafe } = require('../lib/ssrf-policy');
const { sanitizeString } = require('../middleware/sanitize');
const config = require('../config');

// MBFD Media Control Studio — media downloads by URL (Phase 7). Records jobs in
// download_jobs and runs yt-dlp when it's present in the container. yt-dlp is
// NOT in the base node:22-alpine image; until it's added to the Dockerfile
// (e.g. `apk add --no-cache yt-dlp ffmpeg`), /health reports available:false
// and jobs fail fast with a clear message — functioning scaffolding per spec.

let ytdlpPath = null;
let probed = false;
function probeYtdlp() {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--version'], { timeout: 5000, windowsHide: true }, (error) => {
      ytdlpPath = error ? null : 'yt-dlp';
      probed = true;
      resolve(ytdlpPath);
    });
  });
}

function writeGate(req, res) {
  if (!config.features.mediaDownloader) { res.status(503).json({ error: 'Downloads is disabled' }); return null; }
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') { res.status(403).json({ error: 'Read-only access' }); return null; }
  return ctx;
}

router.get('/health', async (req, res) => {
  if (!config.features.mediaDownloader) return res.json({ enabled: false });
  if (!probed) await probeYtdlp();
  res.json({ enabled: true, available: !!ytdlpPath });
});

// Phase 2.5: per-user — a caller sees only their own download jobs in the
// current workspace (no platform-template download jobs exist, but the shared
// scope helper keeps the pattern consistent with content/presentations).
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scope = ownedContentScope(req.workspaceId, req.user.id);
  const jobs = db.prepare(`SELECT * FROM download_jobs WHERE ${scope.clause} ORDER BY created_at DESC LIMIT 100`).all(...scope.params);
  // Self-heal: any 'done' job still missing a content_id (completed before this
  // fix shipped, or whose worker-side finalize threw) gets its content row now.
  // finalizeDownload is idempotent, so this is a cheap no-op for already-linked jobs.
  for (const j of jobs) {
    if (j.status === 'done' && !j.content_id) {
      try { finalizeDownload({ db, contentDir: config.contentDir, jobId: j.id }); } catch (e) { console.error('downloads.js finalize (poll):', e.message); }
    }
  }
  res.json(db.prepare(`SELECT * FROM download_jobs WHERE ${scope.clause} ORDER BY created_at DESC LIMIT 100`).all(...scope.params));
});

router.post('/', async (req, res) => {
  if (!writeGate(req, res)) return;
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A valid http(s) URL is required' });
  const safe = await assertRemoteUrlSafe(url);
  if (!safe.ok) return res.status(400).json({ code: safe.reason, error: safe.error });
  const title = (String(req.body.title || '').trim()) || null;
  const id = uuidv4();
  const contentId = uuidv4();
  const parsed = safe.parsed;
  const displayName = sanitizeString(
    title || path.basename(parsed.pathname) || `Downloaded media ${id.slice(0, 8)}`,
  );
  const sourceUrl = parsed.toString().slice(0, 1000);
  const now = Math.floor(Date.now() / 1000);
  const pipeline = getMediaPipeline({ db, io: req.app.get('io'), contentDir: config.contentDir });
  let queued;
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (
          id, user_id, workspace_id, filename, filepath, mime_type, file_size,
          remote_url, processing_status, access_level
        ) VALUES (?, ?, ?, ?, '', 'video/mp4', 0, ?, 'processing', 'private')
      `).run(contentId, req.user.id, req.workspaceId, displayName, sourceUrl);
      db.prepare(`
        INSERT INTO content_media_metadata (
          content_id, workspace_id, source_type, source_identity, source_url,
          detected_mime_type, remote_health_status, remote_source_kind,
          created_at, updated_at
        ) VALUES (?, ?, 'url_download', ?, ?, 'video/mp4', 'importing',
          'imported_local', ?, ?)
      `).run(contentId, req.workspaceId, sourceUrl, sourceUrl, now, now);
      db.prepare(`
        INSERT INTO download_jobs (
          id, workspace_id, user_id, source_url, title, content_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(id, req.workspaceId, req.user.id, sourceUrl, title, contentId);
      queued = pipeline.enqueueUrlDownload({
        contentId,
        workspaceId: req.workspaceId,
        userId: req.user.id,
        url: sourceUrl,
        downloadJobId: id,
        expectedVersion: 1,
      });
    })();
  } catch (error) {
    console.error('[downloads] queue failed:', error.message);
    return res.status(500).json({
      code: 'DOWNLOAD_QUEUE_FAILED',
      error: 'The download could not be queued.',
    });
  }
  res.status(202).json({
    id,
    status: 'pending',
    content_id: contentId,
    media_job_id: queued.job.id,
  });
});

module.exports = router;
