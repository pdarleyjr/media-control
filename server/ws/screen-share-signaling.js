/**
 * WebRTC signaling over Socket.IO for live screen sharing.
 *
 * Architecture:
 *   Broadcaster (admin dashboard / authenticated /dashboard socket)
 *     <--- SDP offer/answer + ICE candidates --->
 *   Receiver (display / authenticated /device socket)
 *
 * The server is a stateless relay - it does NOT inspect SDP or candidates.
 * All payloads are forwarded verbatim between the broadcaster's dashboard
 * socket and the receiver's device socket using the existing namespace
 * pattern from ws/dashboardSocket.js.
 *
 * Security model:
 *   - Dashboard sockets are JWT-authenticated; they joined workspace rooms
 *     at connect time (see ws/dashboardSocket.js).
 *   - canActOnDevice(socket, device_id, 'write') is called on EVERY
 *     incoming dashboard event to enforce: (a) the device exists,
 *     (b) the device is in a workspace the user can access, and (c) the
 *     user has write tier (editor or admin) on that workspace. This is
 *     the same gate used for remote-touch / remote-start.
 *   - Device sockets are device_token-authenticated; their currentDeviceId
 *     is set in deviceSocket.js after register, so we trust device->dashboard
 *     emits as coming from the named device (server stamps device_id, never
 *     trusts a client-supplied value).
 *
 * Active sessions:
 *   activeSessions: Map<device_id, { broadcasterSocketId, startedAt }>
 *   - Only one broadcaster per device at a time. A new start from a different
 *     broadcaster preempts the existing session (the prior broadcaster gets
 *     a 'screen-share:preempted' notice and tears down its peer connection).
 */

const activeSessions = new Map();

