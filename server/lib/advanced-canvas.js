const crypto = require('crypto');
const { db } = require('../db/database');
const { deckPlayerUrl } = require('./deck-player-url');
const { canvasAssetUrl } = require('./canvas-asset-signature');

const MAX_LAYERS = 64;
const MAX_CANVAS_DIMENSION = 32768;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateEndpointToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeTopology(input) {
  const topology = input && typeof input === 'object' ? input : {};
  const outputs = Array.isArray(topology.outputs) ? topology.outputs.slice(0, 16) : [];
  const safeOutputs = outputs.map((output, index) => ({
    id: String(output.id || `output-${index + 1}`).slice(0, 128),
    slug: String(output.slug || `output-${index + 1}`).slice(0, 128),
    name: String(output.name || `Output ${index + 1}`).slice(0, 160),
    group: String(output.group || '').slice(0, 128),
    x: clampNumber(output.x, -MAX_CANVAS_DIMENSION, MAX_CANVAS_DIMENSION, 0),
    y: clampNumber(output.y, -MAX_CANVAS_DIMENSION, MAX_CANVAS_DIMENSION, 0),
    width: clampNumber(output.width, 1, MAX_CANVAS_DIMENSION, 1920),
    height: clampNumber(output.height, 1, MAX_CANVAS_DIMENSION, 1080),
    scale_factor: clampNumber(output.scale_factor, 0.25, 8, 1),
    rotation: clampNumber(output.rotation, 0, 359, 0),
  }));

  const minX = safeOutputs.length ? Math.min(...safeOutputs.map((output) => output.x)) : 0;
  const minY = safeOutputs.length ? Math.min(...safeOutputs.map((output) => output.y)) : 0;
  const maxX = safeOutputs.length
    ? Math.max(...safeOutputs.map((output) => output.x + output.width))
    : clampNumber(topology.width, 1, MAX_CANVAS_DIMENSION, 1920);
  const maxY = safeOutputs.length
    ? Math.max(...safeOutputs.map((output) => output.y + output.height))
    : clampNumber(topology.height, 1, MAX_CANVAS_DIMENSION, 1080);

  return {
    origin_x: minX,
    origin_y: minY,
    width: clampNumber(maxX - minX, 1, MAX_CANVAS_DIMENSION, 1920),
    height: clampNumber(maxY - minY, 1, MAX_CANVAS_DIMENSION, 1080),
    outputs: safeOutputs,
    reported_at: Math.floor(Date.now() / 1000),
  };
}

