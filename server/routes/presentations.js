const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const { ELEVATED_ROLES } = require('../middleware/auth');
const { ownedContentScope } = require('../lib/content-scope');
const upload = require('../middleware/upload');
const config = require('../config');
const { sanitizeString } = require('../middleware/sanitize');
const ncSync = require('../services/nextcloud-sync');
const { renderDeckToPptxBuffer } = require('../services/pptx');
const {
  SOURCE_SPEC,
  DECK_VERSIONS,
  PROFILE_IDS,
  listProfiles,
  listLayouts,
  decorateLayoutStyles,
  validateDeck,
} = require('../lib/presentation-template-registry');
const { contentUseDecision, contextFromRequest } = require('../lib/content-visibility');
const { inspectMediaFile } = require('../lib/media-integrity');
const { getMediaPipeline } = require('../lib/media-pipeline');
const { emitContentPurge } = require('../lib/node-registry');
const {
  beginPresentationCleanup,
  processPresentationCleanup,
} = require('../services/presentation-cleanup');
const { copyPresentationAssetToLibrary } = require('../services/presentation-asset-copy');

// MBFD Media Control Studio — Presentations CRUD. Mirrors the workspace-scoped
// access idiom from routes/playlists.js: list/create scope by req.workspaceId,
// per-row access via accessContext() on the presentation's workspace, and a
// viewer-write denial. A presentation's canonical content is the mbfd-deck-v1
// document in `deck_json`; slides/assets relational rows back the visual editor
// (Phase 3). No platform_admin cross-workspace bypass (matches the other routes).

const CANVAS_PROFILES = ['16x9', '4x3', 'wall-12372x2160', 'wall-3zone', ...Object.values(PROFILE_IDS)];

function emptyDeck(id, title, theme, canvasProfile) {
  return {
    version: 'mbfd-deck-v1',
    deck_id: id,
    title: title,
    theme: theme || 'mbfd-command',
    canvas_profile: canvasProfile || '16x9',
    slides: [],
    assets: [],
  };
}

function emptyV2Deck(id, title, wallProfile) {
  return {
    version: DECK_VERSIONS.V2,
    deck_id: id,
    title,
    theme_id: 'mbfd-videowall-v2',
    wall_profile: wallProfile,
    template_system_version: SOURCE_SPEC.spec_version,
    slides: [],
    assets: [],
  };
}

function allowV2(res) {
  if (config.features.presentationStudioV2) return true;
  res.status(404).json({ error: 'Presentation Studio v2 is disabled' });
  return false;
}

function slideCount(deckJson) {
  if (!deckJson) return 0;
  try { const d = JSON.parse(deckJson); return Array.isArray(d.slides) ? d.slides.length : 0; }
  catch { return 0; }
}

