'use strict';

const { ELEVATED_ROLES } = require('../middleware/auth');

function parseSnapshot(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function snapshotReferencesContent(value, contentId) {
  if (Array.isArray(value)) return value.some((entry) => snapshotReferencesContent(entry, contentId));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => (
    (key === 'content_id' || key === 'contentId') && String(entry) === String(contentId)
  ) || snapshotReferencesContent(entry, contentId));
}

function authenticatedPresentationAccess(db, presentation, user) {
  if (!db || !presentation || !user || !presentation.workspace_id) return false;
  const workspace = db.prepare('SELECT organization_id FROM workspaces WHERE id=?').get(presentation.workspace_id);
  if (!workspace) return false;
  if (ELEVATED_ROLES.includes(user.role)) return true;
  const membership = db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?')
    .get(presentation.workspace_id, user.id);
  const organizationRole = workspace.organization_id
    ? db.prepare('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?')
      .get(workspace.organization_id, user.id)?.role
    : null;
  if (!membership && !['org_owner', 'org_admin'].includes(organizationRole)) return false;
  if (['org_owner', 'org_admin'].includes(organizationRole)) return true;
  return !presentation.user_id || presentation.user_id === user.id;
}

function deckForPlayer(db, presentationId, user = null) {
  const presentation = db.prepare(`SELECT id,workspace_id,user_id,title,deck_json,status,published_snapshot
    FROM presentations WHERE id=?`).get(presentationId);
  if (!presentation) return null;
  if (presentation.status === 'published') {
    const snapshot = parseSnapshot(presentation.published_snapshot);
    if (!snapshot) return null;
    return { presentation, deck: snapshot, public: true };
  }
  if (!authenticatedPresentationAccess(db, presentation, user)) return null;
  const working = parseSnapshot(presentation.deck_json);
  return working ? { presentation, deck: working, public: false } : null;
}

function presentationAssetAccess(db, contentId, user = null) {
  const presentations = db.prepare(`SELECT DISTINCT p.id,p.workspace_id,p.user_id,p.status,
      p.published_snapshot
    FROM presentations p
    JOIN presentation_assets pa ON pa.presentation_id=p.id
    WHERE pa.content_id=?`).all(contentId);
  for (const presentation of presentations) {
    if (presentation.status === 'published') {
      const snapshot = parseSnapshot(presentation.published_snapshot);
      if (snapshot && snapshotReferencesContent(snapshot, contentId)) return { allowed: true, public: true };
    }
    if (authenticatedPresentationAccess(db, presentation, user)) return { allowed: true, public: false };
  }
  return { allowed: false, public: false };
}

function canServePresentationAsset(db, contentId, user = null) {
  return presentationAssetAccess(db, contentId, user).allowed;
}

module.exports = {
  authenticatedPresentationAccess,
  canServePresentationAsset,
  deckForPlayer,
  parseSnapshot,
  presentationAssetAccess,
  snapshotReferencesContent,
};
