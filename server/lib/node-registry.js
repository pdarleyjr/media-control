// node-registry.js — server-side handling for classroom room-agent "nodes"
// (the P3 / podium boxes that run a local read-through content cache).
//
// Scope: this is intentionally small and additive. It records node heartbeats
// into managed_nodes + node_heartbeats (observability) and builds the content
// pre-warm manifest the agent uses to populate its local cache ahead of a
// broadcast. Actual content DELIVERY does not depend on any of this — the agent
// is a read-through proxy and the player falls back to the origin — so a missing
// or stale node row can never affect playback.
//
// Auth: a node presents config.classroomCache.nodeToken in its Socket.IO
// handshake (role:'node'). If no token is configured, node connections are
// rejected (feature stays inert). Tokens are compared in constant time.

const crypto = require('crypto');
const config = require('../config');
const { canonicalAssetPath, queueAssetManifest } = require('./asset-manifest');

function nodeTokenMatches(givenValue, expectedValue) {
  const expected = String(expectedValue || '');
  if (!expected) return false; // no token configured => nodes disabled
  const given = String(givenValue || '');
  if (!given) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function nodeAuthOk(handshakeAuth) {
  const cc = config.classroomCache || {};
  return nodeTokenMatches(handshakeAuth && handshakeAuth.token, cc.nodeToken);
}

function nodeHttpAuthOk(req, classroomCache = config.classroomCache || {}) {
  let token = '';
  try {
    token = req && typeof req.get === 'function'
      ? req.get('x-mbfd-node-token')
      : req && req.headers && req.headers['x-mbfd-node-token'];
  } catch (_) { /* invalid request shape */ }
  return nodeTokenMatches(token, classroomCache.nodeToken);
}

function boundedText(value, max = 256) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeTransfer(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    content_id: boundedText(value.content_id, 128),
    bytes_downloaded: boundedNumber(value.bytes_downloaded ?? value.bytes),
    total_bytes: boundedNumber(value.total_bytes),
    instantaneous_mbps: boundedNumber(value.instantaneous_mbps),
    rolling_average_mbps: boundedNumber(value.rolling_average_mbps ?? value.average_mbps),
    elapsed_ms: boundedNumber(value.elapsed_ms),
    eta_seconds: boundedNumber(value.eta_seconds),
    waiting_players: boundedNumber(value.waiting_players),
    origin_category: boundedText(value.origin_category, 32),
    retries: boundedNumber(value.retries),
    at: boundedNumber(value.at),
  };
}

function normalizeLanHealthTest(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ok: value.ok === true,
    at: boundedNumber(value.at),
    bytes: boundedNumber(value.bytes),
    elapsed_ms: boundedNumber(value.elapsed_ms),
    ttfb_ms: boundedNumber(value.ttfb_ms),
    mbps: boundedNumber(value.mbps),
    status: boundedText(value.status, 32),
    degraded: typeof value.degraded === 'boolean' ? value.degraded : null,
    degraded_reason: boundedText(value.degraded_reason, 128),
    error: boundedText(value.error, 128),
  };
}

