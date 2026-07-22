'use strict';

// Authoritative, restart-safe room state contract. The service is deliberately
// transport-agnostic: Socket.IO and REST callers can share the same snapshot
// builder, while tests can inject a better-sqlite3 database and explicit
// OBS/recording state without loading the production singleton.

const ROOM_SNAPSHOT_SCHEMA_VERSION = 1;
const LIVE_STREAM_DEVICE_PREFIX = 'live-stream-program-';
const revisionSchemaReady = new WeakSet();

// Every object that crosses the room-state boundary is shaped against one of
// these schemas. Unknown properties are discarded even when their names do not
// look secret; a deny-list alone cannot prevent a credential hidden under an
// innocuous or newly introduced property name from reaching dashboards.
const PUBLIC_SCALAR = true;
const PUBLIC_CAPABILITIES = Symbol('public-capabilities');
const PUBLIC_CAPABILITY_KEYS = new Set([
  'audio', 'content', 'dash', 'hls', 'image', 'pdf', 'presentation',
  'preview', 'screen_share', 'screenshare', 'video', 'webrtc', 'whiteboard',
]);
const CONFIRMED_DISPLAY_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, status: PUBLIC_SCALAR,
  contentId: PUBLIC_SCALAR, assetId: PUBLIC_SCALAR, contentType: PUBLIC_SCALAR,
  layoutMode: PUBLIC_SCALAR, slideIndex: PUBLIC_SCALAR, slideCount: PUBLIC_SCALAR,
  currentTime: PUBLIC_SCALAR, duration: PUBLIC_SCALAR, paused: PUBLIC_SCALAR,
  muted: PUBLIC_SCALAR, volume: PUBLIC_SCALAR, localAssetReady: PUBLIC_SCALAR,
  lastAckAt: PUBLIC_SCALAR, lastHeartbeatAt: PUBLIC_SCALAR,
  renderState: PUBLIC_SCALAR, errorState: PUBLIC_SCALAR, wallId: PUBLIC_SCALAR,
  layoutId: PUBLIC_SCALAR, groupId: PUBLIC_SCALAR, memberId: PUBLIC_SCALAR,
  playbackRevision: PUBLIC_SCALAR, commandRevision: PUBLIC_SCALAR,
  stateRevision: PUBLIC_SCALAR, updatedAt: PUBLIC_SCALAR,
};
const COMMAND_SCHEMA = {
  commandId: PUBLIC_SCALAR, targetType: PUBLIC_SCALAR, targetId: PUBLIC_SCALAR,
  commandType: PUBLIC_SCALAR, revision: PUBLIC_SCALAR,
  parentCommandId: PUBLIC_SCALAR, createdAt: PUBLIC_SCALAR,
  requiresAck: PUBLIC_SCALAR, ackDeadline: PUBLIC_SCALAR, status: PUBLIC_SCALAR,
  ackAt: PUBLIC_SCALAR, error: PUBLIC_SCALAR,
};
const DEVICE_DISPLAY_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, status: PUBLIC_SCALAR,
  lastHeartbeat: PUBLIC_SCALAR, screenOn: PUBLIC_SCALAR, width: PUBLIC_SCALAR,
  height: PUBLIC_SCALAR, wallId: PUBLIC_SCALAR, layoutId: PUBLIC_SCALAR,
  playlistId: PUBLIC_SCALAR, capabilities: PUBLIC_CAPABILITIES,
  updatedAt: PUBLIC_SCALAR,
};
const NETWORK_STATE_SCHEMA = {
  adapter_name: PUBLIC_SCALAR, adapter_description: PUBLIC_SCALAR,
  adapter_type: PUBLIC_SCALAR, interface_name: PUBLIC_SCALAR,
  link_speed: PUBLIC_SCALAR, link_speed_bps: PUBLIC_SCALAR,
  link_speed_display: PUBLIC_SCALAR, duplex: PUBLIC_SCALAR,
  link_status: PUBLIC_SCALAR, server_url_category: PUBLIC_SCALAR,
  selected_server_url_category: PUBLIC_SCALAR, reachability: PUBLIC_SCALAR,
  interface_errors: PUBLIC_SCALAR, interface_discards: PUBLIC_SCALAR,
  degraded: PUBLIC_SCALAR, degraded_reason: PUBLIC_SCALAR,
  wired: PUBLIC_SCALAR, ethernet: PUBLIC_SCALAR,
  ipv4_address: PUBLIC_SCALAR, address_family: PUBLIC_SCALAR,
  gateway_reachable: PUBLIC_SCALAR, server_reachable: PUBLIC_SCALAR,
  measured_at: PUBLIC_SCALAR,
};
const TRANSFER_SCHEMA = {
  content_id: PUBLIC_SCALAR, bytes_downloaded: PUBLIC_SCALAR,
  total_bytes: PUBLIC_SCALAR, instantaneous_mbps: PUBLIC_SCALAR,
  rolling_average_mbps: PUBLIC_SCALAR, elapsed_ms: PUBLIC_SCALAR,
  eta_seconds: PUBLIC_SCALAR, waiting_players: PUBLIC_SCALAR,
  origin_category: PUBLIC_SCALAR, retries: PUBLIC_SCALAR, at: PUBLIC_SCALAR,
};
const LAN_HEALTH_SCHEMA = {
  ok: PUBLIC_SCALAR, at: PUBLIC_SCALAR, bytes: PUBLIC_SCALAR,
  elapsed_ms: PUBLIC_SCALAR, ttfb_ms: PUBLIC_SCALAR, mbps: PUBLIC_SCALAR,
  status: PUBLIC_SCALAR, degraded: PUBLIC_SCALAR,
  degraded_reason: PUBLIC_SCALAR, error: PUBLIC_SCALAR,
};
const NODE_TELEMETRY_SCHEMA = {
  agent_uptime_sec: PUBLIC_SCALAR, kiosk_uptime_sec: PUBLIC_SCALAR,
  player_version: PUBLIC_SCALAR, kiosk_version: PUBLIC_SCALAR,
  build_hash: PUBLIC_SCALAR, configuration_schema_version: PUBLIC_SCALAR,
  cache_health: PUBLIC_SCALAR, current_asset_readiness: PUBLIC_SCALAR,
  current_renderer: PUBLIC_SCALAR, audio_track_present: PUBLIC_SCALAR,
  audio_codec: PUBLIC_SCALAR, last_successful_command: PUBLIC_SCALAR,
  last_command_error: PUBLIC_SCALAR, display_mapping: [PUBLIC_SCALAR],
  lan_health_test: LAN_HEALTH_SCHEMA,
  cache: {
    current_content_id: PUBLIC_SCALAR, current_transfer: TRANSFER_SCHEMA,
    cache_size: PUBLIC_SCALAR, file_count: PUBLIC_SCALAR,
    manifest_count: PUBLIC_SCALAR, cached_manifest_count: PUBLIC_SCALAR,
    missing_manifest_count: PUBLIC_SCALAR, downloading: PUBLIC_SCALAR,
    queued: PUBLIC_SCALAR, sync_status: PUBLIC_SCALAR,
    cache_hits: PUBLIC_SCALAR, cache_misses: PUBLIC_SCALAR,
    fill_failures: PUBLIC_SCALAR, timeout_count: PUBLIC_SCALAR,
    checksum_failures: PUBLIC_SCALAR, disk_write_failures: PUBLIC_SCALAR,
    last_successful_fill: TRANSFER_SCHEMA, last_failure_reason: PUBLIC_SCALAR,
    last_failure_type: PUBLIC_SCALAR, origin_category: PUBLIC_SCALAR,
  },
};
const NODE_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, type: PUBLIC_SCALAR,
  roomId: PUBLIC_SCALAR, lastHeartbeat: PUBLIC_SCALAR,
  softwareVersion: PUBLIC_SCALAR, freeDisk: PUBLIC_SCALAR,
  cacheSize: PUBLIC_SCALAR, syncStatus: PUBLIC_SCALAR,
  audioEndpoint: PUBLIC_SCALAR, networkState: NETWORK_STATE_SCHEMA,
  telemetry: NODE_TELEMETRY_SCHEMA, updatedAt: PUBLIC_SCALAR,
};
const VIEWPORT_SCHEMA = {
  x: PUBLIC_SCALAR, y: PUBLIC_SCALAR, width: PUBLIC_SCALAR, height: PUBLIC_SCALAR,
};
const PLAYER_RECT_SCHEMA = {
  x: PUBLIC_SCALAR, y: PUBLIC_SCALAR, width: PUBLIC_SCALAR, height: PUBLIC_SCALAR,
};
const WALL_MEMBER_SCHEMA = {
  deviceId: PUBLIC_SCALAR, gridColumn: PUBLIC_SCALAR, gridRow: PUBLIC_SCALAR,
  rotation: PUBLIC_SCALAR, viewport: VIEWPORT_SCHEMA,
  displayWidth: PUBLIC_SCALAR, displayHeight: PUBLIC_SCALAR,
};
const STORED_LAYOUT_GROUP_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, layout: PUBLIC_SCALAR,
  member_ids: [PUBLIC_SCALAR], leader_device_id: PUBLIC_SCALAR,
  configured_leader_device_id: PUBLIC_SCALAR,
  leader_failover_active: PUBLIC_SCALAR,
  geometry: { columns: PUBLIC_SCALAR, rows: PUBLIC_SCALAR },
  playlist_id: PUBLIC_SCALAR,
  audio_policy: { mode: PUBLIC_SCALAR },
};
const STORED_LAYOUT_SCHEMA = {
  version: PUBLIC_SCALAR, id: PUBLIC_SCALAR, wall_id: PUBLIC_SCALAR,
  mode: PUBLIC_SCALAR, revision: PUBLIC_SCALAR, preset: PUBLIC_SCALAR,
  source: PUBLIC_SCALAR, groups: [STORED_LAYOUT_GROUP_SCHEMA],
};
const WALL_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, gridColumns: PUBLIC_SCALAR,
  gridRows: PUBLIC_SCALAR, syncMode: PUBLIC_SCALAR, layoutMode: PUBLIC_SCALAR,
  locked: PUBLIC_SCALAR, leaderDeviceId: PUBLIC_SCALAR,
  contentId: PUBLIC_SCALAR, playlistId: PUBLIC_SCALAR,
  playerRect: PLAYER_RECT_SCHEMA,
  layoutRevision: PUBLIC_SCALAR, layout: STORED_LAYOUT_SCHEMA,
  members: [WALL_MEMBER_SCHEMA], updatedAt: PUBLIC_SCALAR,
};
const DEVICE_GROUP_SCHEMA = {
  id: PUBLIC_SCALAR, name: PUBLIC_SCALAR, color: PUBLIC_SCALAR,
  playlistId: PUBLIC_SCALAR, memberIds: [PUBLIC_SCALAR],
};
const CLASSROOM_TARGET_SCHEMA = {
  id: PUBLIC_SCALAR, contentId: PUBLIC_SCALAR, contentType: PUBLIC_SCALAR,
  layoutMode: PUBLIC_SCALAR, wallId: PUBLIC_SCALAR, renderState: PUBLIC_SCALAR,
  paused: PUBLIC_SCALAR, stateRevision: PUBLIC_SCALAR,
};
const LIVESTREAM_PROGRAM_SCHEMA = {
  configured: PUBLIC_SCALAR, displayId: PUBLIC_SCALAR, displayName: PUBLIC_SCALAR,
  status: PUBLIC_SCALAR, playlistId: PUBLIC_SCALAR, width: PUBLIC_SCALAR,
  height: PUBLIC_SCALAR, contentId: PUBLIC_SCALAR, assetId: PUBLIC_SCALAR,
  contentType: PUBLIC_SCALAR, layoutMode: PUBLIC_SCALAR, paused: PUBLIC_SCALAR,
  muted: PUBLIC_SCALAR, renderState: PUBLIC_SCALAR, errorState: PUBLIC_SCALAR,
  stateRevision: PUBLIC_SCALAR, updatedAt: PUBLIC_SCALAR,
};
const RECORDING_STATE_SCHEMA = {
  status: PUBLIC_SCALAR, active: PUBLIC_SCALAR, available: PUBLIC_SCALAR,
  reachable: PUBLIC_SCALAR,
  stale: PUBLIC_SCALAR, startedAt: PUBLIC_SCALAR, stoppedAt: PUBLIC_SCALAR,
  updatedAt: PUBLIC_SCALAR, checkedAt: PUBLIC_SCALAR,
  lastCheckedAt: PUBLIC_SCALAR,
  durationSeconds: PUBLIC_SCALAR, filename: PUBLIC_SCALAR,
  service: PUBLIC_SCALAR, error: PUBLIC_SCALAR,
};
const STREAM_STATE_SCHEMA = {
  status: PUBLIC_SCALAR, active: PUBLIC_SCALAR, available: PUBLIC_SCALAR,
  reachable: PUBLIC_SCALAR,
  stale: PUBLIC_SCALAR, currentScene: PUBLIC_SCALAR, mode: PUBLIC_SCALAR,
  activeCamera: PUBLIC_SCALAR,
  viewers: PUBLIC_SCALAR, bitrateKbps: PUBLIC_SCALAR,
  droppedFrames: PUBLIC_SCALAR, startedAt: PUBLIC_SCALAR,
  stoppedAt: PUBLIC_SCALAR, updatedAt: PUBLIC_SCALAR,
  checkedAt: PUBLIC_SCALAR, lastCheckedAt: PUBLIC_SCALAR,
  service: PUBLIC_SCALAR, error: PUBLIC_SCALAR,
};
const CONFIRMED_STATE_SCHEMA = { displays: [CONFIRMED_DISPLAY_SCHEMA] };
const DEVICE_STATES_SCHEMA = {
  displays: [DEVICE_DISPLAY_SCHEMA],
  nodes: [NODE_SCHEMA],
};
const LAYOUT_STATE_SCHEMA = {
  walls: [WALL_SCHEMA],
  groups: [DEVICE_GROUP_SCHEMA],
};
const CLASSROOM_PROGRAM_SCHEMA = { targets: [CLASSROOM_TARGET_SCHEMA] };

function requireDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('A better-sqlite3 database is required');
  }
  return db;
}

function normalizeIdentity(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${name} is required`);
  if (normalized.length > 255) throw new RangeError(`${name} is too long`);
  return normalized;
}

function ensureRoomRevisionSchema(db) {
  const database = requireDatabase(db);
  if (revisionSchemaReady.has(database)) return database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_state_revisions (
      workspace_id TEXT NOT NULL,
      room_id      TEXT NOT NULL,
      revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      last_reason  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, room_id)
    );
    CREATE INDEX IF NOT EXISTS idx_room_state_revisions_updated
      ON room_state_revisions(updated_at DESC);
  `);
  revisionSchemaReady.add(database);
  return database;
}

function revisionIdentity(workspaceId, roomId) {
  return {
    workspaceId: normalizeIdentity(workspaceId, 'workspaceId'),
    roomId: normalizeIdentity(roomId, 'roomId'),
  };
}

function ensureRevisionRow(db, workspaceId, roomId, now = Date.now()) {
  ensureRoomRevisionSchema(db);
  db.prepare(`
    INSERT OR IGNORE INTO room_state_revisions
      (workspace_id, room_id, revision, last_reason, created_at, updated_at)
    VALUES (?, ?, 0, NULL, ?, ?)
  `).run(workspaceId, roomId, now, now);
}