// Load + authorize a presentation by :id. requireWrite=false for reads.
function loadAccess(req, res, requireWrite) {
  const p = db.prepare('SELECT * FROM presentations WHERE id = ?').get(req.params.id);
  if (!p) { res.status(404).json({ error: 'presentation not found' }); return null; }
  if (!p.workspace_id) { res.status(403).json({ error: 'Presentation not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(p.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  // Phase 2.5: per-user ownership. Non-elevated users may only access their own
  // presentations (read + write). Acting-as impersonation and elevated roles pass.
  if (!ctx.actingAs && !ELEVATED_ROLES.includes(req.user.role) && p.user_id && p.user_id !== req.user.id) {
    res.status(403).json({ error: 'You can only access your own presentations' }); return null;
  }
  req.presentation = p;
  req.presentationCtx = ctx;
  return p;
}
const requireRead = (req, res, next) => { if (!loadAccess(req, res, false)) return; next(); };
const requireWrite = (req, res, next) => { if (!loadAccess(req, res, true)) return; next(); };

// Shared row shape for list/detail (adds derived slide_count).
function shape(p) {
  return { ...p, slide_count: slideCount(p.deck_json) };
}

function presentationAssetIds(presentationId) {
  return new Set(db.prepare(`SELECT content_id FROM presentation_assets
    WHERE presentation_id=? AND content_id IS NOT NULL`).all(presentationId).map((row) => String(row.content_id)));
}

// List — scoped to the caller's current workspace AND their own rows.
// Phase 2.5: presentations are private per-user; platform templates
// (workspace_id IS NULL) stay visible to all via the shared scope helper.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scope = ownedContentScope(req.workspaceId, req.user.id);
  const rows = db.prepare(`
    SELECT id, workspace_id, user_id, title, description, theme, canvas_profile,
           deck_json, status, published_at, thumbnail_path, created_by, created_at, updated_at
    FROM presentations WHERE ${scope.clause} ORDER BY updated_at DESC
  `).all(...scope.params);
  res.json(rows.map(shape));
});

// Canonical browser/editor registry. Geometry comes from the same checked-in
// template package consumed by server validation/player/export; local template
// filesystem paths are deliberately omitted from the response.
router.get('/templates/registry', (_req, res) => {
  if (!allowV2(res)) return;
  const profiles = listProfiles().map(({ production_template_path: _path, ...profile }) => ({
    ...profile,
    layouts: listLayouts(profile.id).map(decorateLayoutStyles),
  }));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({
    version: SOURCE_SPEC.spec_version,
    template_system: SOURCE_SPEC.template_system,
    theme: SOURCE_SPEC.theme,
    global_rules: SOURCE_SPEC.global_rules,
    profiles,
  });
});

// Create — stamps workspace_id + user_id, initializes an empty mbfd-deck-v1.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const description = (req.body.description || '').trim();
  const theme = (req.body.theme || 'mbfd-command').trim();
  let canvas = (req.body.canvas_profile || '16x9').trim();
  if (!CANVAS_PROFILES.includes(canvas)) canvas = '16x9';
  const id = uuidv4();
  // Use a caller-supplied versioned deck when valid. V2 is an additive path
  // behind its own feature flag; v1 creation behavior is unchanged.
  let deckJson;
  if (req.body.deck_json) {
    try {
      const d = typeof req.body.deck_json === 'string' ? JSON.parse(req.body.deck_json) : req.body.deck_json;
      if (d && d.version === DECK_VERSIONS.V2 && !config.features.presentationStudioV2) return res.status(404).json({ error: 'Presentation Studio v2 is disabled' });
      d.deck_id = id;
      d.title = title;
      const valid = validateDeck(d);
      if (valid.valid) {
        if (d.version === DECK_VERSIONS.V2) canvas = d.wall_profile;
        deckJson = JSON.stringify(d);
      }
    } catch { /* fall through to empty */ }
  }
  if (!deckJson && req.body.deck_version === DECK_VERSIONS.V2) {
    if (!allowV2(res)) return;
    if (!Object.values(PROFILE_IDS).includes(canvas)) canvas = PROFILE_IDS.THREE_DISPLAY;
    deckJson = JSON.stringify(emptyV2Deck(id, title, canvas));
  }
  if (!deckJson) deckJson = JSON.stringify(emptyDeck(id, title, theme, canvas));
  db.prepare(`
    INSERT INTO presentations (id, workspace_id, user_id, created_by, title, description, theme, canvas_profile, deck_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, req.workspaceId, req.user.id, req.user.id, title, description, theme, canvas, deckJson);
  res.status(201).json(shape(db.prepare('SELECT * FROM presentations WHERE id = ?').get(id)));
});

// Read one.
router.get('/:id', requireRead, (req, res) => {
  res.json(shape(req.presentation));
});

// Nextcloud sync status for this deck — lets the editor show "Saved to your
// Nextcloud". requireRead enforces the same per-user authorization as the deck
// itself, so a member only ever sees their own sync state. Returns null when no
// sync has been attempted (or the feature is off).
router.get('/:id/sync-job', requireRead, (req, res) => {
  if (!ncSync.enabled()) return res.json({ enabled: false, job: null });
  const row = db.prepare(
    'SELECT status, nextcloud_path, error_msg, last_synced_at FROM nextcloud_sync_jobs WHERE presentation_id = ?'
  ).get(req.params.id);
  res.json({ enabled: true, job: row || null });
});

// Update — title/description/theme/canvas_profile/deck_json/status.
router.put('/:id', requireWrite, (req, res) => {
  const updates = [];
  const values = [];
  const { title, description, theme, canvas_profile, deck_json, status } = req.body;
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: 'title cannot be empty' });
    updates.push('title = ?'); values.push(String(title).trim());
  }
  if (description !== undefined) { updates.push('description = ?'); values.push(String(description).trim()); }
  if (theme !== undefined) { updates.push('theme = ?'); values.push(String(theme).trim()); }
  if (canvas_profile !== undefined) {
    const c = String(canvas_profile).trim();
    if (!CANVAS_PROFILES.includes(c)) return res.status(400).json({ error: 'invalid canvas_profile' });
    updates.push('canvas_profile = ?'); values.push(c);
  }
  if (deck_json !== undefined) {
    let str;
    try {
      const d = typeof deck_json === 'string' ? JSON.parse(deck_json) : deck_json;
      if (d && d.version === DECK_VERSIONS.V2 && !config.features.presentationStudioV2) return res.status(404).json({ error: 'Presentation Studio v2 is disabled' });
      const valid = validateDeck(d);
      if (!valid.valid) throw new Error(valid.errors.join('; '));
      d.deck_id = req.params.id;
      if (d.version === DECK_VERSIONS.V2 && canvas_profile === undefined) {
        updates.push('canvas_profile = ?');
        values.push(d.wall_profile);
      }
      str = JSON.stringify(d);
    } catch (error) { return res.status(400).json({ error: `deck_json must be a valid mbfd-deck-v1 or mbfd-deck-v2 document: ${error.message}` }); }
    updates.push('deck_json = ?'); values.push(str);
  }
  if (status !== undefined) {
    if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    updates.push('status = ?'); values.push(status);
  }
  if (updates.length) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE presentations SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  // Mirror the saved deck into the owner's own Nextcloud (best-effort, async).
  if (deck_json !== undefined || title !== undefined) ncSync.syncSoon(req.params.id);
  res.json(shape(db.prepare('SELECT * FROM presentations WHERE id = ?').get(req.params.id)));
});

// Publish — snapshot the deck + stamp published_at. (Broadcast/playback in P4.)
router.post('/:id/publish', requireWrite, (req, res) => {
  db.prepare(`UPDATE presentations SET status = 'published', published_at = strftime('%s','now'),
              published_snapshot = deck_json, updated_at = strftime('%s','now') WHERE id = ?`).run(req.params.id);
  ncSync.syncSoon(req.params.id);
  res.json(shape(db.prepare('SELECT * FROM presentations WHERE id = ?').get(req.params.id)));
});

// Duplicate — clone deck into a new draft in the same workspace.
router.post('/:id/duplicate', requireWrite, (req, res) => {
  const src = req.presentation;
  const id = uuidv4();
  let deckJson = src.deck_json;
  try { const d = JSON.parse(src.deck_json); d.deck_id = id; deckJson = JSON.stringify(d); } catch { /* keep */ }
  db.prepare(`
    INSERT INTO presentations (id, workspace_id, user_id, created_by, title, description, theme, canvas_profile, deck_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, src.workspace_id, req.user.id, req.user.id, `${src.title} (copy)`, src.description, src.theme, src.canvas_profile, deckJson);
  res.status(201).json(shape(db.prepare('SELECT * FROM presentations WHERE id = ?').get(id)));
});

