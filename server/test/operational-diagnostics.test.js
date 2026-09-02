'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

function fixtureDb({ displays = [], nodes = [] } = {}) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      assert.match(normalized, /^(SELECT|WITH)\b/i, 'diagnostics may prepare SELECT statements only');
      return {
        all() {
          if (/FROM devices d/i.test(normalized)) return displays;
          if (/FROM managed_nodes/i.test(normalized)) return nodes;
          throw new Error(`Unexpected diagnostics query: ${normalized}`);
        },
      };
    },
  };
}

test('operational diagnostics are read-only, bounded, and use authoritative existing rows', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const now = 1_800_000_000_000;
  const db = fixtureDb({
    displays: Array.from({ length: 60 }, (_, index) => ({
      id: `tv-${index + 1}`,
      name: index === 0 ? 'Front Left' : `TV ${index + 1}`,
      status: 'online',
      last_heartbeat: Math.floor(now / 1000) - 4,
      last_heartbeat_at: now - 3_000,
      latest_route_confirmed_at: now - 2_000,
      render_state: 'playing',
      error_state: null,
      current_content_id: 'content-1',
      content_type: 'video',
      muted: index !== 0 ? 1 : 0,
      operator_muted: 0,
      state_updated_at: now - 1_000,
    })),
    nodes: Array.from({ length: 30 }, (_, index) => ({
      node_id: `node-${index + 1}`,
      node_name: `Node ${index + 1}`,
      node_type: 'p3',
      last_heartbeat: Math.floor(now / 1000) - 5,
      software_version: 'agent-1',
      cache_size: 4096,
      sync_status: 'ready',
      network_state_json: JSON.stringify({ server_url_category: 'local_lan', reachability: 'reachable' }),
      telemetry_json: JSON.stringify({ cache: { file_count: 12, manifest_count: 12, cached_manifest_count: 12, origin_category: 'local_lan' } }),
    })),
  });

  const snapshot = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1',
    roomId: 'classroom-1',
    now,
    heartbeatTimeoutMs: 45_000,
    audioAuthorityDeviceId: 'tv-1',
  });

  assert.equal(snapshot.renderers.length, 50);
  assert.equal(snapshot.nodes.length, 20);
  assert.equal(snapshot.renderers[0].connected, true);
  assert.equal(snapshot.renderers[0].latest_route_confirmation_at, now - 2_000);
  assert.equal(snapshot.renderers[0].latest_render_confirmation.state, 'playing');
  assert.deepEqual(snapshot.configured_audio_authority, {
    device_id: 'tv-1',
    device_name: 'Front Left',
    configured: true,
    connected: true,
    muted: false,
    operator_muted: false,
  });
  assert.equal(snapshot.nodes[0].origin_path, 'local_lan');
  assert.equal(snapshot.nodes[0].cache.file_count, 12);
  assert.equal(snapshot.health.status, 'healthy');
  assert.ok(db.statements.every((sql) => /^(SELECT|WITH)\b/i.test(sql)));
});

test('missing and malformed telemetry degrade safely without inventing authority', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const now = 1_800_000_000_000;
  const db = fixtureDb({
    displays: [{
      id: 'tv-1', name: 'TV 1', status: 'online', last_heartbeat: null,
      last_heartbeat_at: null, last_ack_at: null, render_state: null,
      error_state: '{not-json', muted: null, operator_muted: null,
    }],
    nodes: [{
      node_id: 'node-1', node_name: 'P3', last_heartbeat: null, cache_size: null,
      network_state_json: '{broken', telemetry_json: '[]',
    }],
  });

  const snapshot = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1', roomId: 'classroom-1', now,
    heartbeatTimeoutMs: 45_000, audioAuthorityDeviceId: 'missing-device',
  });

  assert.equal(snapshot.renderers[0].connected, false);
  assert.equal(snapshot.renderers[0].heartbeat_age_sec, null);
  assert.deepEqual(snapshot.renderers[0].latest_render_confirmation, { state: 'unknown', at: null, error: null });
  assert.deepEqual(snapshot.nodes[0].cache, {
    size_bytes: null, file_count: null, manifest_count: null,
    cached_manifest_count: null, sync_status: 'unknown',
  });
  assert.equal(snapshot.nodes[0].origin_path, 'unknown');
  assert.equal(snapshot.configured_audio_authority.configured, true);
  assert.equal(snapshot.configured_audio_authority.device_name, null);
  assert.equal(snapshot.health.status, 'degraded');
  assert.ok(snapshot.health.reasons.includes('configured_audio_authority_not_found'));
});