function normalizeNodeTelemetry(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sourceCache = p.cache && typeof p.cache === 'object' ? p.cache : {};
  return {
    agent_uptime_sec: boundedNumber(p.agent_uptime_sec),
    kiosk_uptime_sec: boundedNumber(p.kiosk_uptime_sec),
    player_version: boundedText(p.player_version, 128),
    kiosk_version: boundedText(p.kiosk_version, 128),
    build_hash: boundedText(p.build_hash, 128),
    configuration_schema_version: boundedNumber(p.configuration_schema_version),
    cache_health: boundedText(p.cache_health, 32),
    current_asset_readiness: boundedText(p.current_asset_readiness, 32),
    current_renderer: boundedText(p.current_renderer, 64),
    audio_track_present: typeof p.audio_track_present === 'boolean' ? p.audio_track_present : null,
    audio_codec: boundedText(p.audio_codec, 64),
    last_successful_command: boundedText(p.last_successful_command, 128),
    last_command_error: boundedText(p.last_command_error, 256),
    display_mapping: Array.isArray(p.display_mapping)
      ? p.display_mapping.slice(0, 16).map((value) => boundedText(value, 128))
      : [],
    lan_health_test: normalizeLanHealthTest(p.lan_health_test),
    cache: {
      current_content_id: boundedText(sourceCache.current_content_id, 128),
      current_transfer: normalizeTransfer(sourceCache.current_transfer),
      cache_size: boundedNumber(sourceCache.cache_size),
      file_count: boundedNumber(sourceCache.file_count),
      downloading: boundedNumber(sourceCache.downloading),
      queued: boundedNumber(sourceCache.queued),
      sync_status: boundedText(sourceCache.sync_status, 32),
      cache_hits: boundedNumber(sourceCache.cache_hits),
      cache_misses: boundedNumber(sourceCache.cache_misses),
      fill_failures: boundedNumber(sourceCache.fill_failures),
      timeout_count: boundedNumber(sourceCache.timeout_count),
      checksum_failures: boundedNumber(sourceCache.checksum_failures),
      disk_write_failures: boundedNumber(sourceCache.disk_write_failures),
      last_successful_fill: normalizeTransfer(sourceCache.last_successful_fill),
      last_failure_reason: boundedText(sourceCache.last_failure_reason, 256),
      last_failure_type: boundedText(sourceCache.last_failure_type, 64),
      origin_category: boundedText(sourceCache.origin_category, 32),
    },
  };
}

// Upsert managed_nodes + append a node_heartbeats row. All best-effort: any
// error is swallowed so a malformed heartbeat never throws inside the socket
// handler. Returns true on a recorded heartbeat.
function recordHeartbeat(db, nodeId, payload) {
  if (!db || !nodeId) return false;
  const cc = config.classroomCache || {};
  const now = Math.floor(Date.now() / 1000);
  const p = payload || {};
  const activeDisplays = Array.isArray(p.active_displays) ? p.active_displays.join(',') : (p.active_displays || '');
  const networkStateJson = p.network ? JSON.stringify(p.network) : null;
  const telemetryJson = JSON.stringify(normalizeNodeTelemetry(p));
  try {
    db.prepare(`
      INSERT INTO managed_nodes
        (node_id, node_name, node_type, room_id, workspace_id, last_heartbeat,
         software_version, free_disk, cache_size, sync_status, audio_endpoint, network_state_json, telemetry_json, created_at, updated_at)
      VALUES (@node_id, @node_name, @node_type, @room_id, @workspace_id, @ts,
         @software_version, @free_disk, @cache_size, @sync_status, @audio_endpoint, @network_state_json, @telemetry_json, @ts, @ts)
      ON CONFLICT(node_id) DO UPDATE SET
        node_type=excluded.node_type,
        room_id=COALESCE(excluded.room_id, managed_nodes.room_id),
        last_heartbeat=excluded.last_heartbeat,
        software_version=excluded.software_version,
        free_disk=excluded.free_disk,
        cache_size=excluded.cache_size,
        sync_status=excluded.sync_status,
        audio_endpoint=excluded.audio_endpoint,
        network_state_json=excluded.network_state_json,
        telemetry_json=excluded.telemetry_json,
        updated_at=excluded.updated_at
    `).run({
      node_id: nodeId,
      node_name: p.node_name || nodeId,
      node_type: p.node_type || 'p3',
      room_id: cc.roomId || null,
      workspace_id: null,
      ts: now,
      software_version: p.software_version || null,
      free_disk: Number.isFinite(p.free_disk) ? p.free_disk : null,
      cache_size: Number.isFinite(p.cache_size) ? p.cache_size : null,
      sync_status: p.sync_status || 'idle',
      audio_endpoint: p.audio_endpoint || null,
      network_state_json: networkStateJson,
      telemetry_json: telemetryJson,
    });
  } catch (e) {
    // managed_nodes may be absent on very old DBs — degrade silently.
    return false;
  }
  try {
    db.prepare(`
      INSERT INTO node_heartbeats (node_id, ts, software_version, free_disk, cache_size, sync_status, active_displays, audio_endpoint, network_state_json, telemetry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, now, p.software_version || null,
      Number.isFinite(p.free_disk) ? p.free_disk : null,
      Number.isFinite(p.cache_size) ? p.cache_size : null,
      p.sync_status || 'idle', activeDisplays, p.audio_endpoint || null, networkStateJson, telemetryJson);
    // Keep the history bounded (last ~7 days).
    db.prepare("DELETE FROM node_heartbeats WHERE ts < strftime('%s','now') - 604800").run();
  } catch (e) { /* analytics table optional */ }
  return true;
}

// Build the content pre-warm manifest for the classroom node: every local-file
// content row that the classroom should have cached. The agent read-through
// cache is keyed by content_id, so the manifest is a simple content-id list
// (size_bytes included as a hint). We include ALL library content that has a
// filepath (so "existing content" is staged) — new uploads are added by a
// re-push on upload and are also cached on first broadcast via read-through.
function buildContentManifest(db, options = {}) {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT c.id AS content_id, c.file_size AS size_bytes, c.mime_type,
             c.created_at, c.updated_at, a.computed_at,
             a.asset_id, a.sha256, a.size_bytes AS canonical_size
      FROM content c
      LEFT JOIN asset_checksums a ON a.content_id = c.id
      WHERE c.filepath IS NOT NULL AND c.filepath <> ''
    `).all();
    rows.sort((a, b) => {
      const aVideo = String(a.mime_type || '').startsWith('video/') ? 0 : 1;
      const bVideo = String(b.mime_type || '').startsWith('video/') ? 0 : 1;
      if (aVideo !== bVideo) return aVideo - bVideo;
      const aTime = Number(a.updated_at || a.created_at || a.computed_at) || 0;
      const bTime = Number(b.updated_at || b.created_at || b.computed_at) || 0;
      if (aTime !== bTime) return bTime - aTime;
      return String(a.content_id || '').localeCompare(String(b.content_id || ''));
    });
    const manifest = [];
    for (const row of rows) {
      if (!/^[0-9a-f]{64}$/i.test(String(row.sha256 || ''))) {
        if (options.queueMissing !== false) queueAssetManifest(db, row.content_id);
        continue;
      }
      const size = row.canonical_size || row.size_bytes || null;
      manifest.push({
        asset_id: row.asset_id || row.content_id,
        content_id: row.content_id,
        sha256: row.sha256,
        size,
        size_bytes: size,
        canonical_url: canonicalAssetPath(row.content_id),
      });
    }
    return manifest;
  } catch (e) {
    console.warn('[node-registry] manifest build failed:', e.message);
    return [];
  }
}