router.get('/:id/export.pptx', requireRead, async (req, res) => {
  try {
    const deck = JSON.parse(req.presentation.deck_json);
    const buffer = await renderDeckToPptxBuffer(deck, { allowedContentIds: presentationAssetIds(req.params.id) });
    const fallback = String(req.presentation.title || 'presentation').replace(/[^A-Za-z0-9._ -]+/g, '').slice(0, 100) || 'presentation';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fallback.replace(/"/g, '')}.pptx"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    console.error('[presentations] PPTX export failed');
    res.status(500).json({ error: 'PowerPoint export failed' });
  }
});

// Refresh one linked Media Library artifact while keeping the presentation row
// as the only editable source of truth.
router.post('/:id/export-to-library', requireWrite, async (req, res) => {
  let newPath = null;
  let partialPath = null;
  try {
    const deck = JSON.parse(req.presentation.deck_json);
    const buffer = await renderDeckToPptxBuffer(deck, { allowedContentIds: presentationAssetIds(req.params.id) });
    const revision = Number(req.presentation.updated_at) || Math.floor(Date.now() / 1000);
    const storedName = `presentation_export_${req.params.id}_${revision}.pptx`;
    newPath = path.resolve(config.contentDir, path.basename(storedName));
    if (path.dirname(newPath) !== path.resolve(config.contentDir)) throw new Error('invalid export path');
    partialPath = `${newPath}.partial-${process.pid}-${uuidv4()}`;
    await fs.promises.writeFile(partialPath, buffer, { flag: 'wx' });
    await fs.promises.rename(partialPath, newPath);
    partialPath = null;
    const existing = db.prepare(`
      SELECT pe.id AS export_id, pe.content_id, c.filepath AS old_filepath
      FROM presentation_exports pe LEFT JOIN content c ON c.id=pe.content_id
      WHERE pe.presentation_id=? AND pe.export_format='pptx' AND pe.user_id=?
      ORDER BY pe.created_at DESC LIMIT 1
    `).get(req.params.id, req.user.id);
    const now = Math.floor(Date.now() / 1000);
    let contentId = existing && existing.content_id;
    const exportId = existing ? existing.export_id : uuidv4();
    const metadata = JSON.stringify({ presentation_id: req.params.id, source_revision: revision, wall_profile: deck.wall_profile || req.presentation.canvas_profile });
    const commit = db.transaction(() => {
      if (contentId) {
        db.prepare(`UPDATE content SET filename=?, filepath=?, mime_type=?, file_size=?, content_type='presentation_export',
          metadata_json=?, processing_status='ready', processing_error=NULL, version=COALESCE(version,1)+1, updated_at=?
          WHERE id=? AND workspace_id=? AND user_id=?`)
          .run(`${req.presentation.title}.pptx`, storedName, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer.length, metadata, now, contentId, req.presentation.workspace_id, req.user.id);
      } else {
        contentId = uuidv4();
        db.prepare(`INSERT INTO content
          (id,user_id,workspace_id,filename,filepath,mime_type,file_size,content_type,metadata_json,processing_status,access_level,updated_at)
          VALUES (?,?,?,?,?,?,?,'presentation_export',?,'ready','private',?)`)
          .run(contentId, req.user.id, req.presentation.workspace_id, `${req.presentation.title}.pptx`, storedName,
            'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer.length, metadata, now);
      }
      if (existing) {
        db.prepare(`UPDATE presentation_exports SET content_id=?, workspace_id=?, user_id=?, file_path=?, wall_profile=?,
          source_revision=?, status='completed', error_msg=NULL, generated_at=?, completed_at=? WHERE id=?`)
          .run(contentId, req.presentation.workspace_id, req.user.id, storedName, deck.wall_profile || req.presentation.canvas_profile,
            revision, now, now, exportId);
      } else {
        db.prepare(`INSERT INTO presentation_exports
          (id,presentation_id,content_id,workspace_id,user_id,export_format,file_path,wall_profile,source_revision,status,generated_at,completed_at)
          VALUES (?,?,?,?,?,'pptx',?,?,?,'completed',?,?)`)
          .run(exportId, req.params.id, contentId, req.presentation.workspace_id, req.user.id, storedName,
            deck.wall_profile || req.presentation.canvas_profile, revision, now, now);
      }
    });
    commit();
    if (existing && existing.old_filepath && existing.old_filepath !== storedName) {
      fs.promises.unlink(path.resolve(config.contentDir, path.basename(existing.old_filepath))).catch(() => {});
    }
    res.status(existing ? 200 : 201).json({ export_id: exportId, content_id: contentId, source_revision: revision, filename: `${req.presentation.title}.pptx` });
  } catch (error) {
    if (partialPath) fs.promises.unlink(partialPath).catch(() => {});
    if (newPath) fs.promises.unlink(newPath).catch(() => {});
    console.error('[presentations] Media Library export failed');
    res.status(500).json({ error: 'Could not save PowerPoint to Media Library' });
  }
});

// Link an existing safe Media Library item instead of creating a competing
// presentation-only asset store.
router.post('/:id/assets/link', requireWrite, (req, res) => {
  const contentId = String(req.body.content_id || '').trim();
  if (!contentId) return res.status(400).json({ error: 'content_id required' });
  const decision = contentUseDecision(db, contentId, req.presentation.workspace_id, contextFromRequest(req));
  if (!decision.allowed) return res.status(403).json({ error: decision.reason || 'Content is not available in this workspace' });
  const mime = String(decision.content.mime_type || '');
  if (!/^(image\/(?:jpeg|png|gif|webp|bmp)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|mp4|wav|ogg))$/i.test(mime)) {
    return res.status(400).json({ error: 'Only safe image, video, or audio Media Library items can be linked' });
  }
  const existing = db.prepare('SELECT id FROM presentation_assets WHERE presentation_id=? AND content_id=?').get(req.params.id, contentId);
  const assetId = existing ? existing.id : uuidv4();
  if (!existing) db.prepare(`INSERT INTO presentation_assets (id,presentation_id,content_id,position_json,fit_mode)
    VALUES (?,?,?,'{}','contain')`).run(assetId, req.params.id, contentId);
  res.status(existing ? 200 : 201).json({ asset_id: assetId, content_id: contentId, url: `/player/asset/${contentId}`, mime_type: mime });
});

router.get('/:id/assets', requireRead, (req, res) => {
  const linked = db.prepare(`SELECT pa.id AS asset_id, pa.content_id, pa.created_at,
      c.filename, c.mime_type, c.file_size, c.content_type, c.processing_status,
      c.thumbnail_path, c.library_scope
    FROM presentation_assets pa JOIN content c ON c.id=pa.content_id
    WHERE pa.presentation_id=? ORDER BY pa.created_at, pa.id`).all(req.params.id);
  const sourceDecks = db.prepare(`SELECT DISTINCT c.id AS content_id, c.filename, c.mime_type,
      c.file_size, c.processing_status, c.library_scope
    FROM presentation_conversion_runs pcr JOIN content c ON c.id=pcr.source_content_id
    WHERE pcr.presentation_id=?`).all(req.params.id);
  const previews = db.prepare(`SELECT id AS slide_id, sort_order, thumbnail_path
    FROM presentation_slides WHERE presentation_id=? AND thumbnail_path IS NOT NULL
    ORDER BY sort_order`).all(req.params.id);
  const response = {
    source_decks: sourceDecks,
    extracted_images: [],
    studio_uploads: [],
    video_audio: [],
    rendered_previews: previews,
    linked_library_media: [],
  };
  for (const asset of linked) {
    if (asset.library_scope !== 'internal') response.linked_library_media.push(asset);
    else if (/^(video|audio)\//i.test(asset.mime_type || '')) response.video_audio.push(asset);
    else if (asset.content_type === 'presentation_image') response.studio_uploads.push(asset);
    else response.extracted_images.push(asset);
  }
  res.json(response);
});

// Create an independent Media Library item from one dependency owned by this
// presentation. The internal source row and bytes remain unchanged.
router.post('/:id/assets/:contentId/save-copy', requireWrite, async (req, res) => {
  try {
    const copy = await copyPresentationAssetToLibrary(db, {
      presentationId: req.params.id,
      contentId: req.params.contentId,
      workspaceId: req.presentation.workspace_id,
      userId: req.user.id,
      contentDir: config.contentDir,
    });
    return res.status(201).json(copy);
  } catch (error) {
    if (error.code === 'PRESENTATION_ASSET_NOT_FOUND') {
      return res.status(404).json({ code: error.code, error: 'Presentation asset not found.' });
    }
    if (['PRESENTATION_ASSET_NOT_LOCAL', 'PRESENTATION_ASSET_PATH_INVALID', 'PRESENTATION_ASSET_NOT_READY'].includes(error.code)) {
      return res.status(409).json({ code: error.code, error: error.message });
    }
    console.error('[presentations] asset Save Copy failed');
    return res.status(500).json({ code: 'PRESENTATION_ASSET_COPY_FAILED', error: 'Could not save this asset to the Media Library.' });
  }
});

// ── Slide image upload ──────────────────────────────────────────────────────
// Upload an image to use on a slide. The binary is stored in the shared content
// table (content_type='presentation_image') + a presentation_assets row links it
// to this presentation. The public player fetches it at /player/asset/:contentId
// (that route only serves rows that have a presentation_assets link, so arbitrary
// content can't be enumerated). Placement (x/y/w/h/fit/effects) is NOT stored
// here — it lives in the slide's `images[]` inside deck_json, edited client-side.
const IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
const PRESENTATION_MEDIA_MIME = new Set([
  ...IMG_MIME,
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg',
]);

function safeName(name) { return sanitizeString((name || 'image').normalize('NFC')); }

router.post('/:id/assets', requireWrite, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!upload.uploadedFileHasBytes(req.file)) {
      try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
      return res.status(400).json({ code: 'EMPTY_UPLOAD', error: 'The presentation media file is empty.' });
    }
    const integrity = inspectMediaFile({
      filePath: req.file.path,
      contentDir: config.contentDir,
      claimedMime: req.file.mimetype,
      filename: req.file.originalname,
    });
    if (!integrity.ok || !PRESENTATION_MEDIA_MIME.has(integrity.detectedMime)) {
      // Drop the rejected upload multer wrote to disk before bailing.
      try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
      return res.status(415).json({ error: 'Only inspected raster images, MP4/WebM/QuickTime video, or common audio files can be added to slides' });
    }
    req.file.mimetype = integrity.detectedMime;
    req.file.size = integrity.size;
    const isImage = IMG_MIME.has(req.file.mimetype);
    const filepath = req.file.filename;
    let width = null, height = null, thumbnailPath = null;
    // Best-effort metadata + thumbnail (mirrors routes/content.js; never fatal).
    try {
      const sharp = require('sharp');
      const sharpOpts = { limitInputPixels: false, failOn: 'none' };
      try { const m = await sharp(req.file.path, sharpOpts).metadata(); width = m.width; height = m.height; }
      catch (e) { console.warn('[pres-asset] sharp metadata failed:', e.message); }
      try {
        thumbnailPath = `thumb_${filepath}`;
        await sharp(req.file.path, sharpOpts).resize(config.thumbnailWidth).jpeg({ quality: 70 })
          .toFile(path.join(config.contentDir, thumbnailPath));
      } catch (e) { console.warn('[pres-asset] sharp thumbnail failed:', e.message); thumbnailPath = null; }
    } catch (e) { console.warn('[pres-asset] sharp unavailable:', e.message); }

    const contentId = uuidv4();
    const assetId = uuidv4();
    const pipeline = getMediaPipeline({ db, io: req.app.get('io') });
    let queued;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, thumbnail_path, width, height, content_type, access_level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')
      `).run(contentId, req.user.id, req.presentation.workspace_id, safeName(req.file.originalname),
      filepath, req.file.mimetype, req.file.size, thumbnailPath, width, height,
      isImage ? 'presentation_image' : 'presentation_asset');
      db.prepare("UPDATE content SET library_scope='internal' WHERE id=?").run(contentId);
      db.prepare(`
        INSERT INTO presentation_assets (id, presentation_id, content_id, position_json, fit_mode)
        VALUES (?, ?, ?, '{}', 'contain')
      `).run(assetId, req.params.id, contentId);
      queued = (req.file.mimetype.startsWith('video/')
        ? pipeline.enqueueVideo({
        contentId,
        workspaceId: req.presentation.workspace_id,
        userId: req.user.id,
        absolutePath: req.file.path,
        expectedVersion: 1,
        expectedFilepath: filepath,
        sourceType: 'presentation_studio_upload',
      })
        : pipeline.enqueueThumbnailFinalize({
        contentId,
        workspaceId: req.presentation.workspace_id,
        userId: req.user.id,
        absolutePath: req.file.path,
        expectedVersion: 1,
        expectedFilepath: filepath,
        mimeType: req.file.mimetype,
          sourceType: 'presentation_studio_upload',
        })).job;
    })();

    res.status(201).json({
      asset_id: assetId,
      content_id: contentId,
      url: `/player/asset/${contentId}`,
      thumbnail_url: thumbnailPath ? `/api/content/${contentId}/thumbnail` : `/player/asset/${contentId}`,
      filename: safeName(req.file.originalname),
      mime_type: req.file.mimetype,
      width, height,
      media_job: queued ? { id: queued.id, status: queued.status, stage: queued.stage, progress_pct: queued.progress_pct } : null,
    });
  } catch (err) {
    console.error('[pres-asset] upload error:', err);
    // Don't leak the uploaded file (or its thumbnail) on a failed insert.
    if (req.file) {
      if (req.file.path) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
      if (req.file.filename) { try { fs.unlinkSync(path.join(config.contentDir, 'thumb_' + req.file.filename)); } catch { /* */ } }
    }
    res.status(500).json({ error: 'Presentation media upload failed' });
  }
});

// Delete the presentation and durably ledger every internal dependency before
// cleanup. A crash or byte-removal failure remains retryable at next startup.
router.delete('/:id', requireWrite, async (req, res) => {
  let operationId;
  try {
    operationId = beginPresentationCleanup(db, {
      presentationId: req.params.id,
      workspaceId: req.presentation.workspace_id,
    });
  } catch (error) {
    console.warn('[pres-asset] cleanup ledger creation failed:', error.message);
    return res.status(409).json({ error: 'Presentation could not be deleted safely.' });
  }
  const cleanup = processPresentationCleanup(db, operationId, { contentDir: config.contentDir });
  const purges = await Promise.all(cleanup.erased.map(async (entry) => {
    const purge = await emitContentPurge(req.app.get('io'), {
      contentId: entry.content_id,
      assetId: entry.asset_id,
      generation: entry.generation,
      nodeIds: entry.node_ids.length ? entry.node_ids : undefined,
    });
    return {
      content_id: entry.content_id,
      nodes: (purge.nodes || []).map((node) => ({
        node_id: node.node_id,
        acknowledged: node.acknowledged,
        purged: node.purged,
        offline: node.offline,
        error: node.error || null,
      })),
    };
  }));
  return res.status(cleanup.state === 'completed' ? 200 : 202).json({
    success: true,
    cleanup_operation_id: operationId,
    cleanup_state: cleanup.state,
    cleanup_pending: cleanup.state !== 'completed',
    internal_assets_erased: purges,
    shared_internal_assets_preserved: cleanup.skipped_shared,
    cleanup_errors: cleanup.errors,
  });
});

module.exports = router;
