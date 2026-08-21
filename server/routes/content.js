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
  canReadInternalContent,
  contentCapabilities,
} = require('../lib/content-visibility');
const { contentRowsWithThumbnailUrls } = require('../lib/content-response');
const { gridUrlReferencesContent } = require('../lib/public-content-access');
const { checkRemoteUrlShape, assertRemoteUrlSafe } = require('../lib/ssrf-policy');
const {
  inspectMediaFile,
  isActiveContentMime,
} = require('../lib/media-integrity');
const {
  getMediaPipeline,
  normalizeYoutubeId,
  youtubeSourceIdentity,
} = require('../lib/media-pipeline');
const {
  contentCursorPredicate,
  contentFtsQuery,
  decodeContentCursor,
  encodeContentCursor,
} = require('../lib/content-pagination');
const {
  requestMatchesEtag,
  thumbnailCacheIdentity,
} = require('../lib/content-thumbnail-cache');
const { normalizePosterRequest } = require('../lib/thumbnail-studio');
const {
  eraseContent,
  eraseImpact,
  publicEraseImpact,
  publicEraseResult,
} = require('../services/content-permanent-erase');
const { emitContentPurge } = require('../lib/node-registry');
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
        cmm.source_type AS media_source_type,
        cmm.source_identity AS media_source_identity,
        cmm.source_url AS media_source_url,
        cmm.detected_mime_type,
        cmm.source_sha256,
        cmm.container AS media_container,
        cmm.video_codec,
        cmm.video_profile,
        cmm.pixel_format,
        cmm.color_transfer,
        cmm.audio_codec,
        cmm.audio_profile,
        cmm.audio_sample_format,
        cmm.audio_channels,
        cmm.audio_channel_layout,
        cmm.bitrate_bps,
        cmm.frame_rate,
        cmm.thumbnail_generation,
        cmm.thumbnail_provenance,
        cmm.remote_health_status,
        cmm.remote_source_kind,
        cmm.remote_last_validated_at,
        cmm.remote_error_code,
        cmm.remote_final_url,
        cmm.remote_content_length,
        cmm.remote_range_supported,
        cmm.remote_cors_allowed,
        cmm.remote_etag,
        cmm.remote_last_modified,
        EXISTS (
          SELECT 1 FROM content_template_assignments cta
          WHERE cta.content_id = c.id AND cta.workspace_id = ?
        ) AS template_assigned,
        EXISTS (
          SELECT 1 FROM content_favorites cf
          WHERE cf.content_id = c.id AND cf.user_id = ?
        ) AS is_favorite,
        EXISTS (
          SELECT 1 FROM asset_checksums wallpaper_asset
          WHERE wallpaper_asset.content_id = c.id
            AND wallpaper_asset.is_screensaver = 1
            AND LOWER(COALESCE(wallpaper_asset.screensaver_category, '')) = 'wallpaper'
        ) AS is_wallpaper_menu,
        (
          SELECT COUNT(*)
          FROM content duplicate_content
          LEFT JOIN content_media_metadata duplicate_media
            ON duplicate_media.content_id = duplicate_content.id
          WHERE duplicate_content.id <> c.id
            AND duplicate_content.workspace_id IS c.workspace_id
            AND duplicate_content.library_scope = 'library'
            AND duplicate_content.archived_at IS NULL
            AND COALESCE(c.original_sha256, cmm.source_sha256) IS NOT NULL
            AND COALESCE(duplicate_content.original_sha256, duplicate_media.source_sha256)
              = COALESCE(c.original_sha256, cmm.source_sha256)
        ) AS duplicate_count,
        EXISTS (
          SELECT 1
          FROM asset_checksums ac
          JOIN node_assets na ON na.asset_id = ac.asset_id
          JOIN managed_nodes mn ON mn.node_id = na.node_id
          WHERE ac.content_id = c.id
            AND mn.workspace_id = ?
            AND na.desired = 1
            AND na.sync_status = 'ready'
            AND na.checksum_verified = 1
            AND na.generation = ac.generation
        ) AS classroom_ready,
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
      LEFT JOIN content_media_metadata cmm ON cmm.content_id = c.id
    `,
    params: [workspaceId, req.user?.id || '', workspaceId],
  };
}

function decorateContent(row, req) {
  if (!row) return row;
  const caps = contentCapabilities(row, visibilityContext(req, { includeArchived: true }));
  return {
    ...row,
    is_favorite: row.is_favorite === 1,
    is_wallpaper_menu: row.is_wallpaper_menu === 1,
    duplicate_count: Number(row.duplicate_count) || 0,
    classroom_ready: row.classroom_ready === 1,
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
    media: {
      source_type: row.media_source_type || null,
      source_identity: row.media_source_identity || null,
      source_url: row.media_source_url || null,
      detected_mime_type: row.detected_mime_type || row.mime_type || null,
      source_sha256: row.source_sha256 || null,
      container: row.media_container || null,
      video_codec: row.video_codec || null,
      video_profile: row.video_profile || null,
      pixel_format: row.pixel_format || null,
      color_transfer: row.color_transfer || null,
      audio_codec: row.audio_codec || null,
      audio_profile: row.audio_profile || null,
      audio_sample_format: row.audio_sample_format || null,
      audio_channels: row.audio_channels ?? null,
      audio_channel_layout: row.audio_channel_layout || null,
      bitrate_bps: row.bitrate_bps ?? null,
      frame_rate: row.frame_rate ?? null,
      thumbnail_generation: row.thumbnail_generation ?? null,
      thumbnail_provenance: row.thumbnail_provenance || null,
      remote_health_status: row.remote_health_status || null,
      remote_source_kind: row.remote_source_kind || null,
      remote_last_validated_at: row.remote_last_validated_at || null,
      remote_error_code: row.remote_error_code || null,
      remote_final_url: row.remote_final_url || null,
      remote_content_length: row.remote_content_length ?? null,
      remote_range_supported: row.remote_range_supported === 1,
      remote_cors_allowed: row.remote_cors_allowed === 1,
      remote_etag: row.remote_etag || null,
      remote_last_modified: row.remote_last_modified || null,
      externally_dependent: Boolean(row.remote_url && !row.filepath),
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

function normalizeContentTags(tags) {
  if (!Array.isArray(tags)) return null;
  const normalized = [];
  for (const value of tags) {
    if (typeof value !== 'string') return null;
    const tag = sanitizeString(value.normalize('NFC').trim()).slice(0, 40);
    if (tag && !normalized.includes(tag)) normalized.push(tag);
    if (normalized.length > 20) return null;
  }
  return normalized;
}

const SAVED_VIEW_FILTERS = new Set([
  'search', 'visibility', 'type', 'owner', 'archived', 'processing',
  'codec', 'dimensions', 'source', 'thumbnail', 'p3', 'favorite', 'sort',
]);

function normalizeSavedViewQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null;
  const normalized = {};
  for (const [key, value] of Object.entries(query)) {
    if (!SAVED_VIEW_FILTERS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'boolean') return null;
    const serialized = typeof value === 'string' ? value.trim().slice(0, 120) : value;
    if (serialized !== '' && serialized !== false) normalized[key] = serialized;
  }
  return normalized;
}

function removeLocalContentFile(relativePath) {
  if (!relativePath || /^https?:\/\//i.test(relativePath)) return;
  const root = path.resolve(config.contentDir);
  const candidate = path.resolve(root, path.basename(relativePath));
  if (path.dirname(candidate) !== root) return;
  try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch (error) {
    console.warn('Could not remove a superseded content file', {
      code: String(error?.code || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 32),
    });
  }
}

function validateUploadedFile(req, res) {
  let integrity;
  try {
    integrity = inspectMediaFile({
      filePath: upload.resolveUploadedFilePath(req.file),
      contentDir: config.contentDir,
      claimedMime: req.file.mimetype,
      filename: req.file.originalname,
    });
  } catch (error) {
    removeLocalContentFile(req.file.filename);
    res.status(422).json({
      code: 'MEDIA_VALIDATION_FAILED',
      error: 'The uploaded file could not be inspected.',
    });
    return false;
  }
  if (!integrity.ok) {
    removeLocalContentFile(req.file.filename);
    const status = integrity.code === 'SOURCE_TOO_LARGE' ? 413 : 415;
    res.status(status).json({
      code: integrity.code,
      error: integrity.code === 'ACTIVE_CONTENT_REJECTED'
        ? 'Executable HTML, JavaScript, and SVG uploads are not accepted as media.'
        : 'The file contents do not match a supported media type.',
      detected_mime_type: integrity.detectedMime || null,
    });
    return false;
  }
  req.file.mimetype = integrity.detectedMime;
  req.file.size = integrity.size;
  return true;
}

function publicMediaJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    content_id: job.content_id,
    job_type: job.job_type,
    status: job.status,
    stage: job.stage,
    progress_pct: job.progress_pct,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    retryable: job.retryable === 1,
    error_code: job.error_code || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
  };
}

function contentFtsAvailable(database = db) {
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_fts'",
    ).get());
  } catch {
    return false;
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
  const cursorMode = req.query.pagination === 'cursor' || req.query.cursor !== undefined;
  if (!req.workspaceId) {
    return res.json(cursorMode ? { items: [], next_cursor: null } : []);
  }
  const folder = req.query.folder;
  const folderId = req.query.folder_id;
  const ctx = visibilityContext(req);
  const includeArchived = req.query.archived === 'include' || req.query.archived === 'only';
  const scope = contentVisibilityScope(ctx, { alias: 'c', includeArchived });
  const select = contentSelect(req);
  let sql = `${select.sql} WHERE ${scope.clause}`;
  const params = [...select.params, ...scope.params];
  sql += " AND c.library_scope = 'library'";
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
  } else if (req.query.owner && String(req.query.owner).length <= 128) {
    sql += ' AND c.user_id = ?';
    params.push(String(req.query.owner));
  }
  if (req.query.type) {
    sql += ' AND (c.content_type = ? OR c.mime_type LIKE ?)';
    params.push(req.query.type, `${req.query.type}/%`);
  }
  if (req.query.search) {
    const ftsQuery = contentFtsQuery(req.query.search);
    if (ftsQuery && contentFtsAvailable(db)) {
      sql += ' AND c.id IN (SELECT content_id FROM content_fts WHERE content_fts MATCH ?)';
      params.push(ftsQuery);
    } else {
      sql += ` AND (
        c.filename LIKE ? ESCAPE '\\'
        OR COALESCE(c.tags_json, '') LIKE ? ESCAPE '\\'
        OR COALESCE(c.metadata_json, '') LIKE ? ESCAPE '\\'
        OR COALESCE(u.name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(u.email, '') LIKE ? ESCAPE '\\'
      )`;
      const q = `%${String(req.query.search).replace(/[\\%_]/g, '\\$&')}%`;
      params.push(q, q, q, q, q);
    }
  }
  if (req.query.processing) {
    const processing = String(req.query.processing).toLowerCase();
    if (['ready', 'processing', 'failed', 'uploaded'].includes(processing)) {
      sql += processing === 'ready'
        ? " AND c.processing_status IN ('ready','completed')"
        : ' AND c.processing_status = ?';
      if (processing !== 'ready') params.push(processing);
    }
  }
  if (req.query.codec && /^[a-z0-9._-]{1,32}$/i.test(String(req.query.codec))) {
    sql += ' AND (LOWER(cmm.video_codec) = LOWER(?) OR LOWER(cmm.audio_codec) = LOWER(?))';
    params.push(String(req.query.codec), String(req.query.codec));
  }
  if (req.query.dimensions === '4k') {
    sql += ' AND (c.width >= 3840 OR c.height >= 2160)';
  } else if (req.query.dimensions === 'hd') {
    sql += ' AND c.width >= 1280 AND c.height >= 720';
  } else if (req.query.dimensions === 'portrait') {
    sql += ' AND c.height > c.width';
  } else if (req.query.dimensions === 'landscape') {
    sql += ' AND c.width >= c.height AND c.width IS NOT NULL';
  } else if (req.query.dimensions === 'unknown') {
    sql += ' AND (c.width IS NULL OR c.height IS NULL)';
  }
  if (req.query.source) {
    const source = String(req.query.source).toLowerCase();
    if (source === 'local') {
      sql += ' AND c.filepath IS NOT NULL';
    } else if (source === 'remote') {
      sql += ' AND c.remote_url IS NOT NULL AND c.filepath IS NULL';
    } else if (/^[a-z0-9._-]{1,32}$/.test(source)) {
      sql += ' AND LOWER(cmm.source_type) = ?';
      params.push(source);
    }
  }
  if (req.query.thumbnail === 'ready') {
    sql += " AND c.thumbnail_path IS NOT NULL AND TRIM(c.thumbnail_path) <> ''";
  } else if (req.query.thumbnail === 'missing') {
    sql += " AND (c.thumbnail_path IS NULL OR TRIM(c.thumbnail_path) = '')";
  }
  if (req.query.p3 === 'ready') {
    sql += ` AND EXISTS (
      SELECT 1 FROM asset_checksums filter_ac
      JOIN node_assets filter_na ON filter_na.asset_id = filter_ac.asset_id
      JOIN managed_nodes filter_mn ON filter_mn.node_id = filter_na.node_id
      WHERE filter_ac.content_id = c.id AND filter_mn.workspace_id = ?
        AND filter_na.desired = 1 AND filter_na.sync_status = 'ready'
        AND filter_na.checksum_verified = 1
        AND filter_na.generation = filter_ac.generation
    )`;
    params.push(req.workspaceId);
  } else if (req.query.p3 === 'pending') {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM asset_checksums filter_ac
      JOIN node_assets filter_na ON filter_na.asset_id = filter_ac.asset_id
      JOIN managed_nodes filter_mn ON filter_mn.node_id = filter_na.node_id
      WHERE filter_ac.content_id = c.id AND filter_mn.workspace_id = ?
        AND filter_na.desired = 1 AND filter_na.sync_status = 'ready'
        AND filter_na.checksum_verified = 1
        AND filter_na.generation = filter_ac.generation
    )`;
    params.push(req.workspaceId);
  }
  if (req.query.favorite === '1' || req.query.favorite === 'true') {
    sql += ' AND EXISTS (SELECT 1 FROM content_favorites filter_cf WHERE filter_cf.content_id = c.id AND filter_cf.user_id = ?)';
    params.push(req.user.id);
  }
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 500));
  if (cursorMode && req.query.cursor) {
    let cursor;
    try {
      cursor = decodeContentCursor(req.query.cursor);
    } catch {
      return res.status(400).json({
        code: 'INVALID_CONTENT_CURSOR',
        error: 'The pagination cursor is invalid or expired.',
      });
    }
    const predicate = contentCursorPredicate(cursor);
    sql += ` AND ${predicate.sql}`;
    params.push(...predicate.params);
  }
  sql += " ORDER BY COALESCE(c.folder, '') ASC, c.created_at DESC, c.id DESC LIMIT ?";
  params.push(cursorMode ? limit + 1 : limit);
  if (!cursorMode) {
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    sql += ' OFFSET ?';
    params.push(offset);
  }
  const rows = db.prepare(sql).all(...params);
  const hasMore = cursorMode && rows.length > limit;
  const content = cursorMode ? rows.slice(0, limit) : rows;
  const items = contentRowsWithThumbnailUrls(
    content.map((row) => decorateContent(row, req)),
    { secret: config.jwtSecret, ttlSeconds: 3600 },
  );
  if (!cursorMode) return res.json(items);
  const nextCursor = hasMore ? encodeContentCursor(content.at(-1)) : null;
  if (nextCursor) res.setHeader('X-Next-Cursor', nextCursor);
  return res.json({ items, next_cursor: nextCursor });
});

