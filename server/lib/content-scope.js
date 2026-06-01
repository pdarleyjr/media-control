// Returns { clause, params } scoping owned content to the caller while keeping
// platform templates (workspace_id IS NULL) visible to all.
function ownedContentScope(workspaceId, userId) {
  return { clause: '((workspace_id = ? AND user_id = ?) OR workspace_id IS NULL)', params: [workspaceId, userId] };
}
module.exports = { ownedContentScope };
