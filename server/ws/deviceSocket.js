const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, pruneTelemetry, pruneScreenshots } = require('../db/database');
const config = require('../config');
const heartbeat = require('../services/heartbeat');
const commandQueue = require('../lib/command-queue');
const { withLocalAssetUrls } = require('../lib/local-asset-url');

// Debounce window for marking a device offline on socket disconnect. Brief
// flap (Wi-Fi blip, Engine.IO ping miss, server-side eviction-then-reconnect)
// shouldn't toggle the dashboard. If a fresh register lands within this
// window, the pending offline transition is cancelled. Per-device timer is
// stored here; cleared by the register handlers and by stale-disconnect
// guards. In-memory only - the heartbeat checker is the safety net for
// server-restart-during-grace-window edge cases (any 'online' rows whose
// last_heartbeat is older than heartbeatTimeout get marked offline by the
// next checker sweep within heartbeatInterval).
const pendingOfflines = new Map();
const OFFLINE_DEBOUNCE_MS = 5000;
// Phase 2.3: deviceRoom() resolves a device_id to its workspace room so
// dashboardNs.emit can be scoped instead of broadcast platform-wide.
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');

function emitToDeviceWorkspace(dashboardNs, deviceId, event, payload) {
  emitToWorkspace(dashboardNs, deviceRoom(deviceId), event, payload);
}

// In-memory store for latest screenshot per device (avoids disk writes during streaming)
let lastScreenshots = {};

// Generate a random device token
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Validate device_id + device_token pair. Returns true if valid.
function validateDeviceToken(deviceId, token) {
  if (!deviceId || !token) return false;
  const row = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(deviceId);
  if (!row || !row.device_token) return false;
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(row.device_token), Buffer.from(token));
  } catch {
    return false;
  }
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function logDeviceStatus(deviceId, status) {
  try {
    db.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)').run(deviceId, status);
    // Prune entries older than 7 days
    db.prepare("DELETE FROM device_status_log WHERE device_id = ? AND timestamp < strftime('%s','now') - 604800").run(deviceId);
  } catch (e) { /* table might not exist yet */ }
}


