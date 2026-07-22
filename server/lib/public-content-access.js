// Public display access guard for content assets.
//
// /player and /api/content/:id/file are reachable by unattended displays, so a
// content UUID must only serve when the item is actually part of a published
// display payload. Multiview grids store nested cell URLs inside a generated
// text/html content row; this helper recognizes those dependencies too.

const MV = require('../player/multiview-core');

function cellUrlReferencesContent(url, contentId) {
  const u = String(url || '');
  const patterns = [
    /\/api\/content\/([^/?#]+)\/(?:file|thumbnail)(?:[?#].*)?$/,
    /\/player\/(?:doc|doc-pdf)\/([^/?#]+)(?:[?#].*)?$/,
  ];
  for (const re of patterns) {
    const match = u.match(re);
    if (!match) continue;
    try {
      if (decodeURIComponent(match[1]) === contentId) return true;
    } catch (_) {
      if (match[1] === contentId) return true;
    }
  }
  return false;
}

function gridUrlReferencesContent(remoteUrl, contentId) {
  try {
    const u = new URL(String(remoteUrl || ''), 'https://media-control.local');
    if (!/\/player\/grid\.html$/i.test(u.pathname)) return false;
    const cells = MV.decodeCells(u.searchParams.get('cells'));
    for (const id of Object.keys(cells)) {
      if (cellUrlReferencesContent(cells[id] && cells[id].u, contentId)) return true;
    }
  } catch (_) { /* invalid URL -> no dependency */ }
  return false;
}

function safeAll(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function assignedWorkspaceIds(db, contentId) {
  const ids = new Set();
  const add = (rows) => rows.forEach((row) => { if (row.workspace_id) ids.add(row.workspace_id); });
  add(safeAll(db, `SELECT DISTINCT p.workspace_id FROM playlist_items pi
    JOIN playlists p ON p.id = pi.playlist_id WHERE pi.content_id = ?`, contentId));
  add(safeAll(db, `SELECT DISTINCT d.workspace_id FROM assignments a
    JOIN devices d ON d.id = a.device_id WHERE a.content_id = ?`, contentId));
  add(safeAll(db, 'SELECT DISTINCT workspace_id FROM schedules WHERE content_id = ?', contentId));
  add(safeAll(db, 'SELECT DISTINCT workspace_id FROM video_walls WHERE content_id = ?', contentId));
  add(safeAll(db, 'SELECT DISTINCT workspace_id FROM devices WHERE default_content_id = ?', contentId));
  add(safeAll(db, `SELECT DISTINCT oa.workspace_id FROM activity_asset_placements aap
    JOIN operational_activities oa ON oa.id = aap.activity_id WHERE aap.content_id = ?`, contentId));
  add(safeAll(db, `SELECT DISTINCT ace.workspace_id FROM advanced_canvas_layers acl
    JOIN advanced_canvas_endpoints ace ON ace.id = acl.endpoint_id
    WHERE acl.source_json LIKE ?`, `%"content_id":"${contentId}"%`));
  add(safeAll(db, 'SELECT DISTINCT workspace_id FROM widgets WHERE config LIKE ?', `%/api/content/${contentId}/%`));
  return [...ids];
}

function visibilityAllowsWorkspace(db, content, workspaceId) {
  if (!content || !workspaceId || content.archived_at != null) return false;
  const visibility = String(content.access_level || 'private');
  if (visibility === 'private' || visibility === 'workspace_shared') {
    return content.workspace_id === workspaceId;
  }
  if (visibility === 'platform_template') {
    return !!db.prepare(`SELECT 1 FROM content_template_assignments
      WHERE content_id = ? AND workspace_id = ?`).get(content.id, workspaceId);
  }
  if (visibility === 'organization_shared') {
    const row = db.prepare(`SELECT source.organization_id AS source_org, target.organization_id AS target_org
      FROM workspaces source CROSS JOIN workspaces target
      WHERE source.id = ? AND target.id = ?`).get(content.workspace_id, workspaceId);
    return !!row && row.source_org === row.target_org;
  }
  return false;
}

function canServeContentInWorkspace(db, content, workspaceId) {
  return visibilityAllowsWorkspace(db, content, workspaceId)
    && assignedWorkspaceIds(db, content.id).includes(workspaceId);
}

function isDirectlyAssigned(db, content) {
  if (!content) return false;
  return assignedWorkspaceIds(db, content.id)
    .some((workspaceId) => visibilityAllowsWorkspace(db, content, workspaceId));
}

function isGridDependency(db, content) {
  if (!content?.id || content.archived_at != null) return false;

  // Some public player routes intentionally select only the columns they need
  // to render. Always authorize the nested asset against its canonical policy
  // row rather than treating a missing access_level as private by accident.
  let nestedContent = content;
  try {
    const canonical = db.prepare(`SELECT id, workspace_id, access_level, archived_at
      FROM content WHERE id = ?`).get(content.id);
    if (canonical) nestedContent = { ...content, ...canonical };
  } catch (_) { /* minimal test adapters may already provide the policy row */ }
  if (nestedContent.archived_at != null) return false;

  const grids = safeAll(db, `
    SELECT id, workspace_id, access_level, archived_at, remote_url
    FROM content
    WHERE remote_url LIKE '%/player/grid.html%cells=%'
  `);
  for (const grid of grids) {
    if (!gridUrlReferencesContent(grid.remote_url, nestedContent.id)) continue;

    // A stored grid is not a publication boundary by itself. It must be routed
    // to a destination workspace, and both the grid and every nested asset must
    // independently be visible there. This permits organization/template reuse
    // while preventing a cross-scope grid URL from laundering private content.
    const destinations = assignedWorkspaceIds(db, grid.id);
    if (destinations.some((workspaceId) => (
      visibilityAllowsWorkspace(db, grid, workspaceId)
      && visibilityAllowsWorkspace(db, nestedContent, workspaceId)
    ))) return true;
  }
  return false;
}

function canServePublicContent(db, content) {
  if (!content || content.archived_at != null) return false;
  return isDirectlyAssigned(db, content) || isGridDependency(db, content);
}

module.exports = {
  canServePublicContent,
  canServeContentInWorkspace,
  assignedWorkspaceIds,
  visibilityAllowsWorkspace,
  cellUrlReferencesContent,
  gridUrlReferencesContent,
  isDirectlyAssigned,
  isGridDependency,
};
