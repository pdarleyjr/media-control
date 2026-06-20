const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const config = require('../config');
const ncfs = require('../services/nextcloud-fs');
const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');
const { logActivity, getClientIp } = require('../services/activity');
const { resolveUploadMime } = require('../middleware/upload');
const { isDocThumbnailMime, kickDocThumbnail } = require('../lib/doc-thumbnail');
const { resolveBroadcastTargets } = require('../lib/broadcast-targets');

// MBFD Media Control Studio — Files (Nextcloud per-user raw-FS) API.
//
// SECURITY / TRUST BOUNDARY (HARD GUARDRAIL):
// The per-user email ALWAYS comes from req.user.email (set by requireAuth from
// the JWT). A client-supplied header is never used — media-control is the trust
// boundary; the microservices trust the email header blindly. Every ncfs call
// passes req.user.email explicitly so a mis-wired route throws
// NextcloudNotConnectedError instead of leaking another user's tree.
//
// The old WebDAV service (services/nextcloud.js) is kept in the tree but is NOT
// imported here. It serves as a disabled fallback during rollout.

// GET /health — connectivity probe for the per-user read path.
// Returns { enabled, connected, mode } (never throws; the frontend renders a banner).
router.get('/health', async (req, res) => {
  if (!config.features.nextcloudSync) return res.json({ enabled: false });
  const h = await ncfs.health(req.user.email);
  res.json({ enabled: true, connected: h.connected, mode: 'per-user', error: h.error });
});

// GET /?path= — list a directory in the caller's Nextcloud Files.
// Email always from JWT; path from query string ('' = root).
router.get('/', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  try {
    const items = await ncfs.listDir(req.user.email, req.query.path || '');
    res.json(items);
  } catch (e) {
    if (e && e.code === 'NC_NOT_CONNECTED') return res.status(503).json({ error: e.message, connected: false });
    res.status(502).json({ error: e.message || String(e) });
  }
});

// GET /download?path= — stream a file from the caller's Nextcloud Files.
// Uses readFile which returns { buffer, mime, name, size } inferred from the
// extension (the read microservice is text-only; binary is re-encoded from
// the UTF-8 surface — see nextcloud-fs.js readFile() caveat for binary).
router.get('/download', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path required' });
  try {
    const { buffer, mime, name } = await ncfs.readFile(req.user.email, p);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || String(p).split('/').pop())}"`);
    res.send(buffer);
  } catch (e) {
    if (e && e.code === 'NC_NOT_CONNECTED') return res.status(503).json({ error: e.message, connected: false });
    const status = e && e.status ? e.status : 502;
    res.status(status).json({ error: e.message || String(e) });
  }
});

// POST /broadcast — import ONE of the caller's own Nextcloud files into a local
// content row, then broadcast it to a selection of displays using the EXISTING
// device-push path (scene-engine.pushSourceToDevice). Body:
//   { path, device_ids[], fit_mode?, confirm_all? }
//
// GUARDRAIL 1 (trust boundary): the per-user email is ALWAYS req.user.email
// (from the JWT) — never a client header. The read is scoped to the caller's
// own tree, so a member can only import THEIR OWN files (a foreign path 404s
// at the microservice).
//
// GUARDRAIL 2 (displays never fetch from NC): broadcasting MATERIALIZES the NC
// bytes into a local content row written to config.contentDir and served from
// media-control's own /uploads/content origin. The display pulls from us, never
// from Nextcloud. pushSourceToDevice is the unmodified shared push — it is NOT
// user-scoped (displays have no user identity).
//
// Mirrors routes/broadcast.js for the write gate, the workspace-membership
// device validation, and the 409 CONFIRM_ALL_REQUIRED all-displays gate.

// Allow the same renderable media/documents the normal upload path accepts. The
// mime is inferred from extension by nextcloud-fs, but we still canonicalize here
// because Office files often arrive as generic zip/octet-stream.
function resolveBroadcastMime(file, relPath) {
  return resolveUploadMime({ mimetype: file && file.mime, originalname: (file && file.name) || relPath });
}

// Map a broadcastable mime to a safe file extension for the local content file.
const MIME_EXT = Object.freeze({
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
});

// Clamp a caller-supplied NC path to a safe RELATIVE path before passing it to
// the read microservice (defense in depth — the email header is the real trust
// boundary, but we still reject obvious abuse here so a foreign read can't even
// be attempted). Rejects: empty, absolute (unix/windows), any '..'/'.' segment,
// and any control character (NUL/newline) that could confuse the downstream
// service's path handling. NOTE: this does NOT URL-decode — values like '%2e%2e'
// reach the service as the literal directory name '%2e%2e' (not traversal), and
// the service path-joins them under the caller's OWN root, so they cannot escape
// the per-user tree even if they pass this clamp.
function clampRelPath(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (!p) return null;
  if (/[\x00-\x1f]/.test(p)) return null; // control chars (NUL, CR/LF, ...)
  if (p.startsWith('/') || p.startsWith('\\')) return null;
  if (/^[A-Za-z]:[\\/]/.test(p)) return null; // windows drive-absolute
  const norm = p.replace(/\\/g, '/');
  const segments = norm.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;
  return norm;
}