function getRoomRevision(db, workspaceId, roomId) {
  requireDatabase(db);
  const identity = revisionIdentity(workspaceId, roomId);
  ensureRevisionRow(db, identity.workspaceId, identity.roomId);
  const row = db.prepare(`
    SELECT revision
    FROM room_state_revisions
    WHERE workspace_id = ? AND room_id = ?
  `).get(identity.workspaceId, identity.roomId);
  return Number(row?.revision) || 0;
}

function bumpRoomRevision(db, workspaceId, roomId, reason = null) {
  requireDatabase(db);
  const identity = revisionIdentity(workspaceId, roomId);
  const safeReason = reason == null ? null : String(reason).trim().slice(0, 160) || null;
  const tx = db.transaction(() => {
    const now = Date.now();
    ensureRevisionRow(db, identity.workspaceId, identity.roomId, now);
    db.prepare(`
      UPDATE room_state_revisions
      SET revision = revision + 1, last_reason = ?, updated_at = ?
      WHERE workspace_id = ? AND room_id = ?
    `).run(safeReason, now, identity.workspaceId, identity.roomId);
    return db.prepare(`
      SELECT revision
      FROM room_state_revisions
      WHERE workspace_id = ? AND room_id = ?
    `).get(identity.workspaceId, identity.roomId).revision;
  });
  return Number(tx());
}

