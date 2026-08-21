'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { copyPresentationAssetToLibrary } = require('../services/presentation-asset-copy');
const { contentBroadcastReadiness } = require('../lib/content-readiness');

function buildDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, filename TEXT NOT NULL,
      filepath TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL, file_size INTEGER DEFAULT 0,
      duration_sec REAL, thumbnail_path TEXT, width INTEGER, height INTEGER,
      processing_status TEXT, processing_error TEXT, media_probe_json TEXT,
      access_level TEXT, source_content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
      version INTEGER DEFAULT 1, archived_at INTEGER, updated_at INTEGER, created_at INTEGER,
      content_type TEXT, metadata_json TEXT,
      library_scope TEXT NOT NULL DEFAULT 'library' CHECK (library_scope IN ('library','internal'))
    );
    CREATE TABLE presentation_assets (
      id TEXT PRIMARY KEY, presentation_id TEXT NOT NULL,
      content_id TEXT REFERENCES content(id) ON DELETE SET NULL
    );
    CREATE TABLE presentation_conversion_runs (
      id TEXT PRIMARY KEY, presentation_id TEXT, source_content_id TEXT REFERENCES content(id) ON DELETE SET NULL
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY, content_id TEXT UNIQUE, generation INTEGER, sha256 TEXT,
      size_bytes INTEGER, canonical_path TEXT, canonical_url TEXT, poster_path TEXT,
      duration_sec REAL, width INTEGER, height INTEGER, computed_at INTEGER
    );
  `);
  return db;
}

function seedInternal(db, overrides = {}) {
  db.prepare(`INSERT INTO content (
    id,user_id,workspace_id,filename,filepath,mime_type,file_size,thumbnail_path,width,height,
    processing_status,access_level,version,content_type,metadata_json,library_scope
  ) VALUES (?,?,?,?,?,?,?,?,?,?,'ready','private',3,'presentation_image','{}','internal')`).run(
    overrides.id || 'internal-asset',
    'owner',
    overrides.workspaceId || 'ws-a',
    overrides.filename || 'Diagram.png',
    overrides.filepath || path.join('nested', 'diagram.png'),
    overrides.mimeType || 'image/png',
    7,
    overrides.thumbnailPath === undefined ? path.join('nested', 'diagram-thumb.png') : overrides.thumbnailPath,
    1200,
    800,
  );
  db.prepare('INSERT INTO presentation_assets VALUES (?,?,?)').run('link', overrides.presentationId || 'deck-a', overrides.id || 'internal-asset');
}

test('Save Copy creates independent library bytes and leaves the internal dependency unchanged', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.png'), 'diagram');
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram-thumb.png'), 'thumb');
    seedInternal(db);

    const result = await copyPresentationAssetToLibrary(db, {
      presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-a',
      userId: 'owner', contentDir, createId: () => 'library-copy', now: 1234,
    });

    const source = db.prepare("SELECT * FROM content WHERE id='internal-asset'").get();
    const copy = db.prepare("SELECT * FROM content WHERE id='library-copy'").get();
    assert.equal(source.library_scope, 'internal');
    assert.equal(copy.library_scope, 'library');
    assert.equal(copy.source_content_id, 'internal-asset');
    assert.equal(copy.workspace_id, 'ws-a');
    assert.equal(copy.user_id, 'owner');
    assert.notEqual(copy.filepath, source.filepath);
    assert.notEqual(copy.thumbnail_path, source.thumbnail_path);
    assert.equal(fs.readFileSync(path.join(contentDir, copy.filepath), 'utf8'), 'diagram');
    assert.equal(fs.readFileSync(path.join(contentDir, copy.thumbnail_path), 'utf8'), 'thumb');
    assert.equal(result.content_id, 'library-copy');
    assert.match(db.prepare("SELECT sha256 FROM asset_checksums WHERE content_id='library-copy'").get().sha256, /^[0-9a-f]{64}$/);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('Save Copy denies cross-workspace and unlinked internal asset IDs without creating bytes', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-deny-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.png'), 'diagram');
    seedInternal(db, { thumbnailPath: null });
    db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,library_scope)
      VALUES ('unlinked','owner','ws-a','Other.png','nested/diagram.png','image/png','internal')`).run();

    for (const options of [
      { presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-b' },
      { presentationId: 'deck-a', contentId: 'unlinked', workspaceId: 'ws-a' },
    ]) {
      await assert.rejects(() => copyPresentationAssetToLibrary(db, {
        ...options, userId: 'owner', contentDir, createId: () => 'must-not-exist',
      }), { code: 'PRESENTATION_ASSET_NOT_FOUND' });
    }
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='must-not-exist'").get().count, 0);
    assert.deepEqual(fs.readdirSync(contentDir), ['nested']);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('Save Copy removes staged output when the catalog transaction fails', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-rollback-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.png'), 'diagram');
    seedInternal(db, { thumbnailPath: null });
    db.prepare(`INSERT INTO content (id,user_id,workspace_id,filename,filepath,mime_type,library_scope)
      VALUES ('collision','owner','ws-a','Existing.png','','image/png','library')`).run();

    await assert.rejects(() => copyPresentationAssetToLibrary(db, {
      presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-a',
      userId: 'owner', contentDir, createId: () => 'collision',
    }), /UNIQUE constraint failed/);
    assert.deepEqual(fs.readdirSync(contentDir).sort(), ['nested']);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('Save Copy publishes video bytes with a generation-matching manifest that is broadcast ready', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-video-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.mp4'), 'normalized-video');
    seedInternal(db, {
      filename: 'Diagram.mp4',
      filepath: path.join('nested', 'diagram.mp4'),
      thumbnailPath: null,
      mimeType: 'video/mp4',
    });

    const result = await copyPresentationAssetToLibrary(db, {
      presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-a',
      userId: 'owner', contentDir, createId: () => 'library-video', now: 1234,
    });
    const copy = db.prepare("SELECT * FROM content WHERE id='library-video'").get();
    assert.deepEqual(contentBroadcastReadiness(db, copy), { ready: true });
    assert.equal(fs.readFileSync(path.join(contentDir, result.filepath), 'utf8'), 'normalized-video');
    fs.unlinkSync(path.join(contentDir, result.filepath));
    assert.equal(fs.existsSync(path.join(contentDir, 'nested', 'diagram.mp4')), true);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('Save Copy never overwrites or cleans up a pre-existing destination file', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-collision-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.png'), 'diagram');
    seedInternal(db, { thumbnailPath: null });
    const collision = path.join(contentDir, 'presentation_asset_copy_collision.png');
    fs.writeFileSync(collision, 'keep-existing');

    await assert.rejects(() => copyPresentationAssetToLibrary(db, {
      presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-a',
      userId: 'owner', contentDir, createId: () => 'collision',
    }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(collision, 'utf8'), 'keep-existing');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='collision'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});

test('Save Copy survives later presentation dependency cleanup as an independent library asset', async () => {
  const db = buildDb();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-copy-survival-'));
  try {
    fs.mkdirSync(path.join(contentDir, 'nested'));
    fs.writeFileSync(path.join(contentDir, 'nested', 'diagram.png'), 'presentation-source');
    seedInternal(db, { thumbnailPath: null });
    const result = await copyPresentationAssetToLibrary(db, {
      presentationId: 'deck-a', contentId: 'internal-asset', workspaceId: 'ws-a',
      userId: 'owner', contentDir, createId: () => 'surviving-copy', now: 1234,
    });

    db.prepare("DELETE FROM presentation_assets WHERE presentation_id='deck-a'").run();
    db.prepare("DELETE FROM content WHERE id='internal-asset'").run();
    fs.unlinkSync(path.join(contentDir, 'nested', 'diagram.png'));

    const copy = db.prepare("SELECT * FROM content WHERE id='surviving-copy'").get();
    assert.equal(copy.library_scope, 'library');
    assert.equal(copy.source_content_id, null);
    assert.equal(copy.processing_status, 'ready');
    assert.equal(fs.readFileSync(path.join(contentDir, result.filepath), 'utf8'), 'presentation-source');
    assert.match(db.prepare("SELECT sha256 FROM asset_checksums WHERE content_id='surviving-copy'").get().sha256, /^[0-9a-f]{64}$/);
  } finally {
    db.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  }
});
