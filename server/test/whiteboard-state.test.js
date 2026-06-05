const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const whiteboardState = require('../services/whiteboard-state');

function cleanup(prefix) {
  db.prepare('DELETE FROM whiteboard_sessions WHERE workspace_id LIKE ? OR device_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM devices WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM workspaces WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM organization_members WHERE organization_id LIKE ? OR user_id LIKE ?').run(`${prefix}%`, `${prefix}%`);
  db.prepare('DELETE FROM organizations WHERE id LIKE ?').run(`${prefix}%`);
  db.prepare('DELETE FROM users WHERE id LIKE ? OR email LIKE ?').run(`${prefix}%`, `${prefix}%@example.test`);
}

function seed(prefix) {
  const userId = `${prefix}user`;
  const orgId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const deviceId = `${prefix}display`;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')")
    .run(userId, `${prefix}user@example.test`, 'Whiteboard Test User');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(orgId, 'Whiteboard Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, orgId, 'Whiteboard Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status) VALUES (?, ?, ?, 'Whiteboard Test Display', 'online')")
    .run(deviceId, userId, workspaceId);
  return { workspaceId, deviceId };
}

test('whiteboard state replays, merges streamed batches, undoes, and clears for media', () => {
  const prefix = `test-whiteboard-${Date.now()}-`;
  cleanup(prefix);
  try {
    const { workspaceId, deviceId } = seed(prefix);
    let session = whiteboardState.startSession(workspaceId, deviceId);
    assert.deepEqual(session.strokes, []);

    whiteboardState.appendStroke(workspaceId, deviceId, {
      stroke_id: 'stroke-1', phase: 'begin', tool: 'pen', color: '#111827', size: 6,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
    });
    whiteboardState.appendStroke(workspaceId, deviceId, {
      stroke_id: 'stroke-1', phase: 'end', tool: 'pen', color: '#111827', size: 6,
      points: [{ x: 0.3, y: 0.4 }],
    });

    session = whiteboardState.startSession(workspaceId, deviceId);
    assert.equal(session.strokes.length, 1);
    assert.equal(session.strokes[0].points.length, 3);

    whiteboardState.undoStroke(workspaceId, deviceId);
    assert.deepEqual(whiteboardState.getSession(workspaceId, deviceId).strokes, []);

    whiteboardState.appendStroke(workspaceId, deviceId, {
      stroke_id: 'stroke-2', tool: 'highlighter', color: '#3b82f6', size: 10,
      points: [{ x: 0.5, y: 0.5 }],
    });
    assert.equal(whiteboardState.getSession(workspaceId, deviceId).strokes.length, 1);
    whiteboardState.clearForMedia(null, deviceId);
    assert.deepEqual(whiteboardState.getSession(workspaceId, deviceId).strokes, []);
  } finally {
    cleanup(prefix);
  }
});
