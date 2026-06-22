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

// Allowed tool kinds. The original trio (pen/highlighter/eraser) is preserved
// verbatim; text + line/rect/ellipse are additive and serialize the same way
// (one row of strokes_json) so old sessions still load on players that only
// understand the original three (unknown tools render as a polyline fallback).
const TOOLS = ['pen', 'highlighter', 'eraser', 'text', 'line', 'rect', 'ellipse'];
const TEXT_FONTS = ['sans', 'serif', 'mono'];

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#111827';
}

function clampSize(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
}

function copyIdPhase(stroke, out) {
  if (typeof stroke.stroke_id === 'string' && stroke.stroke_id.length <= 80) out.stroke_id = stroke.stroke_id;
  if (typeof stroke.phase === 'string' && stroke.phase.length <= 16) out.phase = stroke.phase;
  return out;
}

function normalizeStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return null;
  const tool = TOOLS.includes(stroke.tool) ? stroke.tool : 'pen';
  const color = validColor(stroke.color);

  // Text: a single anchor {x,y} plus a string payload. points is a one-element
  // array on the wire for shape-parity, but we also accept a bare {x,y}.
  if (tool === 'text') {
    const raw = (Array.isArray(stroke.points) ? stroke.points[0] : null) || { x: stroke.x, y: stroke.y };
    const p = normalizePoint(raw);
    if (!p) return null;
    const text = String(stroke.text == null ? '' : stroke.text).slice(0, 500);
    if (!text) return null;
    const font = TEXT_FONTS.includes(stroke.font) ? stroke.font : 'sans';
    const out = {
      points: [p],
      color,
      size: clampSize(stroke.size, 8, 200, 24),
      tool,
      font,
      text,
    };
    return copyIdPhase(stroke, out);
  }

  // Shapes: require a start + end corner (>=2 points after normalization). We
  // persist only the first and last normalized points so the renderer can
  // reconstruct line/rect/ellipse from the bounding box deterministically.
  if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    const points = (Array.isArray(stroke.points) ? stroke.points : []).map(normalizePoint).filter(Boolean);
    if (points.length < 2) return null;
    const out = {
      points: [points[0], points[points.length - 1]],
      color,
      size: clampSize(stroke.size, 1, 96, 6),
      tool,
    };
    return copyIdPhase(stroke, out);
  }

  // pen / highlighter / eraser — free ink, original behavior preserved.
  if (!Array.isArray(stroke.points)) return null;
  const points = stroke.points.map(normalizePoint).filter(Boolean).slice(0, 4000);
  if (points.length === 0) return null;
  const out = {
    points,
    color,
    size: clampSize(stroke.size, 1, 96, 6),
    tool,
  };
  return copyIdPhase(stroke, out);
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

// Bounded redo stack, kept in memory per (workspace, device). Redo state is
// session-scoped and intentionally NOT persisted: a stroke that was undone and
// then survived a server restart is gone for good (matches the local-only undo
// stack the smartboard client already keeps). Capped so a long undo burst on a
// busy board can't grow unbounded.
const REDO_CAP = 50;
const redoStacks = new Map();

function redoKey(ws, deviceId) {
  return (ws || '_') + ':' + (deviceId || '_');
}

function getRedoStack(ws, deviceId) {
  const k = redoKey(ws, deviceId);
  let s = redoStacks.get(k);
  if (!s) { s = []; redoStacks.set(k, s); }
  return s;
}

function clearRedoStack(ws, deviceId) {
  redoStacks.delete(redoKey(ws, deviceId));
}

function appendStroke(workspaceId, deviceId, stroke) {
  const safeStroke = normalizeStroke(stroke);
  if (!safeStroke) return null;
  const ws = workspaceId || workspaceForDevice(deviceId);
  const session = startSession(ws, deviceId);
  let wasNew = false;
  if (safeStroke.stroke_id) {
    const existing = session.strokes.find(s => s && s.stroke_id === safeStroke.stroke_id);
    if (existing) {
      existing.points = [...(existing.points || []), ...safeStroke.points].slice(0, 8000);
      existing.color = safeStroke.color;
      existing.size = safeStroke.size;
      existing.tool = safeStroke.tool;
      existing.phase = safeStroke.phase;
      if (safeStroke.tool === 'text') {
        existing.text = safeStroke.text;
        existing.font = safeStroke.font;
      }
    } else {
      session.strokes.push(safeStroke);
      wasNew = true;
    }
  } else {
    session.strokes.push(safeStroke);
    wasNew = true;
  }
  // A genuinely new stroke (id not seen before, or no id) invalidates redo: the
  // operator drew new ink after undoing, so the redo branch is abandoned.
  if (wasNew) clearRedoStack(ws, deviceId);
  saveSession(session.workspace_id, deviceId, session.strokes);
  return safeStroke;
}

function clearSession(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  if (!ws || !deviceId) return;
  saveSession(ws, deviceId, []);
  clearRedoStack(ws, deviceId);
}

// Pops the most recent stroke off the session and stashes it on the redo stack.
// Returns the popped stroke (null if nothing to undo) — this is the value
// redoStroke needs to replay it. Old callers that ignored the return value are
// unaffected; the one internal caller in ws/deviceSocket.js was updated.
function undoStroke(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  const session = getSession(ws, deviceId);
  if (session.strokes.length === 0) return null;
  const popped = session.strokes.pop();
  if (popped) {
    const redo = getRedoStack(ws, deviceId);
    redo.push(popped);
    if (redo.length > REDO_CAP) redo.splice(0, redo.length - REDO_CAP);
  }
  saveSession(ws, deviceId, session.strokes);
  return popped || null;
}

// Pops the top of the redo stack back onto the session and persists. Returns
// the re-added stroke (null if the redo stack is empty). Append of a NEW stroke
// or clearSession resets the stack (see above).
function redoStroke(workspaceId, deviceId) {
  const ws = workspaceId || workspaceForDevice(deviceId);
  if (!ws || !deviceId) return null;
  const redo = redoStacks.get(redoKey(ws, deviceId));
  if (!redo || redo.length === 0) return null;
  const stroke = redo.pop();
  const session = getSession(ws, deviceId);
  session.strokes.push(stroke);
  saveSession(ws, deviceId, session.strokes);
  return stroke || null;
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
  redoStroke,
  clearForMedia,
  TOOLS,
  TEXT_FONTS,
};
