'use strict';

// The Media Edge status endpoint is the health authority for live sources.
// This monitor deliberately owns polling and durable freshness writes so a
// browser tab cannot make a computer source routable merely by remaining open.

const { db } = require('../db/database');
const cameraControl = require('./camera-control-client');
const { persistedSignal } = require('./live-source-state');

const CANONICAL_SOURCE_IDS = Object.freeze([
  'anpviz',
  'podium-computer',
  'guest-computer',
]);
const COMPUTER_SOURCE_IDS = Object.freeze([
  'podium-computer',
  'guest-computer',
]);

function nullableFiniteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeSignal(sourceId, edgeStatus) {
  const source = edgeStatus?.sources?.[sourceId];
  if (!source || typeof source !== 'object') return {};
  if (sourceId === 'anpviz') {
    return {
      video_online: source.video_online === true,
      microphone_connected: source.microphone_connected === true,
      audio_online: source.audio_online === true,
      synchronization_status: String(source.synchronization_status || 'unknown'),
      configured_delay_ms: Number.isFinite(Number(source.configured_delay_ms))
        ? Number(source.configured_delay_ms)
        : null,
      input_level_db: Number.isFinite(Number(source.input_level_db))
        ? Number(source.input_level_db)
        : null,
      mean_level_db: Number.isFinite(Number(source.mean_level_db))
        ? Number(source.mean_level_db)
        : null,
      audio_detected: source.audio_detected === true,
      silence_detected: source.silence_detected === true,
      clipping: source.clipping === true,
      audio_level_probe_healthy: source.audio_level_probe_healthy === true,
      last_audio_measurement_at: source.last_audio_measurement_at || null,
      last_audio_frame_at: source.last_audio_frame_at || null,
      last_update: source.last_update || null,
    };
  }
  return {
    device_online: source.device_online === true ? true : source.device_online === null ? null : false,
    device_observable: source.device_observable === true,
    publisher_online: source.publisher_online === true,
    signal_present: source.signal_present === true,
    available: source.available === true,
    stream_ready: source.stream_ready === true,
    resolution: source.resolution || null,
    frame_rate: nullableFiniteNumber(source.frame_rate),
    embedded_audio_detected: source.embedded_audio_detected === true,
    last_update: source.last_update || null,
  };
}

function isSourceAvailable(sourceId, signal) {
  if (sourceId === 'anpviz') {
    return signal.video_online === true
      && signal.microphone_connected === true
      && signal.audio_online === true
      && ['locked', 'configured'].includes(signal.synchronization_status);
  }
  return signal.available === true && signal.stream_ready === true;
}

function copySnapshot(snapshot) {
  return {
    edgeAvailable: snapshot.edgeAvailable === true,
    observedAt: snapshot.observedAt || null,
    sources: Object.fromEntries(Object.entries(snapshot.sources || {}).map(([id, source]) => [id, {
      available: source.available === true,
      signal: source.signal && typeof source.signal === 'object' ? { ...source.signal } : {},
    }])),
  };
}