router.post('/broadcast', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  // Deny read-only members (mirrors broadcast.js:23).
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { path: rawPath, device_ids, fit_mode, confirm_all, import_only } = req.body || {};

  // Validate the source path (and clamp traversal at this trust boundary).
  const relPath = clampRelPath(rawPath);
  if (!relPath) return res.status(400).json({ error: 'path is required and must be a relative file path' });

  // Validate the target selection (mirrors broadcast.js:32-34).
  if (import_only !== true && (!Array.isArray(device_ids) || device_ids.length === 0)) {
    return res.status(400).json({ error: 'device_ids must be a non-empty array' });
  }

  // De-dupe and confirm target devices are in this workspace. Missing IDs are
  // stale browser selections; skip them so valid targets still receive content.
  const requested = import_only === true ? [] : [...new Set(device_ids.map(String))];
  const resolvedTargets = import_only === true
    ? { ok: true, targets: [], missing: [] }
    : resolveBroadcastTargets({ db, requestedIds: requested, workspaceId: req.workspaceId });
  if (!resolvedTargets.ok) return res.status(resolvedTargets.status).json(resolvedTargets.body);
  const targets = resolvedTargets.targets;

  // Confirmation gate when targeting ALL displays in the workspace (broadcast.js:54-60).
  const totalInWorkspace = db.prepare(
    'SELECT COUNT(*) AS c FROM devices WHERE workspace_id = ?'
  ).get(req.workspaceId).c;
  const targetingAll = import_only !== true && totalInWorkspace > 0 && targets.length === totalInWorkspace;
  if (targetingAll && confirm_all !== true) {
    return res.status(409).json({ code: 'CONFIRM_ALL_REQUIRED', count: totalInWorkspace });
  }

  // Read the caller's OWN file (email from the JWT — GUARDRAIL 1).
  let file;
  try {
    file = await ncfs.readFile(req.user.email, relPath);
  } catch (e) {
    if (e && e.code === 'NC_NOT_CONNECTED') return res.status(503).json({ error: e.message, connected: false });
    const status = e && e.status ? e.status : 502;
    return res.status(status).json({ error: e.message || String(e) });
  }

  const canonicalMime = resolveBroadcastMime(file, relPath);
  if (!canonicalMime) {
    return res.status(415).json({ error: 'Only video, image, PDF, and Office document files can be broadcast', mime: file.mime });
  }

  // Materialize the NC bytes into a local content file under config.contentDir
  // (GUARDRAIL 2: the display serves from our origin, never from Nextcloud).
  const id = crypto.randomUUID();
  const ext = MIME_EXT[canonicalMime] || path.extname(relPath).toLowerCase() || '';
  const localName = `${id}${ext}`;
  const localPath = path.join(config.contentDir, localName);
  try {
    fs.mkdirSync(config.contentDir, { recursive: true });
    fs.writeFileSync(localPath, file.buffer);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to materialize file for broadcast' });
  }

  // INSERT a content row (content.js:166 shape) owned by the importer and marked
  // private — this is the caller's imported copy, not a shared template.
  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, content_type, access_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'nextcloud_import', 'private')
  `).run(
    id, req.user.id, req.workspaceId,
    file.name || relPath.split('/').pop() || 'nextcloud_file',
    localName, canonicalMime, file.buffer.length
  );

  if (isDocThumbnailMime(canonicalMime)) {
    kickDocThumbnail(id, localPath, canonicalMime);
  }

  if (import_only === true) {
    try {
      logActivity(
        req.user.id,
        'POST /api/files/broadcast',
        `imported nextcloud:${relPath} as content:${id} for advanced canvas`,
        null,
        getClientIp(req),
        req.workspaceId
      );
    } catch (_) {}
    return res.json({ success: true, content_id: id, imported: true, sent: 0, failed: [], total: 0 });
  }

  // Push to each target via the UNMODIFIED shared push path (broadcast.js:62-73).
  const source = { content_id: id, fit_mode: typeof fit_mode === 'string' ? fit_mode : null };
  const io = req.app.get('io');
  let sent = 0;
  const failed = resolvedTargets.missing.slice();
  for (const deviceId of targets) {
    const ok = sceneEngine.pushSourceToDevice(io, deviceId, source, {
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    if (ok) sent++; else failed.push(deviceId);
  }

  // Explicit summary log (a broadcast touches many devices).
  try {
    logActivity(
      req.user.id,
      'POST /api/files/broadcast',
      `broadcast nextcloud:${relPath} (content:${id}) to ${sent}/${requested.length} display(s)${targetingAll ? ' (ALL)' : ''}`,
      null,
      getClientIp(req),
      req.workspaceId
    );
  } catch (e) { /* logging best-effort */ }

  res.json({ success: true, content_id: id, sent, failed, total: requested.length });
});

module.exports = router;