test('diagnostics never return raw persisted error text', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const probes = [
    'Authorization: Bearer very-secret-token',
    'https://example.invalid/media?token=secret',
    'https://example.invalid/signed?Signature=secret',
    'sessionid=secret-cookie',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
    'api_key=secret',
    'x'.repeat(10_000),
  ];
  for (const errorState of probes) {
    const snapshot = buildOperationalDiagnostics(fixtureDb({ displays: [{
      id: 'tv-1', name: 'TV 1', status: 'online', last_heartbeat: 1_800_000_000,
      error_state: errorState,
    }] }), { workspaceId: 'workspace-1', now: 1_800_000_001_000 });
    const rendered = JSON.stringify(snapshot);
    assert.equal(rendered.includes(errorState), false);
    assert.equal(snapshot.renderers[0].latest_render_confirmation.error, null);
  }
});

test('a generic command acknowledgement is not reported as a confirmed route', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const db = fixtureDb({ displays: [{
    id: 'tv-1', name: 'TV 1', status: 'online', last_heartbeat: 1_800_000_000,
    last_ack_at: 1_800_000_000_000, latest_route_confirmed_at: null,
  }] });
  const snapshot = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1', now: 1_800_000_001_000,
    audioAuthorityDeviceId: 'tv-1', heartbeatTimeoutMs: 45_000,
  });
  assert.equal(snapshot.renderers[0].latest_route_confirmation_at, null);
});

test('diagnostics correlate existing per-target command ACKs with only causally matching software progress', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const now = 1_800_000_010_000;
  const db = fixtureDb({ displays: [{
    id: 'tv-1', name: 'TV 1', status: 'online', last_heartbeat: Math.floor(now / 1000),
    last_heartbeat_at: now, last_command_id: 'child-command-1', last_parent_command_id: 'wall-command-1',
    last_command_created_at: now - 800, last_command_ack_at: now - 600, last_command_status: 'acked',
  }] });
  const snapshot = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1', now, heartbeatTimeoutMs: 45_000,
    rendererProgressById: () => ({
      playback_state: 'PLAYING_PROGRESS', command_id: 'child-command-1',
      last_confirmed_render_progress_at: now - 400, command_confirmation_at: now - 400,
      physical_pixels_observed: false,
    }),
  });
  const renderer = snapshot.renderers[0];
  assert.equal(renderer.last_command.parent_command_id, 'wall-command-1');
  assert.equal(renderer.last_command.ack_latency_ms, 200);
  assert.equal(renderer.last_command.render_confirmation_at, now - 400);
  assert.equal(renderer.last_command.render_confirmation_latency_ms, 400);
  assert.equal(renderer.render_progress.physical_pixels_observed, false);
});

test('diagnostics fail closed for impossible clock ordering and timeout is not an acknowledgement', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const now = 1_800_000_010_000;
  const db = fixtureDb({ displays: [{
    id: 'tv-1', name: 'TV 1', status: 'online', last_heartbeat: Math.floor(now / 1000),
    last_heartbeat_at: now, last_command_id: 'command-1', last_command_created_at: now - 100,
    last_command_ack_at: now - 200, last_command_status: 'timeout',
  }] });
  const renderer = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1', now, rendererProgressById: () => ({
      command_id: 'command-1', command_confirmation_at: now - 200,
    }),
  }).renderers[0];
  assert.equal(renderer.last_command.acknowledged_at, null);
  assert.equal(renderer.last_command.ack_latency_ms, null);
  assert.equal(renderer.last_command.render_confirmation_at, null);
  assert.equal(renderer.last_command.render_confirmation_latency_ms, null);
});

test('command lookup is a bounded display-only read model, never a scalar-ID lookup across target types', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'server', 'lib', 'operational-diagnostics.js'), 'utf8');
  assert.match(source, /WITH scoped_displays AS/);
  assert.match(source, /FROM scoped_displays d/);
  assert.match(source, /cl\.target_type = 'display' AND cl\.target_id = d\.id/);
  assert.doesNotMatch(source, /latest_display_commands/);
  const schema = fs.readFileSync(path.join(repoRoot, 'server', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /idx_command_logs_display_latest_command[\s\S]*target_type, target_id, created_at DESC, command_id DESC/);
});

