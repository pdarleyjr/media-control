'use strict';

const express = require('express');
const { db } = require('../db/database');
const cameraControl = require('../lib/camera-control-client');
const { persistedSignal } = require('../lib/live-source-state');

const router = express.Router();

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
    frame_rate: Number.isFinite(Number(source.frame_rate)) ? Number(source.frame_rate) : null,
    embedded_audio_detected: source.embedded_audio_detected === true,
    last_update: source.last_update || null,
  };
}

function isAvailable(sourceId, signal) {
  if (sourceId === 'anpviz') {
    return signal.video_online === true
      && signal.microphone_connected === true
      && signal.audio_online === true
      && ['locked', 'configured'].includes(signal.synchronization_status);
  }
  return signal.available === true
    && signal.stream_ready === true;
}

router.get('/', async (_req, res) => {
  const edge = await cameraControl.getStatus();
  const edgeStatus = edge.ok && edge.data ? edge.data : {};
  const rows = db.prepare(`
    SELECT id, source_type, display_name, player_path, visibility_policy, enabled
    FROM live_sources
    WHERE enabled = 1
    ORDER BY CASE id WHEN 'anpviz' THEN 0 ELSE 1 END
  `).all();

  const update = db.prepare(`
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lastSeenCutoff = nowSeconds - 60;
  const sources = rows.map((row) => {
    const signal = safeSignal(row.id, edgeStatus);
    const available = isAvailable(row.id, signal);
    const availability = available ? 'available' : 'unavailable';
    const persistentJson = JSON.stringify(persistedSignal(signal));
    update.run(
      availability,
      persistentJson,
      availability,
      nowSeconds,
      row.id,
      availability,
      persistentJson,
      availability,
      lastSeenCutoff,
    );
    return {
      id: row.id,
      source_type: row.source_type,
      display_name: row.display_name,
      player_url: row.player_path,
      visibility_policy: row.visibility_policy,
      available,
      signal,
    };
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    sources,
    edge_available: edge.ok === true,
    updated_at: new Date().toISOString(),
  });
});

module.exports = router;
