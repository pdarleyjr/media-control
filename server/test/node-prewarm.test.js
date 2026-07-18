const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  nodeHttpAuthOk,
  normalizeNodeTelemetry,
  prewarmUploadedContent,
  requestContentPrewarm,
} = require('../lib/node-registry');

function fakeDb({ member = true } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('FROM video_wall_devices')) {
        return { get: () => (member ? { found: 1 } : undefined) };
      }
      if (sql.includes('FROM content c')) {
        return {
          all: () => [{
            content_id: 'video-id',
            size_bytes: 123,
            canonical_size: 123,
            sha256: 'a'.repeat(64),
            asset_id: 'video-id',
            mime_type: 'video/mp4',
            created_at: 1,
          }],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function fakeIo(events) {
  return {
    of(namespace) {
      assert.equal(namespace, '/device');
      return {
        to(room) {
          return {
            emit(event, payload) { events.push({ room, event, payload }); },
          };
        },
      };
    },
  };
}

test('classroom content broadcast sends a priority prewarm to the configured P3 node', () => {
  const events = [];
  const result = requestContentPrewarm(fakeIo(events), fakeDb(), {
    deviceIds: ['display-1', 'display-2'],
    contentId: 'video-id',
    classroomCache: {
      enabled: true,
      wallIds: ['wall-1'],
      nodeId: 'classroom-1-p3',
    },
  });

  assert.equal(result.requested, true);
  assert.equal(result.content_id, 'video-id');
  assert.deepEqual(events, [{
    room: 'node:classroom-1-p3',
    event: 'node:prewarm-content',
    payload: {
      asset_id: 'video-id',
      content_id: 'video-id',
      sha256: 'a'.repeat(64),
      size: 123,
      size_bytes: 123,
      canonical_url: '/api/content/video-id/file',
    },
  }]);
});

test('new uploads are checksummed on GMKtec and immediately prewarmed on the P3', async () => {
  const events = [];
  const item = {
    asset_id: 'upload-id',
    content_id: 'upload-id',
    sha256: 'b'.repeat(64),
    size_bytes: 456,
    canonical_url: '/api/content/upload-id/file',
  };
  const result = await prewarmUploadedContent(fakeIo(events), fakeDb(), {
    contentId: 'upload-id',
    absolutePath: '/gmktec/uploads/upload-id.png',
    classroomCache: { enabled: true, nodeId: 'classroom-1-p3' },
    writeManifest: async (_db, contentId, absolutePath) => {
      assert.equal(contentId, 'upload-id');
      assert.equal(absolutePath, '/gmktec/uploads/upload-id.png');
      return item;
    },
  });

  assert.equal(result.requested, true);
  assert.deepEqual(events, [{
    room: 'node:classroom-1-p3',
    event: 'node:prewarm-content',
    payload: item,
  }]);
});

test('prewarm signal is skipped for targets outside configured classroom walls', () => {
  const events = [];
  const result = requestContentPrewarm(fakeIo(events), fakeDb({ member: false }), {
    deviceIds: ['other-display'],
    contentId: 'video-id',
    classroomCache: { enabled: true, wallIds: ['wall-1'], nodeId: 'classroom-1-p3' },
  });
  assert.equal(result.requested, false);
  assert.equal(result.reason, 'targets_not_cached');
  assert.deepEqual(events, []);
});

test('cache HTTP access requires the configured node token', () => {
  const request = {
    get(name) {
      return String(name).toLowerCase() === 'x-mbfd-node-token' ? 'node-secret' : undefined;
    },
  };
  assert.equal(nodeHttpAuthOk(request, { nodeToken: 'node-secret' }), true);
  assert.equal(nodeHttpAuthOk(request, { nodeToken: 'different-secret' }), false);
  assert.equal(nodeHttpAuthOk({ get: () => '' }, { nodeToken: 'node-secret' }), false);
});

test('public content route allows a valid cache node without weakening browser access', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /const nodeAuthorized = nodeRegistry\.nodeHttpAuthOk\(req\)/);
  assert.match(source, /if \(!nodeAuthorized && !canServePublicContent\(db, content\)\)/);
});