// Compact, workspace-governed source for the classroom wallpaper selector.
// Keep this separate from the full Media Library query: that response computes
// readiness, usage, duplicate, publication, and P3 state for every card, none of
// which is needed to paint a select option during control-screen startup.
router.get('/wallpaper-menu', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scope = contentVisibilityScope(visibilityContext(req), { alias: 'c' });
  const rows = db.prepare(`
    SELECT c.id, c.filename, c.mime_type, c.version, 1 AS is_wallpaper_menu
    FROM content c
    JOIN asset_checksums ac ON ac.content_id = c.id
    WHERE c.workspace_id = ?
      AND ${scope.clause}
      AND c.library_scope = 'library'
      AND c.archived_at IS NULL
      AND c.filepath IS NOT NULL AND TRIM(c.filepath) <> ''
      AND LOWER(c.mime_type) LIKE 'image/%'
      AND LOWER(COALESCE(c.processing_status, 'uploaded')) IN ('uploaded', 'ready', 'completed')
      AND ac.generation = COALESCE(c.version, 1)
      AND ac.sha256 GLOB '${'[0-9A-Fa-f]'.repeat(64)}'
      AND ac.size_bytes > 0
      AND ac.canonical_path = c.filepath
      AND ac.is_screensaver = 1
      AND LOWER(COALESCE(ac.screensaver_category, '')) = 'wallpaper'
    ORDER BY c.filename COLLATE NOCASE, c.id
    LIMIT 200
  `).all(req.workspaceId, ...scope.params);
  return res.json(rows.map(row => ({ ...row, is_wallpaper_menu: true })));
});

