const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const upload = require('../middleware/upload');
const config = require('../config');
const { checkStorageLimit, checkRemoteUrl } = require('../middleware/subscription');
const { sanitizeString } = require('../middleware/sanitize');
const { PLATFORM_ROLES } = require('../middleware/auth');
// Phase 2.2b: workspace-aware access. Mirrors the pattern from devices.js.
const {
  VISIBILITY,
  normalizeVisibility,
  contentVisibilityScope,
  canReadContent,
  contentCapabilities,
} = require('../lib/content-visibility');
const { contentRowsWithThumbnailUrls } = require('../lib/content-response');
const { gridUrlReferencesContent } = require('../lib/public-content-access');
const { checkRemoteUrlShape, assertRemoteUrlSafe } = require('../lib/ssrf-policy');
const { isDocThumbnailMime, kickDocThumbnail } = require('../lib/doc-thumbnail');
const { isHeicMime, heicToJpeg, kickHevcTranscodeIfNeeded } = require('../lib/media-transcode');
const { prewarmUploadedContent } = require('../lib/node-registry');
const { logActivity, getClientIp } = require('../services/activity');

function visibilityContext(req, overrides = {}) {
  return {
    userId: req.user?.id,
    userRole: req.user?.role,
    workspaceId: req.workspaceId || null,
    organizationId: req.organizationId || null,
    workspaceRole: req.workspaceRole || null,
    orgRole: req.orgRole || null,
    isPlatformAdmin: req.isPlatformAdmin === true
      || PLATFORM_ROLES.includes(req.user?.role),
    ...overrides,
  };
}

function requireContentWriteRole(req, res, next) {
  const ctx = visibilityContext(req);
  const allowed = ctx.isPlatformAdmin
    || ctx.orgRole === 'org_owner'
    || ctx.orgRole === 'org_admin'
    || ctx.workspaceRole === 'workspace_admin'
    || ctx.workspaceRole === 'workspace_editor';
  if (!allowed) return res.status(403).json({ error: 'Read-only access' });
  next();
}

function contentSelect(req) {
  const workspaceId = req.workspaceId || '';
  return {
    sql: `
      SELECT c.*, w.organization_id, u.name AS owner_name, u.email AS owner_email,
        EXISTS (
          SELECT 1 FROM content_template_assignments cta
          WHERE cta.content_id = c.id AND cta.workspace_id = ?
        ) AS template_assigned,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.content_id = c.id)
          + (SELECT COUNT(*) FROM assignments a WHERE a.content_id = c.id)
          + (SELECT COUNT(*) FROM schedules s WHERE s.content_id = c.id)
          + (SELECT COUNT(*) FROM video_walls vw WHERE vw.content_id = c.id)
          + (SELECT COUNT(*) FROM activity_asset_placements aap WHERE aap.content_id = c.id)
          + (SELECT COUNT(*) FROM presentation_assets pa WHERE pa.content_id = c.id)
          + (SELECT COUNT(*) FROM advanced_canvas_layers acl
              WHERE acl.source_json LIKE '%"content_id":"' || c.id || '"%')
          + (SELECT COUNT(*) FROM devices dd WHERE dd.default_content_id = c.id) AS usage_count,
        (SELECT cpr.status FROM content_publication_requests cpr
          WHERE cpr.content_id = c.id ORDER BY cpr.created_at DESC LIMIT 1) AS publication_request_status
      FROM content c
      LEFT JOIN workspaces w ON w.id = c.workspace_id
      LEFT JOIN users u ON u.id = c.user_id
    `,
    params: [workspaceId],
  };
}

function decorateContent(row, req) {
  if (!row) return row;
  const caps = contentCapabilities(row, visibilityContext(req, { includeArchived: true }));
  return {
    ...row,
    visibility: {
      access_level: row.access_level || VISIBILITY.PRIVATE,
      owner_user_id: row.user_id || null,
      owner_name: row.owner_name || row.owner_email || null,
      workspace_id: row.workspace_id || null,
      organization_id: row.organization_id || null,
      published_at: row.published_at || null,
      published_by: row.published_by || null,
      archived_at: row.archived_at || null,
      publication_request_status: row.publication_request_status || null,
    },
    permissions: {
      is_owner: caps.isOwner,
      can_edit: caps.canEditMetadata,
      can_change_visibility: caps.canChangeVisibility,
      allowed_visibilities: caps.allowedVisibilities,
      can_request_organization: caps.canRequestOrganization,
      can_duplicate: caps.canDuplicate,
      can_archive: caps.canArchive,
      can_delete: caps.canDelete,
      can_transfer: caps.canTransfer,
      can_review_publication_requests: caps.canReviewPublicationRequests,
    },
  };
}

function getContentRow(req, id) {
  const select = contentSelect(req);
  return db.prepare(`${select.sql} WHERE c.id = ?`).get(...select.params, id);
}

function auditContent(req, action, before, after, details = null) {
  const activityId = logActivity(
    req.user?.id,
    action,
    details,
    null,
    getClientIp(req),
    after?.workspace_id || before?.workspace_id || req.workspaceId || null,
  );
  try {
    db.prepare(`UPDATE activity_log SET resource_type = 'content', before_state = ?, after_state = ?
      WHERE id = ?`)
      .run(before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, activityId);
  } catch { /* legacy schemas retain the base activity row */ }
}

function contentUsage(contentId) {
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
  const gridDependencies = db.prepare(`SELECT DISTINCT grid.id, grid.filename AS name,
      grid.remote_url, p.workspace_id, 'grid_dependency' AS type
    FROM content grid
    JOIN playlist_items pi ON pi.content_id = grid.id
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE grid.remote_url LIKE '%/player/grid.html%cells=%'`).all()
    .filter((row) => gridUrlReferencesContent(row.remote_url, contentId))
    .map(({ remote_url: _remoteUrl, ...row }) => row);
  references.push(...gridDependencies);
  return {
    content_id: contentId,
    usage_count: playlists.length + assignments.length + references.length,
    playlists,
    assignments,
    references,
  };
}

