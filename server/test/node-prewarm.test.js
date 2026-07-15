const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nodeHttpAuthOk, requestContentPrewarm } = require('../lib/node-registry');

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
