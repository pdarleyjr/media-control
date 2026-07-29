'use strict';

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { db } = require('../db/database');
const { audit } = require('../lib/audit');
const {
  contentCapabilities,
  contentUseDecision,
  contextFromRequest,
} = require('../lib/content-visibility');
const {
  MAX_CAPTION_BYTES,
  captionsForContent,
  normalizeCaption,
  publicCaption,
} = require('../lib/content-captions');
const { canServePublicContent } = require('../lib/public-content-access');
const nodeRegistry = require('../lib/node-registry');
const { getClientIp } = require('../services/activity');

const router = express.Router();
const captionUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CAPTION_BYTES,
    files: 1,
    fields: 8,
  },
});

function captionErrorStatus(error) {
  if (error?.code === 'LIMIT_FILE_SIZE') return 413;
  if (/caption_too_large/.test(error?.code || error?.message || '')) return 413;
  return 422;
}

function captionErrorMessage(error) {
  const code = String(error?.code || error?.message || '');
  const messages = {
    caption_empty: 'Caption file is empty.',
    caption_too_large: 'Caption file exceeds the 2 MB limit.',
    caption_binary: 'Caption file contains binary data.',
    caption_encoding_invalid: 'Caption file must use valid UTF-8 text.',
    caption_line_too_long: 'Caption file contains an excessively long line.',
    caption_too_many_cues: 'Caption file contains too many cues.',
    caption_invalid_timing: 'Caption cue timing is invalid.',
    caption_empty_cue: 'Caption file contains an empty cue.',
    caption_extension_invalid: 'Caption file must use .vtt or .srt.',
    caption_invalid: 'Caption file is not valid WebVTT or SRT.',
  };
  return messages[code] || 'Caption file could not be processed.';
}

function contentDecision(req, contentId) {
  return contentUseDecision(
    db,
    String(contentId || ''),
    req.workspaceId,
    contextFromRequest(req),
  );
}

function requireReadableContent(req, res, contentId) {
  const decision = contentDecision(req, contentId);
  if (!decision.content) {
    res.status(404).json({ error: 'Content not found' });
    return null;
  }
  if (!decision.allowed) {
    res.status(403).json({ error: decision.reason });
    return null;
  }
  return decision.content;
}

function requireEditableContent(req, res, contentId) {
  const content = requireReadableContent(req, res, contentId);
  if (!content) return null;
  const capabilities = contentCapabilities(content, contextFromRequest(req));
  if (
    (!req.actingAs && req.workspaceRole === 'workspace_viewer')
    || !capabilities.canEditMetadata
  ) {
    res.status(403).json({ error: 'You do not have permission to edit captions.' });
    return null;
  }
  return content;
}

function normalizeLanguageCode(value) {
  const language = String(value || '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || language.length > 35) {
    return null;
  }
  return language;
}

function auditCaption(req, action, contentId, captionId, details = {}) {
  audit({
    actorType: 'user',
    actorId: req.user.id,
    action,
    targetType: 'content-caption',
    targetId: captionId,
    workspaceId: req.workspaceId,
    sourceIp: getClientIp(req),
    details: { content_id: contentId, ...details },
  });
}

router.get('/search', (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (query.length < 2) {
    return res.status(400).json({ error: 'Search requires at least two characters.' });
  }
  const escaped = query.replace(/[\\%_]/g, value => `\\${value}`);
  const rows = db.prepare(`
    SELECT cc.id, cc.content_id, cc.language_code, cc.label, cc.kind,
           cc.is_default, cc.source_type, cc.source_format, cc.cue_count,
           c.filename
    FROM content_captions cc
    JOIN content c ON c.id=cc.content_id
    WHERE cc.workspace_id=?
      AND c.archived_at IS NULL
      AND cc.search_text LIKE ? ESCAPE '\\'
    ORDER BY cc.updated_at DESC, cc.id
    LIMIT 100
  `).all(req.workspaceId, `%${escaped}%`);
  return res.json({
    query,
    results: rows.map(row => ({
      ...publicCaption(row),
      content_id: row.content_id,
      filename: row.filename,
    })),
  });
});

router.get('/content/:contentId', (req, res) => {
  const content = requireReadableContent(req, res, req.params.contentId);
  if (!content) return undefined;
  res.set('Cache-Control', 'no-store');
  const captions = captionsForContent(db, content.id);
  if (req.query.include_body === '1') {
    const bodies = new Map(db.prepare(
      'SELECT id, body_vtt FROM content_captions WHERE content_id=?',
    ).all(content.id).map(row => [String(row.id), row.body_vtt]));
    return res.json({
      captions: captions.map(caption => ({
        ...caption,
        body_vtt: bodies.get(String(caption.id)) || '',
      })),
    });
  }
  return res.json({ captions });
});

