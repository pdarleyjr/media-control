'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-peertube-v2-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { db } = require('../db/database');
const svc = require('../services/peertube-replay');
const { VISIBILITY } = require('../lib/peertube-replay-permissions');

process.on('exit', () => {
  try { svc.stop(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const READY_VIDEO = {
  uuid: 'vid-ready-001',
  id: 101,
  name: 'Classroom Replay 1',
  description: 'desc',
  duration: 1800,
  isLive: false,
  state: { id: 5, label: 'Published' },
  privacy: 3,
  tags: ['rec:session-ws1'],
  thumbnailPath: '/static/thumbnails/101.jpg',
  path: '/w/vid-ready-001',
  files: [{ fileUrl: 'https://peertube.example.test/static/web-videos/vid-ready-001.mp4' }],
};

const PROCESSING_VIDEO = {
  uuid: 'vid-processing-002',
  id: 102,
  name: 'Classroom Replay 2',
  duration: 600,
  isLive: false,
  state: { id: 3, label: 'To transcode' },
  privacy: 1,
  tags: ['rec:session-ws1-processing'],
};

test.before(() => {
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'user', 'enterprise')")
    .run('u1', 'u1@mbfd.test', 'Instructor One');
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'user', 'enterprise')")
    .run('u2', 'u2@mbfd.test', 'Instructor Two');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org1', 'Org One', 'u1');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org2', 'Org Two', 'u2');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws1', 'org1', 'Workspace One');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws2', 'org2', 'Workspace Two');

  svc.registerRecordingSession({
    id: 'session-ws1', workspaceId: 'ws1', instructorUserId: 'u1',
    title: 'Classroom Replay 1', roomId: 'classroom-1', streamSessionId: 'stream-ws1', startedAt: 1000, endedAt: 2000,
  });
  svc.registerRecordingSession({
    id: 'session-ws1-processing', workspaceId: 'ws1', instructorUserId: 'u1',
    title: 'Classroom Replay 2', roomId: 'classroom-1', obsRecordingId: 'obs-002', startedAt: 3000, endedAt: 4000,
  });
  svc.registerRecordingSession({
    id: 'session-ws2', workspaceId: 'ws2', instructorUserId: 'u2',
    title: 'Other Tenant Recording', roomId: 'classroom-2', expectedReplayUuid: 'vid-ws2-003', startedAt: 5000, endedAt: 6000,
  });
});

