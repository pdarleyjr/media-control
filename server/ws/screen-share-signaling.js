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
 *     incoming dashboard event. Same gate used for remote-touch /
 *     remote-start.
 *   - Device sockets are device_token-authenticated. The server stamps
 *     the authenticated device_id on every device->dashboard relay;
 *     client-supplied values are never trusted.
 *
 * Active sessions:
 *   activeSessions: Map<device_id, {
 *     broadcasterSocketId, startedAt, disconnectedAt | null
 *   }>
 *
 *   - Only one broadcaster per device at a time. A new start from a
 *     different broadcaster preempts the existing session.
 *   - On broadcaster disconnect, the session is marked with
 *     disconnectedAt instead of being torn down immediately. A reaper
 *     interval tears down sessions where disconnectedAt is older than
 *     BROADCASTER_RECONNECT_GRACE_MS. This survives transient ping
 *     timeouts (Cloudflare WS dropouts, brief Wi-Fi blips) without
 *     killing every receiver.
 *
 * Rate limiting:
 *   ICE candidate events are rate-limited per socket via a token bucket
 *   (ICE_CANDIDATE_BURST in ICE_CANDIDATE_WINDOW_MS). Excess is dropped
 *   silently - WebRTC tolerates candidate loss, and a single
 *   misbehaving client cannot DoS the relay.
 */

const ICE_CANDIDATE_BURST = 100;
const ICE_CANDIDATE_WINDOW_MS = 10_000;
const BROADCASTER_RECONNECT_GRACE_MS = 30_000;
const REAPER_INTERVAL_MS = 5_000;

const activeSessions = new Map();

