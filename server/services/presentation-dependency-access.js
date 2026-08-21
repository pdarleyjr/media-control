'use strict';

const { contentUseDecision } = require('../lib/content-visibility');

function presentationDependencyDecision(db, presentation, contentId, workspaceId, ctx = {}) {
  const content = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
  if (!content) return { allowed: false, content: null, reason: 'missing' };
  if (content.library_scope !== 'internal') {
    return contentUseDecision(db, contentId, workspaceId, ctx);
  }
  const linked = db.prepare(`SELECT 1 FROM presentation_assets
    WHERE presentation_id=? AND content_id=? LIMIT 1`).get(presentation?.id, contentId);
  const allowed = Boolean(
    presentation?.id
    && presentation.workspace_id === workspaceId
    && content.workspace_id === workspaceId
    && linked,
  );
  return { allowed, content, reason: allowed ? null : 'not_linked_to_presentation' };
}

module.exports = { presentationDependencyDecision };