// Build playlist payload with layout and zones
// Reads from published_snapshot (Phase 3) so draft edits don't affect live devices
function buildPlaylistPayload(deviceId) {
  const device = db.prepare('SELECT playlist_id, layout_id, orientation, wall_id, screen_width, screen_height, refresh_rate_hz, auto_detect_resolution FROM devices WHERE id = ?').get(deviceId);

  let assignments = [];
  if (device?.playlist_id) {
    const playlist = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (playlist?.published_snapshot) {
      try { assignments = JSON.parse(playlist.published_snapshot); } catch (e) { assignments = []; }
    }
    // 2026-05-28: Republish-from-snapshot drops fit_mode (added after the
    // initial snapshot schema). Backfill from playlist_items so existing
    // published playlists pick up per-item fit_mode without needing a
    // re-publish.
    try {
      const liveItems = db.prepare(`
        SELECT content_id, widget_id, sort_order, fit_mode
        FROM playlist_items WHERE playlist_id = ?
      `).all(device.playlist_id);
      const byKey = new Map();
      for (const li of liveItems) {
        const key = (li.content_id || '') + '|' + (li.widget_id || '') + '|' + li.sort_order;
        byKey.set(key, li.fit_mode);
      }
      for (const a of assignments) {
        if (a.fit_mode == null) {
          const key = (a.content_id || '') + '|' + (a.widget_id || '') + '|' + a.sort_order;
          if (byKey.has(key)) a.fit_mode = byKey.get(key);
        }
      }
    } catch (e) { /* live backfill is best-effort */ }

    assignments = withLocalAssetUrls(assignments, config.localContentBaseUrl);
  }

  let layout = null;
  if (device?.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  // Wall membership flips the player into wall mode. The renderer needs two
  // rectangles in canvas-space: this device's screen rect, and the wall's
  // player rect. The intersection is what this screen displays. The leader
  // drives playback; followers track via wall:sync.
  let wall_config = null;
  if (device?.wall_id) {
    const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
    const pos = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?').get(device.wall_id, deviceId);
    if (wall && pos) {
      const baseW = 320, baseH = 180;
      const bezelH = wall.bezel_h_mm || 0;
      const bezelV = wall.bezel_v_mm || 0;

      // Backfill canvas rect from grid math when canvas_* is unset (legacy
      // walls that haven't been touched by the new editor yet). Coords are
      // rounded to integers so sub-pixel drift can't cause two visually
      // identical rects to compute different stage offsets.
      const screenRect = {
        x: Math.round(pos.canvas_x ?? (pos.grid_col * (baseW + bezelH))),
        y: Math.round(pos.canvas_y ?? (pos.grid_row * (baseH + bezelV))),
        w: Math.round(pos.canvas_width ?? baseW),
        h: Math.round(pos.canvas_height ?? baseH),
      };

      // Player rect defaults to the bounding box of all screens on the wall.
      let playerRect;
      if (wall.player_x !== null && wall.player_x !== undefined) {
        playerRect = { x: wall.player_x, y: wall.player_y, w: wall.player_width, h: wall.player_height };
      } else {
        const all = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
        let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of all) {
          const px = p.canvas_x ?? (p.grid_col * (baseW + bezelH));
          const py = p.canvas_y ?? (p.grid_row * (baseH + bezelV));
          const pw = p.canvas_width ?? baseW;
          const ph = p.canvas_height ?? baseH;
          if (px < x) x = px;
          if (py < y) y = py;
          if (px + pw > x2) x2 = px + pw;
          if (py + ph > y2) y2 = py + ph;
        }
        playerRect = isFinite(x)
          ? { x, y, w: x2 - x, h: y2 - y }
          : { x: 0, y: 0, w: baseW, h: baseH };
      }
      // Round the player rect too — same rationale.
      playerRect = {
        x: Math.round(playerRect.x), y: Math.round(playerRect.y),
        w: Math.round(playerRect.w), h: Math.round(playerRect.h),
      };

      wall_config = {
        wall_id: wall.id,
        wall_name: wall.name || null,
        grid_col: pos.grid_col,
        grid_row: pos.grid_row,
        grid_cols: wall.grid_cols,
        grid_rows: wall.grid_rows,
        screen_rect: screenRect,
        player_rect: playerRect,
        is_leader: wall.leader_device_id === deviceId,
        rotation: pos.rotation || 0,
        refresh_rate_hz: wall.refresh_rate_hz || null,
      };
    }
  }

  return {
    assignments,
    layout,
    orientation: device?.orientation || 'landscape',
    wall_config,
    // 2026-05-28: surface the device's authoritative geometry so the player
    // can size to the canonical (admin-overridden) resolution rather than the
    // browser-reported screen.width/height (which underreports on Fire TV).
    device_geometry: {
      width: device?.screen_width || null,
      height: device?.screen_height || null,
      refresh_rate_hz: device?.refresh_rate_hz || null,
      auto_detected: !!device?.auto_detect_resolution,
    },
  };
}

// Device access gating (billing/trial/device-limit) has been removed.
// This function is retained with its original name and return shape so callers
// (the register handlers) continue to work unchanged. It now unconditionally
// grants access — no trial-expired screen, no device-limit block.
function checkDeviceAccess(deviceId) {
  return { allowed: true };
}