function requestContentPrewarm(io, db, options = {}) {
  const deviceIds = [...new Set((options.deviceIds || []).filter(Boolean).map(String))];
  const contentId = String(options.contentId || '');
  const cc = options.classroomCache || config.classroomCache || {};
  if (!cc.enabled || !contentId || deviceIds.length === 0 || !Array.isArray(cc.wallIds) || cc.wallIds.length === 0) {
    return { requested: false, reason: 'cache_disabled' };
  }

  try {
    const deviceSlots = deviceIds.map(() => '?').join(',');
    const wallSlots = cc.wallIds.map(() => '?').join(',');
    const cachedTarget = db.prepare(`
      SELECT 1 AS found
      FROM video_wall_devices
      WHERE device_id IN (${deviceSlots}) AND wall_id IN (${wallSlots})
      LIMIT 1
    `).get(...deviceIds, ...cc.wallIds);
    if (!cachedTarget) return { requested: false, reason: 'targets_not_cached' };

    const item = buildContentManifest(db, { queueMissing: true })
      .find((entry) => entry.content_id === contentId);
    if (!item) return { requested: false, reason: 'manifest_pending' };
    if (!io || typeof io.of !== 'function') return { requested: false, reason: 'socket_unavailable' };

    const nodeId = String(cc.nodeId || 'classroom-1-p3');
    io.of('/device').to(`node:${nodeId}`).emit('node:prewarm-content', item);
    return { requested: true, node_id: nodeId, content_id: contentId };
  } catch (error) {
    return { requested: false, reason: 'prewarm_error', error: error.message };
  }
}

module.exports = {
  buildContentManifest,
  nodeAuthOk,
  nodeHttpAuthOk,
  normalizeNodeTelemetry,
  recordHeartbeat,
  requestContentPrewarm,
};
