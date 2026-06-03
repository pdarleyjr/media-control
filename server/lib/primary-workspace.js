// Resolve the workspace a user's session should bind to.
//
// MBFD runs ONE shared room. Displays are workspace-scoped, so for every member
// to see and control the SAME displays, every individual login must resolve to
// the SAME workspace — the PRIMARY (oldest) workspace, which owns the shared
// displays. Media stays per-user automatically (content is filtered by
// workspace_id AND user_id; Nextcloud is per-user/email).
//
// History: members were originally added to the shared workspace via the invite
// flow (routes/workspaces.js) and the MBFD Hub user-sync mirror (routes/admin-sync.js),
// while the per-user fallback minted a NEW private workspace for anyone without a
// membership — so future logins (and any stray personal workspace) missed the
// shared room. This single helper, used by BOTH onboarding paths, closes that gap.
//
// PURELY ADDITIVE: it only ever INSERTs a membership row (or, on a brand-new
// install, mints the first org+workspace). It NEVER deletes a workspace,
// membership, or device — existing paired displays are always preserved and
// simply become visible to every member.
const { v4: uuidv4 } = require('uuid');

/**
 * Ensure `user` is a member of the primary (shared) workspace and return its id.
 * On a fresh install (no workspaces yet) the first user bootstraps the primary
 * org + Default workspace as its admin.
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string,email:string,name?:string,plan_id?:string}} user
 * @returns {string} the primary workspace id to embed in the JWT
 */
function ensurePrimaryWorkspaceMembership(db, user) {
  const primary = db.prepare(
    'SELECT id FROM workspaces ORDER BY created_at ASC, rowid ASC LIMIT 1'
  ).get();

  if (primary) {
    const isMember = db.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(primary.id, user.id);
    if (!isMember) {
      // workspace_editor = can control displays + broadcast (not a read-only
      // workspace_viewer). Platform admins keep full access via their platform role.
      db.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')`
      ).run(primary.id, user.id);
    }
    return primary.id;
  }

  // Bootstrap ONLY: a fresh install with zero workspaces. The first user becomes
  // the owner/admin of the primary org + Default workspace everyone else joins.
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