test('bounded diagnostics query uses index-backed display command probes and preserves target/workspace isolation', () => {
  const Database = require('better-sqlite3');
  const { DISPLAY_DIAGNOSTICS_SQL } = require('../lib/operational-diagnostics');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE devices (id TEXT, name TEXT, status TEXT, last_heartbeat INTEGER, workspace_id TEXT);
    CREATE TABLE display_states (target_type TEXT, target_id TEXT, last_heartbeat_at INTEGER, render_state TEXT, error_state TEXT, current_content_id TEXT, content_type TEXT, muted INTEGER, operator_muted INTEGER, updated_at INTEGER);
    CREATE TABLE command_logs (command_id TEXT, parent_command_id TEXT, target_type TEXT, target_id TEXT, created_at INTEGER, ack_at INTEGER, status TEXT);
    CREATE TABLE broadcast_device_results (request_id TEXT, device_id TEXT, state TEXT, confirmed_at INTEGER);
    CREATE TABLE broadcast_requests (id TEXT, workspace_id TEXT);
    CREATE INDEX idx_devices_workspace_diagnostics_order ON devices(workspace_id, name COLLATE NOCASE, id);
    CREATE INDEX idx_command_logs_display_latest_command ON command_logs(target_type, target_id, created_at DESC, command_id DESC);
  `);
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run('same-id', 'Display A', 'online', 1, 'workspace-a');
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run('other-id', 'Display B', 'online', 1, 'workspace-b');
  const insert = db.prepare('INSERT INTO command_logs VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('display-command', 'wall-parent', 'display', 'same-id', 100, 120, 'acked');
  insert.run('wall-command', null, 'wall', 'same-id', 999, 999, 'acked');
  const insertMany = db.transaction(() => {
    for (let index = 0; index < 200_000; index += 1) {
      insert.run(`unrelated-${index}`, null, 'display', `unrelated-${index % 200}`, index, null, 'sent');
    }
  });
  insertMany();

  const rows = db.prepare(DISPLAY_DIAGNOSTICS_SQL).all('workspace-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'same-id');
  assert.equal(rows[0].last_command_id, 'display-command');
  assert.equal(rows[0].last_parent_command_id, 'wall-parent');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${DISPLAY_DIAGNOSTICS_SQL}`).all('workspace-a')
    .map((row) => row.detail).join('\n');
  assert.match(plan, /SEARCH cl USING (COVERING )?INDEX idx_command_logs_display_latest_command/);
  assert.doesNotMatch(plan, /SCAN cl/);
  assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  const databaseBootstrap = fs.readFileSync(path.join(repoRoot, 'server', 'db', 'database.js'), 'utf8');
  assert.match(databaseBootstrap, /idx_devices_workspace_diagnostics_order[\s\S]*workspace_id, name COLLATE NOCASE, id/);
});

test('unavailable read models return a bounded degraded snapshot instead of throwing', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  const db = { prepare() { throw new Error('read model unavailable'); } };
  const snapshot = buildOperationalDiagnostics(db, {
    workspaceId: 'workspace-1', now: 1_800_000_001_000,
  });
  assert.deepEqual(snapshot.renderers, []);
  assert.deepEqual(snapshot.nodes, []);
  assert.equal(snapshot.configured_audio_authority.configured, false);
  assert.deepEqual(snapshot.health.reasons, [
    'no_renderer_telemetry',
    'configured_audio_authority_not_configured',
    'no_room_node_telemetry',
  ]);
});

test('diagnostics reject missing database and workspace scope', () => {
  const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');
  assert.throws(() => buildOperationalDiagnostics(null, { workspaceId: 'workspace-1' }), /database/i);
  assert.throws(() => buildOperationalDiagnostics(fixtureDb(), {}), /workspaceId/);
});

test('diagnostics UI is collapsed, fetches on demand, and cannot emit device commands', () => {
  const adminSource = fs.readFileSync(path.join(repoRoot, 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(repoRoot, 'server', 'routes', 'operational-diagnostics.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');

  assert.match(adminSource, /<details[^>]+id="operationalDiagnostics"/);
  assert.doesNotMatch(adminSource, /<details[^>]+id="operationalDiagnostics"[^>]+open/);
  assert.match(adminSource, /addEventListener\('toggle'/);
  assert.match(adminSource, /api\.getOperationalDiagnostics\(\)/);
  assert.match(adminSource, /version\.git_tree/);
  assert.match(adminSource, /version\.build_id/);
  assert.match(adminSource, /version\.image_tag/);
  assert.match(adminSource, /version\.branch/);
  assert.doesNotMatch(adminSource, /device:command|sendCommand|setInterval/);
  assert.match(routeSource, /router\.get\('\/'/);
  assert.doesNotMatch(routeSource, /router\.(post|put|patch|delete)|\.run\(|\.exec\(|\.emit\(/i);
  assert.match(serverSource, /\/api\/operational-diagnostics/);
});
