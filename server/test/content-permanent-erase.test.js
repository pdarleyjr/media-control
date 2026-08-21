const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const Multiview = require('../player/multiview-core');
const {
  eraseContent,
  eraseImpact,
  publicEraseImpact,
  publicEraseResult,
  reconcileEraseOperations,
} = require('../services/content-permanent-erase');
const { migrateContentEraseLedger } = require('../db/migrations/content-erase-ledger');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE content (id TEXT PRIMARY KEY, filename TEXT, filepath TEXT, original_filepath TEXT,
      thumbnail_path TEXT, mime_type TEXT, workspace_id TEXT, remote_url TEXT, version INTEGER DEFAULT 1,
      updated_at INTEGER, source_content_id TEXT REFERENCES content(id) ON DELETE SET NULL);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, published_snapshot TEXT, updated_at INTEGER);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY, playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
      content_id TEXT REFERENCES content(id) ON DELETE CASCADE, widget_id TEXT, sort_order INTEGER, updated_at INTEGER);
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, playlist_id TEXT, default_content_id TEXT REFERENCES content(id) ON DELETE SET NULL, updated_at INTEGER);
    CREATE TABLE assignments (id INTEGER PRIMARY KEY, device_id TEXT, content_id TEXT REFERENCES content(id) ON DELETE CASCADE, widget_id TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT, content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
      widget_id TEXT, playlist_id TEXT, device_id TEXT, group_id TEXT, updated_at INTEGER);
    CREATE TABLE video_walls (id TEXT PRIMARY KEY, name TEXT, content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
      playlist_id TEXT, updated_at INTEGER);
    CREATE TABLE video_wall_devices (wall_id TEXT, device_id TEXT);
    CREATE TABLE device_groups (id TEXT PRIMARY KEY, playlist_id TEXT);
    CREATE TABLE device_group_members (group_id TEXT, device_id TEXT);
    CREATE TABLE activity_asset_placements (id TEXT PRIMARY KEY, activity_id TEXT,
      device_id TEXT, wall_id TEXT, content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
      custom_properties_json TEXT);
    CREATE TABLE presentations (id TEXT PRIMARY KEY, title TEXT, deck_json TEXT, published_snapshot TEXT, updated_at INTEGER);
    CREATE TABLE presentation_slides (id TEXT PRIMARY KEY, presentation_id TEXT REFERENCES presentations(id) ON DELETE CASCADE,
      slide_json TEXT, updated_at INTEGER);
    CREATE TABLE presentation_assets (id TEXT PRIMARY KEY, presentation_id TEXT, content_id TEXT REFERENCES content(id) ON DELETE SET NULL);
    CREATE TABLE advanced_canvas_endpoints (id TEXT PRIMARY KEY, scene_revision INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE advanced_canvas_layers (id TEXT PRIMARY KEY, endpoint_id TEXT, label TEXT,
      source_json TEXT, render_json TEXT, updated_at INTEGER);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, config TEXT, updated_at INTEGER);
    CREATE TABLE asset_variants (id TEXT PRIMARY KEY, content_id TEXT REFERENCES content(id) ON DELETE CASCADE, file_path TEXT);
    CREATE TABLE asset_checksums (asset_id TEXT PRIMARY KEY, content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
      generation INTEGER, canonical_path TEXT, poster_path TEXT);
    CREATE TABLE node_assets (asset_id TEXT, node_id TEXT);
    CREATE TABLE content_media_metadata (content_id TEXT PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE, thumbnail_source_filepath TEXT);
    CREATE TABLE download_jobs (id TEXT PRIMARY KEY, content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
      local_path TEXT, status TEXT, error_msg TEXT, completed_at INTEGER);
    CREATE TABLE media_jobs (id TEXT PRIMARY KEY, content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
      status TEXT, stage TEXT, cancel_requested INTEGER, lease_owner TEXT, lease_expires_at INTEGER,
      completed_at INTEGER, updated_at INTEGER);
    CREATE TABLE media_job_artifacts (id TEXT PRIMARY KEY, job_id TEXT, content_id TEXT,
      file_path TEXT, created_at INTEGER, UNIQUE(job_id, file_path));
  `);
  return db;
}

test('permanent erase previews and deterministically detaches every active dependency', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-erase-'));
  try {
    for (const name of ['target.mp4', 'source.mov', 'poster.jpg', 'variant.mp4', 'canonical.mp4', 'checksum.jpg', 'metadata.jpg', 'download.part']) {
      fs.writeFileSync(path.join(contentDir, name), name);
    }
    db.prepare(`INSERT INTO content (id, filename, filepath, original_filepath, thumbnail_path, mime_type, workspace_id, version)
      VALUES ('target', 'Training.mp4', 'target.mp4', 'source.mov', 'poster.jpg', 'video/mp4', 'ws', 4)`).run();
    const cells = Multiview.encodeCells({
      L1: { u: '/api/content/target/file', l: 'Training', k: 'v' },
      R1: { u: '/api/content/keep/file', l: 'Keep', k: 'v' },
    });
    db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, workspace_id, remote_url)
      VALUES ('grid', 'Grid', '', 'text/html', 'ws', ?)`).run(`/player/grid.html?cells=${cells}`);
    db.prepare("INSERT INTO playlists VALUES ('playlist', 'Daily', 'ws', ?, 0)")
      .run(JSON.stringify([{ content_id: 'target' }, { content_id: 'keep' }]));
    db.prepare("INSERT INTO playlist_items VALUES (1, 'playlist', 'target', NULL, 4, 0)").run();
    db.prepare("INSERT INTO playlist_items VALUES (2, 'playlist', NULL, NULL, 8, 0)").run();
    db.prepare("INSERT INTO devices VALUES ('display', 'Front', 'playlist', 'target', 0)").run();
    db.prepare("INSERT INTO assignments VALUES (1, 'display', 'target', NULL)").run();
    db.prepare("INSERT INTO assignments VALUES (2, 'assignment-widget-device', NULL, 'widget')").run();
    db.prepare("INSERT INTO schedules VALUES ('sole', 'Sole', 'target', NULL, NULL, NULL, NULL, 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('alternate', 'Alternate', 'target', 'clock', NULL, NULL, NULL, 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('group-schedule', 'Group', 'target', 'clock', NULL, NULL, 'schedule-group', 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('playlist-device-schedule', 'Playlist Device', NULL, NULL, 'playlist', 'scheduled-device', NULL, 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('playlist-group-schedule', 'Playlist Group', NULL, NULL, 'playlist', NULL, 'scheduled-playlist-group', 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('widget-device-schedule', 'Widget Device', NULL, 'widget', NULL, 'widget-device', NULL, 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('widget-group-schedule', 'Widget Group', NULL, 'widget', NULL, NULL, 'widget-group', 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('widget-playlist-device-schedule', 'Widget Playlist Device', NULL, NULL, 'widget-playlist', 'scheduled-widget-playlist-device', NULL, 0)").run();
    db.prepare("INSERT INTO schedules VALUES ('widget-playlist-group-schedule', 'Widget Playlist Group', NULL, NULL, 'widget-playlist', NULL, 'scheduled-widget-playlist-group', 0)").run();
    db.prepare("INSERT INTO video_walls VALUES ('wall', 'Wall', 'target', NULL, 0)").run();
    db.prepare("INSERT INTO video_walls VALUES ('playlist-wall', 'Playlist Wall', NULL, 'playlist', 0)").run();
    db.prepare("INSERT INTO video_walls VALUES ('scene-wall', 'Scene Wall', NULL, NULL, 0)").run();
    db.prepare("INSERT INTO video_walls VALUES ('widget-playlist-wall', 'Widget Playlist Wall', NULL, 'widget-playlist', 0)").run();
    db.prepare("INSERT INTO video_wall_devices VALUES ('playlist-wall', 'wall-playlist-device')").run();
    db.prepare("INSERT INTO video_wall_devices VALUES ('scene-wall', 'scene-wall-device')").run();
    db.prepare("INSERT INTO video_wall_devices VALUES ('widget-playlist-wall', 'widget-playlist-wall-device')").run();
    db.prepare("INSERT INTO device_groups VALUES ('playlist-group', 'playlist')").run();
    db.prepare("INSERT INTO device_groups VALUES ('widget-playlist-group', 'widget-playlist')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('playlist-group', 'group-playlist-device')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('schedule-group', 'group-schedule-device')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('scheduled-playlist-group', 'group-playlist-schedule-device')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('widget-group', 'widget-group-device')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('widget-playlist-group', 'widget-playlist-group-device')").run();
    db.prepare("INSERT INTO device_group_members VALUES ('scheduled-widget-playlist-group', 'scheduled-widget-playlist-group-device')").run();
    db.prepare("INSERT INTO activity_asset_placements VALUES ('place', 'scene', 'scene-device', 'scene-wall', 'target', '{}')").run();
    db.prepare("INSERT INTO presentations VALUES ('deck', 'Deck', ?, ?, 0)")
      .run(JSON.stringify({ slides: [{ media: { content_id: 'target' } }] }), JSON.stringify({ slides: [{ media: { content_id: 'target' } }] }));
    db.prepare("INSERT INTO presentation_slides VALUES ('slide', 'deck', ?, 0)")
      .run(JSON.stringify({ objects: [{ content_id: 'target' }] }));
    db.prepare("INSERT INTO presentation_assets VALUES ('pa', 'deck', 'target')").run();
    db.prepare("INSERT INTO advanced_canvas_endpoints VALUES ('canvas', 2, 0)").run();
    db.prepare("INSERT INTO advanced_canvas_layers VALUES ('layer', 'canvas', 'Media', ?, ?, 0)")
      .run(
        JSON.stringify({ kind: 'video', label: 'render-only legacy layer' }),
        JSON.stringify({ kind: 'video', content_id: 'target', url: '/api/content/target/file' }),
      );
    db.prepare("INSERT INTO widgets VALUES ('widget', 'Widget', ?, 0)")
      .run(JSON.stringify({ background: '/api/content/target/file', safe: 'keep' }));
    db.prepare("INSERT INTO playlists VALUES ('widget-playlist', 'Widget Playlist', 'ws', '[]', 0)").run();
    db.prepare("INSERT INTO playlist_items VALUES (3, 'widget-playlist', NULL, 'widget', 0, 0)").run();
    db.prepare("INSERT INTO devices VALUES ('widget-playlist-device', 'Widget Playlist Display', 'widget-playlist', NULL, 0)").run();
    db.prepare("INSERT INTO devices VALUES ('grid-display', 'Grid Display', NULL, 'grid', 0)").run();
    db.prepare("INSERT INTO asset_variants VALUES ('variant', 'target', 'variant.mp4')").run();
    db.prepare("INSERT INTO asset_checksums VALUES ('asset', 'target', 4, 'canonical.mp4', 'checksum.jpg')").run();
    db.prepare("INSERT INTO node_assets VALUES ('asset', 'classroom-1-p3')").run();
    db.prepare("INSERT INTO content_media_metadata VALUES ('target', 'metadata.jpg')").run();
    db.prepare("INSERT INTO download_jobs VALUES ('download', 'target', 'download.part', 'downloading', NULL, NULL)").run();
    db.prepare("INSERT INTO media_jobs VALUES ('media', 'target', 'queued', 'received', 0, NULL, NULL, NULL, 0)").run();

    const impact = eraseImpact(db, 'target', { contentDir });
    assert.equal(impact.dependency_count, 12);
    assert.deepEqual(impact.blockers, []);
    assert.deepEqual(impact.cache, { asset_id: 'asset', generation: 4, node_ids: ['classroom-1-p3'] });
    assert.deepEqual(impact.affected_canvas_endpoint_ids, ['canvas']);
    assert.ok(impact.files.includes(path.join(contentDir, 'variant.mp4')));
    assert.deepEqual(new Set(impact.affected_device_ids), new Set([
      'display',
      'wall-playlist-device',
      'group-playlist-device',
      'group-schedule-device',
      'scheduled-device',
      'group-playlist-schedule-device',
      'scene-device',
      'scene-wall-device',
      'grid-display',
      'widget-device',
      'widget-group-device',
      'assignment-widget-device',
      'widget-playlist-device',
      'widget-playlist-wall-device',
      'widget-playlist-group-device',
      'scheduled-widget-playlist-device',
      'scheduled-widget-playlist-group-device',
    ]));

    const result = eraseContent(db, 'target', { contentDir });
    assert.equal(result.success, true);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id = 'target'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM assignments WHERE content_id='target'").get().count, 0);
    assert.equal(db.prepare("SELECT widget_id FROM assignments WHERE id=2").get().widget_id, 'widget');
    assert.equal(db.prepare("SELECT content_id FROM schedules WHERE id = 'sole'").get().content_id, null);
    assert.equal(db.prepare("SELECT content_id FROM schedules WHERE id = 'alternate'").get().content_id, null);
    assert.equal(db.prepare("SELECT content_id FROM video_walls WHERE id = 'wall'").get().content_id, null);
    assert.equal(db.prepare("SELECT default_content_id FROM devices WHERE id = 'display'").get().default_content_id, null);
    assert.equal(db.prepare("SELECT sort_order FROM playlist_items WHERE id = 2").get().sort_order, 0);
    assert.deepEqual(JSON.parse(db.prepare("SELECT published_snapshot FROM playlists WHERE id = 'playlist'").get().published_snapshot), [{ content_id: 'keep' }]);
    const canvasLayer = db.prepare("SELECT source_json,render_json FROM advanced_canvas_layers WHERE id='layer'").get();
    assert.equal(JSON.parse(canvasLayer.source_json).media_status, 'permanently_erased');
    assert.equal(JSON.parse(canvasLayer.render_json).media_status, 'permanently_erased');
    assert.equal(db.prepare("SELECT scene_revision FROM advanced_canvas_endpoints WHERE id = 'canvas'").get().scene_revision, 3);
    assert.deepEqual(JSON.parse(db.prepare("SELECT config FROM widgets WHERE id = 'widget'").get().config), { safe: 'keep' });
    const gridUrl = db.prepare("SELECT remote_url FROM content WHERE id = 'grid'").get().remote_url;
    const remainingCells = Multiview.decodeCells(new URL(gridUrl, 'http://local').searchParams.get('cells'));
    assert.equal(remainingCells.L1, undefined);
    assert.equal(remainingCells.R1.u, '/api/content/keep/file');
    const deck = JSON.parse(db.prepare("SELECT deck_json FROM presentations WHERE id = 'deck'").get().deck_json);
    assert.equal(deck.slides[0].media.media_status, 'permanently_erased');
    assert.match(deck.review_flags[0], /permanently erased/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM node_assets").get().count, 0);
    assert.equal(db.prepare("SELECT content_id FROM activity_asset_placements WHERE id='place'").get().content_id, null);
    assert.equal(JSON.parse(db.prepare("SELECT custom_properties_json FROM activity_asset_placements WHERE id='place'").get().custom_properties_json).media_status, 'permanently_erased');
    assert.equal(db.prepare("SELECT content_id FROM presentation_assets WHERE id='pa'").get().content_id, null);
    const erasedDownload = db.prepare("SELECT content_id,status,error_msg,completed_at FROM download_jobs WHERE id='download'").get();
    assert.equal(erasedDownload.content_id, null);
    assert.equal(erasedDownload.status, 'error');
    assert.match(erasedDownload.error_msg, /permanently erased/i);
    assert.ok(Number(erasedDownload.completed_at) > 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const name of ['target.mp4', 'source.mov', 'poster.jpg', 'variant.mp4', 'canonical.mp4', 'checksum.jpg', 'metadata.jpg', 'download.part']) {
      assert.equal(fs.existsSync(path.join(contentDir, name)), false, name);
    }
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('permanent erase stays prepared until a leased writer exits, then removes its deferred bytes on retry', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-quiescence-'));
  const latePath = path.join(contentDir, 'late-output.mp4');
  try {
    db.prepare(`INSERT INTO content (id,filename,filepath,mime_type,workspace_id)
      VALUES ('target','Target.mp4','target.mp4','video/mp4','ws')`).run();
    db.prepare(`INSERT INTO media_jobs VALUES
      ('writer','target','running','optimizing',0,'worker-a',9999999999,NULL,1)`).run();
    db.prepare(`INSERT INTO media_job_artifacts VALUES
      ('artifact','writer','target',?,1)`).run(latePath);

    assert.throws(
      () => eraseContent(db, 'target', { contentDir, operationId: 'erase-quiescence' }),
      (error) => error.code === 'ERASE_JOB_QUIESCENCE_REQUIRED'
        && error.operation_id === 'erase-quiescence'
        && error.active_job_count === 1,
    );
    const waitingJob = db.prepare("SELECT status,cancel_requested,lease_owner FROM media_jobs WHERE id='writer'").get();
    assert.deepEqual(waitingJob, { status: 'running', cancel_requested: 1, lease_owner: 'worker-a' });
    assert.equal(db.prepare("SELECT state FROM content_erase_operations WHERE id='erase-quiescence'").get().state, 'prepared');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 1);

    fs.writeFileSync(latePath, 'created by the already-leased writer after erase began');
    db.prepare(`UPDATE media_jobs SET status='cancelled',stage='cancelled',lease_owner=NULL,
      lease_expires_at=NULL,completed_at=2 WHERE id='writer'`).run();

    const result = eraseContent(db, 'target', { contentDir, operationId: 'different-id-is-not-used' });
    assert.equal(result.success, true);
    assert.equal(result.operation_id, 'erase-quiescence');
    assert.equal(fs.existsSync(latePath), false);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 0);
    assert.equal(db.prepare("SELECT state FROM content_erase_operations WHERE id='erase-quiescence'").get().state, 'completed');
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('expired media-job lease does not block permanent erase (crashed worker is reconciled)', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-stale-lease-'));
  const latePath = path.join(contentDir, 'late-output.mp4');
  const expired = Math.floor(Date.now() / 1000) - 100;
  try {
    db.prepare(`INSERT INTO content (id,filename,filepath,mime_type,workspace_id)
      VALUES ('target','Target.mp4','target.mp4','video/mp4','ws')`).run();
    // A running job whose lease already expired: the worker crashed and will never
    // heartbeat again. It must be reconciled (cancelled) and must NOT block erase.
    db.prepare(`INSERT INTO media_jobs VALUES
      ('writer','target','running','optimizing',0,'worker-a',?,NULL,1)`).run(expired);
    db.prepare(`INSERT INTO media_job_artifacts VALUES
      ('artifact','writer','target',?,1)`).run(latePath);

    // No quiescence error: an expired lease is treated as stale, not active, so a
    // crashed worker never blocks erase forever.
    const result = eraseContent(db, 'target', { contentDir, operationId: 'erase-stale-lease' });
    assert.equal(result.success, true);
    assert.equal(db.prepare("SELECT state FROM content_erase_operations WHERE id='erase-stale-lease'").get().state, 'completed');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 0);
    // The reconciled job row is removed with its content (ON DELETE CASCADE), which
    // proves the staled job did not block the erase.
    assert.equal(db.prepare("SELECT COUNT(*) count FROM media_jobs WHERE id='writer'").get().count, 0);
    // The crashed worker's deferred bytes are still removed on erase.
    assert.equal(fs.existsSync(latePath), false);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('unknown restrictive content foreign keys block erase before any mutation', () => {
  const db = buildDb();
  db.exec('CREATE TABLE mystery (id TEXT PRIMARY KEY, content_id TEXT REFERENCES content(id))');
  db.prepare("INSERT INTO content (id, filename, filepath, mime_type) VALUES ('target', 'x', '', 'video/mp4')").run();
  db.prepare("INSERT INTO mystery VALUES ('m', 'target')").run();
  const impact = eraseImpact(db, 'target', { contentDir: os.tmpdir() });
  assert.equal(impact.blockers.length, 1);
  assert.throws(() => eraseContent(db, 'target', { contentDir: os.tmpdir() }), { code: 'ERASE_DEPENDENCY_BLOCKED' });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id = 'target'").get().count, 1);
  db.close();
});

test('shared catalog bytes survive erase of one content row', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-shared-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'shared.mp4'), 'shared');
    db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, workspace_id)
      VALUES ('target', 'Target.mp4', 'nested/shared.mp4', 'video/mp4', 'ws')`).run();
    db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, workspace_id)
      VALUES ('keeper', 'Keeper.mp4', 'nested/shared.mp4', 'video/mp4', 'ws')`).run();

    const impact = eraseImpact(db, 'target', { contentDir });
    assert.deepEqual(impact.files, []);
    assert.ok(impact.shared_files.includes(path.join(contentDir, 'nested', 'shared.mp4')));

    eraseContent(db, 'target', { contentDir });
    assert.equal(fs.readFileSync(path.join(contentDir, 'nested', 'shared.mp4'), 'utf8'), 'shared');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='keeper'").get().count, 1);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('permanent erase removes cache sidecars without touching another content row shared primary bytes', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-sidecars-'));
  try {
    const primary = path.join(contentDir, 'shared.mp4');
    fs.writeFileSync(primary, 'shared');
    for (const suffix of ['.part', '.meta', '.previous', '.meta.part', '.meta.previous', '.part.meta', '.previous.meta']) {
      fs.writeFileSync(`${path.join(contentDir, 'target-only')}${suffix}`, suffix);
    }
    db.prepare("INSERT INTO content (id,filename,filepath,thumbnail_path,mime_type) VALUES ('target','Target','shared.mp4','target-only','video/mp4')").run();
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('keeper','Keeper','shared.mp4','video/mp4')").run();

    eraseContent(db, 'target', { contentDir });

    assert.equal(fs.readFileSync(primary, 'utf8'), 'shared');
    for (const suffix of ['.part', '.meta', '.previous', '.meta.part', '.meta.previous', '.part.meta', '.previous.meta']) {
      assert.equal(fs.existsSync(`${path.join(contentDir, 'target-only')}${suffix}`), false, suffix);
    }
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('hard-linked bytes are treated as shared ownership and directories block erase', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-inode-'));
  try {
    fs.writeFileSync(path.join(contentDir, 'target.bin'), 'same-inode');
    fs.linkSync(path.join(contentDir, 'target.bin'), path.join(contentDir, 'keeper.bin'));
    fs.mkdirSync(path.join(contentDir, 'not-a-file'));
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('target','Target','target.bin','application/octet-stream')").run();
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('keeper','Keeper','keeper.bin','application/octet-stream')").run();
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('directory','Directory','not-a-file','application/octet-stream')").run();

    const shared = eraseImpact(db, 'target', { contentDir });
    assert.equal(shared.files.includes(path.join(contentDir, 'target.bin')), false);
    assert.ok(shared.shared_files.includes(path.join(contentDir, 'target.bin')));
    eraseContent(db, 'target', { contentDir });
    assert.equal(fs.readFileSync(path.join(contentDir, 'keeper.bin'), 'utf8'), 'same-inode');

    const blocked = eraseImpact(db, 'directory', { contentDir });
    assert.ok(blocked.blockers.some((item) => item.type === 'unsafe_file'));
    assert.throws(() => eraseContent(db, 'directory', { contentDir }), { code: 'ERASE_DEPENDENCY_BLOCKED' });
    assert.equal(fs.statSync(path.join(contentDir, 'not-a-file')).isDirectory(), true);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('symbolic links inside or outside the content root block erase before catalog mutation', (t) => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-symlink-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-symlink-outside-'));
  try {
    fs.writeFileSync(path.join(contentDir, 'inside.bin'), 'inside');
    fs.writeFileSync(path.join(outsideDir, 'outside.bin'), 'outside');
    try {
      fs.symlinkSync(path.join(contentDir, 'inside.bin'), path.join(contentDir, 'inside-link'));
      fs.symlinkSync(path.join(outsideDir, 'outside.bin'), path.join(contentDir, 'outside-link'));
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('Creating symbolic links requires Windows Developer Mode or elevation');
      throw error;
    }
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('inside-link','Inside','inside-link','application/octet-stream')").run();
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('outside-link','Outside','outside-link','application/octet-stream')").run();

    for (const id of ['inside-link', 'outside-link']) {
      const impact = eraseImpact(db, id, { contentDir });
      assert.ok(impact.blockers.some((item) => item.reason === 'symbolic_link'));
      assert.throws(() => eraseContent(db, id, { contentDir }), { code: 'ERASE_DEPENDENCY_BLOCKED' });
      assert.equal(db.prepare('SELECT COUNT(*) count FROM content WHERE id=?').get(id).count, 1);
    }
    assert.equal(fs.readFileSync(path.join(outsideDir, 'outside.bin'), 'utf8'), 'outside');
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('a symlinked ancestor cannot escape the content root', (t) => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-ancestor-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-ancestor-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'outside.bin'), 'outside');
    try {
      fs.symlinkSync(outsideDir, path.join(contentDir, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('Creating symbolic links requires Windows Developer Mode or elevation');
      throw error;
    }
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('target','Target','nested/outside.bin','application/octet-stream')").run();

    const impact = eraseImpact(db, 'target', { contentDir });
    assert.ok(impact.blockers.some((item) => item.reason === 'resolved_outside_content_root'));
    assert.throws(() => eraseContent(db, 'target', { contentDir }), { code: 'ERASE_DEPENDENCY_BLOCKED' });
    assert.equal(fs.readFileSync(path.join(outsideDir, 'outside.bin'), 'utf8'), 'outside');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 1);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('file staging failures use a stable redacted error contract', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-stage-error-'));
  const originalRename = fs.renameSync;
  try {
    const storedPath = path.join(contentDir, 'target.mp4');
    fs.writeFileSync(storedPath, 'keep-me');
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('target','Target','target.mp4','video/mp4')").run();
    fs.renameSync = (source, destination) => {
      const error = new Error(`EACCES staging ${source} to ${destination}`);
      error.code = 'EACCES';
      throw error;
    };

    assert.throws(
      () => eraseContent(db, 'target', { contentDir }),
      (error) => error.code === 'ERASE_FILE_STAGE_FAILED'
        && error.message === 'Media bytes could not be staged safely for permanent erase.'
        && !error.message.includes(contentDir),
    );
    assert.equal(fs.readFileSync(storedPath, 'utf8'), 'keep-me');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 1);
  } finally {
    fs.renameSync = originalRename;
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('database failure restores staged bytes at their exact nested path', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-rollback-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    const storedPath = path.join('nested', 'target.mp4');
    fs.writeFileSync(path.join(contentDir, storedPath), 'recover-me');
    db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, workspace_id)
      VALUES ('target', 'Target.mp4', ?, 'video/mp4', 'ws')`).run(storedPath);

    assert.throws(() => eraseContent(db, 'target', {
      contentDir,
      audit: () => { throw new Error('forced audit failure'); },
    }), /forced audit failure/);
    assert.equal(fs.readFileSync(path.join(contentDir, storedPath), 'utf8'), 'recover-me');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='target'").get().count, 1);
    assert.deepEqual(fs.readdirSync(path.join(contentDir, 'nested')), ['target.mp4']);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('a failed rename-back remains recoverable and is never recorded as rolled back', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-recovery-failure-'));
  const originalRename = fs.renameSync;
  try {
    const storedPath = path.join(contentDir, 'target.mp4');
    fs.writeFileSync(storedPath, 'recover-later');
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('target','Target','target.mp4','video/mp4')").run();
    let staged = false;
    fs.renameSync = (source, destination) => {
      if (String(source).includes('.erasing-') && destination === storedPath) {
        const error = new Error('forced restore failure');
        error.code = 'EACCES';
        throw error;
      }
      staged = true;
      return originalRename(source, destination);
    };
    assert.throws(() => eraseContent(db, 'target', {
      contentDir,
      audit: () => { throw new Error('forced database rollback'); },
    }), /forced database rollback/);
    assert.equal(staged, true);
    const operation = db.prepare('SELECT id,state FROM content_erase_operations').get();
    assert.equal(operation.state, 'recovery_failed');
    assert.equal(fs.existsSync(storedPath), false);

    fs.renameSync = originalRename;
    const result = reconcileEraseOperations(db, contentDir);
    assert.equal(result[0].state, 'rolled_back');
    assert.equal(fs.readFileSync(storedPath, 'utf8'), 'recover-later');
  } finally {
    fs.renameSync = originalRename;
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('startup reconciliation restores precommit staging and finishes postcommit cleanup', () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-reconcile-'));
  try {
    migrateContentEraseLedger(db);
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('live','Live.mp4','live.mp4','video/mp4')").run();
    const liveOriginal = path.join(contentDir, 'live.mp4');
    const liveStaged = `${liveOriginal}.erasing-op-live`;
    fs.writeFileSync(liveStaged, 'restore');
    const goneOriginal = path.join(contentDir, 'gone.mp4');
    const goneStaged = `${goneOriginal}.erasing-op-gone`;
    fs.writeFileSync(goneStaged, 'remove');
    const insert = db.prepare(`INSERT INTO content_erase_operations
      (id,content_id,state,file_manifest_json,created_at,updated_at) VALUES (?,?,?,?,1,1)`);
    insert.run('op-live', 'live', 'staged', JSON.stringify([{ originalPath: liveOriginal, stagedPath: liveStaged }]));
    insert.run('op-gone', 'gone', 'catalog_committed', JSON.stringify([{ originalPath: goneOriginal, stagedPath: goneStaged }]));

    const results = reconcileEraseOperations(db, contentDir);
    assert.equal(results.length, 2);
    assert.equal(fs.readFileSync(liveOriginal, 'utf8'), 'restore');
    assert.equal(fs.existsSync(liveStaged), false);
    assert.equal(fs.existsSync(goneStaged), false);
    assert.equal(db.prepare("SELECT state FROM content_erase_operations WHERE id='op-live'").get().state, 'rolled_back');
    assert.equal(db.prepare("SELECT state FROM content_erase_operations WHERE id='op-gone'").get().state, 'completed');
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('startup reconciliation refuses restore and cleanup through a swapped ancestor junction', (t) => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-reconcile-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-reconcile-outside-'));
  try {
    migrateContentEraseLedger(db);
    db.prepare("INSERT INTO content (id,filename,filepath,mime_type) VALUES ('live','Live.mp4','nested/live.mp4','video/mp4')").run();
    try {
      fs.symlinkSync(outsideDir, path.join(contentDir, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('Creating symbolic links requires Windows Developer Mode or elevation');
      throw error;
    }
    const liveOriginal = path.join(contentDir, 'nested', 'live.mp4');
    const liveStaged = `${liveOriginal}.erasing-op-live-link`;
    const goneOriginal = path.join(contentDir, 'nested', 'gone.mp4');
    const goneStaged = `${goneOriginal}.erasing-op-gone-link`;
    fs.writeFileSync(path.join(outsideDir, path.basename(liveStaged)), 'do-not-restore');
    fs.writeFileSync(path.join(outsideDir, path.basename(goneStaged)), 'do-not-delete');
    const insert = db.prepare(`INSERT INTO content_erase_operations
      (id,content_id,state,file_manifest_json,created_at,updated_at) VALUES (?,?,?,?,1,1)`);
    insert.run('op-live-link', 'live', 'staged', JSON.stringify([{ originalPath: liveOriginal, stagedPath: liveStaged }]));
    insert.run('op-gone-link', 'gone', 'catalog_committed', JSON.stringify([{ originalPath: goneOriginal, stagedPath: goneStaged }]));

    const results = reconcileEraseOperations(db, contentDir);
    assert.deepEqual(results.map((result) => result.state), ['recovery_failed', 'recovery_failed']);
    assert.equal(fs.existsSync(liveOriginal), false);
    assert.equal(fs.readFileSync(path.join(outsideDir, path.basename(liveStaged)), 'utf8'), 'do-not-restore');
    assert.equal(fs.readFileSync(path.join(outsideDir, path.basename(goneStaged)), 'utf8'), 'do-not-delete');
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('public erase responses never disclose server or staged filesystem paths', () => {
  const absolute = path.resolve('D:/private/media/target.mp4');
  const staged = `${absolute}.erasing-operation`;
  const impact = {
    content: { id: 'target', filename: 'Target.mp4' },
    dependency_count: 1,
    categories: { widgets: 1 },
    dependencies: {
      widgets: [{ id: 'widget', name: 'Clock', config: { file: absolute } }],
    },
    affected_device_ids: ['display'],
    files: [absolute],
    shared_files: [`${absolute}.meta`],
    blocked_files: [{ type: 'unsafe_file', reason: 'symbolic_link', path: absolute }],
    blockers: [{ type: 'unsafe_file', reason: 'symbolic_link', path: absolute }],
    foreign_keys: [],
  };
  const publicImpact = publicEraseImpact(impact);
  const publicResult = publicEraseResult({
    success: false,
    operation_id: 'operation',
    content_id: 'target',
    impact,
    detachments: {},
    files: [{ path: absolute, staged_path: staged, removed: false }],
    cache_purge: {
      requested: true,
      nodes: [{ node_id: 'p3', acknowledged: true, purged: true, result: { cache: { content_dir: absolute } } }],
    },
  });
  const serialized = JSON.stringify({ publicImpact, publicResult });
  assert.equal(serialized.includes(absolute), false);
  assert.equal(serialized.includes(staged), false);
  assert.equal(serialized.includes('content_dir'), false);
  assert.deepEqual(publicImpact.files, ['target.mp4']);
  assert.deepEqual(publicImpact.dependencies.widgets, [{ id: 'widget', name: 'Clock' }]);
});
