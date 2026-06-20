const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { assertRemoteUrlSafe } = require('../lib/ssrf-policy');
const { audit } = require('../lib/audit');
const { getClientIp } = require('../services/activity');
const config = require('../config');
const {
  generateEndpointToken,
  getEndpoint,
  hashToken,
  normalizeSceneLayers,
} = require('../lib/advanced-canvas');

const router = express.Router();

function canWrite(req, res) {
  if (!req.workspaceId) {
    res.status(400).json({ error: 'No active workspace' });
    return false;
  }
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' });
    return false;
  }
  return true;
}

function findOwnedEndpoint(req, res) {
  const endpoint = db.prepare(
    'SELECT * FROM advanced_canvas_endpoints WHERE id = ? AND workspace_id = ?'
  ).get(String(req.params.id), req.workspaceId);
  if (!endpoint) {
    res.status(404).json({ error: 'Advanced canvas endpoint not found' });
    return null;
  }
  return endpoint;
}

function auditCanvas(req, endpoint, action, details = {}) {
  audit({
    actorType: 'user',
    actorId: req.user && req.user.id,
    action,
    targetType: 'advanced_canvas',
    targetId: endpoint.id,
    workspaceId: req.workspaceId,
    sourceIp: getClientIp(req),
    details,
  });
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json({ endpoints: [] });
  const rows = db.prepare(`
    SELECT id FROM advanced_canvas_endpoints
    WHERE workspace_id = ?
    ORDER BY name COLLATE NOCASE
  `).all(req.workspaceId);
  res.json({ endpoints: rows.map((row) => getEndpoint(row.id)) });
});

router.post('/', (req, res) => {
  if (!canWrite(req, res)) return;
  const name = String(req.body && req.body.name || 'Advanced Canvas').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const endpointId = uuidv4();
  const token = generateEndpointToken();
  db.prepare(`
    INSERT INTO advanced_canvas_endpoints
      (id, workspace_id, name, token_hash, canvas_width, canvas_height)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    endpointId,
    req.workspaceId,
    name,
    hashToken(token),
    Math.max(1, Math.min(32768, Number(req.body && req.body.canvas_width) || 6400)),
    Math.max(1, Math.min(32768, Number(req.body && req.body.canvas_height) || 720))
  );
  res.status(201).json({ endpoint: getEndpoint(endpointId), endpoint_token: token });
});

router.get('/:id', (req, res) => {
  const endpoint = findOwnedEndpoint(req, res);
  if (!endpoint) return;
  res.json({ endpoint: getEndpoint(endpoint.id) });
});

router.put('/:id/scene', async (req, res) => {
  if (!canWrite(req, res)) return;
  const endpoint = findOwnedEndpoint(req, res);
  if (!endpoint) return;
  const publicBase = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  let layers;
  try {
    layers = await normalizeSceneLayers({
      layers: req.body && req.body.layers,
      workspaceId: req.workspaceId,
      canvasWidth: endpoint.canvas_width || 1920,
      canvasHeight: endpoint.canvas_height || 1080,
      publicBase,
      endpointId: endpoint.id,
      canvasAssetSecret: config.jwtSecret,
      assertRemoteUrlSafe,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const replaceScene = db.transaction(() => {
    db.prepare('DELETE FROM advanced_canvas_layers WHERE endpoint_id = ?').run(endpoint.id);
    const insert = db.prepare(`
      INSERT INTO advanced_canvas_layers
        (id, endpoint_id, x, y, width, height, z_index, label, source_json,
         render_json, fit_mode, muted, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `);
    for (const layer of layers) {
      insert.run(
        layer.id,
        endpoint.id,
        layer.x,
        layer.y,
        layer.width,
        layer.height,
        layer.z_index,
        layer.label,
        JSON.stringify(layer.source),
        JSON.stringify(layer.render),
        layer.fit_mode,
        layer.muted ? 1 : 0
      );
    }
    db.prepare(`
      UPDATE advanced_canvas_endpoints
      SET active = ?, scene_revision = scene_revision + 1,
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(layers.length ? 1 : 0, endpoint.id);
  });
  replaceScene();

  const scene = getEndpoint(endpoint.id);
  auditCanvas(req, endpoint, 'advanced_canvas.publish', {
    scene_revision: scene.scene_revision,
    layer_count: scene.layers.length,
    active: scene.active,
  });
  req.app.get('io').of('/canvas').to(endpoint.id).emit('canvas:scene', scene);
  res.json({ endpoint: scene });
});

router.post('/:id/active', (req, res) => {
  if (!canWrite(req, res)) return;
  const endpoint = findOwnedEndpoint(req, res);
  if (!endpoint) return;
  const active = req.body && req.body.active === true;
  db.prepare(`
    UPDATE advanced_canvas_endpoints
    SET active = ?, scene_revision = scene_revision + 1,
        updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(active ? 1 : 0, endpoint.id);
  const scene = getEndpoint(endpoint.id);
  auditCanvas(req, endpoint, active ? 'advanced_canvas.unblank' : 'advanced_canvas.blank', {
    scene_revision: scene.scene_revision,
    layer_count: scene.layers.length,
  });
  req.app.get('io').of('/canvas').to(endpoint.id).emit('canvas:scene', scene);
  res.json({ endpoint: scene });
});

router.post('/:id/clear', (req, res) => {
  if (!canWrite(req, res)) return;
  const endpoint = findOwnedEndpoint(req, res);
  if (!endpoint) return;
  const clear = db.transaction(() => {
    db.prepare('DELETE FROM advanced_canvas_layers WHERE endpoint_id = ?').run(endpoint.id);
    db.prepare(`
      UPDATE advanced_canvas_endpoints
      SET active = 0, scene_revision = scene_revision + 1,
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(endpoint.id);
  });
  clear();
  const scene = getEndpoint(endpoint.id);
  auditCanvas(req, endpoint, 'advanced_canvas.clear', {
    scene_revision: scene.scene_revision,
    layer_count: 0,
  });
  req.app.get('io').of('/canvas').to(endpoint.id).emit('canvas:scene', scene);
  res.json({ endpoint: scene });
});

router.post('/:id/rotate-token', (req, res) => {
  if (!canWrite(req, res)) return;
  const endpoint = findOwnedEndpoint(req, res);
  if (!endpoint) return;
  const token = generateEndpointToken();
  db.prepare(`
    UPDATE advanced_canvas_endpoints
    SET token_hash = ?, updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(hashToken(token), endpoint.id);
  res.json({ endpoint_id: endpoint.id, endpoint_token: token });
});

module.exports = router;