function sanitizePublicScalar(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function sanitizePublicCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, rawSupport] of Object.entries(value)) {
    if (!PUBLIC_CAPABILITY_KEYS.has(key)) continue;
    if (typeof rawSupport === 'boolean') {
      result[key] = rawSupport;
    } else if (rawSupport === 0 || rawSupport === 1) {
      result[key] = rawSupport === 1;
    } else if (rawSupport === 'supported' || rawSupport === 'true') {
      result[key] = true;
    } else if (rawSupport === 'unsupported' || rawSupport === 'false') {
      result[key] = false;
    }
  }
  return result;
}

function sanitizePublicState(value, schema) {
  if (schema === PUBLIC_SCALAR) return sanitizePublicScalar(value);
  if (schema === PUBLIC_CAPABILITIES) return sanitizePublicCapabilities(value);
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => sanitizePublicState(entry, schema[0]))
      .filter((entry) => entry !== undefined);
  }
  if (!schema || typeof schema !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return value == null ? value : undefined;
  }
  const result = {};
  for (const [key, childSchema] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const safe = sanitizePublicState(value[key], childSchema);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function boolOrNull(value) {
  return value == null ? null : !!value;
}

function parsePublicJson(value, fallback, schema) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const shaped = sanitizePublicState(JSON.parse(value), schema);
    return shaped === undefined ? fallback : shaped;
  } catch {
    return fallback;
  }
}