router.put('/:id/wallpaper-menu', requireContentWriteRole, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ code: 'INVALID_WALLPAPER_MENU_STATE', error: 'enabled must be true or false.' });
  }
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!req.workspaceId || content.workspace_id !== req.workspaceId) {
    return res.status(403).json({ error: 'Wallpaper menu changes must target the current workspace.' });
  }
  const generation = Math.max(1, Number(content.version) || 1);
  if (req.body.expected_version !== undefined && Number(req.body.expected_version) !== generation) {
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before saving.' });
  }
  const manifest = db.prepare(`SELECT generation, sha256, size_bytes, canonical_path, is_screensaver, screensaver_category
    FROM asset_checksums WHERE content_id = ?`).get(content.id);
  const enabled = req.body.enabled === true;
  const wasEnabled = Number(manifest?.is_screensaver) === 1
    && String(manifest?.screensaver_category || '').toLowerCase() === 'wallpaper';

  // Removing membership is cleanup, not playback. Allow an authorized editor
  // to clear a stale flag even after archive, replacement, or manifest drift;
  // otherwise restoring/re-preparing the row could make it silently reappear.
  if (!enabled) {
    if (wasEnabled) {
      const result = db.prepare(`UPDATE asset_checksums AS target
        SET is_screensaver = 0, screensaver_category = NULL
        WHERE target.content_id = ?
          AND EXISTS (
            SELECT 1 FROM content current
            WHERE current.id = target.content_id AND current.workspace_id = ?
          )`)
        .run(content.id, req.workspaceId);
      if (result.changes !== 1) {
        return res.status(409).json({ code: 'CONTENT_CHANGED', error: 'The image changed before the wallpaper menu was updated.' });
      }
    }
    const updated = getContentRow(req, content.id);
    const remaining = db.prepare(`SELECT is_screensaver, screensaver_category
      FROM asset_checksums WHERE content_id = ?`).get(content.id);
    const stillEnabled = Number(remaining?.is_screensaver) === 1
      && String(remaining?.screensaver_category || '').toLowerCase() === 'wallpaper';
    if (!updated || stillEnabled) {
      return res.status(409).json({ code: 'CONTENT_CHANGED', error: 'The image changed before the wallpaper menu was updated.' });
    }
    if (wasEnabled) {
      auditContent(
        req,
        'content:wallpaper_menu_remove',
        { ...content, is_wallpaper_menu: true },
        updated,
        `content_id: ${content.id}`,
      );
    }
    return res.json(decorateContent(updated, req));
  }

  if (content.archived_at != null) {
    return res.status(409).json({ code: 'CONTENT_ARCHIVED', error: 'Restore this image before adding it to the wallpaper menu.' });
  }
  if (!String(content.mime_type || '').toLowerCase().startsWith('image/') || !String(content.filepath || '').trim()) {
    return res.status(409).json({ code: 'WALLPAPER_IMAGE_REQUIRED', error: 'Only uploaded images can be added to the wallpaper menu.' });
  }
  if (!['uploaded', 'ready', 'completed'].includes(String(content.processing_status || 'uploaded').toLowerCase())) {
    return res.status(409).json({ code: 'CONTENT_NOT_READY', error: 'This image is not ready for classroom playback.' });
  }
  if (!manifest
      || Number(manifest.generation) !== generation
      || !/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ''))
      || Number(manifest.size_bytes) <= 0
      || String(manifest.canonical_path || '') !== String(content.filepath)) {
    return res.status(409).json({ code: 'CONTENT_NOT_READY', error: 'Prepare this image for the classroom before adding it to the wallpaper menu.' });
  }

  if (!wasEnabled) {
    const result = db.prepare(`UPDATE asset_checksums AS target
      SET is_screensaver = ?, screensaver_category = ?
      WHERE target.content_id = ? AND target.generation = ?
        AND target.canonical_path = (
          SELECT current.filepath FROM content current
          WHERE current.id = target.content_id
            AND current.workspace_id = ?
            AND current.archived_at IS NULL
            AND current.version = target.generation
            AND LOWER(current.mime_type) LIKE 'image/%'
            AND LOWER(COALESCE(current.processing_status, 'uploaded')) IN ('uploaded', 'ready', 'completed')
        )`)
      .run(enabled ? 1 : 0, enabled ? 'wallpaper' : null, content.id, generation, req.workspaceId);
    if (result.changes !== 1) {
      return res.status(409).json({ code: 'CONTENT_CHANGED', error: 'The image changed before the wallpaper menu was updated.' });
    }
  }
  const updated = getContentRow(req, content.id);
  if (!updated || updated.is_wallpaper_menu !== (enabled ? 1 : 0)) {
    return res.status(409).json({ code: 'CONTENT_CHANGED', error: 'The image changed before the wallpaper menu was updated.' });
  }
  if (!wasEnabled) {
    auditContent(
      req,
      'content:wallpaper_menu_add',
      { ...content, is_wallpaper_menu: wasEnabled },
      updated,
      `content_id: ${content.id}`,
    );
  }
  return res.json(decorateContent(updated, req));
});

