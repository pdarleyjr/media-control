'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const { db } = require('../db/database');
const { createLiveSourcesRouter } = require('../routes/live-sources');
const { createManagedLiveSourceHealthMonitor } = require('../lib/managed-live-source-health');

function sourceMap(payload) {
  return Object.fromEntries(payload.sources.map((source) => [source.id, source]));
}

async function requestRouter(server) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

test('live-source route persists the three-source health contract without fabricating Guest device reachability', async () => {
  const originalRows = db.prepare(`
    SELECT id, availability, signal_json, last_seen_at, updated_at
    FROM live_sources
    WHERE id IN ('anpviz', 'podium-computer', 'guest-computer')
  `).all();
  assert.equal(originalRows.length, 3, 'canonical source migration must already be applied');
  const reset = db.prepare(`
    UPDATE live_sources
    SET availability = 'unknown', signal_json = NULL, last_seen_at = 0
    WHERE id IN ('anpviz', 'podium-computer', 'guest-computer')
  `);
  const restore = db.prepare(`
    UPDATE live_sources
    SET availability = ?, signal_json = ?, last_seen_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const healthyAnpviz = {
    video_online: true,
    microphone_connected: true,
    audio_online: true,
    synchronization_status: 'locked',
  };
  let phase = 0;
  const statuses = [
    {
      anpviz: healthyAnpviz,
      'podium-computer': {
        device_online: null,
        signal_present: false,
        publisher_online: false,
        stream_ready: true,
        available: false,
        resolution: '1920x1080',
        frame_rate: 60,
        embedded_audio_detected: true,
      },
      'guest-computer': {
        device_online: null,
        device_observable: false,
        publisher_online: true,
        signal_present: true,
        stream_ready: true,
        available: true,
        resolution: null,
        frame_rate: null,
        embedded_audio_detected: true,
        last_update: '2026-08-27T15:01:00.000Z',
      },
    },
    {
      anpviz: healthyAnpviz,
      'podium-computer': {
        device_online: true,
        signal_present: true,
        publisher_online: false,
        stream_ready: true,
        available: true,
        resolution: '1920x1080',
        frame_rate: 60,
        embedded_audio_detected: true,
      },
      'guest-computer': {
        device_online: null,
        device_observable: false,
        publisher_online: true,
        signal_present: true,
        stream_ready: true,
        available: true,
        embedded_audio_detected: true,
      },
    },
    {
      anpviz: healthyAnpviz,
      'podium-computer': {
        device_online: true,
        signal_present: true,
        stream_ready: true,
        available: true,
        embedded_audio_detected: true,
      },
      'guest-computer': {
        device_online: null,
        device_observable: false,
        publisher_online: true,
        signal_present: true,
        stream_ready: true,
        available: false,
        embedded_audio_detected: false,
      },
    },
  ];
  const app = express();
  let edgeCalls = 0;
  const monitor = createManagedLiveSourceHealthMonitor({
    database: db,
    fetchStatus: async () => {
      edgeCalls++;
      return { ok: true, data: { sources: statuses[phase] } };
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  app.use('/', createLiveSourcesRouter({ health: monitor }));
  const server = app.listen(0, '127.0.0.1');

  reset.run();
  try {
    await once(server, 'listening');
    const before = Math.floor(Date.now() / 1000);
    await monitor.refresh();
    const first = sourceMap(await requestRouter(server));
    assert.equal(edgeCalls, 1, 'the UI route only displays the server-owned snapshot');
    assert.equal(first.anpviz.available, true, 'Anpviz behavior remains unchanged');
    assert.equal(first['podium-computer'].available, false);
    assert.equal(first['podium-computer'].signal.device_online, null);
    assert.equal(first['guest-computer'].available, true);
    assert.deepEqual(first['guest-computer'].signal, {
      device_online: null,
      device_observable: false,
      publisher_online: true,
      signal_present: true,
      available: true,
      stream_ready: true,
      resolution: null,
      frame_rate: null,
      embedded_audio_detected: true,
      last_update: '2026-08-27T15:01:00.000Z',
    });
    assert.ok(
      db.prepare('SELECT last_seen_at FROM live_sources WHERE id = ?').get('guest-computer').last_seen_at >= before,
      'available Guest publisher health refreshes the durable freshness record',
    );

    phase = 1;
    await monitor.refresh();
    const second = sourceMap(await requestRouter(server));
    assert.equal(edgeCalls, 2, 'the explicit server monitor refresh, not the route, polls health');
    assert.equal(second['podium-computer'].available, true);
    assert.equal(second['podium-computer'].signal.device_online, true);
    assert.ok(
      db.prepare('SELECT last_seen_at FROM live_sources WHERE id = ?').get('podium-computer').last_seen_at >= before,
      'available Podium health refreshes the durable freshness record',
    );

    phase = 2;
    await monitor.refresh();
    const third = sourceMap(await requestRouter(server));
    assert.equal(edgeCalls, 3);
    assert.equal(third['guest-computer'].signal.stream_ready, true);
    assert.equal(third['guest-computer'].signal.embedded_audio_detected, false);
    assert.equal(third['guest-computer'].available, false, 'AAC-less edge health cannot make Guest routable');
  } finally {
    monitor.stop();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const row of originalRows) {
      restore.run(row.availability, row.signal_json, row.last_seen_at, row.updated_at, row.id);
    }
  }
});