// Returns display/control references for one destination workspace. This is
// deliberately stricter than the general usage summary: removing a platform
// template assignment must never strand a published route in that workspace.
function contentUsageInWorkspace(contentId, workspaceId) {
  const references = [
    ...db.prepare(`SELECT DISTINCT p.id, p.name, 'playlist' AS type
      FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
      WHERE pi.content_id = ? AND p.workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT a.id, COALESCE(d.name, a.device_id) AS name, 'assignment' AS type
      FROM assignments a JOIN devices d ON d.id = a.device_id
      WHERE a.content_id = ? AND d.workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT s.id, s.title AS name, 'schedule' AS type
      FROM schedules s
      LEFT JOIN devices d ON d.id = s.device_id
      LEFT JOIN device_group_members dgm ON dgm.group_id = s.group_id
      LEFT JOIN devices gd ON gd.id = dgm.device_id
      WHERE s.content_id = ? AND COALESCE(d.workspace_id, gd.workspace_id) = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT vw.id, vw.name, 'video_wall' AS type
      FROM video_walls vw JOIN video_wall_devices vwd ON vwd.wall_id = vw.id
      JOIN devices d ON d.id = vwd.device_id
      WHERE vw.content_id = ? AND d.workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT aap.id, oa.name, 'scene' AS type
      FROM activity_asset_placements aap JOIN operational_activities oa ON oa.id = aap.activity_id
      WHERE aap.content_id = ? AND oa.workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT pa.id, p.title AS name, 'presentation' AS type
      FROM presentation_assets pa JOIN presentations p ON p.id = pa.presentation_id
      WHERE pa.content_id = ? AND p.workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT DISTINCT acl.id, COALESCE(acl.label, ace.name) AS name, 'advanced_canvas' AS type
      FROM advanced_canvas_layers acl JOIN advanced_canvas_endpoints ace ON ace.id = acl.endpoint_id
      WHERE acl.source_json LIKE ? AND ace.workspace_id = ?`).all(`%"content_id":"${contentId}"%`, workspaceId),
    ...db.prepare(`SELECT id, name, 'device_default' AS type FROM devices
      WHERE default_content_id = ? AND workspace_id = ?`).all(contentId, workspaceId),
    ...db.prepare(`SELECT id, name, 'widget' AS type FROM widgets
      WHERE config LIKE ? AND workspace_id = ?`).all(`%/api/content/${contentId}/%`, workspaceId),
  ];
  const gridDependencies = db.prepare(`SELECT DISTINCT grid.id, grid.filename AS name,
      grid.remote_url, 'grid_dependency' AS type
    FROM content grid
    JOIN playlist_items pi ON pi.content_id = grid.id
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE grid.remote_url LIKE '%/player/grid.html%cells=%' AND p.workspace_id = ?`).all(workspaceId)
    .filter((row) => gridUrlReferencesContent(row.remote_url, contentId))
    .map(({ remote_url: _remoteUrl, ...row }) => row);
  references.push(...gridDependencies);
  return { content_id: contentId, workspace_id: workspaceId, usage_count: references.length, references };
}

// Multer captures file.originalname directly from the multipart filename header,
// bypassing sanitizeBody. Apply the same HTML-escape here so a filename like
// `"><img src=x onerror=alert(1)>.jpg` is stored as `&quot;&gt;&lt;img...` and
// renders as text in every UI sink. Umlauts, spaces, dots, and other unicode are
// preserved - sanitizeString only touches `& < > " '`.
//
// .normalize('NFC') first: macOS clients send NFD-decomposed filenames (an
// umlaut like "u" + combining diaeresis U+0308 instead of the precomposed
// "u-umlaut" U+00FC). Linux + most renderers expect NFC; without this, names
// like "Begrussungsscreens.jpg" arrive with the combining char floating and
// display as mojibake. Single-point fix - every user-facing filename storage
// site (POST /, POST /remote, POST /embed, PUT /:id rename) flows through
// safeFilename, so normalizing here covers all paths.
function safeFilename(name) {
  return sanitizeString((name || '').normalize('NFC'));
}

function removeLocalContentFile(relativePath) {
  if (!relativePath || /^https?:\/\//i.test(relativePath)) return;
  const root = path.resolve(config.contentDir);
  const candidate = path.resolve(root, path.basename(relativePath));
  if (path.dirname(candidate) !== root) return;
  try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch (error) {
    console.warn(`Could not remove superseded content file ${path.basename(relativePath)}: ${error.message}`);
  }
}

// SSRF gate for remote_url (synchronous shape check). Returns null if the URL
// shape is acceptable, else { status, error }. Delegates to the centralized
// policy in lib/ssrf-policy.js so the deny rules (loopback/private/link-local/
// Tailscale/metadata) live in ONE place and stay consistent across broadcast,
// widgets, kiosk, scenes, and content. Used by PUT /:id (a stored remote_url
// that isn't re-fetched here) so a user can't bypass the check by uploading a
// benign URL then PUT-updating it to an internal address.
//
// This is the literal-host check only; routes that actively reach out (POST
// /remote) additionally await assertRemoteUrlSafe() to resolve DNS and close
// the rebinding hole.
function validateRemoteUrl(url) {
  const r = checkRemoteUrlShape(url);
  return r.ok ? null : { status: 400, error: r.error };
}

// List content in the caller's current workspace, plus any platform-template
// rows (workspace_id IS NULL) that are shared with all workspaces.
// Phase 2.2b: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list filter.
// folder_id filter: omit for everything; "root" or "" for root-level only; <uuid> for that folder.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const folder = req.query.folder;
  const folderId = req.query.folder_id;
  const ctx = visibilityContext(req);
  const includeArchived = req.query.archived === 'include' || req.query.archived === 'only';
  const scope = contentVisibilityScope(ctx, { alias: 'c', includeArchived });
  const select = contentSelect(req);
  let sql = `${select.sql} WHERE ${scope.clause}`;
  const params = [...select.params, ...scope.params];
  if (includeArchived && !ctx.isPlatformAdmin && ctx.orgRole !== 'org_owner' && ctx.orgRole !== 'org_admin' && ctx.workspaceRole !== 'workspace_admin') {
    sql += ' AND (c.archived_at IS NULL OR c.user_id = ?)';
    params.push(req.user.id);
  }
  if (req.query.archived === 'only') sql += ' AND c.archived_at IS NOT NULL';
  if (folder) { sql += ' AND c.folder = ?'; params.push(folder); }
  if (folderId !== undefined) {
    if (folderId === 'root' || folderId === '') {
      sql += ' AND c.folder_id IS NULL';
    } else {
      sql += ' AND c.folder_id = ?';
      params.push(folderId);
    }
  }
  if (req.query.visibility && normalizeVisibility(req.query.visibility)) {
    sql += ' AND c.access_level = ?';
    params.push(normalizeVisibility(req.query.visibility));
  }
  if (req.query.owner === 'me') {
    sql += ' AND c.user_id = ?';
    params.push(req.user.id);
  }
  if (req.query.type) {
    sql += ' AND (c.content_type = ? OR c.mime_type LIKE ?)';
    params.push(req.query.type, `${req.query.type}/%`);
  }
  if (req.query.search) {
    sql += ' AND (c.filename LIKE ? ESCAPE \'\\\' OR COALESCE(c.tags_json, \'\') LIKE ? ESCAPE \'\\\')';
    const q = `%${String(req.query.search).replace(/[\\%_]/g, '\\$&')}%`;
    params.push(q, q);
  }
  sql += ' ORDER BY c.folder, c.created_at DESC LIMIT ? OFFSET ?';
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 500));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  params.push(limit, offset);
  const content = db.prepare(sql).all(...params);
  res.json(contentRowsWithThumbnailUrls(
    content.map((row) => decorateContent(row, req)),
    { secret: config.jwtSecret, ttlSeconds: 3600 },
  ));
});