router.get('/library-summary', (req, res) => {
  if (!req.workspaceId) {
    return res.json({
      total_items: 0,
      storage_bytes: 0,
      archived_items: 0,
      duplicate_items: 0,
      favorite_items: 0,
      retained_originals: 0,
    });
  }
  const ctx = visibilityContext(req);
  const scope = contentVisibilityScope(ctx, { alias: 'c', includeArchived: true });
  let where = scope.clause;
  const params = [...scope.params];
  where += " AND c.library_scope = 'library'";
  if (!ctx.isPlatformAdmin && ctx.orgRole !== 'org_owner' && ctx.orgRole !== 'org_admin' && ctx.workspaceRole !== 'workspace_admin') {
    where += ' AND (c.archived_at IS NULL OR c.user_id = ?)';
    params.push(req.user.id);
  }
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_items,
      COALESCE(SUM(COALESCE(c.file_size, 0)), 0) AS storage_bytes,
      COALESCE(SUM(CASE WHEN c.archived_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived_items,
      COALESCE(SUM(CASE WHEN c.original_filepath IS NOT NULL THEN 1 ELSE 0 END), 0) AS retained_originals,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1 FROM content_favorites summary_cf
        WHERE summary_cf.content_id = c.id AND summary_cf.user_id = ?
      ) THEN 1 ELSE 0 END), 0) AS favorite_items,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM content summary_duplicate
        LEFT JOIN content_media_metadata summary_media
          ON summary_media.content_id = summary_duplicate.id
        WHERE summary_duplicate.id <> c.id
          AND summary_duplicate.workspace_id IS c.workspace_id
          AND summary_duplicate.library_scope = 'library'
          AND summary_duplicate.archived_at IS NULL
          AND COALESCE(c.original_sha256, cmm.source_sha256) IS NOT NULL
          AND COALESCE(summary_duplicate.original_sha256, summary_media.source_sha256)
            = COALESCE(c.original_sha256, cmm.source_sha256)
      ) THEN 1 ELSE 0 END), 0) AS duplicate_items
    FROM content c
    LEFT JOIN content_media_metadata cmm ON cmm.content_id = c.id
    WHERE ${where}
  `).get(req.user.id, ...params);
  return res.json(Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value) || 0]),
  ));
});

router.get('/saved-views', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const rows = db.prepare(`
    SELECT id, name, query_json, created_at, updated_at
    FROM content_saved_views
    WHERE workspace_id = ? AND user_id = ?
    ORDER BY name COLLATE NOCASE, created_at
  `).all(req.workspaceId, req.user.id);
  return res.json(rows.map((row) => {
    let query = {};
    try { query = normalizeSavedViewQuery(JSON.parse(row.query_json)) || {}; } catch { /* corrupt rows become empty views */ }
    const { query_json: _queryJson, ...savedView } = row;
    return { ...savedView, query };
  }));
});

router.post('/saved-views', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const name = safeFilename(String(req.body.name || '').trim()).slice(0, 80);
  const query = normalizeSavedViewQuery(req.body.query);
  if (!name || !query) {
    return res.status(400).json({ code: 'INVALID_SAVED_VIEW', error: 'A valid name and filter set are required.' });
  }
  const now = Math.floor(Date.now() / 1000);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO content_saved_views
      (id, workspace_id, user_id, name, query_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.workspaceId, req.user.id, name, JSON.stringify(query), now, now);
  logActivity(req.user.id, 'content:saved_view_create', `saved_view_id: ${id}`, null, getClientIp(req), req.workspaceId);
  return res.status(201).json({ id, name, query, created_at: now, updated_at: now });
});

router.delete('/saved-views/:viewId', (req, res) => {
  if (!req.workspaceId) return res.status(404).json({ error: 'Saved view not found' });
  const result = db.prepare(`
    DELETE FROM content_saved_views
    WHERE id = ? AND workspace_id = ? AND user_id = ?
  `).run(req.params.viewId, req.workspaceId, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Saved view not found' });
  logActivity(req.user.id, 'content:saved_view_delete', `saved_view_id: ${req.params.viewId}`, null, getClientIp(req), req.workspaceId);
  return res.json({ deleted: true });
});

// Get folders list for the caller's current workspace.
router.get('/folders', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scope = contentVisibilityScope(visibilityContext(req), { alias: 'content' });
  const folders = db.prepare(
    `SELECT folder, COUNT(*) as count FROM content WHERE folder IS NOT NULL AND library_scope = 'library' AND ${scope.clause} GROUP BY folder ORDER BY folder`
  ).all(...scope.params);
  res.json(folders);
});

// Upload content
router.post('/', requireContentWriteRole, checkStorageLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before uploading.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const uploadedPath = upload.resolveUploadedFilePath(req.file);
    if (!uploadedPath) return res.status(400).json({ error: 'Invalid upload path' });
    if (!upload.uploadedFileHasBytes(req.file)) {
      upload.discardUploadedFile(req.file);
      return res.status(400).json({
        code: 'EMPTY_UPLOAD',
        error: 'Uploaded file is empty. Select the original file and try again.',
      });
    }
    if (!validateUploadedFile(req, res)) return;

    const id = uuidv4();
    const filepath = req.file.filename;
    const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
    let job;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (
          id, user_id, workspace_id, filename, filepath, mime_type, file_size,
          processing_status, access_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', 'private')
      `).run(
        id,
        req.user.id,
        req.workspaceId,
        safeFilename(req.file.originalname),
        filepath,
        req.file.mimetype,
        req.file.size,
      );
      job = (req.file.mimetype.startsWith('video/')
        ? pipeline.enqueueVideo({
          contentId: id,
          workspaceId: req.workspaceId,
          userId: req.user.id,
          absolutePath: uploadedPath,
          expectedVersion: 1,
          expectedFilepath: filepath,
          sourceType: 'multipart_upload',
        })
        : pipeline.enqueueThumbnailFinalize({
          contentId: id,
          workspaceId: req.workspaceId,
          userId: req.user.id,
          absolutePath: uploadedPath,
          expectedVersion: 1,
          expectedFilepath: filepath,
          mimeType: req.file.mimetype,
          sourceType: 'multipart_upload',
        })).job;
    })();

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(201).json({ ...content, media_job: publicMediaJob(job) });
  } catch (err) {
    if (req.file?.filename) removeLocalContentFile(req.file.filename);
    console.error('Upload error:', err.message);
    res.status(500).json({ code: 'UPLOAD_FAILED', error: 'Upload could not be queued for processing.' });
  }
});