function loadConfirmedState(db, workspaceId) {
  const rows = db.prepare(`
    SELECT d.id AS target_id, d.name, d.status, d.last_heartbeat,
           ds.current_content_id, ds.current_asset_id, ds.content_type,
           ds.layout_mode, ds.slide_index, ds.slide_count, ds.current_time, ds.duration,
           ds.paused, ds.muted, ds.volume, ds.local_asset_ready, ds.last_ack_at,
           ds.last_heartbeat_at, ds.render_state, ds.error_state, ds.wall_id,
           ds.layout_id, ds.group_id, ds.member_id, ds.playback_revision,
           ds.command_revision, ds.state_revision, ds.updated_at
    FROM devices d
    LEFT JOIN display_states ds
      ON ds.target_type = 'display' AND ds.target_id = d.id
    WHERE d.workspace_id = ?
      AND d.id NOT LIKE ?
    ORDER BY d.name COLLATE NOCASE, d.id
  `).all(workspaceId, `${LIVE_STREAM_DEVICE_PREFIX}%`);
  return {
    displays: rows.map((row) => ({
      id: row.target_id,
      name: row.name || row.target_id,
      status: row.status || 'offline',
      contentId: row.current_content_id ?? null,
      assetId: row.current_asset_id ?? null,
      contentType: row.content_type ?? null,
      layoutMode: row.layout_mode ?? null,
      slideIndex: row.slide_index ?? null,
      slideCount: row.slide_count ?? null,
      currentTime: row.current_time ?? null,
      duration: row.duration ?? null,
      paused: boolOrNull(row.paused),
      muted: boolOrNull(row.muted),
      volume: row.volume ?? null,
      localAssetReady: boolOrNull(row.local_asset_ready),
      lastAckAt: row.last_ack_at ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? row.last_heartbeat ?? null,
      renderState: row.render_state ?? null,
      errorState: row.error_state ?? null,
      wallId: row.wall_id ?? null,
      layoutId: row.layout_id ?? null,
      groupId: row.group_id ?? null,
      memberId: row.member_id ?? null,
      playbackRevision: row.playback_revision ?? null,
      commandRevision: row.command_revision ?? null,
      stateRevision: Number(row.state_revision) || 0,
      updatedAt: row.updated_at ?? null,
    })),
  };
}

