const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { nowPlayingFromSnapshot } = require('../lib/display-state');
const { mapDisplayRow } = require('../lib/display-row');
const config = require('../config');

// Deny writes for read-only members (mirrors scenes.js inline gate).
function requireWorkspaceWrite(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return false;
  }
  return true;
}

// GET /api/displays/state — authoritative "what is live where" for the stage.
// Resolves each workspace device's published_snapshot into a now-playing
// summary, plus online status, screen_on flag, geometry, and last screenshot.
router.get('/state', (req, res) => {
  if (!req.workspaceId) return res.json({ displays: [] });
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.screen_width, d.screen_height,
           d.screen_on, d.playlist_id, d.layout_id,
           p.published_snapshot AS snapshot,
           (SELECT s.captured_at FROM screenshots s WHERE s.device_id = d.id ORDER BY s.captured_at DESC LIMIT 1) AS shot_at
    FROM devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    WHERE d.workspace_id = ?
    ORDER BY d.name COLLATE NOCASE
    LIMIT 500
  `).all(req.workspaceId);

  const assetCache = config.localContentBaseUrl
    ? { mode: 'local', base_url: config.localContentBaseUrl }
    : { mode: 'direct' };
  const displays = rows.map(r => mapDisplayRow(r, nowPlayingFromSnapshot(r.snapshot), now, assetCache));
  res.json({ displays });
});

// GET /api/displays/selection — the per-user "what was I last controlling".
router.get('/selection', (req, res) => {
  if (!req.workspaceId) return res.json({ device_ids: [] });
  const row = db.prepare('SELECT selection_json FROM dashboard_state WHERE user_id = ? AND workspace_id = ?')
    .get(req.user.id, req.workspaceId);
  let ids = [];
  if (row) { try { ids = JSON.parse(row.selection_json) || []; } catch { ids = []; } }
  res.json({ device_ids: Array.isArray(ids) ? ids : [] });
});

// PUT /api/displays/selection { device_ids: [] } — persist the stage selection.
router.put('/selection', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const ids = Array.isArray(req.body && req.body.device_ids) ? req.body.device_ids.filter(x => typeof x === 'string') : [];
  db.prepare(`
    INSERT INTO dashboard_state (user_id, workspace_id, selection_json, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, workspace_id) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at
  `).run(req.user.id, req.workspaceId, JSON.stringify(ids));
  res.json({ device_ids: ids });
});

module.exports = router;
