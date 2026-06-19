const crypto = require('crypto');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const { workspaceRoom } = require('../lib/socket-rooms');
const {
  getEndpoint,
  hashToken,
  normalizeTopology,
} = require('../lib/advanced-canvas');

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canActOnCanvas(socket, endpointId, tier) {
  const endpoint = db.prepare(
    'SELECT workspace_id FROM advanced_canvas_endpoints WHERE id = ?'
  ).get(String(endpointId || ''));
  if (!endpoint) return null;
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(endpoint.workspace_id);
  if (!workspace) return null;
  const context = accessContext(socket.userId, socket.userRole, workspace);
  if (!context) return null;
  if (!context.actingAs && tier === 'write' &&
      !['workspace_editor', 'workspace_admin'].includes(context.workspaceRole)) {
    return null;
  }
  if (!context.actingAs && tier === 'read' && !context.workspaceRole) return null;
  return endpoint;
}

function setupAdvancedCanvas(io, dashboardNs) {
  const canvasNs = io.of('/canvas');

  canvasNs.use((socket, next) => {
    const endpointId = String(socket.handshake.auth && socket.handshake.auth.endpoint_id || '');
    const token = String(socket.handshake.auth && socket.handshake.auth.token || '');
    const endpoint = db.prepare(
      'SELECT id, workspace_id, token_hash FROM advanced_canvas_endpoints WHERE id = ?'
    ).get(endpointId);
    if (!endpoint || !token || !timingSafeEqual(endpoint.token_hash, hashToken(token))) {
      return next(new Error('Canvas authentication failed'));
    }
    socket.endpointId = endpoint.id;
    socket.workspaceId = endpoint.workspace_id;
    next();
  });

  canvasNs.on('connection', (socket) => {
    socket.join(socket.endpointId);
    db.prepare(`
      UPDATE advanced_canvas_endpoints
      SET status = 'online', last_heartbeat = strftime('%s','now'),
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(socket.endpointId);
    socket.emit('canvas:scene', getEndpoint(socket.endpointId));
    dashboardNs.to(workspaceRoom(socket.workspaceId)).emit('dashboard:canvas-status', {
      endpoint_id: socket.endpointId,
      status: 'online',
    });

    socket.on('canvas:heartbeat', () => {
      db.prepare(`
        UPDATE advanced_canvas_endpoints
        SET status = 'online', last_heartbeat = strftime('%s','now')
        WHERE id = ?
      `).run(socket.endpointId);
    });

    socket.on('canvas:topology', (data) => {
      const topology = normalizeTopology(data);
      db.prepare(`
        UPDATE advanced_canvas_endpoints
        SET topology_json = ?, canvas_width = ?, canvas_height = ?,
            status = 'online', last_heartbeat = strftime('%s','now'),
            updated_at = strftime('%s','now')
        WHERE id = ?
      `).run(
        JSON.stringify(topology),
        topology.width,
        topology.height,
        socket.endpointId
      );
      dashboardNs.to(workspaceRoom(socket.workspaceId)).emit('dashboard:canvas-status', {
        endpoint_id: socket.endpointId,
        status: 'online',
        topology,
      });
    });

    socket.on('canvas:preview-offer', (data) => {
      if (!data || !data.dashboard_socket || !data.sdp) return;
      dashboardNs.to(String(data.dashboard_socket)).emit('canvas:preview-offer', {
        endpoint_id: socket.endpointId,
        sdp: data.sdp,
      });
    });

    socket.on('canvas:preview-ice', (data) => {
      if (!data || !data.dashboard_socket || !data.candidate) return;
      dashboardNs.to(String(data.dashboard_socket)).emit('canvas:preview-ice', {
        endpoint_id: socket.endpointId,
        candidate: data.candidate,
      });
    });

    socket.on('canvas:preview-ended', (data) => {
      if (!data || !data.dashboard_socket) return;
      dashboardNs.to(String(data.dashboard_socket)).emit('canvas:preview-ended', {
        endpoint_id: socket.endpointId,
      });
    });

    socket.on('canvas:camera-frame', (data) => {
      if (!data || !data.dashboard_socket || !data.image) return;
      const image = String(data.image);
      if (image.length > 4_000_000 || !image.startsWith('data:image/jpeg;base64,')) return;
      dashboardNs.to(String(data.dashboard_socket)).emit('canvas:camera-frame', {
        endpoint_id: socket.endpointId,
        image,
        captured_at: Date.now(),
      });
    });

    socket.on('canvas:camera-error', (data) => {
      if (!data || !data.dashboard_socket) return;
      dashboardNs.to(String(data.dashboard_socket)).emit('canvas:camera-error', {
        endpoint_id: socket.endpointId,
        error: String(data.error || 'camera_failed').slice(0, 300),
      });
    });

    socket.on('disconnect', () => {
      const room = canvasNs.adapter.rooms.get(socket.endpointId);
      if (room && room.size > 0) return;
      db.prepare(`
        UPDATE advanced_canvas_endpoints
        SET status = 'offline', updated_at = strftime('%s','now')
        WHERE id = ?
      `).run(socket.endpointId);
      dashboardNs.to(workspaceRoom(socket.workspaceId)).emit('dashboard:canvas-status', {
        endpoint_id: socket.endpointId,
        status: 'offline',
      });
    });
  });

  dashboardNs.on('connection', (socket) => {
    socket.on('dashboard:canvas-preview-start', (data, ack) => {
      const endpointId = data && data.endpoint_id;
      if (!canActOnCanvas(socket, endpointId, 'read')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      const room = canvasNs.adapter.rooms.get(endpointId);
      if (!room || room.size === 0) return ack && ack({ ok: false, error: 'offline' });
      canvasNs.to(endpointId).emit('canvas:preview-start', {
        dashboard_socket: socket.id,
        ice_servers: Array.isArray(data.ice_servers) ? data.ice_servers : [],
      });
      ack && ack({ ok: true });
    });

    socket.on('dashboard:canvas-preview-answer', (data) => {
      if (!data || !data.sdp || !canActOnCanvas(socket, data.endpoint_id, 'read')) return;
      canvasNs.to(data.endpoint_id).emit('canvas:preview-answer', {
        dashboard_socket: socket.id,
        sdp: data.sdp,
      });
    });

    socket.on('dashboard:canvas-preview-ice', (data) => {
      if (!data || !data.candidate || !canActOnCanvas(socket, data.endpoint_id, 'read')) return;
      canvasNs.to(data.endpoint_id).emit('canvas:preview-ice', {
        dashboard_socket: socket.id,
        candidate: data.candidate,
      });
    });

    socket.on('dashboard:canvas-preview-stop', (data) => {
      if (!data || !canActOnCanvas(socket, data.endpoint_id, 'read')) return;
      canvasNs.to(data.endpoint_id).emit('canvas:preview-stop', {
        dashboard_socket: socket.id,
      });
    });

    socket.on('dashboard:canvas-input', (data) => {
      if (!data || !canActOnCanvas(socket, data.endpoint_id, 'write')) return;
      canvasNs.to(data.endpoint_id).emit('canvas:input', {
        dashboard_socket: socket.id,
        input: data.input,
      });
    });

    socket.on('dashboard:canvas-camera-request', (data, ack) => {
      if (!data || !canActOnCanvas(socket, data.endpoint_id, 'read')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      const room = canvasNs.adapter.rooms.get(data.endpoint_id);
      if (!room || room.size === 0) return ack && ack({ ok: false, error: 'offline' });
      canvasNs.to(data.endpoint_id).emit('canvas:camera-request', {
        dashboard_socket: socket.id,
      });
      ack && ack({ ok: true });
    });
  });

  return canvasNs;
}

module.exports = { setupAdvancedCanvas };
