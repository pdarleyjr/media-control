'use strict';

const { contentUseDecision } = require('../lib/content-visibility');
const { PPTX_MIME } = require('./presentation-conversion-job');

function listPresentationSources(db, workspaceId, ctx = {}) {
  if (!workspaceId || !ctx.userId) return [];
  return db.prepare(`
    SELECT id, filename, mime_type
    FROM content
    WHERE workspace_id=? AND user_id=?
      AND library_scope='internal' AND content_type='presentation_source'
      AND mime_type=? AND LOWER(filename) LIKE '%.pptx'
      AND filepath IS NOT NULL AND TRIM(filepath) <> ''
      AND archived_at IS NULL
    ORDER BY filename COLLATE NOCASE, id
  `).all(workspaceId, ctx.userId, PPTX_MIME);
}

function presentationSourceDecision(db, contentId, workspaceId, ctx = {}) {
  const internal = db.prepare('SELECT * FROM content WHERE id=? AND library_scope=\'internal\'').get(contentId);
  if (!internal) return contentUseDecision(db, contentId, workspaceId, ctx);
  const allowed = internal.workspace_id === workspaceId
    && internal.user_id === ctx.userId
    && internal.content_type === 'presentation_source'
    && internal.mime_type === PPTX_MIME
    && /\.pptx$/i.test(String(internal.filename || ''))
    && Boolean(internal.filepath);
  return {
    allowed,
    reason: allowed ? null : 'Source is not available in this workspace',
    content: allowed ? internal : null,
  };
}

module.exports = { listPresentationSources, presentationSourceDecision };