function loadDeviceStates(db, workspaceId, roomId) {
  const displays = db.prepare(`
    SELECT id, name, status, last_heartbeat, screen_on, screen_width, screen_height,
           wall_id, layout_id, playlist_id, capabilities_json, updated_at
    FROM devices
    WHERE workspace_id = ? AND id NOT LIKE ?
    ORDER BY name COLLATE NOCASE, id
  `).all(workspaceId, `${LIVE_STREAM_DEVICE_PREFIX}%`).map((row) => ({
    id: row.id,
    name: row.name || row.id,
    status: row.status || 'offline',
    lastHeartbeat: row.last_heartbeat ?? null,
    screenOn: boolOrNull(row.screen_on),
    width: row.screen_width ?? null,
    height: row.screen_height ?? null,
    wallId: row.wall_id ?? null,
    layoutId: row.layout_id ?? null,
    playlistId: row.playlist_id ?? null,
    capabilities: parsePublicJson(row.capabilities_json, {}, PUBLIC_CAPABILITIES),
    updatedAt: row.updated_at ?? null,
  }));

  const nodes = db.prepare(`
    SELECT node_id, node_name, node_type, room_id, last_heartbeat, software_version,
           free_disk, cache_size, sync_status, audio_endpoint, network_state_json,
           telemetry_json, updated_at
    FROM managed_nodes
    WHERE workspace_id = ? AND room_id = ?
    ORDER BY node_name COLLATE NOCASE, node_id
  `).all(workspaceId, roomId).map((row) => ({
    id: row.node_id,
    name: row.node_name || row.node_id,
    type: row.node_type || null,
    roomId: row.room_id,
    lastHeartbeat: row.last_heartbeat ?? null,
    softwareVersion: row.software_version || null,
    freeDisk: row.free_disk ?? null,
    cacheSize: row.cache_size ?? null,
    syncStatus: row.sync_status || 'unknown',
    audioEndpoint: row.audio_endpoint || null,
    networkState: parsePublicJson(row.network_state_json, null, NETWORK_STATE_SCHEMA),
    telemetry: parsePublicJson(row.telemetry_json, null, NODE_TELEMETRY_SCHEMA),
    updatedAt: row.updated_at ?? null,
  }));

  return { displays, nodes };
}

function loadLayoutState(db, workspaceId) {
  const memberRows = db.prepare(`
    SELECT vwd.wall_id, vwd.device_id, vwd.grid_col, vwd.grid_row, vwd.rotation,
           vwd.canvas_x, vwd.canvas_y, vwd.canvas_width, vwd.canvas_height,
           d.screen_width, d.screen_height
    FROM video_wall_devices vwd
    INNER JOIN video_walls vw ON vw.id = vwd.wall_id
    INNER JOIN devices d ON d.id = vwd.device_id
    WHERE vw.workspace_id = ?
    ORDER BY vwd.wall_id, vwd.grid_row, vwd.grid_col, vwd.device_id
  `).all(workspaceId);
  const membersByWall = new Map();
  for (const row of memberRows) {
    if (!membersByWall.has(row.wall_id)) membersByWall.set(row.wall_id, []);
    membersByWall.get(row.wall_id).push({
      deviceId: row.device_id,
      gridColumn: row.grid_col,
      gridRow: row.grid_row,
      rotation: row.rotation ?? 0,
      viewport: {
        x: row.canvas_x ?? null,
        y: row.canvas_y ?? null,
        width: row.canvas_width ?? row.screen_width ?? null,
        height: row.canvas_height ?? row.screen_height ?? null,
      },
      displayWidth: row.screen_width ?? null,
      displayHeight: row.screen_height ?? null,
    });
  }

  const walls = db.prepare(`
    SELECT id, name, grid_cols, grid_rows, sync_mode, layout_mode, is_locked,
           leader_device_id, content_id, playlist_id,
           player_x, player_y, player_width, player_height, layout_json,
           layout_revision, updated_at
    FROM video_walls
    WHERE workspace_id = ?
    ORDER BY name COLLATE NOCASE, id
  `).all(workspaceId).map((row) => ({
    id: row.id,
    name: row.name || row.id,
    gridColumns: row.grid_cols,
    gridRows: row.grid_rows,
    syncMode: row.sync_mode || null,
    layoutMode: row.layout_mode || null,
    locked: !!row.is_locked,
    leaderDeviceId: row.leader_device_id ?? null,
    contentId: row.content_id ?? null,
    playlistId: row.playlist_id ?? null,
    playerRect: [row.player_x, row.player_y, row.player_width, row.player_height]
      .every((value) => value == null)
      ? null
      : {
        x: row.player_x ?? null,
        y: row.player_y ?? null,
        width: row.player_width ?? null,
        height: row.player_height ?? null,
      },
    layoutRevision: Number(row.layout_revision) || 0,
    layout: parsePublicJson(row.layout_json, null, STORED_LAYOUT_SCHEMA),
    members: membersByWall.get(row.id) || [],
    updatedAt: row.updated_at ?? null,
  }));

  const groupMemberRows = db.prepare(`
    SELECT dgm.group_id, dgm.device_id
    FROM device_group_members dgm
    INNER JOIN device_groups dg ON dg.id = dgm.group_id
    WHERE dg.workspace_id = ?
    ORDER BY dgm.group_id, dgm.device_id
  `).all(workspaceId);
  const membersByGroup = new Map();
  for (const row of groupMemberRows) {
    if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
    membersByGroup.get(row.group_id).push(row.device_id);
  }
  const groups = db.prepare(`
    SELECT id, name, color, playlist_id
    FROM device_groups
    WHERE workspace_id = ?
    ORDER BY name COLLATE NOCASE, id
  `).all(workspaceId).map((row) => ({
    id: row.id,
    name: row.name || row.id,
    color: row.color || null,
    playlistId: row.playlist_id ?? null,
    memberIds: membersByGroup.get(row.id) || [],
  }));

  return { walls, groups };
}