router.post(
  '/content/:contentId',
  (req, res, next) => captionUpload.single('caption_file')(req, res, next),
  (req, res) => {
    const content = requireEditableContent(req, res, req.params.contentId);
    if (!content) return undefined;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'caption_file is required' });
    }
    const languageCode = normalizeLanguageCode(req.body.language_code);
    if (!languageCode) {
      return res.status(422).json({ error: 'A valid BCP 47 language code is required.' });
    }
    const label = String(req.body.label || languageCode).trim().slice(0, 80);
    if (!label) return res.status(422).json({ error: 'Caption label is required.' });
    const kind = req.body.kind === 'subtitles' ? 'subtitles' : 'captions';
    const isDefault = String(req.body.is_default || '').toLowerCase() === 'true'
      || String(req.body.is_default || '') === '1';
    let normalized;
    try {
      normalized = normalizeCaption(req.file.buffer, { filename: req.file.originalname });
    } catch (error) {
      return res.status(captionErrorStatus(error)).json({
        error: captionErrorMessage(error),
        code: error.code || error.message,
      });
    }

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const sha256 = crypto.createHash('sha256').update(normalized.body).digest('hex');
    const insert = db.transaction(() => {
      if (isDefault) {
        db.prepare('UPDATE content_captions SET is_default=0, updated_at=? WHERE content_id=?')
          .run(now, content.id);
      }
      db.prepare(`
        INSERT INTO content_captions (
          id, content_id, workspace_id, language_code, label, kind, is_default,
          source_type, source_format, body_vtt, search_text, sha256, cue_count,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        content.id,
        req.workspaceId,
        languageCode,
        label,
        kind,
        isDefault ? 1 : 0,
        normalized.source_format,
        normalized.body,
        normalized.search_text,
        sha256,
        normalized.cue_count,
        req.user.id,
        now,
        now,
      );
      return db.prepare('SELECT * FROM content_captions WHERE id=?').get(id);
    });
    const row = insert();
    auditCaption(req, 'content.caption.upload', content.id, id, {
      language_code: languageCode,
      source_format: normalized.source_format,
      cue_count: normalized.cue_count,
      sha256,
    });
    req.app.get('io')?.of('/dashboard').to(`workspace:${req.workspaceId}`)
      .emit('content-updated', {
        content_id: content.id,
        caption_id: id,
        reason: 'caption_uploaded',
      });
    return res.status(201).json({ caption: publicCaption(row) });
  },
);

router.put('/:captionId/default', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM content_captions WHERE id=?',
  ).get(String(req.params.captionId || ''));
  if (!row) return res.status(404).json({ error: 'Caption not found' });
  const content = requireEditableContent(req, res, row.content_id);
  if (!content) return undefined;
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare('UPDATE content_captions SET is_default=0, updated_at=? WHERE content_id=?')
      .run(now, content.id);
    db.prepare('UPDATE content_captions SET is_default=1, updated_at=? WHERE id=?')
      .run(now, row.id);
  })();
  auditCaption(req, 'content.caption.set_default', content.id, row.id);
  return res.json({
    caption: publicCaption(db.prepare('SELECT * FROM content_captions WHERE id=?').get(row.id)),
  });
});

router.delete('/:captionId', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM content_captions WHERE id=?',
  ).get(String(req.params.captionId || ''));
  if (!row) return res.status(404).json({ error: 'Caption not found' });
  const content = requireEditableContent(req, res, row.content_id);
  if (!content) return undefined;
  db.prepare('DELETE FROM content_captions WHERE id=?').run(row.id);
  auditCaption(req, 'content.caption.delete', content.id, row.id, {
    language_code: row.language_code,
  });
  return res.json({ deleted: true, id: row.id });
});

function publicCaptionFile(req, res) {
  const row = db.prepare(`
    SELECT cc.*, c.workspace_id AS content_workspace_id, c.access_level,
           c.archived_at, c.user_id
    FROM content_captions cc
    JOIN content c ON c.id=cc.content_id
    WHERE cc.id=?
  `).get(String(req.params.captionId || ''));
  if (!row) return res.status(404).json({ error: 'Caption not found' });
  if (row.archived_at != null) return res.status(410).json({ error: 'Content is archived' });
  const content = {
    id: row.content_id,
    workspace_id: row.content_workspace_id,
    access_level: row.access_level,
    archived_at: row.archived_at,
    user_id: row.user_id,
  };
  const nodeAuthorized = nodeRegistry.nodeHttpAuthOk(req)
    && nodeRegistry.nodeCanAccessContent(db, content);
  if (!nodeAuthorized && !canServePublicContent(db, content)) {
    return res.status(403).json({ error: 'Caption asset authorization required' });
  }
  const etag = `"caption-${row.sha256 || crypto.createHash('sha256').update(row.body_vtt).digest('hex')}"`;
  res.set({
    'Content-Type': 'text/vtt; charset=utf-8',
    'Content-Disposition': `inline; filename="${String(row.label || 'captions').replace(/[^\w.-]+/g, '_')}.vtt"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=300, must-revalidate',
    ETag: etag,
  });
  if (String(req.headers['if-none-match'] || '') === etag) return res.status(304).end();
  return res.send(row.body_vtt);
}

module.exports = {
  publicCaptionFile,
  router,
};