// Add remote URL content
router.post('/remote', requireContentWriteRole, checkRemoteUrl, async (req, res) => {
  try {
    if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before adding remote content.' });
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    // Full SSRF check: shape + DNS resolution. A new remote URL will be fetched
    // by the server/displays, so a public hostname that resolves to a private
    // address (DNS rebinding) must be rejected here, not just the literal host.
    const safe = await assertRemoteUrlSafe(url);
    if (!safe.ok) return res.status(400).json({ error: safe.error });
    if (normalizeYoutubeId(url)) {
      return res.status(422).json({
        code: 'USE_YOUTUBE_INGEST',
        error: 'Use Add YouTube so the video can be downloaded, optimized, and prepared for class.',
      });
    }

    const id = uuidv4();
    const filename = name || url.split('/').pop()?.split('?')[0] || 'remote_content';
    const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
    let queued;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (
          id, user_id, workspace_id, filename, filepath, mime_type, file_size,
          remote_url, processing_status, access_level
        ) VALUES (?, ?, ?, ?, '', 'application/octet-stream', 0, ?, 'processing', 'private')
      `).run(id, req.user.id, req.workspaceId, safeFilename(filename), url);
      queued = pipeline.enqueueRemoteValidation({
        contentId: id,
        workspaceId: req.workspaceId,
        userId: req.user.id,
        url,
        expectedVersion: 1,
      });
    })();
    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(202).json({ ...content, media_job: publicMediaJob(queued.job) });
  } catch (err) {
    console.error('Remote URL add error:', err.message);
    res.status(500).json({ code: 'REMOTE_QUEUE_FAILED', error: 'Remote content validation could not be queued.' });
  }
});

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

    const videoId = normalizeYoutubeId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const sourceIdentity = youtubeSourceIdentity(videoId);
    const existingForSource = () => db.prepare(`
      SELECT c.* FROM content_media_metadata cmm
      JOIN content c ON c.id=cmm.content_id
      WHERE cmm.workspace_id=? AND cmm.source_type='youtube'
        AND cmm.source_identity=? AND c.archived_at IS NULL
      LIMIT 1
    `).get(req.workspaceId, sourceIdentity);
    const existing = existingForSource();
    if (existing) {
      const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
      const latestJob = pipeline.store.list({
        workspaceId: req.workspaceId,
        contentId: existing.id,
        limit: 1,
      })[0] || null;
      return res.status(200).json({
        ...existing,
        deduplicated: true,
        media_job: publicMediaJob(latestJob),
      });
    }

    // Fetch video title from YouTube oEmbed if no name provided
    let filename = name;
    if (!filename) {
      try {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(5000) },
        );
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
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const now = Math.floor(Date.now() / 1000);
    const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
    let queued;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (
          id, user_id, workspace_id, filename, filepath, mime_type, file_size,
          remote_url, thumbnail_path, processing_status, access_level
        ) VALUES (?, ?, ?, ?, '', 'video/youtube', 0, ?, ?, 'processing', 'private')
      `).run(id, req.user.id, req.workspaceId, safeFilename(filename), embedUrl, thumbnailUrl);
      db.prepare(`
        INSERT INTO content_media_metadata (
          content_id, workspace_id, source_type, source_identity, source_url,
          detected_mime_type, remote_health_status, created_at, updated_at
        ) VALUES (?, ?, 'youtube', ?, ?, 'video/youtube', 'importing', ?, ?)
      `).run(id, req.workspaceId, sourceIdentity, sourceUrl, now, now);
      queued = pipeline.enqueueYoutube({
        contentId: id,
        workspaceId: req.workspaceId,
        userId: req.user.id,
        videoId,
        expectedVersion: 1,
      });
    })();

    const content = db.prepare('SELECT * FROM content WHERE id = ?').get(id);
    res.status(202).json({ ...content, media_job: publicMediaJob(queued.job) });
  } catch (err) {
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      try {
        const videoId = normalizeYoutubeId(req.body?.url);
        const duplicate = db.prepare(`
          SELECT c.* FROM content_media_metadata cmm
          JOIN content c ON c.id=cmm.content_id
          WHERE cmm.workspace_id=? AND cmm.source_type='youtube'
            AND cmm.source_identity=? AND c.archived_at IS NULL
          LIMIT 1
        `).get(req.workspaceId, youtubeSourceIdentity(videoId));
        if (duplicate) return res.status(200).json({ ...duplicate, deduplicated: true });
      } catch { /* fall through to stable error */ }
    }
    console.error('YouTube add error:', err.message);
    res.status(500).json({ code: 'YOUTUBE_QUEUE_FAILED', error: 'YouTube import could not be queued.' });
  }
});

router.get('/jobs', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const jobs = pipeline.store.list({
    workspaceId: req.workspaceId,
    contentId: req.query.content_id || null,
    limit: req.query.limit,
  });
  res.json(jobs.map(publicMediaJob));
});

