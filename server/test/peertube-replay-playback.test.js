'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-peertube-playback-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { db } = require('../db/database');
const config = require('../config');
const svc = require('../services/peertube-replay');

const originalFetch = global.fetch;
const originalConfig = { ...config.peerTubeReplay };
let replayId;

test.before(() => {
  Object.assign(config.peerTubeReplay, {
    enabled: true,
    apiBase: 'https://peertube.example.test',
    publicWatchBase: 'https://peertube.example.test',
    apiToken: 'private-playback-token',
    apiUsername: '',
    apiPassword: '',
    requestTimeoutMs: 500,
    playbackAllowedOrigins: ['https://peertube.example.test'],
  });
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'user', 'enterprise')")
    .run('u1', 'playback@mbfd.test', 'Playback Operator');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org1', 'Org', 'u1');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws1', 'org1', 'Workspace');
  svc.registerRecordingSession({
    id: 'session-playback', workspaceId: 'ws1', instructorUserId: 'u1', title: 'Playback Test',
    streamSessionId: 'stream-playback', startedAt: 100, endedAt: 200,
  });
  const inserted = svc.upsertReplay({
    uuid: 'video-playback', id: 1, name: 'Playback Test', tags: ['rec:session-playback'],
    state: { id: 5, label: 'Published' }, privacy: 1, duration: 60,
    files: [{ fileUrl: 'https://peertube.example.test/static/web-videos/video-playback.mp4' }],
  });
  replayId = inserted.replay_id;
  svc.addToMediaControl({ replayId, workspaceId: 'ws1', userId: 'u1' });
});

test.afterEach(() => {
  global.fetch = originalFetch;
  db.prepare('UPDATE peertube_replays SET playback_url=? WHERE id=?')
    .run('https://peertube.example.test/static/web-videos/video-playback.mp4', replayId);
});

test.after(() => {
  Object.assign(config.peerTubeReplay, originalConfig);
  try { svc.stop(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('private playback adapter forwards bearer auth and a valid byte range without exposing the token', async () => {
  let captured;
  global.fetch = async (url, options = {}) => {
    captured = { url: String(url), headers: new Headers(options.headers || {}) };
    return new Response('test-bytes', {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 0-9/100',
        'Content-Length': '10',
        'Accept-Ranges': 'bytes',
      },
    });
  };

  const upstream = await svc.fetchPlaybackResponse(replayId, { range: 'bytes=0-9' });
  assert.equal(upstream.status, 206);
  assert.equal(await upstream.text(), 'test-bytes');
  assert.equal(captured.url, 'https://peertube.example.test/static/web-videos/video-playback.mp4');
  assert.equal(captured.headers.get('Range'), 'bytes=0-9');
  assert.equal(captured.headers.get('Authorization'), 'Bearer private-playback-token');
  assert.doesNotMatch(JSON.stringify(svc.getWorkerHealth()), /private-playback-token/);
});

test('invalid range syntax is rejected before reaching PeerTube', async () => {
  let called = false;
  global.fetch = async () => { called = true; return new Response(''); };
  await assert.rejects(svc.fetchPlaybackResponse(replayId, { range: 'bytes=0-9,20-29' }), (caught) => caught.code === 416);
  assert.equal(called, false);
});

test('stored playback URL is restricted to configured PeerTube origins', async () => {
  db.prepare('UPDATE peertube_replays SET playback_url=? WHERE id=?')
    .run('http://169.254.169.254/latest/meta-data', replayId);
  let called = false;
  global.fetch = async () => { called = true; return new Response(''); };
  await assert.rejects(svc.fetchPlaybackResponse(replayId), /not allowed/i);
  assert.equal(called, false);
});

test('only added, linked replay rows can use the playback adapter', async () => {
  db.prepare("UPDATE peertube_replays SET processing_state='archived', content_id=NULL WHERE id=?").run(replayId);
  await assert.rejects(svc.fetchPlaybackResponse(replayId), (caught) => caught.code === 404);
  db.prepare("UPDATE peertube_replays SET processing_state='added', content_id=(SELECT id FROM content WHERE original_sha256='video-playback') WHERE id=?").run(replayId);
});

