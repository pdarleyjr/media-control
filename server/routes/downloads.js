const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const { ownedContentScope } = require('../lib/content-scope');
const { finalizeDownload } = require('../lib/finalize-download');
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
    execFile('sh', ['-c', 'command -v yt-dlp || which yt-dlp'], (e, out) => {
      ytdlpPath = (!e && out && out.trim().split(/\r?\n/)[0]) || null;
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
  const title = (String(req.body.title || '').trim()) || null;
  const id = uuidv4();
  db.prepare("INSERT INTO download_jobs (id, workspace_id, user_id, source_url, title, status) VALUES (?, ?, ?, ?, ?, 'pending')")
    .run(id, req.workspaceId, req.user.id, url.slice(0, 1000), title);
  res.status(202).json({ id, status: 'pending' });

  (async () => {
    if (!probed) await probeYtdlp();
    if (!ytdlpPath) {
      db.prepare("UPDATE download_jobs SET status = 'error', error_msg = ?, completed_at = strftime('%s','now') WHERE id = ?")
        .run('yt-dlp is not installed in the container — add it to the Dockerfile to enable downloads', id);
      return;
    }
    db.prepare("UPDATE download_jobs SET status = 'downloading', started_at = strftime('%s','now') WHERE id = ?").run(id);
    const outTpl = path.join(config.contentDir, id + '.%(ext)s');
    execFile(ytdlpPath, ['-f', 'mp4/best', '--no-playlist', '--max-filesize', '2g', '-o', outTpl, url], { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) {
        db.prepare("UPDATE download_jobs SET status = 'error', error_msg = ?, completed_at = strftime('%s','now') WHERE id = ?")
          .run(String(stderr || err.message).slice(0, 500), id);
        return;
      }
      db.prepare("UPDATE download_jobs SET status = 'done', progress_pct = 100, completed_at = strftime('%s','now') WHERE id = ?").run(id);
      // REPAIR 3: register the finished file as a content row so it's reachable
      // from the Media Library / playlists / broadcast (was orphaned before).
      // Idempotent — a re-run is a no-op once the job has a content_id.
      try {
        finalizeDownload({ db, contentDir: config.contentDir, jobId: id });
      } catch (e) {
        console.error('downloads.js finalize:', e.message);
      }
    });
  })();
});

module.exports = router;
