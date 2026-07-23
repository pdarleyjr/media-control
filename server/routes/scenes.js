// Phase 3: Operational Activities ("Scenes") REST API.
//
// A scene is a named snapshot of which content/playlist shows on which display.
// One POST /:id/trigger pushes the scene to all its displays using the existing
// device-content-push path (see services/scene-engine.js).
//
// Mounted with requireAuth + resolveTenancy (server.js), so req.workspaceId,
// req.workspaceRole, req.actingAs are populated. All queries are scoped by
// workspace_id. Write operations deny workspace_viewer (mirrors playlists.js).

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { getBroadcastDeliveryStore } = require('../lib/broadcast-delivery');
const broadcastDelivery = getBroadcastDeliveryStore(db);
const sceneEngine = require('../services/scene-engine');
const { contentUseDecision, contextFromRequest } = require('../lib/content-visibility');
const { checkRemoteUrlShape } = require('../lib/ssrf-policy');

// Deny writes for read-only members. Returns true if the caller may write in
// the current workspace, else sends 403 and returns false. Mirrors the inline
// viewer-deny gate used by routes/playlists.js POST /.
function requireWorkspaceWrite(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return false;
  }
  return true;
}

// Load a scene scoped to the caller's workspace, or send 404. Returns the row.
function loadScene(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return null; }
  const scene = db.prepare(
    'SELECT * FROM operational_activities WHERE id = ? AND workspace_id = ?'
  ).get(req.params.id, req.workspaceId);
  if (!scene) { res.status(404).json({ error: 'Scene not found' }); return null; }
  return scene;
}

// Validate one placement object from the PUT /:id/placements array. Returns a
// normalized row (without id/activity_id) or throws with a message.
const VALID_FIT_MODES = ['cover', 'contain', 'fill', 'none', 'scale-down'];
function normalizePlacement(p, index) {
  if (!p || typeof p !== 'object') throw new Error(`placement[${index}] must be an object`);
  const hasSource = p.content_id || p.remote_url || p.playlist_id;
  if (!hasSource) throw new Error(`placement[${index}] requires content_id, remote_url, or playlist_id`);
  // SSRF gate: a stored remote_url is later pushed to displays on scene trigger.
  // Reject internal targets at save time (centralized policy; literal-host check).
  if (p.remote_url) {
    const r = checkRemoteUrlShape(p.remote_url);
    if (!r.ok) throw new Error(`placement[${index}] ${r.error}`);
  }
  let fit = p.fit_mode;
  if (fit !== undefined && fit !== null && fit !== '') {
    if (typeof fit !== 'string' || !VALID_FIT_MODES.includes(fit.toLowerCase())) {
      throw new Error(`placement[${index}] has invalid fit_mode`);
    }
    fit = fit.toLowerCase();
  } else {
    fit = 'contain';
  }
  return {
    device_id: p.device_id || null,
    wall_id: p.wall_id || null,
    content_id: p.content_id || null,
    remote_url: p.remote_url || null,
    playlist_id: p.playlist_id || null,
    fit_mode: fit,
    rotation: p.rotation != null ? String(p.rotation) : '0',
    sort_order: Number.isInteger(p.sort_order) ? p.sort_order : index,
    custom_properties_json: p.custom_properties_json != null ? String(p.custom_properties_json) : null,
  };
}

// GET / — list scenes in the caller's workspace (with placement counts).
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const scenes = db.prepare(`
    SELECT oa.*, COUNT(p.id) AS placement_count
    FROM operational_activities oa
    LEFT JOIN activity_asset_placements p ON p.activity_id = oa.id
    WHERE oa.workspace_id = ?
    GROUP BY oa.id
    ORDER BY oa.name ASC
  `).all(req.workspaceId);
  res.json(scenes);
});

// POST / — create a scene { name, description }.
router.post('/', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const { name, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO operational_activities (id, workspace_id, name, description, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.workspaceId, String(name).trim(), (description || '').trim() || null, req.user.id, now, now);
  res.status(201).json(db.prepare('SELECT * FROM operational_activities WHERE id = ?').get(id));
});

// GET /:id — single scene.
router.get('/:id', (req, res) => {
  const scene = loadScene(req, res);
  if (!scene) return;
  const placement_count = db.prepare(
    'SELECT COUNT(*) AS c FROM activity_asset_placements WHERE activity_id = ?'
  ).get(scene.id).c;
  res.json({ ...scene, placement_count });
});