function endpointRowToJson(row, layers = []) {
  if (!row) return null;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    status: row.status || 'offline',
    last_heartbeat: row.last_heartbeat || null,
    topology: parseJson(row.topology_json, {
      origin_x: 0,
      origin_y: 0,
      width: row.canvas_width || 1920,
      height: row.canvas_height || 1080,
      outputs: [],
    }),
    canvas_width: row.canvas_width || 1920,
    canvas_height: row.canvas_height || 1080,
    scene_revision: row.scene_revision || 0,
    active: !!row.active,
    layers,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getEndpointLayers(endpointId) {
  return db.prepare(`
    SELECT id, x, y, width, height, z_index, label, source_json, render_json,
           fit_mode, muted, created_at, updated_at
    FROM advanced_canvas_layers
    WHERE endpoint_id = ?
    ORDER BY z_index ASC, created_at ASC
  `).all(endpointId).map((row) => ({
    id: row.id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z_index: row.z_index,
    label: row.label || '',
    source: parseJson(row.source_json, {}),
    render: parseJson(row.render_json, {}),
    // Default to 'fill' so wall content fills the layer box edge-to-bezel with no
    // letterbox and no crop — the operator-confirmed wallpaper behavior for a
    // video wall. An explicitly stored 'contain'/'cover' still wins (legacy
    // rows / Split regions are untouched); only an empty/NULL column
    // fallbacks to 'fill'.
    fit_mode: row.fit_mode || 'fill',
    muted: !!row.muted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

function getEndpoint(endpointId) {
  const row = db.prepare('SELECT * FROM advanced_canvas_endpoints WHERE id = ?').get(endpointId);
  return endpointRowToJson(row, row ? getEndpointLayers(endpointId) : []);
}

function contentRenderDescriptor(
  content,
  publicBase,
  endpointId,
  workspaceId,
  canvasAssetSecret,
  renderWidth,
  renderHeight
) {
  const mimeType = String(content.mime_type || 'application/octet-stream').toLowerCase();
  const url = content.remote_url || canvasAssetUrl({
    publicBase,
    endpointId,
    contentId: content.id,
    workspaceId,
    width: renderWidth,
    height: renderHeight,
    secret: canvasAssetSecret,
  });
  let kind = 'frame';
  if (mimeType.startsWith('image/')) kind = 'image';
  else if (mimeType.startsWith('video/')) kind = 'video';
  else if (mimeType.startsWith('audio/')) kind = 'audio';
  return {
    kind,
    url,
    mime_type: mimeType,
    content_id: content.id,
    duration_sec: Number(content.duration_sec) || null,
  };
}

async function resolveSource(
  source,
  workspaceId,
  publicBase,
  endpointId,
  canvasAssetSecret,
  renderWidth,
  renderHeight,
  assertRemoteUrlSafe
) {
  const value = source && typeof source === 'object' ? source : {};

  if (value.content_id) {
    const content = db.prepare(`
      SELECT id, workspace_id, mime_type, remote_url, duration_sec
      FROM content
      WHERE id = ?
    `).get(String(value.content_id));
    if (!content) throw new Error(`Content ${value.content_id} not found`);
    if (content.workspace_id && content.workspace_id !== workspaceId) {
      throw new Error(`Content ${value.content_id} is not in this workspace`);
    }
    return contentRenderDescriptor(
      content,
      publicBase,
      endpointId,
      workspaceId,
      canvasAssetSecret,
      renderWidth,
      renderHeight
    );
  }

  if (value.presentation_id) {
    const presentation = db.prepare(
      'SELECT id, workspace_id FROM presentations WHERE id = ?'
    ).get(String(value.presentation_id));
    if (!presentation) throw new Error(`Presentation ${value.presentation_id} not found`);
    if (presentation.workspace_id !== workspaceId) {
      throw new Error(`Presentation ${value.presentation_id} is not in this workspace`);
    }
    return {
      kind: 'frame',
      url: deckPlayerUrl(publicBase, presentation.id),
      presentation_id: presentation.id,
    };
  }

  if (value.playlist_id) {
    const playlist = db.prepare(
      'SELECT id, workspace_id FROM playlists WHERE id = ?'
    ).get(String(value.playlist_id));
    if (!playlist) throw new Error(`Playlist ${value.playlist_id} not found`);
    if (playlist.workspace_id !== workspaceId) {
      throw new Error(`Playlist ${value.playlist_id} is not in this workspace`);
    }
    const items = db.prepare(`
      SELECT pi.duration_sec, pi.fit_mode, c.id, c.workspace_id, c.mime_type,
             c.remote_url, c.duration_sec AS content_duration
      FROM playlist_items pi
      LEFT JOIN content c ON c.id = pi.content_id
      WHERE pi.playlist_id = ? AND c.id IS NOT NULL
      ORDER BY pi.sort_order ASC, pi.id ASC
      LIMIT 200
    `).all(playlist.id).map((item) => ({
      ...contentRenderDescriptor({
        id: item.id,
        mime_type: item.mime_type,
        remote_url: item.remote_url,
        duration_sec: item.content_duration,
      }, publicBase, endpointId, workspaceId, canvasAssetSecret, renderWidth, renderHeight),
      duration_sec: Number(item.duration_sec) || Number(item.content_duration) || 10,
      fit_mode: item.fit_mode || null,
    }));
    if (!items.length) throw new Error(`Playlist ${value.playlist_id} has no playable items`);
    return { kind: 'playlist', playlist_id: playlist.id, items };
  }

  if (value.remote_url) {
    const result = await assertRemoteUrlSafe(String(value.remote_url));
    if (!result.ok) throw new Error(result.error);
    return { kind: 'frame', url: String(value.remote_url) };
  }

  throw new Error('A canvas layer requires content_id, playlist_id, presentation_id, or remote_url');
}

async function normalizeSceneLayers({
  layers,
  workspaceId,
  canvasWidth,
  canvasHeight,
  publicBase,
  endpointId,
  canvasAssetSecret,
  assertRemoteUrlSafe,
}) {
  if (!Array.isArray(layers)) throw new Error('layers must be an array');
  if (layers.length > MAX_LAYERS) throw new Error(`A canvas scene supports at most ${MAX_LAYERS} layers`);

  const safe = [];
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index] && typeof layers[index] === 'object' ? layers[index] : {};
    const x = clampNumber(layer.x, 0, canvasWidth - 1, 0);
    const y = clampNumber(layer.y, 0, canvasHeight - 1, 0);
    // Default a unspecified layer to span the WHOLE canvas (full-bleed span),
    // not a single-screen 1920×1080 cell. The operator can always draw a
    // smaller sub-region (Split), but absent dimensions it should reach the
    // bezel edges of the wall rather than the top-left monitor.
    const width = clampNumber(layer.width, 1, canvasWidth - x, canvasWidth - x);
    const height = clampNumber(layer.height, 1, canvasHeight - y, canvasHeight - y);
    const source = layer.source && typeof layer.source === 'object' ? layer.source : {};
    const render = await resolveSource(
      source,
      workspaceId,
      publicBase,
      endpointId,
      canvasAssetSecret,
      width,
      height,
      assertRemoteUrlSafe
    );
    safe.push({
      id: String(layer.id || crypto.randomUUID()).slice(0, 128),
      x,
      y,
      width,
      height,
      z_index: clampNumber(layer.z_index, -1000, 1000, index),
      label: String(layer.label || `Layer ${index + 1}`).slice(0, 240),
      source,
      render,
      // Default 'fill' (was 'contain'/'cover'): wall content stretches to fill the
      // layer box edge-to-bezel — the operator-confirmed wallpaper behavior for
      // a video wall. An explicit per-layer 'contain'/'cover' still wins; only
      // an empty/invalid fit_mode now resolves to full-bleed 'fill'.
      fit_mode: ['contain', 'cover', 'fill'].includes(layer.fit_mode) ? layer.fit_mode : 'fill',
      muted: layer.muted !== false,
    });
  }
  return safe;
}

module.exports = {
  endpointRowToJson,
  generateEndpointToken,
  getEndpoint,
  getEndpointLayers,
  hashToken,
  normalizeSceneLayers,
  normalizeTopology,
};