// Get folders list for the caller's current workspace.
router.get('/folders', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scope = contentVisibilityScope(visibilityContext(req), { alias: 'content' });
  const folders = db.prepare(
    `SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL AND ${scope.clause} GROUP BY folder ORDER BY folder`
  ).all(...scope.params);
  res.json(folders);
});

// Upload content
router.post('/', requireContentWriteRole, checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // iPhone HEIC/HEIF -> JPEG up front: neither the display players nor sharp
    // can render HEIC, so transcode to JPEG and continue as a normal image so the
    // existing image branch generates dimensions + a thumbnail. Non-fatal: on
    // failure we keep the original (it just won't render/thumbnail).
    if (isHeicMime(req.file.mimetype)) {
      const conv = await heicToJpeg(req.file.path, config.contentDir).catch(() => null);
      if (conv) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        req.file.path = conv.absPath;
        req.file.filename = conv.filename;
        req.file.mimetype = 'image/jpeg';
        req.file.size = conv.size;
      }
    }

    const id = uuidv4();
    const filepath = req.file.filename;
    let width = null, height = null, durationSec = null, thumbnailPath = null;

    // Try to generate thumbnail, get dimensions, and detect duration.
    // Thumbnail failure must be non-fatal: a 25MP triple-4K wallpaper can
    // exceed libvips defaults or run out of RAM during decode, but the
    // upload itself should still succeed (we keep the original file and
    // accept that the thumbnail might be missing — the UI falls back to a
    // placeholder).
    try {
      if (req.file.mimetype.startsWith('image/')) {
        const sharp = require('sharp');
        // limitInputPixels:false disables libvips's 268MP safety ceiling.
        // We deliberately accept any pixel count the user uploaded — the
        // multer fileSize cap is the real gate. failOn:'none' makes sharp
        // skip transient ICC/EXIF warnings that would otherwise throw on
        // some camera-exported images.
        const sharpOpts = { limitInputPixels: false, failOn: 'none' };
        try {
          const metadata = await sharp(req.file.path, sharpOpts).metadata();
          width = metadata.width;
          height = metadata.height;
        } catch (e) {
          console.warn('sharp metadata read failed (non-fatal):', e.message);
        }
        // Thumbnail: best-effort. Wrapped in its own try so a thumbnail
        // failure does not orphan the upload.
        try {
          thumbnailPath = `thumb_${filepath}`;
          await sharp(req.file.path, sharpOpts)
            .resize(config.thumbnailWidth)
            .jpeg({ quality: 70 })
            .toFile(path.join(config.contentDir, thumbnailPath));
        } catch (e) {
          console.warn('sharp thumbnail generation failed (non-fatal):', e.message);
          thumbnailPath = null;
        }
      } else if (req.file.mimetype.startsWith('video/')) {
        // Extract video duration and dimensions with ffprobe
        try {
          const { execFileSync } = require('child_process');
          // Use execFileSync (not execSync) to prevent shell injection - args are NOT passed through shell
          const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', req.file.path],
            { timeout: 15000 }
          ).toString();
          const info = JSON.parse(probe);
          if (info.format?.duration) durationSec = parseFloat(info.format.duration);
          const videoStream = info.streams?.find(s => s.codec_type === 'video');
          if (videoStream) {
            width = videoStream.width;
            height = videoStream.height;
          }
          // Generate video thumbnail at 2 second mark
          thumbnailPath = `thumb_${filepath.replace(/\.[^.]+$/, '.jpg')}`;
          try {
            execFileSync('ffmpeg', ['-y', '-i', req.file.path, '-ss', '2', '-vframes', '1', '-vf', `scale=${config.thumbnailWidth}:-1`, path.join(config.contentDir, thumbnailPath)],
              { timeout: 15000 }
            );
          } catch { thumbnailPath = null; }
        } catch (e) {
          console.warn('ffprobe failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('Thumbnail/metadata generation failed:', e.message);
    }

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec, thumbnail_path, width, height, access_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')
    `).run(id, req.user.id, req.workspaceId, safeFilename(req.file.originalname), filepath, req.file.mimetype, req.file.size, durationSec, thumbnailPath, width, height);

    // PDF/Office/ODF: thumbnail rendering (poppler / LibreOffice) can take a few
    // seconds, so generate it in the background and attach it to the row when
    // ready — the upload response returns immediately with thumbnail_path null,
    // exactly like the YouTube transcode path. Non-fatal by construction.
    if (isDocThumbnailMime(req.file.mimetype)) {
      kickDocThumbnail(id, req.file.path, req.file.mimetype);
    }
    // iPhone HEVC (H.265) video -> H.264 MP4 in the background so it plays on the
    // display browsers; no-op for H.264. Row is swapped in place when done.
    if (req.file.mimetype.startsWith('video/')) {
      kickHevcTranscodeIfNeeded(id, req.file.path);
    }

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
    prewarmUploadedContent(req.app.get('io'), db, {
      contentId: id,
      absolutePath: req.file.path,
    }).catch((error) => console.warn(`[upload-prewarm] ${id} failed: ${error.message}`));
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Add remote URL content
router.post('/remote', requireContentWriteRole, checkRemoteUrl, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding remote content.' });
    const { url, name, mime_type } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    // Full SSRF check: shape + DNS resolution. A new remote URL will be fetched
    // by the server/displays, so a public hostname that resolves to a private
    // address (DNS rebinding) must be rejected here, not just the literal host.
    const safe = await assertRemoteUrlSafe(url);
    if (!safe.ok) return res.status(400).json({ error: safe.error });

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    // Derive MIME from the URL when the caller doesn't specify one. YouTube URLs
    // must use video/youtube so the player renders via the IFrame API rather than
    // the server-side screenshot fallback (which produces a frozen silent still).
    let mimeType = mime_type;
    if (!mimeType) {
      if (/\.(mp4|webm|mkv|avi|mov|m4v)(?:[?#]|$)/i.test(url)) mimeType = 'video/mp4';
      else if (/\.m3u8(?:[?#]|$)/i.test(url)) mimeType = 'application/x-mpegURL';
      else if (/^rtmp?:\/\//i.test(url) || /^rtsp:\/\//i.test(url)) mimeType = 'video/mp4';
      else if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(url)) mimeType = 'image/jpeg';
      else if (/(?:youtube\.com\/(?:watch|embed|v|shorts)|youtu\.be\/)/i.test(url)) mimeType = 'video/youtube';
      else mimeType = 'text/html';
    }

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
      VALUES (?, ?, ?, ?, '', ?, 0, ?, 'private')
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), mimeType, url);

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('Remote URL add error:', err);
    res.status(500).json({ error: 'Failed to add remote URL' });
  }
});

// Background YouTube transcode via yt-dlp. Pulls the HIGHEST available quality
// (4K/8K when offered) so content looks crisp on large displays and the ultra-
// wide video-wall canvas. The transcoded file is rendered through the HTML5
// video path, which works correctly across multi-tile walls — unlike the YouTube
// iframe, which can only render the video pixels in a centered portion of its
// own frame. Best-effort: if yt-dlp is missing OR transcode fails, the content
// row keeps `mime_type='video/youtube'` so the player falls back to iframe embed.
function transcodeYouTubeInBackground(contentId, videoId) {
  const { execFile } = require('child_process');
  const fs = require('fs');
  const ext = 'mp4';
  const outFilename = `${uuidv4()}.${ext}`;
  const outPath = path.join(config.contentDir, outFilename);
  // -f bestvideo+bestaudio/best pulls the best separate video + audio streams
  // (4K/8K) and muxes them, falling back to a single progressive stream when
  // separate tracks aren't offered. --merge-output-format mp4 keeps one playable
  // file. --no-warnings + --no-progress keeps stderr quiet so we can detect real
  // errors. NOTE: 4K+ on YouTube is typically VP9/AV1 — modern Chromium players
  // and ExoPlayer decode these; only very old TV WebKits may need a 1080p source.
  const args = [
    '-f', 'bestvideo+bestaudio/best',
    '--no-warnings', '--no-progress', '--no-playlist',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  // Download + mux can take a while for 4K/8K. Default 30-minute timeout, tunable
  // via YDLP_TIMEOUT_MS; runaway downloads still die at the cap.
  const ydlpTimeoutMs = (() => {
    const v = parseInt(process.env.YDLP_TIMEOUT_MS, 10);
    return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
  })();
  execFile('yt-dlp', args, { timeout: ydlpTimeoutMs }, (err, stdout, stderr) => {
    if (err) {
      console.warn(`yt-dlp transcode failed for ${videoId}: ${err.message}${stderr ? ' | stderr: ' + String(stderr).slice(0, 200) : ''}`);
      // Mark transcode as failed in the existing row so the dashboard can show status.
      // Player keeps iframe fallback; nothing visible breaks.
      try {
        db.prepare("UPDATE content SET filepath = '' WHERE id = ? AND filepath = ?").run(contentId, outFilename);
      } catch (_) { /* row may have been deleted */ }
      // Clean up any partial file.
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
      return;
    }
    // Probe duration + dimensions before swapping the row to video/mp4.
    let durationSec = null, width = null, height = null, fileSize = 0;
    try {
      const stat = fs.statSync(outPath);
      fileSize = stat.size;
      const { execFileSync } = require('child_process');
      const probe = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', outPath], { timeout: 15000 }).toString();
      const info = JSON.parse(probe);
      if (info.format?.duration) durationSec = parseFloat(info.format.duration);
      const vs = info.streams?.find(s => s.codec_type === 'video');
      if (vs) { width = vs.width; height = vs.height; }
    } catch (e) {
      console.warn(`ffprobe of transcoded YouTube file failed: ${e.message}`);
    }
    try {
      const changed = db.transaction(() => {
        // Do not overwrite a file that an editor replaced while yt-dlp was
        // running. A main-asset mutation increments the governed version and
        // invalidates review of the old bytes.
        const result = db.prepare(`UPDATE content SET filepath = ?, mime_type = 'video/mp4', file_size = ?,
          duration_sec = ?, width = ?, height = ?, version = COALESCE(version, 1) + 1,
          updated_at = strftime('%s','now')
          WHERE id = ? AND mime_type = 'video/youtube' AND remote_url LIKE ?`)
          .run(outFilename, fileSize, durationSec, width, height, contentId, `%${videoId}%`);
        if (result.changes) {
          db.prepare(`UPDATE content_publication_requests
            SET status = 'cancelled', decided_by = NULL,
              decision_reason = 'YouTube asset changed after review was requested',
              decided_at = strftime('%s','now'), updated_at = strftime('%s','now')
            WHERE content_id = ? AND status = 'pending'`).run(contentId);
        }
        return result.changes;
      })();
      if (!changed) {
        try { fs.unlinkSync(outPath); } catch (_) {}
        return;
      }
      console.log(`yt-dlp transcoded ${videoId} -> ${outFilename} (${width}x${height}, ${durationSec}s)`);
    } catch (e) {
      console.error(`Failed to update content row after yt-dlp transcode: ${e.message}`);
    }
  });
}

// Add YouTube content (available to all plans - no storage used)
//
// 2026-05-28: row is created immediately as `video/youtube` (iframe-mode) so
// the dashboard sees the content right away. A background yt-dlp job then
// downloads the video as MP4 and rewrites the row in place to `video/mp4`
// with a local filepath. The next playlist publish picks up the local file
// and the player renders via HTML5 video (works correctly on multi-tile
// walls, unlike the YouTube iframe). If yt-dlp isn't installed (or the
// transcode fails), the row stays as `video/youtube` and falls back to
// iframe embed — same behaviour as before this change.
router.post('/youtube', requireContentWriteRole, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding YouTube content.' });
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Extract YouTube video ID from various URL formats
    const videoId = extractYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // Fetch video title from YouTube oEmbed if no name provided
    let filename = name;
    if (!filename) {
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          filename = oembed.title;
        }
      } catch {}
    }
    if (!filename) filename = `YouTube: ${videoId}`;

    const id = uuidv4();
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=${videoId}&enablejsapi=1`;
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path, access_level)
      VALUES (?, ?, ?, ?, '', 'video/youtube', 0, ?, ?, 'private')
    `).run(id, req.user.id, req.workspaceId, safeFilename(filename), embedUrl, thumbnailUrl);

    // Kick off background transcode (no await — caller gets 201 immediately).
    try { transcodeYouTubeInBackground(id, videoId); } catch (e) {
      console.warn(`Failed to dispatch yt-dlp transcode: ${e.message}`);
    }

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json(content);
  } catch (err) {
    console.error('YouTube add error:', err);
    res.status(500).json({ error: 'Failed to add YouTube video' });
  }
});

function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // bare video ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// List pending organization-publication requests for the active organization.
// Platform administrators may review every organization; org owner/admin is
// constrained to the organization resolved from the active workspace.
router.get('/publication-requests', (req, res) => {
  const ctx = visibilityContext(req);
  const canReview = ctx.isPlatformAdmin || ctx.orgRole === 'org_owner' || ctx.orgRole === 'org_admin';
  if (!canReview) return res.status(403).json({ error: 'Organization admin required' });
  let sql = `
    SELECT cpr.*, c.filename, c.access_level, c.workspace_id, c.user_id AS owner_user_id,
      owner.name AS owner_name, requester.name AS requester_name, w.organization_id
    FROM content_publication_requests cpr
    JOIN content c ON c.id = cpr.content_id
    LEFT JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN users owner ON owner.id = c.user_id
    LEFT JOIN users requester ON requester.id = cpr.requested_by
    WHERE cpr.status = 'pending'`;
  const params = [];
  if (!ctx.isPlatformAdmin) { sql += ' AND w.organization_id = ?'; params.push(ctx.organizationId); }
  sql += ' ORDER BY cpr.created_at ASC';
  res.json(db.prepare(sql).all(...params));
});

router.put('/publication-requests/:requestId', requireContentWriteRole, (req, res) => {
  const request = db.prepare(`
    SELECT cpr.*, c.workspace_id, c.version AS current_version,
      c.original_sha256 AS current_sha256, w.organization_id
    FROM content_publication_requests cpr
    JOIN content c ON c.id = cpr.content_id
    LEFT JOIN workspaces w ON w.id = c.workspace_id
    WHERE cpr.id = ?
  `).get(req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Publication request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Publication request is no longer pending' });
  const ctx = visibilityContext(req);
  const allowed = ctx.isPlatformAdmin
    || ((ctx.orgRole === 'org_owner' || ctx.orgRole === 'org_admin') && request.organization_id === ctx.organizationId);
  if (!allowed) return res.status(403).json({ error: 'Organization admin required' });
  const versionChanged = Number(request.requested_version || 1) !== Number(request.current_version || 1);
  const hashChanged = String(request.requested_sha256 || '') !== String(request.current_sha256 || '');
  if (versionChanged || hashChanged) {
    db.prepare(`UPDATE content_publication_requests SET status = 'cancelled', decided_by = ?,
      decision_reason = 'Content changed after review was requested', decided_at = strftime('%s','now'),
      updated_at = strftime('%s','now') WHERE id = ?`).run(req.user.id, request.id);
    return res.status(409).json({
      code: 'PUBLICATION_REQUEST_STALE',
      error: 'Content changed after review was requested. Submit a new publication request.',
    });
  }
  const decision = req.body.decision === 'approved' ? 'approved'
    : req.body.decision === 'rejected' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const reason = req.body.reason ? sanitizeString(String(req.body.reason)).slice(0, 500) : null;
  const before = getContentRow(req, request.content_id);
  db.transaction(() => {
    db.prepare(`UPDATE content_publication_requests
      SET status = ?, decided_by = ?, decision_reason = ?, decided_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE id = ?`)
      .run(decision, req.user.id, reason, request.id);
    if (decision === 'approved') {
      db.prepare(`UPDATE content SET access_level = ?, published_at = strftime('%s','now'), published_by = ?,
        version = COALESCE(version, 1) + 1, updated_at = strftime('%s','now') WHERE id = ?`)
        .run(VISIBILITY.ORGANIZATION_SHARED, req.user.id, request.content_id);
    }
  })();
  const afterRow = getContentRow(req, request.content_id);
  auditContent(req, `content:publication_${decision}`, before, afterRow, reason);
  res.json({
    ...db.prepare('SELECT * FROM content_publication_requests WHERE id = ?').get(request.id),
    content: decorateContent(afterRow, req),
  });
});

router.post('/:id/publication-request', requireContentWriteRole, (req, res) => {
  const content = getContentRow(req, req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
  if (!caps.canRequestOrganization) return res.status(403).json({ error: 'Only the content owner may request organization publication' });
  if (content.archived_at != null) return res.status(409).json({ error: 'Archived content cannot be published' });
  if (content.access_level === VISIBILITY.ORGANIZATION_SHARED) {
    return res.status(409).json({ error: 'Content is already shared with the organization' });
  }
  const existing = db.prepare("SELECT * FROM content_publication_requests WHERE content_id = ? AND status = 'pending'").get(content.id);
  if (existing) return res.status(200).json(existing);
  const id = uuidv4();
  db.prepare(`INSERT INTO content_publication_requests
    (id, content_id, requested_by, requested_version, requested_sha256)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, content.id, req.user.id, Number(content.version) || 1, content.original_sha256 || null);
  const created = db.prepare('SELECT * FROM content_publication_requests WHERE id = ?').get(id);
  auditContent(req, 'content:publication_requested', content, content, `request_id: ${id}`);
  res.status(201).json(created);
});

