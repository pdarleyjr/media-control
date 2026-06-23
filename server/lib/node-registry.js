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

function nodeAuthOk(handshakeAuth) {
  const cc = config.classroomCache || {};
  const expected = String(cc.nodeToken || '');
  if (!expected) return false; // no token configured => nodes disabled
  const given = String((handshakeAuth && handshakeAuth.token) || '');
  if (!given) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
  try {
    db.prepare(`
      INSERT INTO managed_nodes
        (node_id, node_name, node_type, room_id, workspace_id, last_heartbeat,
         software_version, free_disk, cache_size, sync_status, audio_endpoint, created_at, updated_at)
      VALUES (@node_id, @node_name, @node_type, @room_id, @workspace_id, @ts,
         @software_version, @free_disk, @cache_size, @sync_status, @audio_endpoint, @ts, @ts)
      ON CONFLICT(node_id) DO UPDATE SET
        node_type=excluded.node_type,
        room_id=COALESCE(excluded.room_id, managed_nodes.room_id),
        last_heartbeat=excluded.last_heartbeat,
        software_version=excluded.software_version,
        free_disk=excluded.free_disk,
        cache_size=excluded.cache_size,
        sync_status=excluded.sync_status,
        audio_endpoint=excluded.audio_endpoint,
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
    });
  } catch (e) {
    // managed_nodes may be absent on very old DBs — degrade silently.
    return false;
  }
  try {
    db.prepare(`
      INSERT INTO node_heartbeats (node_id, ts, software_version, free_disk, cache_size, sync_status, active_displays, audio_endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, now, p.software_version || null,
      Number.isFinite(p.free_disk) ? p.free_disk : null,
      Number.isFinite(p.cache_size) ? p.cache_size : null,
      p.sync_status || 'idle', activeDisplays, p.audio_endpoint || null);
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
function buildContentManifest(db) {
  if (!db) return [];
  try {
    const rows = db.prepare(
      "SELECT id AS content_id, file_size AS size_bytes FROM content WHERE filepath IS NOT NULL AND filepath <> ''"
    ).all();
    return rows.map((r) => ({ content_id: r.content_id, size_bytes: r.size_bytes || null }));
  } catch (e) {
    return [];
  }
}

module.exports = { nodeAuthOk, recordHeartbeat, buildContentManifest };
