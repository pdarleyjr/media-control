'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { listPresentationSources, presentationSourceDecision } = require('../services/presentation-source-access');

function dbFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE content (
      id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT,filename TEXT,mime_type TEXT,
      filepath TEXT,content_type TEXT,library_scope TEXT,access_level TEXT,archived_at INTEGER
    );
    CREATE TABLE content_template_assignments (content_id TEXT,workspace_id TEXT);
    INSERT INTO workspaces VALUES ('ws-a','org-a'),('ws-b','org-b');
    INSERT INTO content VALUES
      ('source','owner','ws-a','Source.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation','source.pptx','presentation_source','internal','private',NULL),
      ('peer-source','peer','ws-a','Peer.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation','peer.pptx','presentation_source','internal','private',NULL),
      ('other-workspace','owner','ws-b','Other.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation','other.pptx','presentation_source','internal','private',NULL),
      ('wrong-type','owner','ws-a','Image.png','image/png','image.png','presentation_image','internal','private',NULL);
  `);
  return db;
}

test('only the owning user in the exact workspace can enqueue an internal converter source', () => {
  const db = dbFixture();
  try {
    assert.equal(presentationSourceDecision(db, 'source', 'ws-a', { userId: 'owner' }).allowed, true);
    assert.equal(presentationSourceDecision(db, 'source', 'ws-a', { userId: 'peer' }).allowed, false);
    assert.equal(presentationSourceDecision(db, 'source', 'ws-b', { userId: 'owner', isPlatformAdmin: true }).allowed, false);
    assert.equal(presentationSourceDecision(db, 'wrong-type', 'ws-a', { userId: 'owner' }).allowed, false);
  } finally { db.close(); }
});

test('converter source listing returns only the exact owner and workspace internals', () => {
  const db = dbFixture();
  try {
    assert.deepEqual(listPresentationSources(db, 'ws-a', { userId: 'owner' }), [{
      id: 'source', filename: 'Source.pptx', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }]);
    assert.deepEqual(listPresentationSources(db, 'ws-b', { userId: 'owner', isPlatformAdmin: true }).map((row) => row.id), ['other-workspace']);
  } finally { db.close(); }
});