router.post('/:id/duplicate', requireContentWriteRole, async (req, res) => {
  const source = checkContentRead(req, res);
  if (!source) return;
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const caps = contentCapabilities(source, visibilityContext(req));
  if (!caps.canDuplicate) return res.status(403).json({ error: 'Access denied' });

  const id = uuidv4();
  const copyName = `${source.filename} (Private copy)`;
  let filepath = source.filepath || '';
  let thumbnailPath = source.thumbnail_path || null;
  try {
    if (source.filepath) {
      const ext = path.extname(source.filepath);
      filepath = `${id}${ext}`;
      await fs.promises.copyFile(path.join(config.contentDir, path.basename(source.filepath)), path.join(config.contentDir, filepath));
    }
    if (source.thumbnail_path && !/^https?:\/\//i.test(source.thumbnail_path)) {
      const thumbExt = path.extname(source.thumbnail_path) || '.jpg';
      thumbnailPath = `thumb_${id}${thumbExt}`;
      await fs.promises.copyFile(path.join(config.contentDir, path.basename(source.thumbnail_path)), path.join(config.contentDir, thumbnailPath));
    }
    db.prepare(`INSERT INTO content (
      id, user_id, workspace_id, filename, filepath, mime_type, file_size, duration_sec,
      thumbnail_path, width, height, remote_url, original_filepath, original_sha256,
      processing_status, processing_error, media_probe_json, content_type, metadata_json,
      tags_json, access_level, source_content_id, version, default_fit_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(
        id, req.user.id, req.workspaceId, copyName, filepath, source.mime_type, source.file_size || 0,
        source.duration_sec, thumbnailPath, source.width, source.height, source.remote_url,
        filepath || null, source.original_sha256, source.processing_status || 'uploaded', source.processing_error,
        source.media_probe_json, source.content_type, source.metadata_json, source.tags_json,
        VISIBILITY.PRIVATE, source.id, source.default_fit_mode,
      );
  } catch (error) {
    try { if (filepath && filepath !== source.filepath) fs.unlinkSync(path.join(config.contentDir, filepath)); } catch {}
    try { if (thumbnailPath && thumbnailPath !== source.thumbnail_path) fs.unlinkSync(path.join(config.contentDir, thumbnailPath)); } catch {}
    return res.status(500).json({ error: `Could not create private copy: ${error.message}` });
  }
  const created = getContentRow(req, id);
  auditContent(req, 'content:duplicate_private', source, created, `source_content_id: ${source.id}`);
  res.status(201).json(decorateContent(created, req));
});

router.put('/:id/archive', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  const archived = req.body.archived !== false;
  const usage = archived ? contentUsage(content.id) : null;
  if (archived && usage.usage_count > 0) {
    return res.status(409).json({
      code: 'CONTENT_IN_USE',
      error: 'Content is currently in use. Remove every active route before archiving it.',
      ...usage,
    });
  }
  db.prepare(`UPDATE content SET archived_at = ${archived ? "strftime('%s','now')" : 'NULL'},
    version = COALESCE(version, 1) + 1, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(content.id);
  const updated = getContentRow(req, content.id);
  auditContent(req, archived ? 'content:archive' : 'content:restore', content, updated);
  res.json(decorateContent(updated, req));
});

router.put('/:id/transfer', requireContentWriteRole, (req, res) => {
  const content = getContentRow(req, req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
  if (!caps.canTransfer) return res.status(403).json({ error: 'Workspace administrator required' });
  const targetUserId = String(req.body.owner_user_id || '');
  const eligible = db.prepare(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?
    UNION SELECT 1 FROM organization_members om JOIN workspaces w ON w.organization_id = om.organization_id
      WHERE w.id = ? AND om.user_id = ? AND om.role IN ('org_owner','org_admin')`)
    .get(content.workspace_id, targetUserId, content.workspace_id, targetUserId);
  if (!eligible) return res.status(400).json({ error: 'New owner must be an eligible member of this workspace or organization' });
  db.prepare(`UPDATE content SET user_id = ?, version = COALESCE(version, 1) + 1,
    updated_at = strftime('%s','now') WHERE id = ?`).run(targetUserId, content.id);
  const updated = getContentRow(req, content.id);
  auditContent(req, 'content:transfer', content, updated, `owner_user_id: ${targetUserId}`);
  res.json(decorateContent(updated, req));
});

router.get('/:id/usage', (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  res.json(contentUsage(content.id));
});

router.put('/:id/template-assignments', requireContentWriteRole, (req, res) => {
  const ctx = visibilityContext(req);
  if (!ctx.isPlatformAdmin) return res.status(403).json({ error: 'Platform admin required' });
  const content = getContentRow(req, req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (content.access_level !== VISIBILITY.PLATFORM_TEMPLATE) {
    return res.status(409).json({ error: 'Only platform templates can be assigned' });
  }
  const workspaceIds = Array.isArray(req.body.workspace_ids) ? [...new Set(req.body.workspace_ids.map(String))] : [];
  const valid = workspaceIds.length
    ? db.prepare(`SELECT id FROM workspaces WHERE id IN (${workspaceIds.map(() => '?').join(',')})`).all(...workspaceIds).map((r) => r.id)
    : [];
  if (valid.length !== workspaceIds.length) return res.status(400).json({ error: 'One or more workspaces do not exist' });
  const current = db.prepare('SELECT workspace_id FROM content_template_assignments WHERE content_id = ?')
    .all(content.id).map((row) => row.workspace_id);
  const requested = new Set(valid);
  for (const removedWorkspaceId of current.filter((workspaceId) => !requested.has(workspaceId))) {
    const usage = contentUsageInWorkspace(content.id, removedWorkspaceId);
    if (usage.usage_count > 0) {
      return res.status(409).json({
        code: 'CONTENT_IN_USE',
        error: 'Remove every active route in this workspace before revoking its template assignment.',
        ...usage,
      });
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM content_template_assignments WHERE content_id = ?').run(content.id);
    const insert = db.prepare(`INSERT INTO content_template_assignments (content_id, workspace_id, assigned_by)
      VALUES (?, ?, ?)`);
    for (const workspaceId of valid) insert.run(content.id, workspaceId, req.user.id);
  })();
  auditContent(req, 'content:template_assignments', content, content, `workspace_count: ${valid.length}`);
  res.json({ content_id: content.id, workspace_ids: valid });
});

router.get('/:id/template-assignments', (req, res) => {
  const ctx = visibilityContext(req);
  if (!ctx.isPlatformAdmin) return res.status(403).json({ error: 'Platform admin required' });
  const content = getContentRow(req, req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (content.access_level !== VISIBILITY.PLATFORM_TEMPLATE) {
    return res.status(409).json({ error: 'Only platform templates have workspace assignments' });
  }
  const workspaceIds = db.prepare(`SELECT workspace_id FROM content_template_assignments
    WHERE content_id = ? ORDER BY workspace_id`).all(content.id).map((row) => row.workspace_id);
  res.json({ content_id: content.id, workspace_ids: workspaceIds });
});

// Phase 2.2b: workspace-aware access. Mirrors the device check pattern.
// Platform-template content (workspace_id IS NULL) is readable by anyone
// and writable only by platform_admin.
function checkContentRead(req, res) {
  const content = getContentRow(req, req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  const ctx = visibilityContext(req);
  if (content.archived_at != null) {
    const caps = contentCapabilities(content, { ...ctx, includeArchived: true });
    if (!caps.canEditMetadata) { res.status(403).json({ error: 'Access denied' }); return null; }
    return content;
  }
  if (!canReadContent(content, ctx)) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

function checkContentWrite(req, res) {
  const content = getContentRow(req, req.params.id);
  if (!content) { res.status(404).json({ error: 'Content not found' }); return null; }
  const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
  if (!caps.canEditMetadata) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

// Get content metadata
router.get('/:id', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  res.json(decorateContent(content, req));
});

// Update content metadata
router.put('/:id', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (req.body.expected_version !== undefined
      && Number(req.body.expected_version) !== Number(content.version || 1)) {
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before saving.' });
  }

  const { filename, mime_type, remote_url, folder, folder_id, default_fit_mode, access_level } = req.body;
  const updates = [];
  const values = [];
  let normalizedAccessLevel = null;
  if (filename !== undefined) { updates.push('filename = ?'); values.push(safeFilename(filename)); }
  if (mime_type !== undefined) { updates.push('mime_type = ?'); values.push(mime_type); }
  if (default_fit_mode !== undefined) {
    const VALID = ['cover', 'contain', 'fill', 'none', 'scale-down'];
    let v = default_fit_mode;
    if (v === null || v === '' || v === 'inherit') v = null;
    else if (typeof v !== 'string' || !VALID.includes(v.toLowerCase())) return res.status(400).json({ error: 'invalid default_fit_mode' });
    else v = v.toLowerCase();
    updates.push('default_fit_mode = ?');
    values.push(v);
  }
  if (remote_url !== undefined) {
    if (remote_url) {
      const urlErr = validateRemoteUrl(remote_url);
      if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
    }
    updates.push('remote_url = ?');
    values.push(remote_url || null);
  }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }
  if (folder_id !== undefined) {
    // Phase 2.2c: target folder must live in the same workspace as the
    // content row being modified. Strict same-workspace check - no
    // platform_admin override, because cross-workspace folder references
    // break the isolation model. To move content across workspaces, switch
    // workspace first.
    if (folder_id) {
      const target = db.prepare('SELECT workspace_id FROM content_folders WHERE id = ?').get(folder_id);
      if (!target) return res.status(400).json({ error: 'Invalid folder_id' });
      if (target.workspace_id !== content.workspace_id) {
        return res.status(403).json({ error: 'Cannot move content to a folder in another workspace' });
      }
    }
    updates.push('folder_id = ?');
    values.push(folder_id || null);
  }
  if (access_level !== undefined) {
    const visibility = normalizeVisibility(access_level);
    if (!visibility) return res.status(400).json({ error: 'Invalid content visibility' });
    const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
    if (!caps.allowedVisibilities.includes(visibility)) {
      if (visibility === VISIBILITY.ORGANIZATION_SHARED) {
        return res.status(403).json({ error: 'Organization admin approval is required' });
      }
      if (visibility === VISIBILITY.PLATFORM_TEMPLATE) {
        return res.status(403).json({ error: 'Platform admin approval is required' });
      }
      return res.status(403).json({ error: 'You cannot set this visibility' });
    }
    const breadth = {
      [VISIBILITY.PRIVATE]: 0,
      [VISIBILITY.WORKSPACE_SHARED]: 1,
      [VISIBILITY.ORGANIZATION_SHARED]: 2,
    };
    const currentVisibility = normalizeVisibility(content.access_level) || VISIBILITY.PRIVATE;
    const isNarrowing = visibility !== currentVisibility && (
      visibility === VISIBILITY.PLATFORM_TEMPLATE
      || currentVisibility === VISIBILITY.PLATFORM_TEMPLATE
      || breadth[visibility] < breadth[currentVisibility]
    );
    if (isNarrowing) {
      const usage = contentUsage(content.id);
      if (usage.usage_count > 0) {
        return res.status(409).json({
          code: 'CONTENT_IN_USE',
          error: 'Remove every active route before reducing content visibility.',
          ...usage,
        });
      }
    }
    updates.push('access_level = ?');
    values.push(visibility);
    normalizedAccessLevel = visibility;
    if (visibility === VISIBILITY.PRIVATE) {
      updates.push('published_at = NULL', 'published_by = NULL');
    } else {
      updates.push("published_at = strftime('%s','now')", 'published_by = ?');
      values.push(req.user.id);
    }
  }

  if (updates.length > 0) {
    updates.push('version = COALESCE(version, 1) + 1', "updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      if (normalizedAccessLevel === VISIBILITY.PLATFORM_TEMPLATE && req.workspaceId) {
        db.prepare(`INSERT OR IGNORE INTO content_template_assignments (content_id, workspace_id, assigned_by)
          VALUES (?, ?, ?)`)
          .run(req.params.id, req.workspaceId, req.user.id);
      } else if (normalizedAccessLevel && normalizedAccessLevel !== VISIBILITY.PLATFORM_TEMPLATE) {
        db.prepare('DELETE FROM content_template_assignments WHERE content_id = ?').run(req.params.id);
      }
      db.prepare(`UPDATE content_publication_requests
        SET status = 'cancelled', decided_by = ?, decision_reason = 'Content changed after review was requested',
          decided_at = strftime('%s','now'), updated_at = strftime('%s','now')
        WHERE content_id = ? AND status = 'pending'`)
        .run(req.user.id, req.params.id);
    })();
  }

  const updated = getContentRow(req, req.params.id);
  if (updates.length > 0) auditContent(req, 'content:update', content, updated, `fields: ${updates.join(', ')}`);
  res.json(decorateContent(updated, req));
});

// Replace content file
router.put('/:id/replace', requireContentWriteRole, upload.single('file'), async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  if (req.body.expected_version !== undefined
      && Number(req.body.expected_version) !== Number(content.version || 1)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before replacing the file.' });
  }

  const filepath = req.file.filename;
  let width = null, height = null, thumbnailPath = null;

  // Generate new thumbnail for images. Same defenses as the create path:
  // limitInputPixels:false bypasses libvips's 268MP ceiling for triple-4K
  // wallpapers, failOn:'none' skips transient EXIF/ICC warnings, and any
  // failure here is logged but doesn't break the replace-content flow.
  try {
    if (req.file.mimetype.startsWith('image/')) {
      const sharp = require('sharp');
      const sharpOpts = { limitInputPixels: false, failOn: 'none' };
      try {
        const metadata = await sharp(req.file.path, sharpOpts).metadata();
        width = metadata.width;
        height = metadata.height;
      } catch (e) {
        console.warn('sharp metadata read failed (non-fatal):', e.message);
      }
      try {
        thumbnailPath = `thumb_${filepath}`;
        await sharp(req.file.path, sharpOpts).resize(config.thumbnailWidth).jpeg({ quality: 70 })
          .toFile(path.join(config.contentDir, thumbnailPath));
      } catch (e) {
        console.warn('sharp thumbnail generation failed (non-fatal):', e.message);
        thumbnailPath = null;
      }
    }
  } catch (e) {
    console.warn('Thumbnail generation failed:', e.message);
  }

  let changed = 0;
  try {
    changed = db.transaction(() => {
      const result = db.prepare(`UPDATE content SET filepath = ?, original_filepath = ?, original_sha256 = NULL,
          mime_type = ?, file_size = ?, thumbnail_path = ?, width = ?, height = ?,
          processing_status = 'uploaded', processing_error = NULL,
          version = COALESCE(version, 1) + 1, updated_at = strftime('%s','now')
          WHERE id = ? AND COALESCE(version, 1) = ?`)
        .run(filepath, filepath, req.file.mimetype, req.file.size, thumbnailPath, width, height,
          req.params.id, Number(content.version || 1));
      if (result.changes) {
        db.prepare(`UPDATE content_publication_requests
          SET status = 'cancelled', decided_by = ?, decision_reason = 'File replaced after review was requested',
            decided_at = strftime('%s','now'), updated_at = strftime('%s','now')
          WHERE content_id = ? AND status = 'pending'`).run(req.user.id, req.params.id);
      }
      return result.changes;
    })();
  } catch (error) {
    removeLocalContentFile(filepath);
    removeLocalContentFile(thumbnailPath);
    return res.status(500).json({ error: `Could not replace content: ${error.message}` });
  }
  if (!changed) {
    removeLocalContentFile(filepath);
    removeLocalContentFile(thumbnailPath);
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before replacing the file.' });
  }

  // The database now points at the complete replacement, so old bytes can be
  // removed without creating a crash window where the row references no file.
  for (const oldPath of new Set([content.filepath, content.original_filepath, content.thumbnail_path])) {
    if (oldPath && oldPath !== filepath && oldPath !== thumbnailPath) removeLocalContentFile(oldPath);
  }

  // Regenerate a document thumbnail in the background when a file is replaced
  // with a PDF/Office/ODF document (the inline branch above only covers images).
  if (isDocThumbnailMime(req.file.mimetype)) {
    kickDocThumbnail(req.params.id, req.file.path, req.file.mimetype);
  }
  if (req.file.mimetype.startsWith('video/')) {
    kickHevcTranscodeIfNeeded(req.params.id, req.file.path);
  }

  const updated = getContentRow(req, req.params.id);
  auditContent(req, 'content:replace', content, updated);
  res.json(decorateContent(updated, req));
});

// Serve content file
router.get('/:id/file', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Authenticated content download (task §13). Streams the owned storage file as an
// attachment with a sanitized filename. Never accepts a path from the browser,
// never puts the bearer token in the URL, and rejects remote-only content
// (YouTube / uncached external URLs / Nextcloud references) with a precise reason.
router.get('/:id/download', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) {
    const kind = String(content.mime_type || '').toLowerCase();
    if (kind === 'video/youtube' || content.remote_url) {
      return res.status(422).json({ code: 'DOWNLOAD_UNAVAILABLE', error: 'This is a remote/YouTube item with no local file to download.' });
    }
    return res.status(404).json({ code: 'NO_FILE', error: 'No file is associated with this content.' });
  }
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  const rawName = content.original_filename || content.filename || path.basename(content.filepath);
  const safeName = String(rawName).replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'download';
  res.setHeader('Content-Type', content.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  auditContent(req, 'content:download', content, content, { content_id: content.id, filename: safeName });
  res.sendFile(safePath);
});

// Serve thumbnail
router.get('/:id/thumbnail', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Delete content
router.delete('/:id', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (content.archived_at == null) {
    return res.status(409).json({ code: 'CONTENT_NOT_ARCHIVED', error: 'Archive content before permanently deleting it.' });
  }
  const usage = contentUsage(content.id);
  if (usage.usage_count > 0) {
    return res.status(409).json({
      code: 'CONTENT_IN_USE',
      error: 'Remove every active route before deleting content.',
      ...usage,
    });
  }

  // Get devices that have this content in their playlist (via playlist_items)
  const affectedDevices = db.prepare(`
    SELECT DISTINCT d.id as device_id FROM devices d
    JOIN playlists p ON d.playlist_id = p.id
    JOIN playlist_items pi ON pi.playlist_id = p.id
    WHERE pi.content_id = ?
  `).all(req.params.id);

  // Scrub published snapshots that reference this content
  // Validate UUID format to prevent LIKE wildcard injection
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid content ID format' });
  // Phase 2.2k: scope snapshot scrubbing by content.workspace_id (was content.user_id).
  // Playlists referencing this content live in the same workspace; user_id-keying missed
  // cross-user playlists in the same workspace once playlists became workspace-scoped.
  const snapshotPlaylists = db.prepare(
    "SELECT id, published_snapshot FROM playlists WHERE workspace_id = ? AND published_snapshot LIKE ?"
  ).all(content.workspace_id, `%${req.params.id}%`);
  db.transaction(() => {
    for (const pl of snapshotPlaylists) {
      try {
        const items = JSON.parse(pl.published_snapshot);
        const filtered = items.filter(item => item.content_id !== req.params.id);
        if (filtered.length !== items.length) {
          db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
            .run(JSON.stringify(filtered), pl.id);
        }
      } catch (e) { /* corrupt snapshot, skip */ }
    }
    auditContent(req, 'content:delete', content, null);
    db.prepare('DELETE FROM content WHERE id = ?').run(req.params.id);
  })();

  // Database/ref cleanup committed successfully; disk cleanup is now safe and
  // idempotent if a process restart occurs between individual removals.
  for (const localPath of new Set([content.filepath, content.original_filepath, content.thumbnail_path])) {
    removeLocalContentFile(localPath);
  }

  // Push updated snapshots to affected devices
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      const deviceNs = io.of('/device');
      for (const d of affectedDevices) {
        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.device_id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* silent */ }

  res.json({ success: true, affectedDevices: affectedDevices.map(d => d.device_id) });
});

module.exports = router;
