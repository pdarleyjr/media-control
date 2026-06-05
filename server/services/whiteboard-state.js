'use strict';

const { db } = require('../db/database');

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whiteboard_sessions (
      workspace_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      strokes_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (workspace_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_whiteboard_sessions_device ON whiteboard_sessions(device_id);
  `);
}
ensureTable();

function workspaceForDevice(deviceId) {
  const row = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  return row && row.workspace_id ? row.workspace_id : null;
}

function parseStrokes(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizeStroke).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizePoint(point) {
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}

function normalizeStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.points)) return null;
  const points = stroke.points.map(normalizePoint).filter(Boolean).slice(0, 4000);
  if (points.length === 0) return null;
  const tool = ['pen', 'highlighter', 'eraser'].includes(stroke.tool) ? stroke.tool : 'pen';
  const size = Number(stroke.size);
  const out = {
    points,
    color: typeof stroke.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(stroke.color) ? stroke.color : '#111827',
    size: Number.isFinite(size) ? Math.max(1, Math.min(96, Math.round(size))) : 6,
    tool,
  };
  if (typeof stroke.stroke_id === 'string' && stroke.stroke_id.length <= 80) out.stroke_id = stroke.stroke_id;
  if (typeof stroke.phase === 'string' && stroke.phase.length <= 16) out.phase = stroke.phase;
  return out;
}

function getSession(workspaceId, deviceId) {
  if (!workspaceId || !deviceId) return { workspace_id: workspaceId || null, device_id: deviceId || null, strokes: [] };
  const row = db.prepare('SELECT strokes_json FROM whiteboard_sessions WHERE workspace_id = ? AND device_id = ?')
    .get(workspaceId, deviceId);
  return {
    workspace_id: workspaceId,
    device_id: deviceId,
    strokes: row ? parseStrokes(row.strokes_json) : [],
  };
}

function saveSession(workspaceId, deviceId, strokes) {
  if (!workspaceId || !deviceId) return;
  const safe = Array.isArray(strokes) ? strokes.map(normalizeStroke).filter(Boolean).slice(-2000) : [];
  db.prepare(`
    INSERT INTO whiteboard_sessions (workspace_id, device_id, strokes_json, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(workspace_id, device_id) DO UPDATE SET
      strokes_json = excluded.strokes_json,
      updated_at = excluded.updated_at
  `).run(workspaceId, deviceId, JSON.stringify(safe));
}

function startSession(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  if (!ws || !deviceId) return { workspace_id: ws || null, device_id: deviceId || null, strokes: [] };
  db.prepare(`
    INSERT INTO whiteboard_sessions (workspace_id, device_id, strokes_json, updated_at)
    VALUES (?, ?, '[]', strftime('%s','now'))
    ON CONFLICT(workspace_id, device_id) DO NOTHING
  `).run(ws, deviceId);
  return getSession(ws, deviceId);
}

function appendStroke(workspaceId, deviceId, stroke) {
  const safeStroke = normalizeStroke(stroke);
  if (!safeStroke) return null;
  const ws = workspaceId || workspaceForDevice(deviceId);
  const session = startSession(ws, deviceId);
  if (safeStroke.stroke_id) {
    const existing = session.strokes.find(s => s && s.stroke_id === safeStroke.stroke_id);
    if (existing) {
      existing.points = [...(existing.points || []), ...safeStroke.points].slice(0, 8000);
      existing.color = safeStroke.color;
      existing.size = safeStroke.size;
      existing.tool = safeStroke.tool;
      existing.phase = safeStroke.phase;
    } else {
      session.strokes.push(safeStroke);
    }
  } else {
    session.strokes.push(safeStroke);
  }
  saveSession(session.workspace_id, deviceId, session.strokes);
  return safeStroke;
}

function clearSession(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  if (!ws || !deviceId) return;
  saveSession(ws, deviceId, []);
}

function undoStroke(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  const session = getSession(ws, deviceId);
  if (session.strokes.length > 0) session.strokes.pop();
  saveSession(ws, deviceId, session.strokes);
  return session.strokes;
}

function clearForMedia(io, deviceId) {
  const ws = workspaceForDevice(deviceId);
  if (!ws) return;
  clearSession(ws, deviceId);
  if (io) {
    try {
      io.of('/device').to(deviceId).emit('device:wb-clear', {});
      io.of('/device').to(deviceId).emit('device:wb-stop', {});
    } catch { /* best effort */ }
  }
}

module.exports = {
  normalizeStroke,
  workspaceForDevice,
  startSession,
  getSession,
  appendStroke,
  clearSession,
  undoStroke,
  clearForMedia,
};