function loadCommands(db, workspaceId, roomId) {
  const scopedTargetSql = `
    (
      ((cl.target_type = 'display' OR cl.target_type = 'live-program') AND (
        EXISTS (SELECT 1 FROM devices d WHERE d.id = cl.target_id AND d.workspace_id = ?)
        OR (cl.target_type = 'live-program' AND cl.target_id = ?)
      ))
      OR (cl.target_type = 'wall' AND EXISTS (
        SELECT 1 FROM video_walls vw WHERE vw.id = cl.target_id AND vw.workspace_id = ?
      ))
      OR (cl.target_type = 'group' AND EXISTS (
        SELECT 1 FROM device_groups dg WHERE dg.id = cl.target_id AND dg.workspace_id = ?
      ))
      OR (cl.target_type = 'node' AND EXISTS (
        SELECT 1 FROM managed_nodes mn
        WHERE mn.node_id = cl.target_id AND mn.workspace_id = ? AND mn.room_id = ?
      ))
    )
  `;
  const selectFields = `
    SELECT cl.command_id, cl.target_type, cl.target_id, cl.command_type,
           cl.revision, cl.parent_command_id, cl.created_at, cl.requires_ack,
           cl.ack_deadline, cl.status, cl.ack_at, cl.ack_error
    FROM command_logs cl`;
  const parameters = [workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, roomId];
  // Pending work and historical cursor are intentionally separate. A fixed
  // mixed-status history window can otherwise hide a still-unacknowledged
  // command during a burst of newer successful commands.
  const pendingRows = db.prepare(`
    ${selectFields}
    WHERE cl.status = 'sent' AND ${scopedTargetSql}
    ORDER BY cl.created_at DESC, cl.rowid DESC
  `).all(...parameters);
  const lastRow = db.prepare(`
    ${selectFields}
    WHERE ${scopedTargetSql}
    ORDER BY cl.created_at DESC, cl.rowid DESC
    LIMIT 1
  `).get(...parameters);
  const mapCommand = (row) => ({
    commandId: row.command_id,
    targetType: row.target_type,
    targetId: row.target_id,
    commandType: row.command_type,
    revision: Number(row.revision) || 0,
    parentCommandId: row.parent_command_id ?? null,
    createdAt: row.created_at ?? null,
    requiresAck: !!row.requires_ack,
    ackDeadline: row.ack_deadline ?? null,
    status: row.status || 'unknown',
    ackAt: row.ack_at ?? null,
    error: row.ack_error ?? null,
  });
  return {
    pending: pendingRows.map(mapCommand),
    lastCommandId: lastRow?.command_id || null,
  };
}

function deriveClassroomProgram(confirmedState) {
  const displays = Array.isArray(confirmedState?.displays) ? confirmedState.displays : [];
  return {
    targets: displays.map((display) => ({
      id: display.id,
      contentId: display.contentId ?? null,
      contentType: display.contentType ?? null,
      layoutMode: display.layoutMode ?? null,
      wallId: display.wallId ?? null,
      renderState: display.renderState ?? null,
      paused: display.paused ?? null,
      stateRevision: display.stateRevision ?? 0,
    })),
  };
}