test('node telemetry persists only bounded diagnostics fields and excludes secrets', () => {
  const telemetry = normalizeNodeTelemetry({
    agent_uptime_sec: 120,
    kiosk_uptime_sec: 3600,
    player_version: 'player-1',
    kiosk_version: 'kiosk-2',
    build_hash: 'abc123',
    configuration_schema_version: 1,
    cache_health: 'degraded',
    current_renderer: 'video',
    audio_track_present: true,
    audio_codec: 'aac',
    last_successful_command: 'transport:next',
    last_command_error: 'x'.repeat(400),
    display_mapping: ['front-left', 'front-center'],
    lan_health_test: {
      ok: true,
      at: 1_720_000_000,
      bytes: 67_108_864,
      elapsed_ms: 5500,
      ttfb_ms: 4,
      mbps: 97.61,
      status: 'critical',
      degraded: true,
      degraded_reason: 'throughput_below_1_gbps_class',
      token: 'must-not-persist',
    },
    cache: {
      current_content_id: 'video-id',
      cache_hits: 10,
      cache_misses: 2,
      timeout_count: 1,
      last_failure_reason: 'idle_timeout',
      token: 'must-not-persist',
    },
    token: 'must-not-persist',
  });

  assert.equal(telemetry.agent_uptime_sec, 120);
  assert.equal(telemetry.kiosk_uptime_sec, 3600);
  assert.equal(telemetry.configuration_schema_version, 1);
  assert.equal(telemetry.current_renderer, 'video');
  assert.equal(telemetry.audio_track_present, true);
  assert.equal(telemetry.last_command_error.length, 256);
  assert.deepEqual(telemetry.display_mapping, ['front-left', 'front-center']);
  assert.equal(telemetry.lan_health_test.mbps, 97.61);
  assert.equal(telemetry.lan_health_test.token, undefined);
  assert.equal(telemetry.cache.current_content_id, 'video-id');
  assert.equal(telemetry.cache.timeout_count, 1);
  assert.equal(telemetry.token, undefined);
  assert.equal(telemetry.cache.token, undefined);
});

test('node diagnostics schema and secured status response include telemetry JSON', () => {
  const database = fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');
  const status = fs.readFileSync(path.join(__dirname, '..', 'routes', 'status.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  assert.match(database, /managed_nodes ADD COLUMN telemetry_json TEXT/);
  assert.match(database, /node_heartbeats ADD COLUMN telemetry_json TEXT/);
  assert.match(status, /telemetry_json/);
  assert.match(status, /JSON\.parse\(node\.telemetry_json\)/);
  assert.match(status, /nodeRegistry\.nodeHttpAuthOk\(req\)/);
  assert.match(status, /activeLanHealthTests\.get\(testId\)/);
  assert.match(status, /LAN_HEALTH_COOLDOWN_MS/);
  assert.match(status, /node:run-lan-health-test/);
  assert.match(admin, /networkDiagnostics/);
  assert.match(admin, /Negotiated link/);
  assert.match(admin, /Run LAN test when idle/);
  assert.match(admin, /Build mismatch/);
  assert.match(server, /'js\/views\/admin\.js'/);
});

test('P3 agent reconciles manifests slowly but keeps priority and LAN tests event driven', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', '..', 'appliance', 'p3', 'room-agent', 'cache-agent.js'), 'utf8');
  assert.match(agent, /10 \* 60 \* 1000/);
  assert.match(agent, /Math\.min\(15 \* 60 \* 1000, Math\.max\(5 \* 60 \* 1000/);
  assert.match(agent, /node:prewarm-content/);
  assert.match(agent, /node:run-lan-health-test/);
  assert.match(agent, /cacheStats: cache\.getStats\(\)/);
});
