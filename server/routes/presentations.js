const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const upload = require('../middleware/upload');
const config = require('../config');
const { sanitizeString } = require('../middleware/sanitize');

// MBFD Media Control Studio — Presentations CRUD. Mirrors the workspace-scoped
// access idiom from routes/playlists.js: list/create scope by req.workspaceId,
// per-row access via accessContext() on the presentation's workspace, and a
// viewer-write denial. A presentation's canonical content is the mbfd-deck-v1
// document in `deck_json`; slides/assets relational rows back the visual editor
// (Phase 3). No platform_admin cross-workspace bypass (matches the other routes).

const CANVAS_PROFILES = ['16x9', '4x3', 'wall-12372x2160', 'wall-3zone'];

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

// List — scoped to the caller's current workspace.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const rows = db.prepare(`
    SELECT id, workspace_id, user_id, title, description, theme, canvas_profile,
           deck_json, status, published_at, thumbnail_path, created_by, created_at, updated_at
    FROM presentations WHERE workspace_id = ? ORDER BY updated_at DESC
  `).all(req.workspaceId);
  res.json(rows.map(shape));
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
  // Use the caller-supplied deck_json if it's valid mbfd-deck-v1, else seed empty.
  let deckJson;
  if (req.body.deck_json) {
    try {
      const d = typeof req.body.deck_json === 'string' ? JSON.parse(req.body.deck_json) : req.body.deck_json;
      if (d && d.version === 'mbfd-deck-v1') { d.deck_id = id; d.title = title; deckJson = JSON.stringify(d); }
    } catch { /* fall through to empty */ }
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
      if (!d || d.version !== 'mbfd-deck-v1') throw new Error('bad version');
      str = JSON.stringify(d);
    } catch { return res.status(400).json({ error: 'deck_json must be a valid mbfd-deck-v1 document' }); }
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
  res.json(shape(db.prepare('SELECT * FROM presentations WHERE id = ?').get(req.params.id)));
});

// Publish — snapshot the deck + stamp published_at. (Broadcast/playback in P4.)
router.post('/:id/publish', requireWrite, (req, res) => {
  db.prepare(`UPDATE presentations SET status = 'published', published_at = strftime('%s','now'),
              published_snapshot = deck_json, updated_at = strftime('%s','now') WHERE id = ?`).run(req.params.id);
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

// ── Slide image upload ──────────────────────────────────────────────────────
// Upload an image to use on a slide. The binary is stored in the shared content
// table (content_type='presentation_image') + a presentation_assets row links it
// to this presentation. The public player fetches it at /player/asset/:contentId
// (that route only serves rows that have a presentation_assets link, so arbitrary
// content can't be enumerated). Placement (x/y/w/h/fit/effects) is NOT stored
// here — it lives in the slide's `images[]` inside deck_json, edited client-side.
const IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

function safeName(name) { return sanitizeString((name || 'image').normalize('NFC')); }

router.post('/:id/assets', requireWrite, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const isImage = req.file.mimetype && (req.file.mimetype.startsWith('image/') || IMG_MIME.has(req.file.mimetype));
    if (!isImage) {
      // Drop the non-image multer wrote to disk before bailing.
      try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
      return res.status(400).json({ error: 'Only image files can be added to slides' });
    }
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
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, thumbnail_path, width, height, content_type, access_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'presentation_image', 'private')
    `).run(contentId, req.user.id, req.presentation.workspace_id, safeName(req.file.originalname),
           filepath, req.file.mimetype, req.file.size, thumbnailPath, width, height);

    const assetId = uuidv4();
    db.prepare(`
      INSERT INTO presentation_assets (id, presentation_id, content_id, position_json, fit_mode)
      VALUES (?, ?, ?, '{}', 'contain')
    `).run(assetId, req.params.id, contentId);

    res.status(201).json({
      asset_id: assetId,
      content_id: contentId,
      url: `/player/asset/${contentId}`,
      thumbnail_url: thumbnailPath ? `/api/content/${contentId}/thumbnail` : `/player/asset/${contentId}`,
      filename: safeName(req.file.originalname),
      width, height,
    });
  } catch (err) {
    console.error('[pres-asset] upload error:', err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// Delete. Also best-effort prunes presentation_image content that this deck
// uniquely owned (not referenced by any other presentation_asset, playlist
// item, or widget), so removing a deck reclaims its uploaded images + files.
router.delete('/:id', requireWrite, (req, res) => {
  // Gather this presentation's image asset content rows BEFORE the cascade.
  let assetContentIds = [];
  try {
    assetContentIds = db.prepare('SELECT DISTINCT content_id FROM presentation_assets WHERE presentation_id = ? AND content_id IS NOT NULL')
      .all(req.params.id).map((r) => r.content_id);
  } catch { /* table/edge — skip cleanup */ }

  db.prepare('DELETE FROM presentations WHERE id = ?').run(req.params.id);

  // Orphan prune (best-effort, scoped to presentation_image rows only).
  for (const cid of assetContentIds) {
    try {
      const row = db.prepare("SELECT id, filepath, thumbnail_path FROM content WHERE id = ? AND content_type = 'presentation_image'").get(cid);
      if (!row) continue;
      const stillAsset = db.prepare('SELECT 1 FROM presentation_assets WHERE content_id = ? LIMIT 1').get(cid);
      const inPlaylist = db.prepare('SELECT 1 FROM playlist_items WHERE content_id = ? LIMIT 1').get(cid);
      const inWidget = db.prepare('SELECT 1 FROM widgets WHERE config LIKE ? LIMIT 1').get(`%/api/content/${cid}/%`);
      if (stillAsset || inPlaylist || inWidget) continue;
      if (row.filepath) { try { fs.unlinkSync(path.join(config.contentDir, path.basename(row.filepath))); } catch { /* gone */ } }
      if (row.thumbnail_path) { try { fs.unlinkSync(path.join(config.contentDir, path.basename(row.thumbnail_path))); } catch { /* gone */ } }
      db.prepare('DELETE FROM content WHERE id = ?').run(cid);
    } catch (e) { console.warn('[pres-asset] orphan prune skipped for', cid, e.message); }
  }
  res.json({ success: true });
});

module.exports = router;
