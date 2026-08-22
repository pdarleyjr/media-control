'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MediaJobArtifactStore } = require('../lib/media-job-artifacts');
const { renderComplexSlideFallbacks } = require('../services/presentation-conversion-job');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mVQAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-media-artifacts-'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY, filepath TEXT, original_filepath TEXT, thumbnail_path TEXT
    );
    CREATE TABLE media_jobs (
      id TEXT PRIMARY KEY, content_id TEXT, cancel_requested INTEGER,
      status TEXT, lease_expires_at INTEGER
    );
    CREATE TABLE media_job_artifacts (
      id TEXT PRIMARY KEY, job_id TEXT, content_id TEXT, file_path TEXT,
      created_at INTEGER, UNIQUE(job_id,file_path)
    );
    CREATE TABLE content_erase_operations (
      id TEXT PRIMARY KEY, content_id TEXT, state TEXT
    );
  `);
  const store = new MediaJobArtifactStore(db, contentDir, { now: () => 100 });
  t.after(() => { db.close(); fs.rmSync(contentDir, { recursive: true, force: true }); });
  return { db, contentDir, store };
}

test('artifact registration is serialized behind the permanent-erase barrier', (t) => {
  const { db, contentDir, store } = fixture(t);
  db.prepare("INSERT INTO content VALUES ('content-1','','','')").run();
  db.prepare("INSERT INTO media_jobs VALUES ('job-1','content-1',0,'running',200)").run();
  const first = path.join(contentDir, 'first.part.mp4');
  store.register({ id: 'job-1', content_id: 'content-1' }, first);
  db.prepare("INSERT INTO content_erase_operations VALUES ('erase-1','content-1','prepared')").run();
  assert.throws(
    () => store.register({ id: 'job-1', content_id: 'content-1' }, path.join(contentDir, 'late.part.mp4')),
    { code: 'media_job_cancelled' },
  );
  assert.deepEqual(store.pathsForContent('content-1'), [first]);
});

test('crash recovery drops ledger ownership without deleting a catalog-adopted file', async (t) => {
  const { db, contentDir, store } = fixture(t);
  const canonical = path.join(contentDir, 'canonical.mp4');
  fs.writeFileSync(canonical, 'committed');
  db.prepare("INSERT INTO content VALUES ('content-1','canonical.mp4','','')").run();
  db.prepare("INSERT INTO media_jobs VALUES ('job-1','content-1',0,'completed',NULL)").run();
  store.register = store.register.bind(store);
  db.prepare('INSERT INTO media_job_artifacts VALUES (?,?,?,?,?)')
    .run('artifact-1', 'job-1', 'content-1', canonical, 1);

  await store.cleanupJob('job-1');
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'committed');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM media_job_artifacts').get().count, 0);
});

test('startup recovery removes terminal-job bytes and yt-dlp dynamic fragments', async (t) => {
  const { db, contentDir, store } = fixture(t);
  const part = path.join(contentDir, 'content-1.download.part.mp4');
  const fragment = path.join(contentDir, 'content-1.download.part.f299.mp4.part');
  fs.writeFileSync(part, 'partial');
  fs.writeFileSync(fragment, 'fragment');
  db.prepare("INSERT INTO content VALUES ('content-1','','','')").run();
  db.prepare("INSERT INTO media_jobs VALUES ('job-1','content-1',1,'cancelled',NULL)").run();
  db.prepare('INSERT INTO media_job_artifacts VALUES (?,?,?,?,?)')
    .run('artifact-1', 'job-1', 'content-1', part, 1);

  assert.equal(await store.cleanupOrphans(), 1);
  assert.equal(fs.existsSync(part), false);
  assert.equal(fs.existsSync(fragment), false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM media_job_artifacts').get().count, 0);
});

test('startup cleanup does not race a cancellation-requested worker with a live lease', async (t) => {
  const { db, contentDir, store } = fixture(t);
  const active = path.join(contentDir, 'active-output.part');
  fs.writeFileSync(active, 'writer still owns this path');
  db.prepare("INSERT INTO content VALUES ('content-1','','','')").run();
  db.prepare("INSERT INTO media_jobs VALUES ('job-1','content-1',1,'running',200)").run();
  db.prepare('INSERT INTO media_job_artifacts VALUES (?,?,?,?,?)')
    .run('artifact-1', 'job-1', 'content-1', active, 1);

  assert.equal(await store.cleanupOrphans(), 0);
  assert.equal(fs.readFileSync(active, 'utf8'), 'writer still owns this path');

  db.prepare("UPDATE media_jobs SET lease_expires_at=99 WHERE id='job-1'").run();
  assert.equal(await store.cleanupOrphans(), 1);
  assert.equal(fs.existsSync(active), false);
});

test('presentation fallback registers every deterministic external-writer path for restart cleanup', async (t) => {
  const { db, contentDir, store } = fixture(t);
  const source = path.join(contentDir, 'source.pptx');
  fs.writeFileSync(source, 'fixture source');
  db.prepare("INSERT INTO content VALUES ('content-1','source.pptx','','')").run();
  db.prepare("INSERT INTO media_jobs VALUES ('presentation-job','content-1',0,'running',200)").run();
  const job = { id: 'presentation-job', content_id: 'content-1' };
  const registered = () => store.pathsForContent('content-1');
  const execFile = async (command, args) => {
    if (/soffice|libreoffice/.test(command)) {
      const workingSource = args.at(-1);
      const pdfPath = workingSource.replace(/\.pptx$/i, '.pdf');
      assert.ok(registered().includes(workingSource));
      assert.ok(registered().includes(pdfPath));
      fs.writeFileSync(pdfPath, '%PDF-1.7');
      return;
    }
    const pngPath = `${args.at(-1)}.png`;
    assert.ok(registered().includes(pngPath));
    fs.writeFileSync(pngPath, PNG);
  };
  const slideIr = {
    assets: [],
    slides: [{ source_slide_number: 1, elements: [{ id: 'chart', kind: 'chart' }] }],
  };

  const rendered = await renderComplexSlideFallbacks(source, slideIr, contentDir, {
    jobId: job.id,
    execFile,
    registerArtifact: (filePath) => store.register(job, filePath),
  });
  assert.equal(rendered.length, 1);
  assert.equal(fs.existsSync(rendered[0].finalPath), true);
  assert.ok(registered().every((filePath) => path.dirname(filePath) === path.resolve(contentDir)));
  assert.ok(registered().some((filePath) => /presentation_job_[a-f0-9]{24}_fallback\.pdf$/.test(filePath)));

  db.prepare("UPDATE media_jobs SET status='cancelled',cancel_requested=1,lease_expires_at=NULL WHERE id='presentation-job'").run();
  assert.equal(await store.cleanupOrphans(), 1);
  assert.equal(fs.existsSync(rendered[0].finalPath), false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM media_job_artifacts').get().count, 0);
});
