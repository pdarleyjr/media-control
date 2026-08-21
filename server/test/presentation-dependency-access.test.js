'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { presentationDependencyDecision } = require('../services/presentation-dependency-access');

test('presentation broadcast can use only internal assets linked to that exact presentation and workspace', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      library_scope TEXT
    );
    CREATE TABLE presentation_assets (presentation_id TEXT, content_id TEXT);
    INSERT INTO content VALUES
      ('linked', 'ws-a', 'internal'),
      ('other-deck', 'ws-a', 'internal'),
      ('other-workspace', 'ws-b', 'internal');
    INSERT INTO presentation_assets VALUES
      ('deck-a', 'linked'),
      ('deck-b', 'other-deck'),
      ('deck-a', 'other-workspace');
  `);
  const presentation = { id: 'deck-a', workspace_id: 'ws-a' };

  assert.equal(presentationDependencyDecision(db, presentation, 'linked', 'ws-a').allowed, true);
  assert.equal(presentationDependencyDecision(db, presentation, 'other-deck', 'ws-a').allowed, false);
  assert.equal(presentationDependencyDecision(db, presentation, 'other-workspace', 'ws-a').allowed, false);
  assert.equal(presentationDependencyDecision(db, presentation, 'missing', 'ws-a').content, null);
});
