'use strict';

const MAX_RENDERERS = 50;
const MAX_NODES = 20;

function safeAll(db, sql, ...params) {
  try {
    const rows = db.prepare(sql).all(...params);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolOrNull(value) {
  if (value == null) return null;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function timestampMs(value) {
  const number = finiteOrNull(value);
  if (number == null || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function heartbeatState(row, now, timeoutMs) {
  const lastHeartbeatAt = timestampMs(row.last_heartbeat_at) || timestampMs(row.last_heartbeat);
  const ageMs = lastHeartbeatAt == null ? null : Math.max(0, now - lastHeartbeatAt);
  return {
    lastHeartbeatAt,
    ageSeconds: ageMs == null ? null : Math.floor(ageMs / 1000),
    connected: row.status === 'online' && ageMs != null && ageMs <= timeoutMs,
  };
}

function buildOperationalDiagnostics(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A database is required');
  const workspaceId = String(options.workspaceId || '').trim();
  if (!workspaceId) throw new TypeError('workspaceId is required');
  const roomId = String(options.roomId || 'classroom-1').trim() || 'classroom-1';
  const now = finiteOrNull(options.now) || Date.now();
  const heartbeatTimeoutMs = Math.max(1_000, finiteOrNull(options.heartbeatTimeoutMs) || 45_000);

  const displayRows = safeAll(db, `
    SELECT d.id, d.name, d.status, d.last_heartbeat,
           ds.last_heartbeat_at, ds.render_state, ds.error_state,
           ds.current_content_id, ds.content_type, ds.muted, ds.operator_muted,
           ds.updated_at AS state_updated_at,
           (SELECT MAX(bdr.confirmed_at)
              FROM broadcast_device_results bdr
              INNER JOIN broadcast_requests br ON br.id = bdr.request_id
             WHERE br.workspace_id = d.workspace_id
               AND bdr.device_id = d.id
               AND bdr.state = 'confirmed') AS latest_route_confirmed_at
    FROM devices d
    LEFT JOIN display_states ds
      ON ds.target_type = 'display' AND ds.target_id = d.id
    WHERE d.workspace_id = ? AND d.id NOT LIKE 'live-stream-program-%'
    ORDER BY d.name COLLATE NOCASE, d.id
    LIMIT 50
  `, workspaceId).slice(0, MAX_RENDERERS);

  const renderers = displayRows.map((row) => {
    const heartbeat = heartbeatState(row, now, heartbeatTimeoutMs);
    return {
      id: String(row.id || ''),
      name: String(row.name || row.id || 'Unknown renderer'),
      connected: heartbeat.connected,
      heartbeat_age_sec: heartbeat.ageSeconds,
      last_seen_at: heartbeat.lastHeartbeatAt,
      latest_route_confirmation_at: timestampMs(row.latest_route_confirmed_at),
      latest_render_confirmation: {
        state: String(row.render_state || 'unknown'),
        at: timestampMs(row.state_updated_at),
        error: row.error_state == null ? null : String(row.error_state),
      },
      content: {
        id: row.current_content_id == null ? null : String(row.current_content_id),
        type: row.content_type == null ? null : String(row.content_type),
      },
      muted: boolOrNull(row.muted),
      operator_muted: boolOrNull(row.operator_muted),
    };
  });

  const nodeRows = safeAll(db, `
    SELECT node_id, node_name, node_type, last_heartbeat, software_version,
           cache_size, sync_status, network_state_json, telemetry_json
    FROM managed_nodes
    WHERE workspace_id = ? AND room_id = ?
    ORDER BY node_name COLLATE NOCASE, node_id
    LIMIT 20
  `, workspaceId, roomId).slice(0, MAX_NODES);

  const nodes = nodeRows.map((row) => {
    const heartbeat = heartbeatState({ ...row, status: 'online' }, now, heartbeatTimeoutMs);
    const network = parseObject(row.network_state_json);
    const telemetry = parseObject(row.telemetry_json);
    const cache = parseObject(telemetry.cache);
    return {
      id: String(row.node_id || ''),
      name: String(row.node_name || row.node_id || 'Unknown node'),
      type: row.node_type == null ? null : String(row.node_type),
      connected: heartbeat.connected,
      heartbeat_age_sec: heartbeat.ageSeconds,
      last_seen_at: heartbeat.lastHeartbeatAt,
      software_version: row.software_version == null ? null : String(row.software_version),
      origin_path: String(
        cache.origin_category
        || network.server_url_category
        || network.selected_server_url_category
        || 'unknown',
      ),
      network: {
        reachability: network.reachability == null ? 'unknown' : String(network.reachability),
        degraded: network.degraded === true,
        degraded_reason: network.degraded_reason == null ? null : String(network.degraded_reason),
      },
      cache: {
        size_bytes: finiteOrNull(cache.cache_size ?? row.cache_size),
        file_count: finiteOrNull(cache.file_count),
        manifest_count: finiteOrNull(cache.manifest_count),
        cached_manifest_count: finiteOrNull(cache.cached_manifest_count),
        sync_status: String(cache.sync_status || row.sync_status || 'unknown'),
      },
    };
  });

  const configuredAudioId = String(options.audioAuthorityDeviceId || '').trim() || null;
  const audioRenderer = configuredAudioId
    ? renderers.find((renderer) => renderer.id === configuredAudioId) || null
    : null;
  // This is the configured/pinned classroom authority, not the dynamic
  // per-route audio-policy owner or a physical-audio observation.
  const configuredAudioAuthority = {
    device_id: configuredAudioId,
    device_name: audioRenderer?.name || null,
    configured: configuredAudioId != null,
    connected: audioRenderer?.connected === true,
    muted: audioRenderer?.muted ?? null,
    operator_muted: audioRenderer?.operator_muted ?? null,
  };

  const reasons = [];
  if (!renderers.length) reasons.push('no_renderer_telemetry');
  if (renderers.some((renderer) => !renderer.connected)) reasons.push('renderer_offline_or_stale');
  if (renderers.some((renderer) => renderer.latest_render_confirmation.error != null)) reasons.push('renderer_error_reported');
  if (!configuredAudioAuthority.configured) reasons.push('configured_audio_authority_not_configured');
  else if (!audioRenderer) reasons.push('configured_audio_authority_not_found');
  else if (!configuredAudioAuthority.connected) reasons.push('configured_audio_authority_offline_or_stale');
  if (nodes.some((node) => !node.connected)) reasons.push('room_node_offline_or_stale');
  if (!nodes.length) reasons.push('no_room_node_telemetry');
  if (nodes.some((node) => node.network.degraded)) reasons.push('room_node_network_degraded');

  return {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    workspace_id: workspaceId,
    room_id: roomId,
    bounds: { renderers: MAX_RENDERERS, nodes: MAX_NODES },
    health: {
      status: reasons.length ? 'degraded' : 'healthy',
      reasons,
      basis: 'persisted renderer confirmations and latest managed-node heartbeat telemetry',
      physical_acceptance_observed: false,
    },
    configured_audio_authority: configuredAudioAuthority,
    renderers,
    nodes,
  };
}

module.exports = { buildOperationalDiagnostics, MAX_RENDERERS, MAX_NODES };