router.get('/jobs/:jobId', (req, res) => {
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const job = pipeline.store.get(req.params.jobId);
  if (!job || (job.workspace_id !== req.workspaceId && !visibilityContext(req).isPlatformAdmin)) {
    return res.status(404).json({ error: 'Media job not found' });
  }
  res.json(publicMediaJob(job));
});

router.post('/jobs/:jobId/retry', requireContentWriteRole, (req, res) => {
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const current = pipeline.store.get(req.params.jobId);
  if (!current || (current.workspace_id !== req.workspaceId && !visibilityContext(req).isPlatformAdmin)) {
    return res.status(404).json({ error: 'Media job not found' });
  }
  const retried = pipeline.store.retry(current.id, { resetAttempts: true });
  if (!retried) {
    return res.status(409).json({
      code: 'MEDIA_JOB_NOT_RETRYABLE',
      error: 'Only failed media jobs can be retried.',
    });
  }
  pipeline.schedule();
  res.status(202).json(publicMediaJob(retried));
});

router.post('/jobs/:jobId/cancel', requireContentWriteRole, (req, res) => {
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const current = pipeline.store.get(req.params.jobId);
  if (!current || (current.workspace_id !== req.workspaceId && !visibilityContext(req).isPlatformAdmin)) {
    return res.status(404).json({ error: 'Media job not found' });
  }
  const cancelled = pipeline.store.requestCancel(current.id);
  res.status(cancelled.status === 'cancelled' ? 200 : 202).json(publicMediaJob(cancelled));
});

router.post('/:id/thumbnail/regenerate', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!content.filepath) {
    return res.status(422).json({
      code: 'LOCAL_SOURCE_REQUIRED',
      error: 'A local media file is required to regenerate a poster.',
    });
  }
  const absolutePath = path.join(config.contentDir, path.basename(content.filepath));
  if (!fs.existsSync(absolutePath)) {
    return res.status(409).json({ code: 'SOURCE_MISSING', error: 'The local source file is missing.' });
  }
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const token = uuidv4();
  const mimeType = String(content.mime_type || '');
  const queued = mimeType.startsWith('video/') || mimeType.startsWith('image/')
    ? pipeline.enqueueThumbnailStudio({
      contentId: content.id,
      workspaceId: content.workspace_id || '__platform__',
      userId: req.user.id,
      expectedVersion: Number(content.version) || 1,
      expectedFilepath: content.filepath,
      timestampSeconds: 0,
      position: 'center',
      sourceType: 'thumbnail_regenerate',
      idempotencyKey: `poster:${content.id}:v${content.version}:${token}`,
    })
    : pipeline.enqueueThumbnailFinalize({
      contentId: content.id,
      workspaceId: content.workspace_id || '__platform__',
      userId: req.user.id,
      absolutePath,
      expectedVersion: Number(content.version) || 1,
      expectedFilepath: content.filepath,
      mimeType: content.mime_type,
      sourceType: 'thumbnail_regenerate',
      idempotencyKey: `poster:${content.id}:v${content.version}:${token}`,
    });
  res.status(202).json(publicMediaJob(queued.job));
});

router.post(
  '/:id/thumbnail/studio',
  requireContentWriteRole,
  upload.single('poster'),
  async (req, res) => {
    const cleanupUpload = () => {
      if (req.file?.filename) removeLocalContentFile(req.file.filename);
    };
    const content = checkContentWrite(req, res);
    if (!content) {
      cleanupUpload();
      return;
    }
    if (!content.filepath) {
      cleanupUpload();
      return res.status(422).json({
        code: 'LOCAL_SOURCE_REQUIRED',
        error: 'A local media file is required to create a poster.',
      });
    }
    if (req.file) {
      if (Number(req.file.size) > 20 * 1024 * 1024) {
        cleanupUpload();
        return res.status(413).json({
          code: 'POSTER_TOO_LARGE',
          error: 'Custom posters must be 20 MB or smaller.',
        });
      }
      if (!validateUploadedFile(req, res)) return;
      if (!new Set(['image/jpeg', 'image/png', 'image/webp']).has(String(req.file.mimetype || ''))
          || isActiveContentMime(req.file.mimetype)) {
        cleanupUpload();
        return res.status(415).json({
          code: 'POSTER_IMAGE_REQUIRED',
          error: 'Custom posters must be a safe JPEG, PNG, or WebP image.',
        });
      }
    }
    const isVideo = String(content.mime_type || '').startsWith('video/');
    let request;
    try {
      request = normalizePosterRequest(req.body, {
        isVideo,
        durationSeconds: content.duration_sec,
      });
    } catch (error) {
      cleanupUpload();
      return res.status(400).json({
        code: String(error.message || 'INVALID_POSTER_SETTINGS').toUpperCase(),
        error: 'Choose a valid video time and crop position.',
      });
    }
    if (!req.file && !isVideo && !String(content.mime_type || '').startsWith('image/')) {
      return res.status(422).json({
        code: 'CUSTOM_POSTER_REQUIRED',
        error: 'Upload a custom poster for this media type.',
      });
    }
    try {
      const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
      const queued = pipeline.enqueueThumbnailStudio({
        contentId: content.id,
        workspaceId: content.workspace_id || '__platform__',
        userId: req.user.id,
        expectedVersion: Number(content.version) || 1,
        expectedFilepath: content.filepath,
        timestampSeconds: request.timestampSeconds,
        position: request.position,
        customPosterPath: upload.resolveUploadedFilePath(req.file),
        sourceType: req.file ? 'custom_poster' : 'thumbnail_studio',
        idempotencyKey: `thumbnail-studio:${content.id}:v${content.version}:${uuidv4()}`,
      });
      auditContent(
        req,
        req.file ? 'content:poster_upload' : 'content:poster_generate',
        content,
        content,
        `job_id: ${queued.job.id}; position: ${request.position}; timestamp_seconds: ${request.timestampSeconds}`,
      );
      return res.status(202).json(publicMediaJob(queued.job));
    } catch (error) {
      cleanupUpload();
      return res.status(500).json({
        code: 'POSTER_QUEUE_FAILED',
        error: 'The poster could not be queued.',
      });
    }
  },
);

router.post('/:id/remote/recheck', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  if (!content.remote_url || content.filepath) {
    return res.status(422).json({
      code: 'REMOTE_SOURCE_REQUIRED',
      error: 'This item is not a direct external dependency.',
    });
  }
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
  const queued = pipeline.enqueueRemoteValidation({
    contentId: content.id,
    workspaceId: content.workspace_id || '__platform__',
    userId: req.user.id,
    url: content.remote_url,
    expectedVersion: Number(content.version) || 1,
    idempotencyKey: `remote-recheck:${content.id}:v${content.version}:${uuidv4()}`,
  });
  res.status(202).json(publicMediaJob(queued.job));
});

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

