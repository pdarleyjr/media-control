function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function safeOne(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function targetKey(route) {
  const deviceId = String(route?.device_id || route?.id || '');
  if (route?.region_id) return `${deviceId}:region:${route.region_id}`;
  if (route?.zone_id) return `${deviceId}:zone:${route.zone_id}`;
  return deviceId;
}

function rendererCompatibility(device, mimeType) {
  const capabilities = parseJson(device?.capabilities_json, null);
  if (!capabilities || typeof capabilities !== 'object') return 'unknown';
  const mediaKind = String(mimeType || '').split('/')[0];
  const values = [
    capabilities.content,
    capabilities[mediaKind],
    capabilities[String(mimeType || '')],
  ].filter((value) => value !== undefined);
  if (values.some((value) => value === false || value === 0 || value === 'false')) {
    return 'unsupported';
  }
  return values.length ? 'supported' : 'unknown';
}

function p3State(nodeAssets) {
  if (!nodeAssets.length) return 'not_requested';
  if (nodeAssets.some((row) => row.sync_status === 'failed' || row.error_message)) return 'failed';
  if (nodeAssets.every((row) => Number(row.checksum_verified) === 1)) return 'classroom_ready';
  if (nodeAssets.some((row) => row.sync_status === 'downloading' || Number(row.bytes_downloaded) > 0)) {
    return 'downloading';
  }
  return 'queued';
}

function buildBroadcastPreflight(db, options = {}) {
  const workspaceId = String(options.workspaceId || '');
  const content = options.content || {};
  const readiness = options.readiness || { ready: false, state: 'unknown' };
  const warnings = [];
  const targetEntries = [];
  const seenTargetKeys = new Set();

  for (const route of options.routes || []) {
    const key = targetKey(route);
    if (!key || seenTargetKeys.has(key)) continue;
    seenTargetKeys.add(key);
    const deviceId = String(route.device_id || route.id || '');
    const device = safeOne(
      db,
      'SELECT id, name, status, app_version, capabilities_json FROM devices WHERE id = ?',
      deviceId,
    );
    const compatibility = rendererCompatibility(device, content.mime_type);
    targetEntries.push({
      key,
      type: String(route.type || 'display'),
      id: deviceId,
      name: device?.name || deviceId,
      online: device?.status === 'online',
      status: device?.status || 'missing',
      app_version: device?.app_version || null,
      renderer_compatibility: compatibility,
      wall_id: route.wall_id || null,
      region_id: route.region_id || null,
      zone_id: route.zone_id || null,
      layout_revision: Number.isFinite(Number(route.layout_revision))
        ? Number(route.layout_revision)
        : null,
    });
  }

  for (const missingId of options.missingDeviceIds || []) {
    const key = String(missingId || '');
    if (!key || seenTargetKeys.has(key)) continue;
    seenTargetKeys.add(key);
    targetEntries.push({
      key,
      type: 'display',
      id: key,
      name: key,
      online: false,
      status: 'missing',
      app_version: null,
      renderer_compatibility: 'unknown',
      wall_id: null,
      region_id: null,
      zone_id: null,
      layout_revision: null,
    });
  }

  if (readiness.ready !== true) {
    warnings.push({
      code: 'CONTENT_NOT_READY',
      message: readiness.error || 'Server processing is not ready.',
    });
  }
  for (const target of targetEntries) {
    if (target.status === 'missing') {
      warnings.push({ code: 'TARGET_MISSING', target_id: target.id, message: `${target.name} is missing.` });
    } else if (!target.online) {
      warnings.push({ code: 'TARGET_OFFLINE', target_id: target.id, message: `${target.name} is offline.` });
    }
    if (target.renderer_compatibility === 'unsupported') {
      warnings.push({
        code: 'RENDERER_UNSUPPORTED',
        target_id: target.id,
        message: `${target.name} reports that it cannot render this media type.`,
      });
    } else if (target.renderer_compatibility === 'unknown') {
      warnings.push({
        code: 'RENDERER_UNKNOWN',
        target_id: target.id,
        message: `${target.name} has not reported renderer compatibility.`,
      });
    }
  }

  const manifest = safeOne(
    db,
    `SELECT asset_id, generation, sha256, size_bytes, canonical_path
     FROM asset_checksums WHERE content_id = ?`,
    String(content.id || ''),
  );
  const media = safeOne(
    db,
    `SELECT source_type, container, video_codec, audio_codec, audio_channels,
            duration_sec, bitrate_bps, remote_health_status
     FROM content_media_metadata WHERE content_id = ?`,
    String(content.id || ''),
  ) || {};
  const nodeAssets = manifest?.asset_id
    ? safeAll(
      db,
      `SELECT na.*, mn.node_name, mn.last_heartbeat, mn.sync_status AS node_sync_status
       FROM node_assets na
       JOIN managed_nodes mn ON mn.node_id = na.node_id
       WHERE na.asset_id = ? AND mn.workspace_id = ? AND na.desired = 1`,
      manifest.asset_id,
      workspaceId,
    )
    : [];
  const classroomState = p3State(nodeAssets);
  const checksumVerified = nodeAssets.length > 0
    && nodeAssets.every((row) => Number(row.checksum_verified) === 1);
  const cacheHitObserved = false;

  if (classroomState !== 'classroom_ready') {
    warnings.push({
      code: 'P3_NOT_VERIFIED',
      message: 'The classroom cache has not reported checksum verification for this generation.',
    });
  }
  if (media.source_type && !['upload', 'nextcloud', 'youtube'].includes(media.source_type)) {
    warnings.push({
      code: 'EXTERNAL_DEPENDENCY',
      message: `Playback depends on the ${media.source_type} source.`,
    });
  }
  if (media.remote_health_status && media.remote_health_status !== 'healthy') {
    warnings.push({
      code: 'REMOTE_SOURCE_UNHEALTHY',
      message: `Remote source health is ${media.remote_health_status}.`,
    });
  }

  const layoutRevisions = [];
  const seenLayouts = new Set();
  for (const target of targetEntries) {
    if (!target.wall_id || target.layout_revision === null) continue;
    const key = `${target.wall_id}:${target.layout_revision}`;
    if (seenLayouts.has(key)) continue;
    seenLayouts.add(key);
    layoutRevisions.push({
      wall_id: target.wall_id,
      layout_revision: target.layout_revision,
    });
  }

  const blockingWarningCodes = new Set([
    'CONTENT_NOT_READY',
    'TARGET_MISSING',
    'TARGET_OFFLINE',
    'RENDERER_UNSUPPORTED',
  ]);
  return {
    can_send: targetEntries.length > 0
      && !warnings.some((warning) => blockingWarningCodes.has(warning.code)),
    expected_target_count: targetEntries.length,
    targets: targetEntries,
    layout_revisions: layoutRevisions,
    content: {
      id: String(content.id || ''),
      filename: content.filename || null,
      mime_type: content.mime_type || null,
      server_ready: readiness.ready === true,
      processing_state: readiness.state || content.processing_status || 'unknown',
      generation: Number(manifest?.generation ?? content.version) || 1,
      sha256: manifest?.sha256 || null,
      size_bytes: Number(manifest?.size_bytes ?? content.file_size) || 0,
      container: media.container || null,
      video_codec: media.video_codec || null,
      audio: {
        codec: media.audio_codec || null,
        channels: Number(media.audio_channels) || null,
      },
      duration_sec: Number(media.duration_sec ?? content.duration_sec) || null,
      bitrate_bps: Number(media.bitrate_bps) || null,
    },
    p3: {
      state: classroomState,
      checksum_verified: checksumVerified,
      cache_hit_observed: cacheHitObserved,
      nodes: nodeAssets.map((row) => ({
        node_id: row.node_id,
        node_name: row.node_name || row.node_id,
        state: row.sync_status,
        bytes_downloaded: Number(row.bytes_downloaded) || 0,
        checksum_verified: Number(row.checksum_verified) === 1,
        last_heartbeat: row.last_heartbeat || null,
      })),
      note: checksumVerified
        ? 'Checksum verified on the classroom node; a playback cache hit must still be observed separately.'
        : 'Classroom readiness requires node checksum verification and a separately observed playback cache hit.',
    },
    estimated_cold_transfer_bytes: classroomState === 'classroom_ready'
      ? 0
      : Number(manifest?.size_bytes ?? content.file_size) || 0,
    warnings,
  };
}

module.exports = {
  buildBroadcastPreflight,
  rendererCompatibility,
};