function setupScreenShareSignaling({ dashboardNs, deviceNs, canActOnDevice, deviceSocketRegistry }) {
  // ------------------------------------------------------------------
  // Reaper: clean up sessions whose broadcaster has been disconnected
  // longer than the grace window. Also a belt-and-braces guard against
  // any session that lost its broadcasterSocketId reference somehow.
  // ------------------------------------------------------------------
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, session] of activeSessions) {
      if (!session.disconnectedAt) continue;
      if (now - session.disconnectedAt < BROADCASTER_RECONNECT_GRACE_MS) continue;
      try {
        deviceNs.to(deviceId).emit('device:screen-share-end', {
          reason: 'broadcaster_disconnect_grace_expired',
        });
      } catch (_) { /* ignore */ }
      activeSessions.delete(deviceId);
      console.log(`[screen-share] reaper cleaned device=${deviceId} after grace expired`);
    }
  }, REAPER_INTERVAL_MS);
  if (typeof reaper.unref === 'function') reaper.unref();

  // ------------------------------------------------------------------
  // Per-socket token bucket for ICE candidate flood protection.
  // ------------------------------------------------------------------
  function allowIceCandidate(socket) {
    const data = socket.data;
    if (!data.__iceBucket) {
      data.__iceBucket = { count: 0, windowStart: Date.now() };
    }
    const b = data.__iceBucket;
    const now = Date.now();
    if (now - b.windowStart > ICE_CANDIDATE_WINDOW_MS) {
      b.windowStart = now;
      b.count = 0;
    }
    b.count += 1;
    if (b.count > ICE_CANDIDATE_BURST) {
      if (!data.__iceBucketWarned) {
        data.__iceBucketWarned = true;
        console.warn(`[screen-share] ICE candidate flood from socket ${socket.id}; throttling`);
      }
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Dashboard -> Device direction
  // (broadcaster initiates session and sends offer / ICE candidates)
  // ------------------------------------------------------------------
  dashboardNs.on('connection', (socket) => {
    socket.data.ownedScreenShareSessions = new Set();

    socket.on('screen-share:start', (data, ack) => {
      const { device_id, wall_tile } = data || {};
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

      // Lightly validate the optional wall_tile payload. We don't trust the
      // client's geometry beyond well-formedness; the receiver applies its own
      // sanity checks. Discarding malformed values silently is preferable to
      // surfacing them and letting a single bad cell break the whole wall.
      let safeWallTile = null;
      if (wall_tile && typeof wall_tile === 'object') {
        const s = wall_tile.screen_rect, p = wall_tile.player_rect;
        const ok = s && p &&
          ['x', 'y', 'w', 'h'].every(k => typeof s[k] === 'number' && Number.isFinite(s[k])) &&
          ['x', 'y', 'w', 'h'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k])) &&
          s.w > 0 && s.h > 0 && p.w > 0 && p.h > 0;
        if (ok) safeWallTile = { screen_rect: { ...s }, player_rect: { ...p } };
      }

      const existing = activeSessions.get(device_id);
      if (existing && existing.broadcasterSocketId !== socket.id) {
        // If the existing session was awaiting reconnect, this new start
        // implicitly takes over (the original broadcaster has been replaced).
        // Otherwise notify the prior owner that they have been preempted.
        const priorSocket = dashboardNs.sockets.get(existing.broadcasterSocketId);
        if (priorSocket && !existing.disconnectedAt) {
          priorSocket.emit('screen-share:preempted', { device_id });
          if (priorSocket.data.ownedScreenShareSessions) {
            priorSocket.data.ownedScreenShareSessions.delete(device_id);
          }
        }
      }

      activeSessions.set(device_id, {
        broadcasterSocketId: socket.id,
        broadcasterUserId: socket.userId,
        startedAt: Date.now(),
        disconnectedAt: null,
        wallTile: safeWallTile,
      });
      socket.data.ownedScreenShareSessions.add(device_id);

      deviceNs.to(device_id).emit('device:screen-share-start', {
        broadcaster_socket: socket.id,
        wall_tile: safeWallTile,
      });
      console.log(`[screen-share] start: device=${device_id} broadcaster=${socket.id}${safeWallTile ? ' (wall-tile)' : ''}`);
      ack && ack({ ok: true });
    });

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

    socket.on('screen-share:ice-candidate', (data) => {
      const { device_id, candidate } = data || {};
      if (!device_id || !candidate) return;
      if (!allowIceCandidate(socket)) return;
      const session = activeSessions.get(device_id);
      if (!session || session.broadcasterSocketId !== socket.id) return;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:screen-share-ice-candidate', { candidate });
    });

    socket.on('screen-share:stop', (data, ack) => {
      const { device_id } = data || {};
      if (!device_id) {
        return ack && ack({ ok: false, error: 'device_id required' });
      }
      const session = activeSessions.get(device_id);
      if (!session) return ack && ack({ ok: true, already_ended: true });
      const reclaimingGraceSession = session.disconnectedAt && session.broadcasterUserId === socket.userId;
      if (session.broadcasterSocketId !== socket.id && !reclaimingGraceSession) {
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

    socket.on('screen-share:resume', (data, ack) => {
      const { device_id } = data || {};
      if (!device_id) {
        return ack && ack({ ok: false, error: 'device_id required' });
      }
      const session = activeSessions.get(device_id);
      if (!session) return ack && ack({ ok: false, error: 'no_active_session' });
      if (session.broadcasterUserId !== socket.userId) {
        return ack && ack({ ok: false, error: 'not_session_owner' });
      }
      if (!canActOnDevice(socket, device_id, 'write')) {
        return ack && ack({ ok: false, error: 'forbidden' });
      }
      session.broadcasterSocketId = socket.id;
      session.disconnectedAt = null;
      socket.data.ownedScreenShareSessions.add(device_id);
      console.log(`[screen-share] resume: device=${device_id} broadcaster=${socket.id}`);
      ack && ack({ ok: true });
    });

    // On dashboard socket disconnect, mark each owned session with
    // disconnectedAt rather than tearing it down immediately. The reaper
    // will clean up after the grace period if no reconnect happens. Also,
    // a fresh screen-share:start from the same user (new socket.id) will
    // preempt the dangling session naturally.
    socket.on('disconnect', () => {
      const owned = socket.data.ownedScreenShareSessions;
      if (!owned || owned.size === 0) return;
      const disconnectedAt = Date.now();
      for (const deviceId of owned) {
        const session = activeSessions.get(deviceId);
        if (session && session.broadcasterSocketId === socket.id) {
          session.disconnectedAt = disconnectedAt;
          console.log(`[screen-share] broadcaster disconnect grace-started: device=${deviceId}`);
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // Device -> Dashboard direction
  // ------------------------------------------------------------------
  deviceNs.on('connection', (socket) => {
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

    socket.on('device:screen-share-ice-candidate', (data) => {
      const { candidate } = data || {};
      const deviceId = deviceSocketRegistry.getDeviceId(socket);
      if (!deviceId || !candidate) return;
      if (!allowIceCandidate(socket)) return;
      const session = activeSessions.get(deviceId);
      if (!session) return;
      const broadcaster = dashboardNs.sockets.get(session.broadcasterSocketId);
      if (!broadcaster) return;
      broadcaster.emit('screen-share:device-ice-candidate', { device_id: deviceId, candidate });
    });

    socket.on('device:screen-share-ended', () => {
      const deviceId = deviceSocketRegistry.getDeviceId(socket);
      if (!deviceId) return;
      const session = activeSessions.get(deviceId);
      if (!session) return;
      const broadcaster = dashboardNs.sockets.get(session.broadcasterSocketId);
      if (broadcaster) {
        broadcaster.emit('screen-share:ended-by-device', { device_id: deviceId });
        if (broadcaster.data.ownedScreenShareSessions) {
          broadcaster.data.ownedScreenShareSessions.delete(deviceId);
        }
      }
      activeSessions.delete(deviceId);
      console.log(`[screen-share] ended by device: device=${deviceId}`);
    });
  });

  return {
    getActiveSessions: () => {
      const out = [];
      for (const [device_id, s] of activeSessions) {
        out.push({
          device_id,
          broadcaster_socket: s.broadcasterSocketId,
          started_at: s.startedAt,
          disconnected_at: s.disconnectedAt,
        });
      }
      return out;
    },
  };
}

module.exports = { setupScreenShareSignaling };