router.put('/:id/favorite', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  db.prepare(`
    INSERT INTO content_favorites (user_id, content_id, created_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, content_id) DO NOTHING
  `).run(req.user.id, content.id);
  logActivity(req.user.id, 'content:favorite', `content_id: ${content.id}`, null, getClientIp(req), req.workspaceId);
  return res.json({ content_id: content.id, is_favorite: true });
});

router.delete('/:id/favorite', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  db.prepare('DELETE FROM content_favorites WHERE user_id = ? AND content_id = ?')
    .run(req.user.id, content.id);
  logActivity(req.user.id, 'content:unfavorite', `content_id: ${content.id}`, null, getClientIp(req), req.workspaceId);
  return res.json({ content_id: content.id, is_favorite: false });
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

router.get('/:id/erase-impact', requireContentWriteRole, (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  let impact;
  try { impact = eraseImpact(db, content.id, { contentDir: config.contentDir }); }
  catch { return res.status(409).json({ code: 'ERASE_PREVIEW_FAILED', error: 'Permanent erase safety checks could not be completed.' }); }
  return res.json(publicEraseImpact(impact));
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
  if (content.library_scope === 'internal') { res.status(404).json({ error: 'Content not found' }); return null; }
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
  if (content.library_scope === 'internal') { res.status(404).json({ error: 'Content not found' }); return null; }
  const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
  if (!caps.canEditMetadata) { res.status(403).json({ error: 'Access denied' }); return null; }
  return content;
}

// Presentation-converter dependencies stay out of every normal library route.
// This narrow authenticated endpoint is the only direct byte path for them.
router.get('/internal/:id', (req, res) => {
  const content = getContentRow(req, req.params.id);
  if (!content || content.library_scope !== 'internal') {
    return res.status(404).json({ error: 'Internal presentation asset not found' });
  }
  if (!canReadInternalContent(content, visibilityContext(req))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!content.filepath) return res.status(404).json({ error: 'Internal presentation asset file is missing' });
  const root = path.resolve(config.contentDir);
  const candidate = path.resolve(root, path.basename(String(content.filepath)));
  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync(root);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_internal_asset');
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return res.status(404).json({ error: 'Internal presentation asset file is missing' });
  }
  const relative = path.relative(realRoot, realCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return res.status(403).json({ error: 'Invalid internal presentation asset path' });
  }
  res.setHeader('Content-Type', content.mime_type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Authorization, Cookie');
  return res.sendFile(realCandidate);
});

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

  const {
    filename,
    mime_type,
    remote_url,
    folder,
    folder_id,
    default_fit_mode,
    access_level,
    tags,
  } = req.body;
  const updates = [];
  const values = [];
  let normalizedAccessLevel = null;
  if (filename !== undefined) { updates.push('filename = ?'); values.push(safeFilename(filename)); }
  if (mime_type !== undefined) {
    return res.status(400).json({
      code: 'TECHNICAL_MIME_READ_ONLY',
      error: 'Technical MIME type is detected from the media and cannot be edited.',
    });
  }
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
    if (!remote_url) return res.status(400).json({ error: 'remote_url cannot be empty' });
    const urlErr = validateRemoteUrl(remote_url);
    if (urlErr) return res.status(urlErr.status).json({ error: urlErr.error });
    updates.push('remote_url = ?');
    values.push(remote_url);
    updates.push("processing_status = 'processing'", 'processing_error = NULL');
  }
  if (folder !== undefined) { updates.push('folder = ?'); values.push(folder || null); }
  if (tags !== undefined) {
    const normalizedTags = normalizeContentTags(tags);
    if (!normalizedTags) {
      return res.status(400).json({
        code: 'INVALID_CONTENT_TAGS',
        error: 'Tags must be an array of up to 20 short text labels.',
      });
    }
    updates.push('tags_json = ?');
    values.push(JSON.stringify(normalizedTags));
  }
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
    const pipeline = remote_url !== undefined
      ? getMediaPipeline({ db, io: req.app.get('io') })
      : null;
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
      if (pipeline) {
        pipeline.enqueueRemoteValidation({
          contentId: content.id,
          workspaceId: content.workspace_id || '__platform__',
          userId: req.user.id,
          url: remote_url,
          expectedVersion: Math.max(1, Number(content.version) || 1) + 1,
        });
      }
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
  const uploadedPath = upload.resolveUploadedFilePath(req.file);
  if (!uploadedPath) return res.status(400).json({ error: 'Invalid upload path' });
  if (!upload.uploadedFileHasBytes(req.file)) {
    upload.discardUploadedFile(req.file);
    return res.status(400).json({
      code: 'EMPTY_UPLOAD',
      error: 'Uploaded file is empty. Select the original file and try again.',
    });
  }
  if (req.body.expected_version !== undefined
      && Number(req.body.expected_version) !== Number(content.version || 1)) {
    upload.discardUploadedFile(req.file);
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before replacing the file.' });
  }
  if (!validateUploadedFile(req, res)) return;

  const filepath = req.file.filename;
  const oldPaths = [...new Set([content.filepath, content.original_filepath, content.thumbnail_path])]
    .filter((oldPath) => oldPath && oldPath !== filepath);
  const staleAbsolutePaths = oldPaths.map(
    (oldPath) => path.join(config.contentDir, path.basename(oldPath)),
  );
  const nextVersion = Math.max(1, Number(content.version) || 1) + 1;
  const pipeline = getMediaPipeline({ db, io: req.app.get('io') });

  let changed = 0;
  let queued;
  try {
    changed = db.transaction(() => {
      const result = db.prepare(`UPDATE content SET filepath = ?, original_filepath = ?, original_sha256 = NULL,
          mime_type = ?, file_size = ?, thumbnail_path = NULL, width = NULL, height = NULL,
          duration_sec = NULL, remote_url = NULL,
          processing_status = 'uploaded', processing_error = NULL,
          version = COALESCE(version, 1) + 1, updated_at = strftime('%s','now')
          WHERE id = ? AND COALESCE(version, 1) = ?`)
        .run(filepath, filepath, req.file.mimetype, req.file.size,
          req.params.id, Number(content.version || 1));
      if (result.changes) {
        db.prepare('DELETE FROM content_media_metadata WHERE content_id=?').run(req.params.id);
        db.prepare(`UPDATE content_publication_requests
          SET status = 'cancelled', decided_by = ?, decision_reason = 'File replaced after review was requested',
            decided_at = strftime('%s','now'), updated_at = strftime('%s','now')
          WHERE content_id = ? AND status = 'pending'`).run(req.user.id, req.params.id);
        queued = req.file.mimetype.startsWith('video/')
          ? pipeline.enqueueVideo({
            contentId: req.params.id,
            workspaceId: content.workspace_id || '__platform__',
            userId: req.user.id,
            absolutePath: uploadedPath,
            expectedVersion: nextVersion,
            expectedFilepath: filepath,
            staleAbsolutePaths,
            sourceType: 'replacement',
          })
          : pipeline.enqueueThumbnailFinalize({
            contentId: req.params.id,
            workspaceId: content.workspace_id || '__platform__',
            userId: req.user.id,
            absolutePath: uploadedPath,
            expectedVersion: nextVersion,
            expectedFilepath: filepath,
            mimeType: req.file.mimetype,
            staleAbsolutePaths,
            sourceType: 'replacement',
          });
      }
      return result.changes;
    })();
  } catch (error) {
    removeLocalContentFile(filepath);
    return res.status(500).json({ code: 'CONTENT_REPLACE_FAILED', error: 'The replacement could not be saved.' });
  }
  if (!changed) {
    removeLocalContentFile(filepath);
    return res.status(409).json({ code: 'CONTENT_VERSION_CONFLICT', error: 'Content changed; reload before replacing the file.' });
  }

  const updated = getContentRow(req, req.params.id);
  auditContent(req, 'content:replace', content, updated);
  res.status(202).json({
    ...decorateContent(updated, req),
    media_job: publicMediaJob(queued.job),
  });
});