function setupScreenShareSignaling({ dashboardNs, deviceNs, canActOnDevice, deviceSocketRegistry }) {
  // ------------------------------------------------------------------
  // Dashboard -> Device direction
  // (broadcaster initiates session and sends offer / ICE candidates)
  // ------------------------------------------------------------------
  dashboardNs.on('connection', (socket) => {
    // Track sessions this dashboard socket owns so we can clean up on disconnect
    socket.data.ownedScreenShareSessions = new Set();

    // Start a screen-share session. The dashboard hasn't built a peer
    // connection yet - this is the heads-up to the device so it can prepare
    // to receive an offer next. Server marks the session active.
    socket.on('screen-share:start', (data, ack) => {
      const { device_id } = data || {};
      if (!device_id) {
        return ack && ack({ ok: false, error: 'device_id required' });
      }
      if (!canActOnDevice(socket, device_id, 'write')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      const room = deviceNs.adapter.rooms.get(device_id);
      if (!room || room.size === 0) {
        return ack && ack({ ok: false, error: 'device_offline' });
      }

      const existing = activeSessions.get(device_id);
      if (existing && existing.broadcasterSocketId !== socket.id) {
        const priorSocket = dashboardNs.sockets.get(existing.broadcasterSocketId);
        if (priorSocket) {
          priorSocket.emit('screen-share:preempted', { device_id });
          priorSocket.data.ownedScreenShareSessions &&
            priorSocket.data.ownedScreenShareSessions.delete(device_id);
        }
      }

      activeSessions.set(device_id, {
        broadcasterSocketId: socket.id,
        startedAt: Date.now(),
      });
      socket.data.ownedScreenShareSessions.add(device_id);

      deviceNs.to(device_id).emit('device:screen-share-start', {
        broadcaster_socket: socket.id,
      });
      console.log(`[screen-share] start: device=${device_id} broadcaster=${socket.id}`);
      ack && ack({ ok: true });
    });

    // SDP offer from broadcaster -> device. Forwarded verbatim.
    socket.on('screen-share:offer', (data, ack) => {
      const { device_id, sdp } = data || {};
      if (!device_id || !sdp) {
        return ack && ack({ ok: false, error: 'device_id and sdp required' });
      }
      const session = activeSessions.get(device_id);
      if (!session || session.broadcasterSocketId !== socket.id) {
        return ack && ack({ ok: false, error: 'no_active_session' });
      }
      if (!canActOnDevice(socket, device_id, 'write')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      deviceNs.to(device_id).emit('device:screen-share-offer', { sdp });
      ack && ack({ ok: true });
    });

    // ICE candidate from broadcaster -> device.
    socket.on('screen-share:ice-candidate', (data) => {
      const { device_id, candidate } = data || {};
      if (!device_id || !candidate) return;
      const session = activeSessions.get(device_id);
      if (!session || session.broadcasterSocketId !== socket.id) return;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:screen-share-ice-candidate', { candidate });
    });

    // Broadcaster requests session stop.
    socket.on('screen-share:stop', (data, ack) => {
      const { device_id } = data || {};
      if (!device_id) {
        return ack && ack({ ok: false, error: 'device_id required' });
      }
      const session = activeSessions.get(device_id);
      if (!session) return ack && ack({ ok: true, already_ended: true });
      if (session.broadcasterSocketId !== socket.id) {
        return ack && ack({ ok: false, error: 'not_session_owner' });
      }
      if (!canActOnDevice(socket, device_id, 'write')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      deviceNs.to(device_id).emit('device:screen-share-end', {});
      activeSessions.delete(device_id);
      socket.data.ownedScreenShareSessions.delete(device_id);
      console.log(`[screen-share] stop: device=${device_id} broadcaster=${socket.id}`);
      ack && ack({ ok: true });
    });

    // On dashboard socket disconnect, tear down any sessions this broadcaster
    // owned. Prevents zombie sessions where the broadcaster crashed without
    // explicit stop.
    socket.on('disconnect', () => {
      const owned = socket.data.ownedScreenShareSessions;
      if (!owned || owned.size === 0) return;
      for (const deviceId of owned) {
        const session = activeSessions.get(deviceId);
        if (session && session.broadcasterSocketId === socket.id) {
          deviceNs.to(deviceId).emit('device:screen-share-end', { reason: 'broadcaster_disconnect' });
          activeSessions.delete(deviceId);
          console.log(`[screen-share] cleanup on broadcaster disconnect: device=${deviceId}`);
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // Device -> Dashboard direction
  // (receiver's SDP answer + ICE candidates back to broadcaster)
  // ------------------------------------------------------------------
  deviceNs.on('connection', (socket) => {
    // SDP answer from device -> broadcaster.
    // Server stamps device_id from the authenticated socket - never trusts client.
    socket.on('device:screen-share-answer', (data) => {
      const { sdp } = data || {};
      const deviceId = deviceSocketRegistry.getDeviceId(socket);
      if (!deviceId || !sdp) return;
      const session = activeSessions.get(deviceId);
      if (!session) return;
      const broadcaster = dashboardNs.sockets.get(session.broadcasterSocketId);
      if (!broadcaster) return;
      broadcaster.emit('screen-share:answer', { device_id: deviceId, sdp });
    });

    // ICE candidate from device -> broadcaster.
    socket.on('device:screen-share-ice-candidate', (data) => {
      const { candidate } = data || {};
      const deviceId = deviceSocketRegistry.getDeviceId(socket);
      if (!deviceId || !candidate) return;
      const session = activeSessions.get(deviceId);
      if (!session) return;
      const broadcaster = dashboardNs.sockets.get(session.broadcasterSocketId);
      if (!broadcaster) return;
      broadcaster.emit('screen-share:device-ice-candidate', { device_id: deviceId, candidate });
    });

    // Device notifies that it has ended the session locally (user closed,
    // player crashed, page navigation, etc.).
    socket.on('device:screen-share-ended', () => {
      const deviceId = deviceSocketRegistry.getDeviceId(socket);
      if (!deviceId) return;
      const session = activeSessions.get(deviceId);
      if (!session) return;
      const broadcaster = dashboardNs.sockets.get(session.broadcasterSocketId);
      if (broadcaster) {
        broadcaster.emit('screen-share:ended-by-device', { device_id: deviceId });
        broadcaster.data.ownedScreenShareSessions &&
          broadcaster.data.ownedScreenShareSessions.delete(deviceId);
      }
      activeSessions.delete(deviceId);
      console.log(`[screen-share] ended by device: device=${deviceId}`);
    });
  });

  // Expose read-only session inventory for debug/monitoring endpoints.
  return {
    getActiveSessions: () => {
      const out = [];
      for (const [device_id, s] of activeSessions) {
        out.push({ device_id, broadcaster_socket: s.broadcasterSocketId, started_at: s.startedAt });
      }
      return out;
    },
  };
}

module.exports = { setupScreenShareSignaling };
