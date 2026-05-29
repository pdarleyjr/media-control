// Phase 3: Fast Broadcast.
//
// POST /api/broadcast — send one content / remote URL / playlist to a selection
// of displays in ~2 taps, reusing the existing device-content-push path
// (services/scene-engine.pushSourceToDevice -> commandQueue device:playlist-update).
//
// Confirmation gate: if the target set equals ALL devices in the caller's
// workspace AND confirm_all !== true, respond 409 { code:'CONFIRM_ALL_REQUIRED',
// count } so the UI can show a "you're about to take over every display"
// confirmation before re-submitting with confirm_all:true.
//
// Mounted with requireAuth + resolveTenancy (server.js). Writes deny
// workspace_viewer (mirrors playlists.js / scenes.js).

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const sceneEngine = require('../services/scene-engine');
const { logActivity, getClientIp } = require('../services/activity');

router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const {
    device_ids, content_id, remote_url, playlist_id, fit_mode, confirm_all,
  } = req.body || {};

  // Validate the target selection.
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids must be a non-empty array' });
  }

  // Validate at least one source.
  if (!content_id && !remote_url && !playlist_id) {
    return res.status(400).json({ error: 'one of content_id, remote_url, or playlist_id is required' });
  }

  // De-dupe and confirm every target device is in this workspace.
  const requested = [...new Set(device_ids.map(String))];
  const targets = [];
  for (const id of requested) {
    const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: `Device ${id} not found` });
    if (device.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: `Device ${id} is not in this workspace` });
    }
    targets.push(id);
  }

  // Confirmation gate when targeting ALL displays in the workspace.
  const totalInWorkspace = db.prepare(
    'SELECT COUNT(*) AS c FROM devices WHERE workspace_id = ?'
  ).get(req.workspaceId).c;
  const targetingAll = totalInWorkspace > 0 && targets.length === totalInWorkspace;
  if (targetingAll && confirm_all !== true) {
    return res.status(409).json({ code: 'CONFIRM_ALL_REQUIRED', count: totalInWorkspace });
  }

  const source = { content_id, remote_url, playlist_id, fit_mode };
  const io = req.app.get('io');

  let sent = 0;
  const failed = [];
  for (const deviceId of targets) {
    const ok = sceneEngine.pushSourceToDevice(io, deviceId, source, {
      workspaceId: req.workspaceId,
      userId: req.user.id,
    });
    if (ok) sent++; else failed.push(deviceId);
  }

  // Log the broadcast (activityLogger middleware only captures a single
  // device_id; broadcasts touch many, so log an explicit summary here).
  try {
    const sourceLabel = playlist_id ? `playlist:${playlist_id}`
      : content_id ? `content:${content_id}`
      : `url:${remote_url}`;
    logActivity(
      req.user.id,
      'POST /api/broadcast',
      `broadcast ${sourceLabel} to ${sent}/${targets.length} display(s)${targetingAll ? ' (ALL)' : ''}`,
      null,
      getClientIp(req),
      req.workspaceId
    );
  } catch (e) { /* logging best-effort */ }

  res.json({ success: true, sent, failed, total: targets.length });
});

module.exports = router;
