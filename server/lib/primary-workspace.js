// Resolve the workspace a user's session should bind to.
//
// MBFD runs ONE shared room. Displays/walls/layouts/scenes are workspace-scoped,
// so for every member to see and control the SAME displays, every individual
// login must resolve to the SAME (shared) workspace. Content/presentations/
// playlists stay per-user (filtered by workspace_id AND user_id; Nextcloud is
// per-user/email). This is the "shared displays / per-user files" model.
//
// HISTORY (important — a previous agent built most of this):
//   • A one-shot deploy script, scripts/share-workspace-migration.js, already
//     added every EXISTING user to the shared workspace (Peter's, the one that
//     owns the displays) with joined_at = 1, so that workspace sorts FIRST in the
//     "oldest membership" resolver and becomes every member's default at login.
//   • The remaining gap was the FALLBACK: a brand-new login created AFTER that
//     one-shot migration had no membership yet, so the old code minted a PRIVATE
//     workspace for them — they missed the shared room.
//
// This resolver closes that gap with the SMALLEST possible change and without
// fighting the migration:
//   1. If the user already has a membership, keep the prior resolution (their
//      oldest membership — the migration's joined_at = 1 makes that the shared
//      workspace). Behaviour for existing members is UNCHANGED.
//   2. If the user has NO membership (a future login), JOIN the primary (oldest)
//      workspace instead of minting a private one.
//   3. Only on a truly empty install (zero workspaces) do we bootstrap the first
//      org + Default workspace (the first user owns it).
//
// PURELY ADDITIVE: it only ever INSERTs a membership row (or bootstraps a fresh
// install). It NEVER deletes a workspace, membership, or device — existing paired
// displays are always preserved.
const { v4: uuidv4 } = require('uuid');

/**
 * Ensure `user` resolves to the shared workspace and return its id.
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string,email:string,name?:string,plan_id?:string}} user
 * @returns {string} the workspace id to embed in the JWT
 */
function ensurePrimaryWorkspaceMembership(db, user) {
  // 1. Existing member → keep the prior resolution (oldest membership; the
  //    share-workspace migration set joined_at = 1 on the shared workspace so it
  //    sorts first). Tiebreak on the workspace's own age for determinism.
  const existing = db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC, w.created_at ASC, w.rowid ASC
    LIMIT 1
  `).get(user.id);
  if (existing) return existing.id;

  // 2. No membership yet (a new login after the one-shot migration) → join the
  //    PRIMARY (oldest) workspace, the shared room that owns the displays.
  //    workspace_editor = can control displays + broadcast (not read-only).
  const primary = db.prepare(
    'SELECT id FROM workspaces ORDER BY created_at ASC, rowid ASC LIMIT 1'
  ).get();
  if (primary) {
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')`
    ).run(primary.id, user.id);
    return primary.id;
  }

  // 3. Bootstrap ONLY: a fresh install with zero workspaces. The first user owns
  //    the primary org + Default workspace that everyone else then joins.
  const orgId = uuidv4();
  const wsId = uuidv4();
  const orgName = (user.name && user.name.trim())
    ? `${user.name}'s organization`
    : `${user.email}'s organization`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO organizations (id, name, owner_user_id, plan_id) VALUES (?, ?, ?, ?)`
    ).run(orgId, orgName, user.id, user.plan_id || 'enterprise');
    db.prepare(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`
    ).run(orgId, user.id);
    db.prepare(
      `INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`
    ).run(wsId, orgId, user.id);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`
    ).run(wsId, user.id);
  });
  tx();
  return wsId;
}

module.exports = { ensurePrimaryWorkspaceMembership };