test('only explicitly correlated PeerTube videos become replay rows; unrelated videos are quarantined', () => {
  const matched = svc.upsertReplay(READY_VIDEO);
  assert.equal(matched.matched, true);
  assert.equal(matched.workspace_id, 'ws1');

  const unrelated = svc.upsertReplay({
    ...READY_VIDEO,
    uuid: 'unrelated-local-video',
    id: 999,
    name: 'Unrelated PeerTube upload',
    tags: [],
  });
  assert.equal(unrelated.matched, false);
  assert.equal(unrelated.quarantined, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peertube_replays WHERE peertube_video_uuid = ?').get('unrelated-local-video').n, 0);
  assert.equal(db.prepare('SELECT reason_code FROM peertube_replay_quarantine WHERE peertube_video_uuid = ?').get('unrelated-local-video').reason_code, 'no_known_recording_session');
});

test('workspace-scoped list/get prevent cross-workspace reads and direct-ID enumeration', () => {
  const ws2Video = { ...READY_VIDEO, uuid: 'vid-ws2-003', id: 103, name: 'Tenant Two', tags: [] };
  const inserted = svc.upsertReplay(ws2Video);
  assert.equal(inserted.workspace_id, 'ws2');

  const ws1Rows = svc.listAll({ workspaceId: 'ws1' });
  const ws2Rows = svc.listAll({ workspaceId: 'ws2' });
  assert.ok(ws1Rows.every((row) => row.workspace_id === 'ws1'));
  assert.ok(ws2Rows.every((row) => row.workspace_id === 'ws2'));
  assert.equal(svc.getById(inserted.replay_id, 'ws1'), undefined);
  assert.equal(svc.getById(inserted.replay_id, 'ws2').peertube_video_uuid, 'vid-ws2-003');
});

test('upsert is idempotent and never regresses terminal added/discarded states', () => {
  svc.registerRecordingSession({
    id: 'session-terminal', workspaceId: 'ws1', instructorUserId: 'u1', title: 'Terminal State Test',
    streamSessionId: 'stream-terminal', startedAt: 11000, endedAt: 12000,
  });
  const terminalVideo = {
    ...READY_VIDEO,
    uuid: 'vid-terminal-005',
    id: 105,
    tags: ['rec:session-terminal'],
    files: [{ fileUrl: 'https://peertube.example.test/static/web-videos/vid-terminal-005.mp4' }],
  };
  const first = svc.upsertReplay(terminalVideo);
  svc.upsertReplay(terminalVideo);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peertube_replays WHERE peertube_video_uuid = ?').get(terminalVideo.uuid).n, 1);

  db.prepare("UPDATE peertube_replays SET processing_state='discarded' WHERE id=?").run(first.replay_id);
  svc.upsertReplay(terminalVideo);
  assert.equal(svc.getById(first.replay_id, 'ws1').processing_state, 'discarded');
});

test('processing replay advances to ready and captures a playable file URL', () => {
  const inserted = svc.upsertReplay(PROCESSING_VIDEO);
  assert.equal(svc.getById(inserted.replay_id, 'ws1').processing_state, 'processing');

  svc.upsertReplay({
    ...PROCESSING_VIDEO,
    state: { id: 5, label: 'Published' },
    files: [{ fileUrl: 'https://peertube.example.test/static/web-videos/vid-processing-002.mp4' }],
  });
  const ready = svc.getById(inserted.replay_id, 'ws1');
  assert.equal(ready.processing_state, 'ready');
  assert.match(ready.playback_url, /\.mp4$/);
  assert.equal(ready.media_validation, 'valid');
});

test('PeerTube privacy is separate from Media Control visibility and defaults to PRIVATE', () => {
  const replay = db.prepare('SELECT * FROM peertube_replays WHERE peertube_video_uuid = ?').get(READY_VIDEO.uuid);
  assert.equal(replay.peertube_privacy, 3, 'PeerTube may be public');
  assert.equal(replay.library_visibility, VISIBILITY.PRIVATE, 'Media Control remains private');
  assert.equal(replay.publication_status, 'not_requested');
});

test('concurrency-safe add is idempotent, workspace-scoped, and stores the private playback adapter—not a watch page', () => {
  const replay = db.prepare('SELECT id FROM peertube_replays WHERE peertube_video_uuid = ?').get(READY_VIDEO.uuid);
  assert.throws(() => svc.addToMediaControl({
    replayId: replay.id, userId: 'u2', workspaceId: 'ws2', visibility: VISIBILITY.PRIVATE,
  }), /not found/i);

  const first = svc.addToMediaControl({
    replayId: replay.id, userId: 'u1', workspaceId: 'ws1', visibility: VISIBILITY.PRIVATE,
  });
  const second = svc.addToMediaControl({
    replayId: replay.id, userId: 'u1', workspaceId: 'ws1', visibility: VISIBILITY.PRIVATE,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.content_id, first.content_id);

  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(first.content_id);
  assert.equal(content.mime_type, 'video/mp4');
  assert.equal(content.access_level, 'private');
  assert.match(content.remote_url, /^\/api\/peertube-replays\/[^/]+\/playback$/);
  assert.notEqual(content.remote_url, READY_VIDEO.path);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content WHERE content_type='peertube-replay'").get().n, 1);
});

test('discard is workspace-scoped and cannot overwrite an added terminal state', () => {
  const linked = db.prepare('SELECT id FROM peertube_replays WHERE peertube_video_uuid = ?').get(READY_VIDEO.uuid);
  assert.throws(() => svc.discard({ replayId: linked.id, workspaceId: 'ws2', userId: 'u2' }), /not found/i);
  assert.throws(() => svc.discard({ replayId: linked.id, workspaceId: 'ws1', userId: 'u1' }), /already linked/i);

  const processing = db.prepare('SELECT id FROM peertube_replays WHERE peertube_video_uuid = ?').get(PROCESSING_VIDEO.uuid);
  svc.discard({ replayId: processing.id, workspaceId: 'ws1', userId: 'u1' });
  assert.equal(svc.getById(processing.id, 'ws1').processing_state, 'discarded');
});

test('organization sharing creates a pending request and changes visibility only after approval', () => {
  const video = {
    ...READY_VIDEO,
    uuid: 'vid-org-share-004',
    id: 104,
    tags: ['rec:session-org-share'],
    files: [{ fileUrl: 'https://peertube.example.test/static/web-videos/vid-org-share-004.mp4' }],
  };
  svc.registerRecordingSession({
    id: 'session-org-share', workspaceId: 'ws1', instructorUserId: 'u1', title: 'Organization Share',
    streamSessionId: 'stream-org-share', startedAt: 7000, endedAt: 8000,
  });
  const replay = svc.upsertReplay(video);
  svc.requestVisibility({
    replayId: replay.replay_id, workspaceId: 'ws1', userId: 'u1', visibility: VISIBILITY.ORGANIZATION_SHARED,
  });
  let row = svc.getById(replay.replay_id, 'ws1');
  assert.equal(row.library_visibility, VISIBILITY.PRIVATE);
  assert.equal(row.publication_status, 'pending');

  svc.approveOrganizationPublication({ replayId: replay.replay_id, workspaceId: 'ws1', userId: 'org-admin' });
  row = svc.getById(replay.replay_id, 'ws1');
  assert.equal(row.library_visibility, VISIBILITY.ORGANIZATION_SHARED);
  assert.equal(row.publication_status, 'approved');
});

test('revision monotonically advances for workspace mutations', () => {
  const before = svc.getRevision('ws1');
  svc.registerRecordingSession({
    id: 'session-revision', workspaceId: 'ws1', instructorUserId: 'u1', title: 'Revision Test',
    streamSessionId: 'stream-revision', startedAt: 9000, endedAt: 10000,
  });
  const after = svc.getRevision('ws1');
  assert.ok(after > before);
});

test('replay persistence and workspace scoping survive service restart', () => {
  const before = svc.listAll({ workspaceId: 'ws1' }).map((row) => row.id).sort();
  svc.stop();
  delete require.cache[require.resolve('../services/peertube-replay')];
  const restarted = require('../services/peertube-replay');
  const after = restarted.listAll({ workspaceId: 'ws1' }).map((row) => row.id).sort();
  assert.deepEqual(after, before);
  assert.ok(restarted.listAll({ workspaceId: 'ws1' }).every((row) => row.workspace_id === 'ws1'));
});