function loadLivestreamProgram(db, workspaceId) {
  const row = db.prepare(`
    SELECT d.id, d.name, d.status, d.playlist_id, d.screen_width, d.screen_height,
           ds.current_content_id, ds.current_asset_id, ds.content_type,
           ds.layout_mode, ds.paused, ds.muted, ds.render_state,
           ds.error_state, ds.state_revision, ds.updated_at
    FROM devices d
    LEFT JOIN display_states ds
      ON ds.target_type = 'display' AND ds.target_id = d.id
    WHERE d.workspace_id = ? AND d.id LIKE ?
    ORDER BY d.updated_at DESC, d.id
    LIMIT 1
  `).get(workspaceId, `${LIVE_STREAM_DEVICE_PREFIX}%`);
  if (!row) return null;
  return {
    configured: true,
    displayId: row.id,
    displayName: row.name || row.id,
    status: row.status || 'offline',
    playlistId: row.playlist_id ?? null,
    width: row.screen_width ?? null,
    height: row.screen_height ?? null,
    contentId: row.current_content_id ?? null,
    assetId: row.current_asset_id ?? null,
    contentType: row.content_type ?? null,
    layoutMode: row.layout_mode ?? null,
    paused: boolOrNull(row.paused),
    muted: boolOrNull(row.muted),
    renderState: row.render_state ?? null,
    errorState: row.error_state ?? null,
    stateRevision: Number(row.state_revision) || 0,
    updatedAt: row.updated_at ?? null,
  };
}

function stateOrDefault(override, loader) {
  return override !== undefined ? override : loader();
}

function shapeRecord(value, schema, defaults = {}) {
  const shaped = sanitizePublicState(value, schema);
  return shaped && typeof shaped === 'object' && !Array.isArray(shaped)
    ? { ...defaults, ...shaped }
    : { ...defaults };
}

function shapeNullableRecord(value, schema) {
  return value == null ? null : shapeRecord(value, schema);
}

function buildRoomSnapshot(options = {}) {
  const db = requireDatabase(options.db);
  const { workspaceId, roomId } = revisionIdentity(options.workspaceId, options.roomId);
  const confirmedState = shapeRecord(
    stateOrDefault(options.confirmedState, () => loadConfirmedState(db, workspaceId)),
    CONFIRMED_STATE_SCHEMA,
    { displays: [] },
  );
  const commands = (options.pendingCommands === undefined || options.lastCommandId === undefined)
    ? loadCommands(db, workspaceId, roomId)
    : null;
  const serverTimestamp = Number.isFinite(Number(options.serverTimestamp))
    ? Number(options.serverTimestamp)
    : Date.now();

  const pendingCommands = sanitizePublicState(
    options.pendingCommands !== undefined ? options.pendingCommands : commands.pending,
    [COMMAND_SCHEMA],
  );
  const rawLastCommandId = options.lastCommandId !== undefined
    ? options.lastCommandId
    : commands.lastCommandId;
  const lastCommandId = typeof rawLastCommandId === 'string' ? rawLastCommandId : null;
  const deviceStates = shapeRecord(
    stateOrDefault(options.deviceStates, () => loadDeviceStates(db, workspaceId, roomId)),
    DEVICE_STATES_SCHEMA,
    { displays: [], nodes: [] },
  );
  const layoutState = shapeRecord(
    stateOrDefault(options.layoutState, () => loadLayoutState(db, workspaceId)),
    LAYOUT_STATE_SCHEMA,
    { walls: [], groups: [] },
  );
  const classroomProgramSource = stateOrDefault(
    options.classroomProgram,
    () => deriveClassroomProgram(confirmedState),
  );
  const livestreamProgramSource = stateOrDefault(
    options.livestreamProgram,
    () => loadLivestreamProgram(db, workspaceId),
  );

  return {
    schemaVersion: ROOM_SNAPSHOT_SCHEMA_VERSION,
    workspaceId,
    roomId,
    revision: getRoomRevision(db, workspaceId, roomId),
    serverTimestamp,
    confirmedState,
    pendingCommands,
    lastCommandId,
    deviceStates,
    layoutState,
    classroomProgram: shapeNullableRecord(classroomProgramSource, CLASSROOM_PROGRAM_SCHEMA),
    livestreamProgram: shapeNullableRecord(livestreamProgramSource, LIVESTREAM_PROGRAM_SCHEMA),
    recordingState: shapeRecord(
      stateOrDefault(options.recordingState, () => ({ status: 'unknown' })),
      RECORDING_STATE_SCHEMA,
      { status: 'unknown' },
    ),
    streamState: shapeRecord(
      stateOrDefault(options.streamState, () => ({ status: 'unknown' })),
      STREAM_STATE_SCHEMA,
      { status: 'unknown' },
    ),
  };
}

module.exports = {
  ROOM_SNAPSHOT_SCHEMA_VERSION,
  ensureRoomRevisionSchema,
  getRoomRevision,
  bumpRoomRevision,
  buildRoomSnapshot,
  sanitizePublicState,
};