module.exports = function setupDeviceSocket(io) {
  // Expose helpers for use by route handlers
  module.exports.lastScreenshots = lastScreenshots;
  module.exports.buildPlaylistPayload = buildPlaylistPayload;
  module.exports.generateDeviceToken = generateDeviceToken;
  const deviceNs = io.of('/device');
  const dashboardNs = io.of('/dashboard');

  // Disconnect any existing socket that is currently registered for this device_id.
  // Called when a fresh registration comes in for the same device so the old (likely
  // half-dead) socket can't fire its disconnect handler and clobber the new entry.
  function evictPriorSocket(deviceId, exceptSocketId) {
    const prior = heartbeat.getConnection(deviceId);
    if (!prior || prior.socketId === exceptSocketId) return;
    const oldSocket = deviceNs.sockets.get(prior.socketId);
    if (oldSocket) {
      console.log(`Evicting prior socket ${prior.socketId} for device ${deviceId}`);
      try { oldSocket.disconnect(true); } catch (_) {}
    }
  }

  deviceNs.on('connection', (socket) => {
    console.log(`Device socket connected: ${socket.id}`);
    let currentDeviceId = null;
    let authenticated = false; // Track whether this socket has been authenticated

    // Device registers with a pairing code (first time) or device_id + device_token (reconnect)
    socket.on('device:register', (data) => {
      const { pairing_code, device_id, device_token, device_info, fingerprint } = data;

      // Track device fingerprint to prevent reinstall abuse
      if (fingerprint) {
        try {
          const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
          if (existing) {
            db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
              .run(device_id || existing.device_id, fingerprint);
            // If this fingerprint was previously registered to a different device, block the new registration
            if (!device_id && existing.device_id && pairing_code) {
              // Someone reinstalled - link them back to existing device
              const oldDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.device_id);
              if (oldDevice) {
                // Fingerprint reclaim guard: a leaked/duplicated fingerprint shouldn't be enough
                // to take over a live device. Reject the reclaim if the device is currently
                // online OR has been online within the last 24h — by then a real reinstall has
                // had plenty of time to come back, but a credential thief is more likely caught.
                const liveConn = heartbeat.getConnection(existing.device_id);
                const RECLAIM_GRACE_SECONDS = 24 * 60 * 60;
                const lastBeat = oldDevice.last_heartbeat || 0;
                const secondsSince = Math.floor(Date.now() / 1000) - lastBeat;
                if (liveConn || (oldDevice.status === 'online') || secondsSince < RECLAIM_GRACE_SECONDS) {
                  // Reclaim refused (guard against fingerprint hijack of a
                  // live device), but the player ALSO sent a pairing_code
                  // which means it is willing to be paired as a fresh slot.
                  // Don't dead-end with auth-error — that forces the player
                  // to wipe credentials and show "Authentication failed"
                  // with no pairing code visible. Instead, log + fall
                  // through to the normal new-device registration path
                  // below so the admin can claim it from the dashboard.
                  console.warn(`Fingerprint reclaim rejected for ${existing.device_id}: device active (status=${oldDevice.status}, ${secondsSince}s since last heartbeat, liveConn=${!!liveConn}); proceeding with new-device pairing for ${pairing_code}`);
                  // Detach the fingerprint from the in-use device so this
                  // pairing creates its own row when claimed; avoids two
                  // physical displays sharing a single fingerprint slot.
                  try {
                    db.prepare('DELETE FROM device_fingerprints WHERE fingerprint = ? AND device_id = ?').run(fingerprint, existing.device_id);
                  } catch (e) {
                    console.warn('failed to detach colliding fingerprint:', e.message);
                  }
                  // Fall through (no return) to the standard new-device flow.
                } else {
                  // Fingerprint matched — this is a reinstalled app reconnecting to its old device.
                  // Issue a fresh token so the app can authenticate going forward.
                  const newToken = generateDeviceToken();
                  db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(newToken, existing.device_id);
                  console.log(`Fingerprint match: linking reinstalled app to existing device ${existing.device_id} (new token issued)`);
                  authenticated = true;
                  // Cancel any pending offline timer - device is back in the grace window
                  if (pendingOfflines.has(existing.device_id)) {
                    clearTimeout(pendingOfflines.get(existing.device_id));
                    pendingOfflines.delete(existing.device_id);
                  }
                  evictPriorSocket(existing.device_id, socket.id);
                  db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
                    .run(getClientIp(socket), existing.device_id);
                  socket.emit('device:registered', { device_id: existing.device_id, device_token: newToken, status: 'online' });
                  // If device was already claimed by a user, tell the player it's paired
                  if (oldDevice.user_id) {
                    socket.emit('device:paired', { name: oldDevice.name || 'Display' });
                  }
                  currentDeviceId = existing.device_id;
                  heartbeat.registerConnection(existing.device_id, socket.id);
                  socket.join(existing.device_id);
                  logDeviceStatus(existing.device_id, 'online');
                  emitToDeviceWorkspace(dashboardNs, existing.device_id, 'dashboard:device-status', { device_id: existing.device_id, status: 'online' });
                  // Flush any commands/playlist-updates queued while this device was offline.
                  commandQueue.flushQueue(deviceNs, existing.device_id, buildPlaylistPayload);
                  // Send playlist
                  const access = checkDeviceAccess(existing.device_id);
                  if (!access.allowed) {
                    socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
                  } else {
                    socket.emit('device:playlist-update', buildPlaylistPayload(existing.device_id));
                  }
                  return;
                }
              }
            }
          } else if (device_id || pairing_code) {
            db.prepare("INSERT OR IGNORE INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)")
              .run(fingerprint, device_id || null);
          }
        } catch (e) {
          console.error('Fingerprint tracking error:', e.message);
        }
      }

      if (device_id) {
        // Reconnecting known device — require valid token
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
        if (device) {
          // Validate device token (skip for legacy devices that don't have a token yet)
          if (device.device_token && !validateDeviceToken(device_id, device_token)) {
            console.warn(`Invalid device token for ${device_id} from ${getClientIp(socket)} — received_len=${(device_token || '').length}, stored_len=${device.device_token.length}`);
            socket.emit('device:auth-error', { error: 'Invalid device token' });
            return;
          }

          currentDeviceId = device_id;
          authenticated = true;
          // Cancel any pending offline timer - device is back in the grace window
          if (pendingOfflines.has(device_id)) {
            clearTimeout(pendingOfflines.get(device_id));
            pendingOfflines.delete(device_id);
          }
          evictPriorSocket(device_id, socket.id);
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
            .run(getClientIp(socket), device_id);

          // Generate token for legacy devices that don't have one yet
          let tokenToSend = device.device_token;
          if (!tokenToSend) {
            tokenToSend = generateDeviceToken();
            db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(tokenToSend, device_id);
          }

          if (device_info) {
            // 2026-05-28: only overwrite reported screen dimensions when the
            // device is in auto-detect mode. Admins can pin canonical values
            // (e.g. 12372x2160 wall) via /api/devices/:id and have those
            // survive reconnects even though the Fire TV keeps reporting
            // 1920x1080 (the OS surface res, not panel res).
            const fresh = db.prepare('SELECT auto_detect_resolution FROM devices WHERE id = ?').get(device_id);
            const autoDetect = !fresh || fresh.auto_detect_resolution !== 0;
            if (autoDetect) {
              db.prepare('UPDATE devices SET android_version = ?, app_version = ?, screen_width = ?, screen_height = ? WHERE id = ?')
                .run(device_info.android_version, device_info.app_version, device_info.screen_width, device_info.screen_height, device_id);
            } else {
              db.prepare('UPDATE devices SET android_version = ?, app_version = ? WHERE id = ?')
                .run(device_info.android_version, device_info.app_version, device_id);
            }
          }

          heartbeat.registerConnection(device_id, socket.id);
          socket.join(device_id);
          socket.emit('device:registered', { device_id, device_token: tokenToSend, status: 'online' });
          logDeviceStatus(device_id, 'online');
          // Flush any commands/playlist-updates queued while this device was offline.
          commandQueue.flushQueue(deviceNs, device_id, buildPlaylistPayload);

          // If this device is part of a wall, re-evaluate leadership.
          // Preferred leader = online member with smallest (canvas_x +
          // canvas_y), falling back to grid 0,0. If the original leader
          // (top-left tile) is back, they reclaim the role and peers re-sync.
          if (device.wall_id) {
            try {
              const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
              if (wall) {
                const candidates = db.prepare(`
                  SELECT vwd.device_id, vwd.canvas_x, vwd.canvas_y, vwd.grid_col, vwd.grid_row
                  FROM video_wall_devices vwd
                  JOIN devices d ON d.id = vwd.device_id
                  WHERE vwd.wall_id = ? AND d.status = 'online'
                `).all(wall.id);
                if (candidates.length > 0) {
                  const score = (c) => (c.canvas_x ?? c.grid_col * 320) + (c.canvas_y ?? c.grid_row * 180);
                  candidates.sort((a, b) => score(a) - score(b));
                  const preferredLeader = candidates[0].device_id;
                  if (wall.leader_device_id !== preferredLeader) {
                    db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(preferredLeader, wall.id);
                    console.log(`Wall ${wall.id} leader reassigned to ${preferredLeader} on reconnect`);
                    // Re-push payload to every member so role flags refresh.
                    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
                    for (const m of members) {
                      if (m.device_id !== device_id) {
                        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
                      }
                    }
                  }
                }
              }
            } catch (e) { console.error('Wall leader reclaim failed:', e.message); }
          }

          // Device access gating removed — checkDeviceAccess always grants access.
          const access = checkDeviceAccess(device_id);
          if (!access.allowed) {
            socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
          } else {
            socket.emit('device:playlist-update', buildPlaylistPayload(device_id));
          }

          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', { device_id, status: 'online' });
          console.log(`Device reconnected: ${device_id}`);
          return;
        }

        // Device ID not found in database - tell device to re-provision
        console.log(`Device ${device_id} not found in database, sending unpaired`);
        socket.emit('device:unpaired', { reason: 'not_found' });
        return;
      }

      if (pairing_code) {
        // New device registering with pairing code — generate a device_token
        const id = uuidv4();
        const newToken = generateDeviceToken();
        currentDeviceId = id;
        authenticated = true;

        db.prepare(`
          INSERT INTO devices (id, pairing_code, device_token, status, ip_address, android_version, app_version, screen_width, screen_height, last_heartbeat)
          VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, strftime('%s','now'))
        `).run(
          id, pairing_code, newToken, getClientIp(socket),
          device_info?.android_version || null,
          device_info?.app_version || null,
          device_info?.screen_width || null,
          device_info?.screen_height || null
        );

        heartbeat.registerConnection(id, socket.id);
        socket.join(id);
        socket.emit('device:registered', { device_id: id, device_token: newToken, status: 'provisioning' });

        // Newly-provisioned devices have no workspace_id yet (they'll get one
        // on pair claim). emitToDeviceWorkspace silently drops when there's no
        // workspace; that's safer than the previous platform-wide broadcast.
        // Dashboards refresh /api/devices/unassigned on poll for the
        // platform_admin pairing view.
        emitToDeviceWorkspace(dashboardNs, id, 'dashboard:device-added', db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
        console.log(`New device registered: ${id} with pairing code: ${pairing_code}`);
      }
    });

    // Require authentication for all events after register
    function requireDeviceAuth() {
      if (!authenticated || !currentDeviceId) {
        socket.emit('device:auth-error', { error: 'Not authenticated. Send device:register first.' });
        return false;
      }
      return true;
    }

    // Heartbeat with telemetry
    // 2026-05-28: hardened against process-killing FK violations. If the
    // device row is deleted (by an admin or a reset) between socket register
    // and the heartbeat firing, the INSERT INTO device_telemetry would throw
    // SQLITE_CONSTRAINT_FOREIGNKEY and propagate out of the Socket.IO event
    // handler, crashing Node. Now we (a) re-check the parent row exists
    // before any FK insert, and (b) wrap each write in try/catch so a single
    // malformed payload never restarts the container.
    socket.on('device:heartbeat', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const { device_id, telemetry } = data || {};
        if (!device_id || device_id !== currentDeviceId) return;

        // Parent existence check: if the device row was deleted server-side
        // (workspace cleanup, admin delete, schema rebuild) the socket is
        // stale. Tell the player to re-provision and bail.
        const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(device_id);
        if (!exists) {
          try { socket.emit('device:unpaired', { reason: 'not_found' }); } catch (_) {}
          authenticated = false;
          currentDeviceId = null;
          return;
        }

        heartbeat.updateHeartbeat(device_id);

        try {
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?")
            .run(device_id);
        } catch (e) {
          console.warn(`heartbeat UPDATE devices failed for ${device_id}: ${e.message}`);
        }

        if (telemetry) {
          try {
            db.prepare(`
              INSERT INTO device_telemetry (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb,
                ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              device_id,
              telemetry.battery_level ?? null,
              telemetry.battery_charging ? 1 : 0,
              telemetry.storage_free_mb ?? null,
              telemetry.storage_total_mb ?? null,
              telemetry.ram_free_mb ?? null,
              telemetry.ram_total_mb ?? null,
              telemetry.cpu_usage ?? null,
              telemetry.wifi_ssid ?? null,
              telemetry.wifi_rssi ?? null,
              telemetry.uptime_seconds ?? null
            );
            pruneTelemetry(device_id);
          } catch (e) {
            // FK violation, race with delete, etc. Log and skip telemetry —
            // don't crash the whole device namespace.
            console.warn(`device_telemetry INSERT failed for ${device_id}: ${e.message}`);
          }

          try {
            emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', {
              device_id,
              status: 'online',
              telemetry
            });
          } catch (e) {
            console.warn(`dashboard emit failed for ${device_id}: ${e.message}`);
          }
        }
      } catch (e) {
        // Catch-all so a malformed payload never escapes the event loop.
        console.error(`device:heartbeat handler crashed: ${e.message}`, e.stack);
      }
    });

    // Screenshot received from device - relay via WebSocket, keep latest in memory
    socket.on('device:screenshot', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, image_b64 } = data;
      if (!device_id || device_id !== currentDeviceId || !image_b64) return;
      // Validate screenshot size (max 2MB base64 ≈ 1.5MB image)
      if (image_b64.length > 2 * 1024 * 1024) return;

      // Store latest screenshot in memory (for Now Playing preview and offline snapshot)
      if (!lastScreenshots) lastScreenshots = {};
      lastScreenshots[device_id] = image_b64;

      // Relay directly to dashboard - no disk write
      try {
        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:screenshot-ready', {
          device_id,
          image_data: `data:image/jpeg;base64,${image_b64}`,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('Screenshot save error:', err);
      }
    });

    // Content download acknowledgement
    socket.on('device:content-ack', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, content_id, status } = data;
      if (device_id !== currentDeviceId) return;
      console.log(`Device ${device_id} content ${content_id}: ${status}`);
      emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:content-ack', { device_id, content_id, status });
    });

    // Playback state update
    socket.on('device:playback-state', (data) => {
      if (!requireDeviceAuth()) return;
      // currentDeviceId is the authenticated device for this socket; use it
      // for the workspace lookup since data may not carry device_id consistently.
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:playback-state', data);
    });

    // Play event logging (proof-of-play)
    socket.on('device:play-event', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, event, content_id, content_name, zone_id, completed, duration_sec } = data;
      if (device_id !== currentDeviceId) return;
      try {
        if (event === 'play_start') {
          db.prepare(`
            INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, trigger_type)
            VALUES (?, ?, ?, ?, strftime('%s','now'), 'playlist')
          `).run(device_id, content_id || null, zone_id || null, content_name || 'Unknown');
          // Forward to dashboard so it can render a per-device progress bar.
          // Server-side timestamp avoids clock-skew between player and dashboard.
          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:playback-progress', {
            device_id,
            content_id: content_id || null,
            content_name: content_name || null,
            duration_sec: typeof duration_sec === 'number' && duration_sec > 0 ? duration_sec : null,
            started_at: Date.now(),
          });
        } else if (event === 'play_end') {
          db.prepare(`
            UPDATE play_logs SET ended_at = strftime('%s','now'),
              duration_sec = strftime('%s','now') - started_at,
              completed = ?
            WHERE id = (
              SELECT id FROM play_logs WHERE device_id = ? AND content_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            )
          `).run(completed ? 1 : 0, device_id, content_id);
        }
      } catch (err) {
        console.error('Play log error:', err.message);
      }
    });

    // Phase 2 (display self-report): the player reports its rendering
    // geometry/capabilities so the dashboard can show real per-display info
    // (CSS viewport, screen res, DPR, refresh rate, orientation) and so admins
    // can spot a misreporting panel. Trust ONLY the server-stamped
    // currentDeviceId — never the client-supplied id — for the row update.
    // Every DB write is wrapped in try/catch so a malformed payload can't crash
    // the device namespace (same hardening as device:heartbeat).
    socket.on('display:viewport', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const deviceId = currentDeviceId;
        const {
          css_w, css_h, screen_w, screen_h,
          device_pixel_ratio, refresh_hz, orientation, capabilities,
        } = data || {};

        // Parent existence check: the device row may have been deleted
        // server-side between register and this event. Bail quietly.
        const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId);
        if (!exists) return;

        // Coerce to safe types. Anything non-finite becomes null rather than
        // poisoning the row. capabilities is stringified defensively.
        const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
        const toReal = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
        let capsJson = '{}';
        try { capsJson = JSON.stringify(capabilities || {}); } catch (_) { capsJson = '{}'; }

        const cssW = toInt(css_w);
        const cssH = toInt(css_h);
        const dpr = toReal(device_pixel_ratio);
        const hz = toInt(refresh_hz);
        const nowSec = Math.floor(Date.now() / 1000);

        try {
          db.prepare(`
            UPDATE devices SET
              viewport_css_w = ?, viewport_css_h = ?,
              device_pixel_ratio = ?, refresh_hz = ?,
              capabilities_json = ?, last_viewport_at = ?
            WHERE id = ?
          `).run(cssW, cssH, dpr, hz, capsJson, nowSec, deviceId);
        } catch (e) {
          console.warn(`display:viewport UPDATE devices failed for ${deviceId}: ${e.message}`);
        }

        // orientation + screen_width/screen_height live on the base schema /
        // earlier migrations. Only write them when the device supplied a value.
        // screen_width/height are also fed by device:register; respect the
        // admin auto_detect_resolution pin so a self-report can't clobber a
        // manually-set wall geometry.
        try {
          if (orientation === 'landscape' || orientation === 'portrait') {
            db.prepare('UPDATE devices SET orientation = ? WHERE id = ?').run(orientation, deviceId);
          }
        } catch (e) {
          console.warn(`display:viewport orientation update failed for ${deviceId}: ${e.message}`);
        }

        try {
          const sw = toInt(screen_w);
          const sh = toInt(screen_h);
          if (sw != null || sh != null) {
            const fresh = db.prepare('SELECT auto_detect_resolution FROM devices WHERE id = ?').get(deviceId);
            const autoDetect = !fresh || fresh.auto_detect_resolution !== 0;
            if (autoDetect) {
              if (sw != null) db.prepare('UPDATE devices SET screen_width = ? WHERE id = ?').run(sw, deviceId);
              if (sh != null) db.prepare('UPDATE devices SET screen_height = ? WHERE id = ?').run(sh, deviceId);
            }
          }
        } catch (e) {
          console.warn(`display:viewport screen dims update failed for ${deviceId}: ${e.message}`);
        }

        // Notify the dashboard (workspace-scoped) so it can live-update the
        // per-display panel. Reuse the existing dashboard:device-status event
        // and helper used by heartbeat/register, adding viewport fields.
        try {
          const row = db.prepare(
            'SELECT screen_width, screen_height, orientation FROM devices WHERE id = ?'
          ).get(deviceId) || {};
          emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', {
            device_id: deviceId,
            status: 'online',
            viewport: {
              css_w: cssW,
              css_h: cssH,
              screen_w: row.screen_width ?? null,
              screen_h: row.screen_height ?? null,
              device_pixel_ratio: dpr,
              refresh_hz: hz,
              orientation: row.orientation ?? (orientation || null),
              capabilities: capabilities || {},
              last_viewport_at: nowSec,
            },
          });
        } catch (e) {
          console.warn(`display:viewport dashboard emit failed for ${deviceId}: ${e.message}`);
        }
      } catch (e) {
        // Catch-all so a malformed payload never escapes the event loop.
        console.error(`display:viewport handler crashed: ${e.message}`, e.stack);
      }
    });

    // Catch-all for any uncaught throw on this socket so the device
    // namespace stays alive even if a future handler is buggy. Node would
    // otherwise terminate the entire process on an emit-from-handler throw.
    socket.on('error', (err) => {
      console.error(`device socket error (id=${socket.id}, dev=${currentDeviceId}):`, err?.message || err);
    });

    // Video wall sync relay. Sender must be a member of the wall it claims —
    // otherwise an authenticated device could inject sync packets into a wall
    // it doesn't belong to (jitter/DoS that wall's playback). Exclusion uses
    // currentDeviceId, never the client-supplied data.device_id.
    socket.on('wall:sync', (data) => {
      try {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const isMember = db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(data.wall_id, currentDeviceId);
      if (!isMember) return;
      const wallDevices = db.prepare(
        'SELECT device_id FROM video_wall_devices WHERE wall_id = ? AND device_id != ?'
      ).all(data.wall_id, currentDeviceId);
      // Stamp device_id with the authenticated id so followers can trust it.
      const payload = { ...data, device_id: currentDeviceId };
      for (const wd of wallDevices) {
        deviceNs.to(wd.device_id).emit('wall:sync', payload);
      }
      } catch (e) {
        console.warn(`wall:sync handler error: ${e.message}`);
      }
    });

    // A follower asks for an immediate position update from the leader.
    // Used on (re)connect so the follower doesn't drift for ~1s waiting on
    // the next periodic wall:sync tick. Server forwards only to the leader,
    // and only when the requester is actually a member of the named wall.
    socket.on('wall:sync-request', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        if (!data?.wall_id) return;
        const isMember = db.prepare(
          'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
        ).get(data.wall_id, currentDeviceId);
        if (!isMember) return;
        const wall = db.prepare('SELECT leader_device_id FROM video_walls WHERE id = ?').get(data.wall_id);
        if (!wall?.leader_device_id || wall.leader_device_id === currentDeviceId) return;
        deviceNs.to(wall.leader_device_id).emit('wall:sync-request', {
          wall_id: data.wall_id,
          requested_by: currentDeviceId,
        });
      } catch (e) {
        console.warn(`wall:sync-request handler error: ${e.message}`);
      }
    });

    socket.on('disconnect', () => {
      if (!currentDeviceId) return;

      // Stale-disconnect guard: a newer socket already took over this device_id
      // via eviction. Skip the offline transition entirely - don't even start a
      // debounce timer.
      const activeConn = heartbeat.getConnection(currentDeviceId);
      if (activeConn && activeConn.socketId !== socket.id) {
        console.log(`Stale disconnect for ${currentDeviceId} (socket ${socket.id}); active is ${activeConn.socketId}, skipping offline`);
        return;
      }

      const deviceId = currentDeviceId;
      const closingSocketId = socket.id;
      console.log(`Device disconnected: ${deviceId} (offline transition deferred ${OFFLINE_DEBOUNCE_MS}ms)`);

      // Defensive: clear any existing timer for this device. Shouldn't happen
      // (register would have cleared it), but if two disconnects fire in
      // sequence we want the second to refresh the window, not double up.
      if (pendingOfflines.has(deviceId)) clearTimeout(pendingOfflines.get(deviceId));

      pendingOfflines.set(deviceId, setTimeout(() => {
        pendingOfflines.delete(deviceId);
        // Re-check at fire time: did a DIFFERENT socket reclaim during the
        // grace window? If activeConn exists but it's still our (now-closed)
        // socket's entry, the entry is just stale - heartbeat.removeConnection
        // hasn't run yet because we defer it inside this same block. Only
        // abort if a genuinely different socket has registered.
        const activeNow = heartbeat.getConnection(deviceId);
        if (activeNow && activeNow.socketId !== closingSocketId) return;

        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?").run(deviceId);
        heartbeat.removeConnection(deviceId);
        logDeviceStatus(deviceId, 'offline');
        emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', { device_id: deviceId, status: 'offline' });

        // If this device was leading a wall, reassign leadership to the next
        // online member so playback stays driven.
        try {
          const wall = db.prepare('SELECT id FROM video_walls WHERE leader_device_id = ?').get(deviceId);
          if (wall) {
            const candidates = db.prepare(`
              SELECT vwd.device_id FROM video_wall_devices vwd
              JOIN devices d ON d.id = vwd.device_id
              WHERE vwd.wall_id = ? AND d.status = 'online' AND vwd.device_id != ?
              ORDER BY vwd.grid_row, vwd.grid_col LIMIT 1
            `).all(wall.id, deviceId);
            const newLeader = candidates[0]?.device_id || null;
            db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(newLeader, wall.id);
            const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wall.id);
            for (const m of members) {
              if (m.device_id !== deviceId) {
                commandQueue.queueOrEmitPlaylistUpdate(deviceNs, m.device_id, buildPlaylistPayload);
              }
            }
          }
        } catch (e) { console.error('Wall leader reassign failed:', e.message); }

        // Save last screenshot to disk as offline snapshot
        const lastB64 = lastScreenshots[deviceId];
        if (lastB64) {
          try {
            const filename = `${deviceId}_latest.jpg`;
            const buffer = Buffer.from(lastB64, 'base64');
            fs.writeFileSync(path.join(config.screenshotsDir, filename), buffer);
            const existing = db.prepare('SELECT id FROM screenshots WHERE device_id = ?').get(deviceId);
            if (existing) {
              db.prepare('UPDATE screenshots SET filepath = ?, captured_at = strftime(\'%s\',\'now\') WHERE device_id = ?').run(filename, deviceId);
            } else {
              db.prepare('INSERT INTO screenshots (device_id, filepath) VALUES (?, ?)').run(deviceId, filename);
            }
          } catch (e) {
            console.error('Failed to save offline screenshot:', e.message);
          }
          delete lastScreenshots[deviceId];
        }
      }, OFFLINE_DEBOUNCE_MS));
    });
  });

  return deviceNs;
};