// Serve content file
router.get('/:id/file', (req, res) => {
  const content = checkContentRead(req, res);
  if (!content) return;
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  // Prevent path traversal
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isActiveContentMime(content.mime_type)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  } else {
    res.setHeader('Content-Type', content.mime_type || 'application/octet-stream');
  }
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  let stat;
  try {
    stat = fs.statSync(safePath);
    if (!stat.isFile()) throw new Error('not_file');
  } catch {
    return res.status(404).json({ error: 'Thumbnail file is missing' });
  }
  const cacheIdentity = thumbnailCacheIdentity(content, stat);
  res.setHeader('ETag', cacheIdentity.etag);
  res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');
  res.setHeader('Vary', 'Authorization, Cookie');
  res.setHeader('Content-Location', cacheIdentity.contentLocation);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  if (requestMatchesEtag(req.headers?.['if-none-match'], cacheIdentity.etag)) {
    return res.status(304).end();
  }
  res.sendFile(safePath);
});

async function permanentlyErase(req, content) {
  const result = await eraseContent(db, content.id, {
    contentDir: config.contentDir,
    audit: (_summary, impact) => auditContent(
      req,
      'content:permanent_erase',
      content,
      null,
      JSON.stringify({ dependencies_detached: impact.categories }),
    ),
  });
  const io = req.app.get('io');
  result.cache_purge = await emitContentPurge(io, {
    contentId: content.id,
    assetId: result.impact.cache.asset_id,
    generation: result.impact.cache.generation,
    nodeIds: result.impact.cache.node_ids.length ? result.impact.cache.node_ids : undefined,
  });

  try {
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      const { getEndpoint } = require('../lib/advanced-canvas');
      const deviceNs = io.of('/device');
      for (const deviceId of result.impact.affected_device_ids) {
        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, deviceId, buildPlaylistPayload);
      }
      const canvasNs = io.of('/canvas');
      for (const endpointId of result.impact.affected_canvas_endpoint_ids || []) {
        canvasNs.to(endpointId).emit('canvas:scene', getEndpoint(endpointId));
      }
    }
  } catch (error) {
    result.device_refresh_warning = 'Affected displays could not be refreshed automatically.';
  }
  if (!result.success) {
    const error = new Error('Catalog dependencies were detached, but one or more staged byte files could not be removed.');
    error.code = 'ERASE_BYTE_CLEANUP_FAILED';
    error.result = result;
    throw error;
  }
  return result;
}

router.post('/permanent-erase', requireContentWriteRole, async (req, res) => {
  if (req.body?.confirm_permanent_erase !== true) {
    return res.status(400).json({ code: 'ERASE_CONFIRMATION_REQUIRED', error: 'Explicit permanent erase confirmation is required.' });
  }
  const ids = Array.isArray(req.body?.content_ids)
    ? [...new Set(req.body.content_ids.map(String).filter(Boolean))]
    : [];
  if (!ids.length || ids.length > 100) {
    return res.status(400).json({ error: 'Choose between 1 and 100 media items.' });
  }
  const authorized = [];
  for (const id of ids) {
    const content = getContentRow(req, id);
    if (!content) return res.status(404).json({ error: `Content not found: ${id}` });
    const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
    if (!caps.canDelete) return res.status(403).json({ error: `Permanent erase is not allowed for: ${id}` });
    let impact;
    try { impact = eraseImpact(db, id, { contentDir: config.contentDir }); }
    catch { return res.status(409).json({ code: 'ERASE_PREVIEW_FAILED', error: 'Permanent erase safety checks could not be completed.' }); }
    if (impact.blockers.length) {
      return res.status(409).json({
        code: 'ERASE_DEPENDENCY_BLOCKED',
        error: 'A dependency cannot be detached safely.',
        impact: publicEraseImpact(impact),
      });
    }
    authorized.push(content);
  }
  const results = [];
  for (const content of authorized) {
    try {
      results.push(await permanentlyErase(req, content));
    } catch (error) {
      return res.status(409).json({
        code: error.code || 'PERMANENT_ERASE_FAILED',
        error: 'Permanent erase could not be completed safely.',
        completed_content_ids: results.map((result) => result.content_id),
        failed_content_id: content.id,
        impact: publicEraseImpact(error.impact),
        result: publicEraseResult(error.result),
      });
    }
  }
  return res.json({ success: true, results: results.map(publicEraseResult) });
});

// Explicit, irreversible catalog and byte erasure. Archive and restore remain
// API-compatible for existing automation, but are no longer prerequisites.
router.delete('/:id', requireContentWriteRole, async (req, res) => {
  const content = checkContentWrite(req, res);
  if (!content) return;
  const caps = contentCapabilities(content, visibilityContext(req, { includeArchived: true }));
  if (!caps.canDelete) return res.status(403).json({ error: 'Permanent erase is not allowed for this item.' });
  if (req.body?.confirm_permanent_erase !== true) {
    return res.status(400).json({ code: 'ERASE_CONFIRMATION_REQUIRED', error: 'Explicit permanent erase confirmation is required.' });
  }
  try {
    return res.json(publicEraseResult(await permanentlyErase(req, content)));
  } catch (error) {
    return res.status(409).json({
      code: error.code || 'PERMANENT_ERASE_FAILED',
      error: 'Permanent erase could not be completed safely.',
      impact: publicEraseImpact(error.impact),
      result: publicEraseResult(error.result),
    });
  }
});

module.exports = router;
module.exports.contentFtsQuery = contentFtsQuery;
module.exports.decodeContentCursor = decodeContentCursor;
module.exports.encodeContentCursor = encodeContentCursor;