// PUT /:id — update { name?, description? }.
router.put('/:id', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const scene = loadScene(req, res);
  if (!scene) return;
  const { name, description } = req.body || {};
  const updates = [];
  const values = [];
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?'); values.push(String(name).trim());
  }
  if (description !== undefined) {
    updates.push('description = ?'); values.push((description || '').trim() || null);
  }
  if (updates.length > 0) {
    updates.push('updated_at = ?'); values.push(Math.floor(Date.now() / 1000));
    values.push(scene.id);
    db.prepare(`UPDATE operational_activities SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(db.prepare('SELECT * FROM operational_activities WHERE id = ?').get(scene.id));
});

// DELETE /:id — placements cascade via FK.
router.delete('/:id', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const scene = loadScene(req, res);
  if (!scene) return;
  db.prepare('DELETE FROM operational_activities WHERE id = ?').run(scene.id);
  res.json({ success: true });
});

// GET /:id/placements — list placements for a scene.
router.get('/:id/placements', (req, res) => {
  const scene = loadScene(req, res);
  if (!scene) return;
  const placements = db.prepare(
    'SELECT * FROM activity_asset_placements WHERE activity_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(scene.id);
  res.json(placements);
});

// PUT /:id/placements — replace the full placement array.
router.put('/:id/placements', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const scene = loadScene(req, res);
  if (!scene) return;
  const { placements } = req.body || {};
  if (!Array.isArray(placements)) {
    return res.status(400).json({ error: 'placements must be an array' });
  }

  let normalized;
  try {
    normalized = placements.map((p, i) => normalizePlacement(p, i));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Tenancy guard: every referenced device must be in this workspace.
  for (const p of normalized) {
    if (p.device_id) {
      const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(p.device_id);
      if (!device) return res.status(404).json({ error: `Device ${p.device_id} not found` });
      if (device.workspace_id !== req.workspaceId) {
        return res.status(403).json({ error: `Device ${p.device_id} is not in this workspace` });
      }
    }
    if (p.content_id) {
      const decision = contentUseDecision(db, p.content_id, req.workspaceId, contextFromRequest(req));
      if (!decision.content) return res.status(404).json({ error: `Content ${p.content_id} not found` });
      if (!decision.allowed) return res.status(403).json({ error: decision.reason });
    }
    if (p.playlist_id) {
      const playlist = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(p.playlist_id);
      if (!playlist) return res.status(404).json({ error: `Playlist ${p.playlist_id} not found` });
      if (playlist.workspace_id !== req.workspaceId) {
        return res.status(403).json({ error: `Playlist ${p.playlist_id} is not in this workspace` });
      }
      const items = db.prepare(`SELECT DISTINCT content_id FROM playlist_items
        WHERE playlist_id = ? AND content_id IS NOT NULL`).all(p.playlist_id);
      if (items.some((item) => !contentUseDecision(
        db,
        item.content_id,
        req.workspaceId,
        contextFromRequest(req),
      ).allowed)) {
        return res.status(403).json({ error: `Playlist ${p.playlist_id} contains unavailable content` });
      }
    }
  }

  const insert = db.prepare(`
    INSERT INTO activity_asset_placements
      (id, activity_id, device_id, wall_id, content_id, remote_url, playlist_id, fit_mode, rotation, sort_order, custom_properties_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM activity_asset_placements WHERE activity_id = ?').run(scene.id);
    for (const p of normalized) {
      insert.run(uuidv4(), scene.id, p.device_id, p.wall_id, p.content_id, p.remote_url,
        p.playlist_id, p.fit_mode, p.rotation, p.sort_order, p.custom_properties_json);
    }
    db.prepare('UPDATE operational_activities SET updated_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), scene.id);
  });
  tx();

  const saved = db.prepare(
    'SELECT * FROM activity_asset_placements WHERE activity_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(scene.id);
  res.json(saved);
});

// POST /:id/trigger — push the scene to all its displays via scene-engine.
router.post('/:id/trigger', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const scene = loadScene(req, res);
  if (!scene) return;
  const resolved = sceneEngine.resolveSceneActions(scene.id);
  if (!resolved || resolved.actions.length === 0) {
    return res.status(409).json({ error: 'Scene has no valid physical display targets' });
  }
  const io = req.app.get('io');
  const targetIds = resolved.actions.map((action) => action.deviceId);
  const deliveryRequest = broadcastDelivery.createRequest({
    workspaceId: req.workspaceId,
    userId: req.user.id,
    sourceType: 'scene',
    sourceId: scene.id,
    typedTargets: resolved.typedTargets,
    expectedTargetCount: targetIds.length,
    targets: resolved.actions.map((action) => ({
      deviceId: action.deviceId,
      expectedSourceId: action.source.content_id || null,
    })),
  });
  const deliveryByDevice = new Map(
    deliveryRequest.devices.map((entry) => [entry.device_id, entry])
  );
  let pushed = 0;
  let failed = 0;
  for (const action of resolved.actions) {
    const delivery = deliveryByDevice.get(action.deviceId);
    const result = sceneEngine.pushSourceToDevice(io, action.deviceId, action.source, {
      workspaceId: req.workspaceId,
      userId: req.user.id,
      contentContext: contextFromRequest(req),
      targetDeviceIds: action.scopeDeviceIds,
      delivery: {
        requestId: deliveryRequest.id,
        commandId: delivery.command_id,
        sourceId: scene.id,
        sourceType: 'scene',
        expectedSourceId: action.source.content_id || null,
      },
      returnDetails: true,
    });
    broadcastDelivery.markDispatched({
      requestId: deliveryRequest.id,
      deviceId: action.deviceId,
      commandId: delivery.command_id,
      delivered: result.delivered,
      queued: result.queued,
      playlistRevision: result.playlistRevision,
      expectedSourceId: result.expectedSourceId,
      failureReason: result.failureReason,
    });
    if (result.ok) pushed++; else failed++;
  }
  res.status(202).json({
    accepted: true,
    success: true,
    activityId: scene.id,
    pushed,
    failed,
    total: targetIds.length,
    request_id: deliveryRequest.id,
    status_url: `/api/broadcast/${encodeURIComponent(deliveryRequest.id)}`,
    delivery: broadcastDelivery.getRequest(deliveryRequest.id, req.workspaceId),
  });
});

// POST /capture — snapshot the current state of { device_ids } into a new scene.
router.post('/capture', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const { name, device_ids } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids must be a non-empty array' });
  }
  const scene = sceneEngine.captureCurrent(req.workspaceId, req.user.id, String(name).trim(), device_ids);
  if (!scene) return res.status(500).json({ error: 'Failed to capture scene' });
  const placement_count = db.prepare(
    'SELECT COUNT(*) AS c FROM activity_asset_placements WHERE activity_id = ?'
  ).get(scene.id).c;
  res.status(201).json({ ...scene, placement_count });
});

module.exports = router;