function createManagedLiveSourceHealthMonitor({
  database = db,
  fetchStatus = (timeoutMs) => cameraControl.getStatus(timeoutMs),
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  intervalMs = 5_000,
  requestTimeoutMs = 4_000,
  lastSeenWriteIntervalMs = 25_000,
} = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new Error('managed live-source health monitor requires a SQLite database');
  }
  if (typeof fetchStatus !== 'function') {
    throw new Error('managed live-source health monitor requires a status fetch function');
  }

  let timer = null;
  let running = false;
  let inFlight = null;
  let generation = 0;
  let snapshot = { edgeAvailable: false, observedAt: null, sources: {} };

  const update = database.prepare(`
    UPDATE live_sources
    SET availability = ?,
        signal_json = ?,
        last_seen_at = CASE WHEN ? = 'available' THEN ? ELSE last_seen_at END,
        updated_at = strftime('%s','now')
    WHERE id = ?
      AND (
        availability <> ?
        OR COALESCE(signal_json, '') <> ?
        OR (? = 'available' AND COALESCE(last_seen_at, 0) < ?)
      )
  `);

  function updateSnapshotFromRows(edgeAvailable, observedAt) {
    const rows = database.prepare(`
      SELECT id, availability, signal_json
      FROM live_sources
      WHERE id IN (${CANONICAL_SOURCE_IDS.map(() => '?').join(', ')})
    `).all(...CANONICAL_SOURCE_IDS);
    const sources = {};
    for (const row of rows) {
      let signal = {};
      try { signal = JSON.parse(row.signal_json || '{}'); } catch { signal = {}; }
      sources[row.id] = {
        available: row.availability === 'available',
        signal: signal && typeof signal === 'object' ? signal : {},
      };
    }
    snapshot = { edgeAvailable: edgeAvailable === true, observedAt, sources };
    return copySnapshot(snapshot);
  }

  function persistObservation(edge, expectedGeneration) {
    if (expectedGeneration !== generation) return getSnapshot();
    const observedAtMs = Number(now());
    const nowMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const edgeAvailable = edge?.ok === true && Boolean(edge?.data && typeof edge.data === 'object');
    const edgeStatus = edgeAvailable ? edge.data : {};
    const refreshCutoff = nowSeconds - Math.max(1, Math.floor(lastSeenWriteIntervalMs / 1000));
    const sources = {};

    for (const sourceId of CANONICAL_SOURCE_IDS) {
      const signal = safeSignal(sourceId, edgeStatus);
      const available = edgeAvailable && isSourceAvailable(sourceId, signal);
      const availability = available ? 'available' : 'unavailable';
      const persistentJson = JSON.stringify(persistedSignal(signal));
      update.run(
        availability,
        persistentJson,
        availability,
        nowSeconds,
        sourceId,
        availability,
        persistentJson,
        availability,
        refreshCutoff,
      );
      sources[sourceId] = { available, signal };
    }

    if (expectedGeneration !== generation) return getSnapshot();
    snapshot = {
      edgeAvailable,
      observedAt: new Date(nowMs).toISOString(),
      sources,
    };
    return copySnapshot(snapshot);
  }

  function refresh() {
    if (inFlight) return inFlight;
    const expectedGeneration = generation;
    let fetch;
    try {
      fetch = fetchStatus(requestTimeoutMs);
    } catch (error) {
      fetch = Promise.reject(error);
    }
    let work;
    work = Promise.resolve(fetch)
      .then((edge) => persistObservation(edge, expectedGeneration))
      .catch(() => persistObservation({ ok: false }, expectedGeneration))
      .finally(() => {
        if (inFlight === work) inFlight = null;
      });
    inFlight = work;
    return work;
  }

  function start() {
    if (running) return inFlight || Promise.resolve(getSnapshot());
    running = true;
    generation++;
    const startedAt = Math.floor(Number(now()) / 1000) || Math.floor(Date.now() / 1000);
    // A new process must not inherit authorization for a computer source from
    // a prior process. Preserve last_seen_at and signal diagnostics, but require
    // a fresh edge observation before either source is routable.
    database.prepare(`
      UPDATE live_sources
      SET availability = 'unknown', updated_at = ?
      WHERE id IN (${COMPUTER_SOURCE_IDS.map(() => '?').join(', ')})
    `).run(startedAt, ...COMPUTER_SOURCE_IDS);
    updateSnapshotFromRows(false, new Date(startedAt * 1000).toISOString());
    timer = setIntervalImpl(() => refresh(), intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return refresh();
  }

  function stop() {
    running = false;
    generation++;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }

  function getSnapshot() {
    return copySnapshot(snapshot);
  }

  function hasAuthoritativeSnapshot() {
    return snapshot.observedAt !== null;
  }

  function isRunning() {
    return running;
  }

  return Object.freeze({
    start,
    stop,
    refresh,
    getSnapshot,
    hasAuthoritativeSnapshot,
    isRunning,
  });
}

const managedLiveSourceHealth = createManagedLiveSourceHealthMonitor();

module.exports = {
  CANONICAL_SOURCE_IDS,
  COMPUTER_SOURCE_IDS,
  safeSignal,
  isSourceAvailable,
  createManagedLiveSourceHealthMonitor,
  managedLiveSourceHealth,
};
