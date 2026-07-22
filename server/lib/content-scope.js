// Generic owner scope for tables such as folders and presentations that do not
// have an access_level column.
function ownedContentScope(workspaceId, userId) {
  return { clause: '((workspace_id = ? AND user_id = ?) OR workspace_id IS NULL)', params: [workspaceId, userId] };
}

// Content-library scope with explicit sharing semantics. PeerTube privacy is
// intentionally not consulted here: it controls the upstream media object,
// while access_level controls who sees the Media Control library row.
function libraryContentScope(workspaceId, userId) {
  return {
    clause: `(
      (workspace_id = ? AND (
        user_id = ?
        OR access_level IN ('workspace','workspace_shared')
      ))
      OR (
        access_level IN ('organization','organization_shared')
        AND workspace_id IN (
          SELECT id FROM workspaces
          WHERE organization_id = (SELECT organization_id FROM workspaces WHERE id = ?)
        )
      )
      OR workspace_id IS NULL
    )`,
    params: [workspaceId, userId, workspaceId],
  };
}
module.exports = { ownedContentScope, libraryContentScope };
