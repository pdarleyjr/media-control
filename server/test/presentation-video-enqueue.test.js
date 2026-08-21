'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  enqueuePresentationVideoAssets,
  reconcileRecoveredPresentationVideos,
} = require('../services/presentation-conversion-job');

test('embedded video enqueue failure is retryable and can never be swallowed as conversion success', () => {
  const asset = { contentId: 'video', finalPath: '/media/video.mp4', storedName: 'video.mp4' };
  assert.throws(
    () => enqueuePresentationVideoAssets([asset], () => { throw new Error('queue unavailable'); }, {
      workspace_id: 'workspace', user_id: 'owner',
    }),
    (error) => error.code === 'presentation_video_enqueue_failed' && error.retryable === true,
  );
  assert.throws(
    () => enqueuePresentationVideoAssets([asset], undefined, { workspace_id: 'workspace', user_id: 'owner' }),
    (error) => error.code === 'presentation_video_enqueue_failed' && error.retryable === true,
  );
});

test('recovered conversion re-enqueues only its pending embedded videos after a post-commit crash', (t) => {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-recovered-video-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(contentDir, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE presentations (id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT);
    CREATE TABLE presentation_assets (presentation_id TEXT, content_id TEXT);
    CREATE TABLE content (
      id TEXT PRIMARY KEY, filename TEXT, filepath TEXT, version INTEGER,
      processing_status TEXT, mime_type TEXT
    );
  `);
  db.prepare('INSERT INTO presentations VALUES (?,?,?)').run('deck', 'workspace', 'owner');
  db.prepare('INSERT INTO presentations VALUES (?,?,?)').run('other-deck', 'other-workspace', 'owner');
  db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?)')
    .run('pending-video', 'Pending.mp4', 'pending.mp4', 3, 'uploaded', 'video/mp4');
  db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?)')
    .run('ready-video', 'Ready.mp4', 'ready.mp4', 2, 'ready', 'video/mp4');
  db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?)')
    .run('other-video', 'Other.mp4', 'other.mp4', 1, 'uploaded', 'video/mp4');
  db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('deck', 'pending-video');
  db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('deck', 'ready-video');
  db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('other-deck', 'other-video');
  fs.writeFileSync(path.join(contentDir, 'pending.mp4'), 'pending');
  fs.writeFileSync(path.join(contentDir, 'ready.mp4'), 'ready');
  fs.writeFileSync(path.join(contentDir, 'other.mp4'), 'other');

  const queued = [];
  const assets = reconcileRecoveredPresentationVideos({
    db,
    contentDir,
    presentationId: 'deck',
    enqueueVideo: (input) => queued.push(input),
    job: { workspace_id: 'workspace', user_id: 'owner' },
  });

  assert.deepEqual(assets.map((asset) => asset.contentId).sort(), ['pending-video', 'ready-video']);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].contentId, 'pending-video');
  assert.equal(queued[0].expectedVersion, 3);
  assert.equal(queued[0].expectedFilepath, 'pending.mp4');
  assert.equal(queued[0].idempotencyKey, 'presentation-video:pending-video:v3');
});
