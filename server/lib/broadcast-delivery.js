'use strict';

const crypto = require('crypto');

const REQUEST_TERMINAL = new Set(['confirmed', 'partial', 'failed', 'timed_out']);
const DEVICE_TERMINAL = new Set(['confirmed', 'failed', 'timed_out']);
const stores = new WeakMap();

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function createBroadcastDeliveryStore(database, options = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A better-sqlite3 database is required');
  }

  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : crypto.randomUUID;
  const configuredTimeout = Number(options.timeoutMs || process.env.BROADCAST_CONFIRM_TIMEOUT_MS || 45000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
    ? Math.round(configuredTimeout)
    : 45000;

  function ensureSchema() {
    // Boot schema.sql owns the production tables. This self-heal covers upgraded
    // databases; test stubs that only implement prepare are left alone.
    if (typeof database.exec !== 'function') return;
    database.exec(`
      CREATE TABLE IF NOT EXISTS broadcast_requests (
        id                       TEXT PRIMARY KEY,
        workspace_id             TEXT NOT NULL,
        user_id                  TEXT,
        source_type              TEXT NOT NULL,
        source_id                TEXT NOT NULL,
        typed_targets_json       TEXT NOT NULL DEFAULT '[]',
        resolved_target_ids_json TEXT NOT NULL DEFAULT '[]',
        expected_target_count    INTEGER NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'requested'
                                 CHECK (status IN ('requested','in_progress','confirmed','partial','failed','timed_out')),
        created_at               INTEGER NOT NULL,
        expires_at               INTEGER NOT NULL,
        completed_at             INTEGER,
        idempotency_key          TEXT,
        request_fingerprint      TEXT
      );

      CREATE TABLE IF NOT EXISTS broadcast_device_results (
        request_id                  TEXT NOT NULL REFERENCES broadcast_requests(id) ON DELETE CASCADE,
        target_key                  TEXT NOT NULL,
        device_id                   TEXT NOT NULL,
        device_name                 TEXT NOT NULL,
        ordinal                     INTEGER NOT NULL DEFAULT 0,
        command_id                  TEXT NOT NULL UNIQUE,
        region_id                   TEXT,
        zone_id                     TEXT,
        expected_source_id          TEXT,
        expected_playlist_revision  TEXT,
        state                       TEXT NOT NULL DEFAULT 'requested'
                                    CHECK (state IN ('requested','delivered','acknowledged','confirmed','failed','offline','timed_out')),
        delivery_state              TEXT NOT NULL DEFAULT 'requested'
                                    CHECK (delivery_state IN ('requested','delivered','offline','failed','timed_out')),
        acknowledgment_state        TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (acknowledgment_state IN ('pending','acknowledged','confirmed','failed','timed_out')),
        confirmed_player_state_json TEXT,
        failure_reason              TEXT,
        renderer_session_id         TEXT,
        render_generation           INTEGER,
        requested_at                INTEGER NOT NULL,
        delivered_at                INTEGER,
        acknowledged_at             INTEGER,
        confirmed_at                INTEGER,
        updated_at                  INTEGER NOT NULL,
        PRIMARY KEY (request_id, target_key)
      );

      CREATE INDEX IF NOT EXISTS idx_broadcast_requests_workspace_created
        ON broadcast_requests(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_broadcast_requests_expiry
        ON broadcast_requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_broadcast_device_results_state
        ON broadcast_device_results(request_id, state);
    `);
    const requestColumns = new Set(
      database.prepare('PRAGMA table_info(broadcast_requests)').all().map((column) => column.name)
    );
    if (!requestColumns.has('idempotency_key')) {
      database.exec('ALTER TABLE broadcast_requests ADD COLUMN idempotency_key TEXT');
    }
    if (!requestColumns.has('request_fingerprint')) {
      database.exec('ALTER TABLE broadcast_requests ADD COLUMN request_fingerprint TEXT');
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_requests_idempotency
      ON broadcast_requests(workspace_id, user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    const columns = new Set(
      database.prepare('PRAGMA table_info(broadcast_device_results)').all().map((column) => column.name)
    );
    if (!columns.has('renderer_session_id')) {
      database.exec('ALTER TABLE broadcast_device_results ADD COLUMN renderer_session_id TEXT');
      columns.add('renderer_session_id');
    }
    if (!columns.has('region_id')) {
      database.exec('ALTER TABLE broadcast_device_results ADD COLUMN region_id TEXT');
      columns.add('region_id');
    }
    if (!columns.has('zone_id')) {
      database.exec('ALTER TABLE broadcast_device_results ADD COLUMN zone_id TEXT');
      columns.add('zone_id');
    }
    if (!columns.has('target_key')) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE broadcast_device_results_v2 (
          request_id                  TEXT NOT NULL REFERENCES broadcast_requests(id) ON DELETE CASCADE,
          target_key                  TEXT NOT NULL,
          device_id                   TEXT NOT NULL,
          device_name                 TEXT NOT NULL,
          ordinal                     INTEGER NOT NULL DEFAULT 0,
          command_id                  TEXT NOT NULL UNIQUE,
          region_id                   TEXT,
          zone_id                     TEXT,
          expected_source_id          TEXT,
          expected_playlist_revision  TEXT,
          state                       TEXT NOT NULL DEFAULT 'requested'
                                      CHECK (state IN ('requested','delivered','acknowledged','confirmed','failed','offline','timed_out')),
          delivery_state              TEXT NOT NULL DEFAULT 'requested'
                                      CHECK (delivery_state IN ('requested','delivered','offline','failed','timed_out')),
          acknowledgment_state        TEXT NOT NULL DEFAULT 'pending'
                                      CHECK (acknowledgment_state IN ('pending','acknowledged','confirmed','failed','timed_out')),
          confirmed_player_state_json TEXT,
          failure_reason              TEXT,
          renderer_session_id         TEXT,
          render_generation           INTEGER,
          requested_at                INTEGER NOT NULL,
          delivered_at                INTEGER,
          acknowledged_at             INTEGER,
          confirmed_at                INTEGER,
          updated_at                  INTEGER NOT NULL,
          PRIMARY KEY (request_id, target_key)
        );
        INSERT INTO broadcast_device_results_v2 (
          request_id, target_key, device_id, device_name, ordinal, command_id,
          region_id, zone_id, expected_source_id, expected_playlist_revision,
          state, delivery_state, acknowledgment_state, confirmed_player_state_json,
          failure_reason, renderer_session_id, render_generation, requested_at,
          delivered_at, acknowledged_at, confirmed_at, updated_at
        )
        SELECT
          request_id,
          CASE WHEN region_id IS NOT NULL AND region_id <> ''
            THEN device_id || ':region:' || region_id ELSE device_id END,
          device_id, device_name, ordinal, command_id,
          region_id, zone_id, expected_source_id, expected_playlist_revision,
          state, delivery_state, acknowledgment_state, confirmed_player_state_json,
          failure_reason, renderer_session_id, render_generation, requested_at,
          delivered_at, acknowledged_at, confirmed_at, updated_at
        FROM broadcast_device_results;
        DROP TABLE broadcast_device_results;
        ALTER TABLE broadcast_device_results_v2 RENAME TO broadcast_device_results;
        CREATE INDEX idx_broadcast_device_results_state
          ON broadcast_device_results(request_id, state);
        COMMIT;
      `);
      columns.add('target_key');
    }
  }

  ensureSchema();

  function rowForCommand(requestId, deviceId, commandId) {
    return database.prepare(`
      SELECT bdr.*, br.workspace_id, br.source_type, br.source_id, br.expires_at
      FROM broadcast_device_results bdr
      JOIN broadcast_requests br ON br.id = bdr.request_id
      WHERE bdr.request_id = ? AND bdr.device_id = ? AND bdr.command_id = ?
    `).get(requestId, deviceId, commandId) || null;
  }

  function recomputeRequest(requestId) {
    const request = database.prepare(
      'SELECT status FROM broadcast_requests WHERE id = ?'
    ).get(requestId);
    if (!request) return null;

    const rows = database.prepare(
      'SELECT state FROM broadcast_device_results WHERE request_id = ?'
    ).all(requestId);
    const states = rows.map((row) => row.state);
    let status = 'requested';
    let completedAt = null;

    if (states.length > 0 && states.every((state) => state === 'confirmed')) {
      status = 'confirmed';
      completedAt = now();
    } else if (states.length > 0 && states.every((state) => DEVICE_TERMINAL.has(state))) {
      if (states.some((state) => state === 'confirmed')) status = 'partial';
      else if (states.every((state) => state === 'timed_out')) status = 'timed_out';
      else status = 'failed';
      completedAt = now();
    } else if (states.some((state) => state !== 'requested')) {
      status = 'in_progress';
    }

    database.prepare(`
      UPDATE broadcast_requests
      SET status = ?, completed_at = ?
      WHERE id = ?
    `).run(status, completedAt, requestId);
    return status;
  }

  function serializeRequest(row, deviceRows) {
    if (!row) return null;
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      user_id: row.user_id || null,
      source_type: row.source_type,
      source_id: row.source_id,
      typed_targets: parseJson(row.typed_targets_json, []),
      resolved_target_ids: parseJson(row.resolved_target_ids_json, []),
      expected_target_count: Number(row.expected_target_count) || 0,
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at,
      completed_at: row.completed_at || null,
      idempotency_key: row.idempotency_key || null,
      devices: deviceRows.map((device) => ({
        request_id: device.request_id,
        target_key: device.target_key,
        device_id: device.device_id,
        device_name: device.device_name,
        command_id: device.command_id,
        region_id: device.region_id || null,
        zone_id: device.zone_id || null,
        expected_source_id: device.expected_source_id || null,
        expected_playlist_revision: device.expected_playlist_revision || null,
        state: device.state,
        delivery_state: device.delivery_state,
        acknowledgment_state: device.acknowledgment_state,
        confirmed_player_state: parseJson(device.confirmed_player_state_json, null),
        failure_reason: device.failure_reason || null,
        renderer_session_id: device.renderer_session_id || null,
        render_generation: device.render_generation == null ? null : Number(device.render_generation),
        requested_at: device.requested_at,
        delivered_at: device.delivered_at || null,
        acknowledged_at: device.acknowledged_at || null,
        confirmed_at: device.confirmed_at || null,
        updated_at: device.updated_at,
      })),
    };
  }

  function getRequest(requestId, workspaceId = null) {
    const row = workspaceId
      ? database.prepare('SELECT * FROM broadcast_requests WHERE id = ? AND workspace_id = ?').get(requestId, workspaceId)
      : database.prepare('SELECT * FROM broadcast_requests WHERE id = ?').get(requestId);
    if (!row) return null;
    const devices = database.prepare(`
      SELECT * FROM broadcast_device_results
      WHERE request_id = ?
      ORDER BY ordinal ASC, device_name COLLATE NOCASE ASC, device_id ASC
    `).all(requestId);
    return serializeRequest(row, devices);
  }

  function createRequest(args = {}) {
    const {
      workspaceId,
      userId = null,
      sourceType,
      sourceId,
      typedTargets = [],
      targets = [],
      expectedTargetCount,
      idempotencyKey = null,
      requestFingerprint = null,
    } = args;
    if (!workspaceId || !sourceType || !sourceId) {
      throw new TypeError('workspaceId, sourceType, and sourceId are required');
    }

    const normalizedIdempotencyKey = typeof idempotencyKey === 'string'
      ? idempotencyKey.trim().slice(0, 200)
      : '';
    const normalizedFingerprint = typeof requestFingerprint === 'string'
      ? requestFingerprint.trim().slice(0, 500)
      : '';
    if (normalizedIdempotencyKey) {
      const prior = database.prepare(`
        SELECT id, request_fingerprint
        FROM broadcast_requests
        WHERE workspace_id = ? AND user_id IS ? AND idempotency_key = ?
      `).get(workspaceId, userId, normalizedIdempotencyKey);
      if (prior) {
        if (!normalizedFingerprint || prior.request_fingerprint !== normalizedFingerprint) {
          const error = new Error('Idempotency key was already used for a different broadcast');
          error.code = 'IDEMPOTENCY_KEY_REUSED';
          throw error;
        }
        return { ...getRequest(prior.id, workspaceId), idempotent_replay: true };
      }
    }

    const uniqueTargets = [];
    const seen = new Set();
    for (const raw of Array.isArray(targets) ? targets : []) {
      const deviceId = String(raw?.deviceId || '').trim();
      const regionId = String(raw?.regionId || '').trim();
      const targetKey = regionId ? `${deviceId}:region:${regionId}` : deviceId;
      if (!deviceId || seen.has(targetKey)) continue;
      seen.add(targetKey);
      uniqueTargets.push({ ...raw, deviceId, regionId: regionId || null, targetKey });
    }
    if (uniqueTargets.length === 0) throw new TypeError('At least one broadcast target is required');

    const id = randomUUID();
    const createdAt = now();
    const count = Number.isInteger(Number(expectedTargetCount))
      ? Math.max(uniqueTargets.length, Number(expectedTargetCount))
      : uniqueTargets.length;
    const resolvedTargetIds = uniqueTargets
      .filter((target) => target.resolved !== false)
      .map((target) => target.deviceId);
    const selectName = database.prepare('SELECT name FROM devices WHERE id = ? AND workspace_id = ?');
    const insertRequest = database.prepare(`
      INSERT INTO broadcast_requests (
        id, workspace_id, user_id, source_type, source_id, typed_targets_json,
        resolved_target_ids_json, expected_target_count, status, created_at, expires_at,
        idempotency_key, request_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)
    `);
    const insertDevice = database.prepare(`
      INSERT INTO broadcast_device_results (
        request_id, target_key, device_id, device_name, ordinal, command_id, region_id, zone_id, expected_source_id,
        state, delivery_state, acknowledgment_state, failure_reason,
        requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = database.transaction(() => {
      insertRequest.run(
        id,
        workspaceId,
        userId,
        String(sourceType),
        String(sourceId),
        JSON.stringify(Array.isArray(typedTargets) ? typedTargets : []),
        JSON.stringify(resolvedTargetIds),
        count,
        createdAt,
        createdAt + timeoutMs,
        normalizedIdempotencyKey || null,
        normalizedFingerprint || null,
      );
      uniqueTargets.forEach((target, ordinal) => {
        const name = selectName.get(target.deviceId, workspaceId)?.name || target.deviceName || target.deviceId;
        const initialState = target.initialState === 'failed' ? 'failed' : 'requested';
        insertDevice.run(
          id,
          target.targetKey,
          target.deviceId,
          String(name),
          ordinal,
          randomUUID(),
          target.regionId || null,
          target.zoneId || null,
          target.expectedSourceId || null,
          initialState,
          initialState === 'failed' ? 'failed' : 'requested',
          initialState === 'failed' ? 'failed' : 'pending',
          target.failureReason || null,
          createdAt,
          createdAt,
        );
      });
    });
    tx();
    recomputeRequest(id);
    return getRequest(id, workspaceId);
  }

  function markDispatched(args = {}) {
    const {
      requestId,
      deviceId,
      commandId,
      delivered = false,
      queued = false,
      playlistRevision = null,
      expectedSourceId = null,
      regionId = null,
      failureReason = null,
    } = args;
    const row = rowForCommand(requestId, deviceId, commandId);
    if (!row || DEVICE_TERMINAL.has(row.state)) {
      return { applied: false, reason: 'unknown_or_terminal_delivery' };
    }
    if (row.expires_at <= now()) {
      sweepExpired();
      return { applied: false, reason: 'delivery_expired' };
    }

    const at = now();
    let state = 'failed';
    let deliveryState = 'failed';
    let acknowledgmentState = 'failed';
    let reason = failureReason || 'Broadcast dispatch failed';
    let deliveredAt = null;
    if (delivered) {
      state = 'delivered';
      deliveryState = 'delivered';
      acknowledgmentState = 'pending';
      reason = null;
      deliveredAt = at;
    } else if (queued) {
      state = 'offline';
      deliveryState = 'offline';
      acknowledgmentState = 'pending';
      reason = failureReason || 'Player offline; update queued';
    }

    database.prepare(`
      UPDATE broadcast_device_results
      SET state = ?, delivery_state = ?, acknowledgment_state = ?,
          expected_playlist_revision = COALESCE(?, expected_playlist_revision),
          expected_source_id = COALESCE(?, expected_source_id),
          region_id = COALESCE(?, region_id),
          failure_reason = ?, delivered_at = COALESCE(?, delivered_at), updated_at = ?
      WHERE request_id = ? AND device_id = ? AND command_id = ?
    `).run(
      state,
      deliveryState,
      acknowledgmentState,
      playlistRevision,
      expectedSourceId,
      regionId,
      reason,
      deliveredAt,
      at,
      requestId,
      deviceId,
      commandId,
    );
    recomputeRequest(requestId);
    return { applied: true, state };
  }

  function markPrepared(args = {}) {
    const {
      requestId,
      deviceId,
      commandId,
      playlistRevision,
      expectedSourceId = null,
    } = args;
    if (!playlistRevision || typeof playlistRevision !== 'string') {
      return { applied: false, reason: 'playlist_revision_required' };
    }
    const row = rowForCommand(requestId, deviceId, commandId);
    if (!row || DEVICE_TERMINAL.has(row.state)) {
      return { applied: false, reason: 'unknown_or_terminal_delivery' };
    }
    if (row.expires_at <= now()) {
      sweepExpired();
      return { applied: false, reason: 'delivery_expired' };
    }
    if (row.expected_playlist_revision && row.expected_playlist_revision !== playlistRevision) {
      return { applied: false, reason: 'playlist_revision_mismatch' };
    }
    const result = database.prepare(`
      UPDATE broadcast_device_results
      SET expected_playlist_revision = COALESCE(expected_playlist_revision, ?),
          expected_source_id = COALESCE(?, expected_source_id),
          updated_at = ?
      WHERE request_id = ? AND device_id = ? AND command_id = ?
    `).run(playlistRevision, expectedSourceId, now(), requestId, deviceId, commandId);
    return { applied: result.changes === 1, state: row.state };
  }

  function pendingForDevice(deviceId, playlistRevision) {
    if (!deviceId || !playlistRevision) return [];
    const at = now();
    const rows = database.prepare(`
      SELECT bdr.*, br.source_type, br.source_id, br.expires_at
      FROM broadcast_device_results bdr
      JOIN broadcast_requests br ON br.id = bdr.request_id
      WHERE bdr.device_id = ?
        AND bdr.expected_playlist_revision = ?
        AND bdr.state NOT IN ('confirmed','failed','timed_out')
        AND br.expires_at > ?
      ORDER BY br.created_at DESC, bdr.ordinal ASC
    `).all(String(deviceId), String(playlistRevision), at);
    return rows.map((row) => ({
      requestId: row.request_id,
      commandId: row.command_id,
      sourceId: row.source_id,
      sourceType: row.source_type,
      expectedSourceId: row.expected_source_id || null,
      regionId: row.region_id || null,
      zoneId: row.zone_id || null,
    }));
  }

  function markPlayerStatus(args = {}) {
    const {
      requestId,
      deviceId,
      commandId,
      phase,
      playlistRevision = null,
      renderGeneration = null,
      rendererSessionId = null,
      playerState = null,
      failureReason = null,
    } = args;
    const row = rowForCommand(requestId, deviceId, commandId);
    if (!row) {
      return { applied: false, reason: 'command_mismatch' };
    }
    if (row.expires_at <= now()) {
      sweepExpired();
      return { applied: false, reason: 'delivery_expired' };
    }
    if (DEVICE_TERMINAL.has(row.state) && !(row.state === 'failed' && phase === 'failed')) {
      return { applied: false, reason: 'terminal_delivery' };
    }
    if (!['acknowledged', 'confirmed', 'failed'].includes(phase)) {
      return { applied: false, reason: 'invalid_phase' };
    }
    if (row.expected_playlist_revision && row.expected_playlist_revision !== playlistRevision) {
      return { applied: false, reason: 'playlist_revision_mismatch' };
    }

    const at = now();
    if (phase === 'failed') {
      database.prepare(`
        UPDATE broadcast_device_results
        SET state = 'failed', delivery_state = CASE
              WHEN delivery_state = 'requested' THEN 'failed' ELSE delivery_state END,
            acknowledgment_state = 'failed', failure_reason = ?, updated_at = ?
        WHERE request_id = ? AND device_id = ? AND command_id = ?
      `).run(failureReason || 'Player reported render failure', at, requestId, deviceId, commandId);
      recomputeRequest(requestId);
      return { applied: true, state: 'failed' };
    }

    if (!playlistRevision || typeof playlistRevision !== 'string') {
      return { applied: false, reason: 'playlist_revision_required' };
    }
    const sessionId = typeof rendererSessionId === 'string'
      ? rendererSessionId.trim().slice(0, 128)
      : '';
    if (!sessionId) return { applied: false, reason: 'renderer_session_required' };
    if (row.renderer_session_id && row.renderer_session_id !== sessionId) {
      return { applied: false, reason: 'renderer_session_mismatch' };
    }

    if (phase === 'acknowledged') {
      database.prepare(`
        UPDATE broadcast_device_results
        SET state = CASE WHEN state = 'confirmed' THEN state ELSE 'acknowledged' END,
            delivery_state = 'delivered',
            acknowledgment_state = CASE
              WHEN acknowledgment_state = 'confirmed' THEN acknowledgment_state ELSE 'acknowledged' END,
            expected_playlist_revision = COALESCE(expected_playlist_revision, ?),
            renderer_session_id = COALESCE(renderer_session_id, ?),
            failure_reason = NULL,
            delivered_at = COALESCE(delivered_at, ?),
            acknowledged_at = COALESCE(acknowledged_at, ?),
            updated_at = ?
        WHERE request_id = ? AND device_id = ? AND command_id = ?
      `).run(playlistRevision, sessionId, at, at, at, requestId, deviceId, commandId);
      recomputeRequest(requestId);
      return { applied: true, state: 'acknowledged' };
    }

    const generation = Number(renderGeneration);
    if (!Number.isInteger(generation) || generation <= 0) {
      return { applied: false, reason: 'render_generation_required' };
    }
    if (!playerState || typeof playerState !== 'object') {
      return { applied: false, reason: 'player_state_required' };
    }
    if (playerState.render_state === 'error' || playerState.error_state) {
      return { applied: false, reason: 'player_state_error' };
    }
    if (row.region_id) {
      const regionState = Array.isArray(playerState.region_states)
        ? playerState.region_states.find((entry) => String(entry?.region_id || '') === String(row.region_id))
        : null;
      if (!regionState) return { applied: false, reason: 'region_state_missing' };
      if (
        row.expected_source_id
        && String(regionState.current_content_id || '') !== String(row.expected_source_id)
      ) return { applied: false, reason: 'source_mismatch' };
    } else if (
      row.expected_source_id
      && playerState.current_content_id
      && String(row.expected_source_id) !== String(playerState.current_content_id)
    ) {
      return { applied: false, reason: 'source_mismatch' };
    }

    database.prepare(`
      UPDATE broadcast_device_results
      SET state = 'confirmed', delivery_state = 'delivered',
          acknowledgment_state = 'confirmed',
          expected_playlist_revision = COALESCE(expected_playlist_revision, ?),
          renderer_session_id = COALESCE(renderer_session_id, ?),
          confirmed_player_state_json = ?, failure_reason = NULL,
          render_generation = ?, delivered_at = COALESCE(delivered_at, ?),
          acknowledged_at = COALESCE(acknowledged_at, ?), confirmed_at = ?,
          updated_at = ?
      WHERE request_id = ? AND device_id = ? AND command_id = ?
    `).run(
      playlistRevision,
      sessionId,
      JSON.stringify(playerState),
      generation,
      at,
      at,
      at,
      at,
      requestId,
      deviceId,
      commandId,
    );
    recomputeRequest(requestId);
    return { applied: true, state: 'confirmed' };
  }

  function sweepExpired() {
    const at = now();
    const expired = database.prepare(`
      SELECT DISTINCT request_id
      FROM broadcast_device_results
      WHERE request_id IN (
        SELECT id FROM broadcast_requests
        WHERE expires_at <= ? AND status NOT IN ('confirmed','partial','failed','timed_out')
      )
      AND state NOT IN ('confirmed','failed','timed_out')
    `).all(at).map((row) => row.request_id);

    const tx = database.transaction(() => {
      for (const requestId of expired) {
        database.prepare(`
          UPDATE broadcast_device_results
          SET state = 'timed_out',
              delivery_state = CASE
                WHEN delivery_state = 'delivered' THEN delivery_state ELSE 'timed_out' END,
              acknowledgment_state = 'timed_out',
              failure_reason = COALESCE(failure_reason, 'Player confirmation timed out'),
              updated_at = ?
          WHERE request_id = ? AND state NOT IN ('confirmed','failed','timed_out')
        `).run(at, requestId);
      }
    });
    tx();
    for (const requestId of expired) recomputeRequest(requestId);
    return expired.length;
  }

  return {
    ensureSchema,
    createRequest,
    getRequest,
    markPrepared,
    markDispatched,
    markPlayerStatus,
    pendingForDevice,
    sweepExpired,
    recomputeRequest,
  };
}

function getBroadcastDeliveryStore(database, options = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A better-sqlite3 database is required');
  }
  if (!stores.has(database)) stores.set(database, createBroadcastDeliveryStore(database, options));
  return stores.get(database);
}

module.exports = {
  REQUEST_TERMINAL,
  createBroadcastDeliveryStore,
  getBroadcastDeliveryStore,
};
