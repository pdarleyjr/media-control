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

function isDirectlyAssigned(db, content) {
  if (!content) return false;
  if (content.workspace_id) {
    const inPlaylist = db.prepare(
      `SELECT pi.id FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
       WHERE pi.content_id = ? AND p.workspace_id = ? LIMIT 1`
    ).get(content.id, content.workspace_id);
    if (inPlaylist) return true;
    return !!db.prepare('SELECT id FROM widgets WHERE workspace_id = ? AND config LIKE ? LIMIT 1')
      .get(content.workspace_id, `%/api/content/${content.id}/%`);
  }
  const inPlaylist = db.prepare('SELECT id FROM playlist_items WHERE content_id = ? LIMIT 1').get(content.id);
  if (inPlaylist) return true;
  return !!db.prepare('SELECT id FROM widgets WHERE config LIKE ? LIMIT 1')
    .get(`%/api/content/${content.id}/%`);
}

function isGridDependency(db, content) {
  if (!content) return false;
  const params = [];
  let sql = `
    SELECT DISTINCT grid.remote_url
    FROM content grid
    JOIN playlist_items pi ON pi.content_id = grid.id
    JOIN playlists p ON p.id = pi.playlist_id
    WHERE grid.remote_url LIKE '%/player/grid.html%cells=%'
  `;
  if (content.workspace_id) {
    sql += ' AND grid.workspace_id = ? AND p.workspace_id = ?';
    params.push(content.workspace_id, content.workspace_id);
  }
  sql += ' LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  return rows.some((r) => gridUrlReferencesContent(r.remote_url, content.id));
}

function canServePublicContent(db, content) {
  return isDirectlyAssigned(db, content) || isGridDependency(db, content);
}

module.exports = {
  canServePublicContent,
  cellUrlReferencesContent,
  gridUrlReferencesContent,
  isDirectlyAssigned,
  isGridDependency,
};
