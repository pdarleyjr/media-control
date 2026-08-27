'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { migrateLiveSourcesSchema } = require('../db/migrations/live-sources');
const {
  createManagedLiveSourceHealthMonitor,
} = require('../lib/managed-live-source-health');
const {
  managedComputerRouteFailure,
} = require('../lib/managed-computer-routing');

function healthyComputerSource() {
  return {
    device_online: true,
    publisher_online: true,
    signal_present: true,
    stream_ready: true,
    available: true,
    embedded_audio_detected: true,
  };
}

function healthyStatus() {
  return {
    sources: {
      anpviz: {
        video_online: true,
        microphone_connected: true,
        audio_online: true,
        synchronization_status: 'locked',
      },
      'podium-computer': healthyComputerSource(),
      'guest-computer': healthyComputerSource(),
    },
  };
}

function sourceDb() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER DEFAULT (strftime('%s', 'now')),
      checksum TEXT
    );
  `);
  migrateLiveSourcesSchema(database);
  return database;
}

test('server-owned monitor refreshes Podium and Guest health without any UI request and fails closed on edge loss', async () => {
  const database = sourceDb();
  let nowSeconds = 10_000;
  let intervalCallback = null;
  let fetchCalls = 0;
  let status = healthyStatus();
  const monitor = createManagedLiveSourceHealthMonitor({
    database,
    fetchStatus: async (timeoutMs) => {
      fetchCalls++;
      assert.equal(timeoutMs, 4_000, 'monitor uses the bounded camera API timeout');
      return { ok: true, data: status };
    },
    now: () => nowSeconds * 1000,
    setIntervalImpl: (callback, intervalMs) => {
      assert.equal(intervalMs, 5_000, 'monitor interval is bounded at five seconds');
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
  });

  try {
    await monitor.start();
    assert.equal(fetchCalls, 1);
    assert.ok(monitor.hasAuthoritativeSnapshot());
    assert.equal(monitor.getSnapshot().sources['podium-computer'].available, true);
    assert.equal(monitor.getSnapshot().sources['guest-computer'].available, true);

    // Reading health is the only work a UI route may do. It must not be the
    // heartbeat authority that keeps durable source state alive.
    const beforeUiReadCalls = fetchCalls;
    monitor.getSnapshot();
    assert.equal(fetchCalls, beforeUiReadCalls, 'a UI read does not poll the edge');

    nowSeconds += 61;
    await intervalCallback();
    assert.equal(fetchCalls, 2, 'the server timer, not the UI, refreshed health');
    for (const sourceId of ['podium-computer', 'guest-computer']) {
      const row = database.prepare('SELECT last_seen_at FROM live_sources WHERE id = ?').get(sourceId);
      assert.equal(row.last_seen_at, nowSeconds, `${sourceId} freshness is renewed by the monitor`);
      assert.equal(
        managedComputerRouteFailure(`/player/live-source.html?source=${sourceId}`, {
          database,
          healthProvider: monitor,
          nowSeconds,
        }),
        null,
        `${sourceId} remains routable after more than the old UI poll window`,
      );
    }

    status = healthyStatus();
    status.sources['podium-computer'].available = false;
    status.sources['guest-computer'].available = false;
    await monitor.refresh();
    for (const sourceId of ['podium-computer', 'guest-computer']) {
      assert.match(
        managedComputerRouteFailure(`/player/live-source.html?source=${sourceId}`, {
          database,
          healthProvider: monitor,
          nowSeconds,
        }),
        new RegExp(`unavailable: ${sourceId}`),
        `${sourceId} is blocked as soon as the server monitor observes edge loss`,
      );
    }
  } finally {
    monitor.stop();
    database.close();
  }
});

test('server-owned monitor permits only one outstanding edge request', async () => {
  const database = sourceDb();
  let fetchCalls = 0;
  let resolveFetch;
  const monitor = createManagedLiveSourceHealthMonitor({
    database,
    fetchStatus: () => {
      fetchCalls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  try {
    const first = monitor.refresh();
    const second = monitor.refresh();
    assert.strictEqual(second, first, 'a concurrent refresh joins the in-flight request');
    assert.equal(fetchCalls, 1);
    resolveFetch({ ok: true, data: healthyStatus() });
    await first;
  } finally {
    monitor.stop();
    database.close();
  }
});

test('a monitor restart fails closed for durable computer state and ignores a late edge response after stop', async () => {
  const database = sourceDb();
  database.prepare(`
    UPDATE live_sources
    SET availability = 'available', last_seen_at = ?
    WHERE id IN ('anpviz', 'podium-computer', 'guest-computer')
  `).run(12_000);
  let resolveFetch;
  const monitor = createManagedLiveSourceHealthMonitor({
    database,
    fetchStatus: () => new Promise((resolve) => { resolveFetch = resolve; }),
    now: () => 12_000_000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  try {
    const pendingStart = monitor.start();
    assert.deepEqual(
      database.prepare("SELECT id, availability FROM live_sources WHERE id IN ('podium-computer', 'guest-computer') ORDER BY id").all(),
      [
        { id: 'guest-computer', availability: 'unknown' },
        { id: 'podium-computer', availability: 'unknown' },
      ],
      'a new process cannot inherit computer routing authority',
    );
    assert.equal(
      database.prepare("SELECT availability FROM live_sources WHERE id = 'anpviz'").get().availability,
      'available',
      'Anpviz retains its existing startup behavior',
    );
    assert.match(
      managedComputerRouteFailure('/player/live-source.html?source=podium-computer', {
        database,
        healthProvider: monitor,
        nowSeconds: 12_000,
      }),
      /unavailable: podium-computer/,
    );

    monitor.stop();
    resolveFetch({ ok: true, data: healthyStatus() });
    await pendingStart;
    assert.equal(
      database.prepare("SELECT availability FROM live_sources WHERE id = 'podium-computer'").get().availability,
      'unknown',
      'a response that arrives after stop cannot rewrite durable health',
    );
  } finally {
    monitor.stop();
    database.close();
  }
});

test('a monitor snapshot never bypasses the durable enabled and 60-second freshness fences', async () => {
  const database = sourceDb();
  let nowSeconds = 20_000;
  const monitor = createManagedLiveSourceHealthMonitor({
    database,
    fetchStatus: async () => ({ ok: true, data: healthyStatus() }),
    now: () => nowSeconds * 1000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  try {
    await monitor.refresh();
    const options = { database, healthProvider: monitor, nowSeconds };
    assert.equal(managedComputerRouteFailure('/player/live-source.html?source=guest-computer', options), null);

    database.prepare("UPDATE live_sources SET enabled = 0 WHERE id = 'guest-computer'").run();
    assert.match(
      managedComputerRouteFailure('/player/live-source.html?source=guest-computer', options),
      /unavailable: guest-computer/,
      'a healthy in-memory snapshot cannot override durable disablement',
    );

    database.prepare("UPDATE live_sources SET enabled = 1 WHERE id = 'guest-computer'").run();
    nowSeconds += 61;
    assert.match(
      managedComputerRouteFailure('/player/live-source.html?source=guest-computer', {
        database,
        healthProvider: monitor,
        nowSeconds,
      }),
      /unavailable: guest-computer/,
      'a stale monitor snapshot cannot bypass the pre-existing 60-second freshness fence',
    );
  } finally {
    monitor.stop();
    database.close();
  }
});
