'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { DISPLAY_DIAGNOSTICS_SQL } = require('../lib/operational-diagnostics');

test('representative 200k broadcast history stays device-scoped and index-backed', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    PRAGMA journal_mode = MEMORY;
    PRAGMA synchronous = OFF;
    CREATE TABLE devices (id TEXT, name TEXT, status TEXT, last_heartbeat INTEGER, workspace_id TEXT);
    CREATE TABLE display_states (target_type TEXT, target_id TEXT, last_heartbeat_at INTEGER, render_state TEXT, error_state TEXT, current_content_id TEXT, content_type TEXT, muted INTEGER, operator_muted INTEGER, updated_at INTEGER);
    CREATE TABLE command_logs (command_id TEXT, parent_command_id TEXT, target_type TEXT, target_id TEXT, created_at INTEGER, ack_at INTEGER, status TEXT);
    CREATE TABLE broadcast_requests (id TEXT PRIMARY KEY, workspace_id TEXT, created_at INTEGER);
    CREATE TABLE broadcast_device_results (request_id TEXT, target_key TEXT, device_id TEXT, state TEXT, confirmed_at INTEGER);
    CREATE INDEX idx_devices_workspace_diagnostics_order ON devices(workspace_id, name COLLATE NOCASE, id);
    CREATE INDEX idx_command_logs_display_latest_command ON command_logs(target_type, target_id, created_at DESC, command_id DESC);
    CREATE INDEX idx_broadcast_requests_workspace_created ON broadcast_requests(workspace_id, created_at DESC);
    CREATE INDEX idx_broadcast_device_results_state ON broadcast_device_results(request_id, state);
    CREATE INDEX idx_broadcast_device_results_device_state_confirmed
      ON broadcast_device_results(device_id, state, confirmed_at DESC, request_id);
  `);

  const insertDevice = db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)');
  insertDevice.run('hot-device', 'Display 00 Hot', 'online', 1, 'workspace-a');
  for (let index = 1; index < 20; index += 1) {
    insertDevice.run(`display-${index}`, `Display ${String(index).padStart(2, '0')}`, 'online', 1, 'workspace-a');
  }
  for (let index = 0; index < 200; index += 1) {
    insertDevice.run(`irrelevant-${index}`, `Irrelevant ${index}`, 'online', 1, 'workspace-b');
  }

  const insertRequest = db.prepare('INSERT INTO broadcast_requests VALUES (?, ?, ?)');
  const insertResult = db.prepare('INSERT INTO broadcast_device_results VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let requestIndex = 0; requestIndex < 20_000; requestIndex += 1) {
      const requestId = `request-${requestIndex}`;
      const workspaceId = requestIndex % 4 === 0 ? 'workspace-b' : 'workspace-a';
      insertRequest.run(requestId, workspaceId, requestIndex);
      for (let targetIndex = 0; targetIndex < 10; targetIndex += 1) {
        const deviceId = targetIndex === 0
          ? 'hot-device'
          : `noise-${(requestIndex + targetIndex) % 500}`;
        const state = (requestIndex + targetIndex) % 3 === 0 ? 'confirmed' : 'acknowledged';
        insertResult.run(
          requestId,
          `${deviceId}:target:${targetIndex}`,
          deviceId,
          state,
          state === 'confirmed' ? 1_800_000_000_000 + requestIndex : null,
        );
      }
    }
  })();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM broadcast_device_results').get().count, 200_000);

  const statement = db.prepare(DISPLAY_DIAGNOSTICS_SQL);
  const rows = statement.all('workspace-a');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, 'hot-device');
  assert.ok(rows[0].latest_route_confirmed_at > 0);

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${DISPLAY_DIAGNOSTICS_SQL}`).all('workspace-a')
    .map((row) => row.detail).join('\n');
  statement.all('workspace-a');
  const timings = [];
  for (let run = 0; run < 7; run += 1) {
    const startedAt = performance.now();
    statement.all('workspace-a');
    timings.push(performance.now() - startedAt);
  }
  const sorted = [...timings].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  t.diagnostic(`rows=200000 timings_ms=${timings.map((value) => value.toFixed(2)).join(',')} median_ms=${median.toFixed(2)}`);
  t.diagnostic(`plan=${plan.replace(/\n/g, ' | ')}`);
  assert.match(plan, /idx_broadcast_device_results_device_state_confirmed/);
  assert.doesNotMatch(plan, /USE TEMP B-TREE|MATERIALIZE/i);
  assert.ok(median < 250, `median diagnostics query latency ${median.toFixed(2)} ms exceeded 250 ms`);
});
