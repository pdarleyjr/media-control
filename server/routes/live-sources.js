'use strict';

const express = require('express');
const { db } = require('../db/database');
const { managedLiveSourceHealth } = require('../lib/managed-live-source-health');

function persistedSignal(row) {
  try {
    const signal = JSON.parse(row.signal_json || '{}');
    return signal && typeof signal === 'object' ? signal : {};
  } catch {
    return {};
  }
}

// This endpoint is display-only. The server-owned monitor is the sole status
// poller and durable freshness writer; opening this UI cannot keep a source
// routable.
function createLiveSourcesRouter({ database = db, health = managedLiveSourceHealth } = {}) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const snapshot = health && typeof health.getSnapshot === 'function'
      ? health.getSnapshot()
      : { edgeAvailable: false, observedAt: null, sources: {} };
    const rows = database.prepare(`
      SELECT id, source_type, display_name, player_path, visibility_policy,
             availability, signal_json
      FROM live_sources
      WHERE enabled = 1
      ORDER BY CASE id WHEN 'anpviz' THEN 0 ELSE 1 END
    `).all();
    const sources = rows.map((row) => {
      const observed = snapshot.sources?.[row.id];
      return {
        id: row.id,
        source_type: row.source_type,
        display_name: row.display_name,
        player_url: row.player_path,
        visibility_policy: row.visibility_policy,
        available: observed ? observed.available === true : row.availability === 'available',
        signal: observed?.signal && typeof observed.signal === 'object'
          ? observed.signal
          : persistedSignal(row),
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      sources,
      edge_available: snapshot.edgeAvailable === true,
      updated_at: snapshot.observedAt || new Date().toISOString(),
    });
  });

  return router;
}

const router = createLiveSourcesRouter();
module.exports = router;
module.exports.createLiveSourcesRouter = createLiveSourcesRouter;
