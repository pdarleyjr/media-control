'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  canServePresentationAsset,
  deckForPlayer,
  presentationAssetAccess,
  snapshotReferencesContent,
} = require('../lib/presentation-player-access');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE organization_members (organization_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE presentations (
      id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, title TEXT,
      deck_json TEXT, status TEXT, published_snapshot TEXT
    );
    CREATE TABLE presentation_assets (presentation_id TEXT, content_id TEXT);
    INSERT INTO workspaces VALUES ('ws-a','org-a'),('ws-b','org-a');
    INSERT INTO workspace_members VALUES
      ('ws-a','owner-a','workspace_editor'),
      ('ws-a','peer-a','workspace_editor'),
      ('ws-b','owner-a','workspace_admin');
  `);
  return db;
}

test('published-player access is snapshot-only and draft access requires exact ownership', () => {
  const db = fixture();
  try {
    const working = JSON.stringify({ version: 'mbfd-deck-v1', marker: 'working', assets: [{ content_id: 'asset-draft' }] });
    const published = JSON.stringify({ version: 'mbfd-deck-v1', marker: 'published', assets: [{ content_id: 'asset-public' }] });
    db.prepare('INSERT INTO presentations VALUES (?,?,?,?,?,?,?)')
      .run('deck-published', 'ws-a', 'owner-a', 'Published', working, 'published', published);
    db.prepare('INSERT INTO presentations VALUES (?,?,?,?,?,?,NULL)')
      .run('deck-draft', 'ws-a', 'owner-a', 'Draft', working, 'draft');

    assert.equal(deckForPlayer(db, 'deck-published').deck.marker, 'published');
    assert.equal(deckForPlayer(db, 'deck-draft'), null);
    assert.equal(deckForPlayer(db, 'deck-draft', { id: 'owner-a', role: 'user' }).deck.marker, 'working');
    assert.equal(deckForPlayer(db, 'deck-draft', { id: 'peer-a', role: 'user' }), null);
  } finally { db.close(); }
});

test('public assets require an exact reference in a published snapshot', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO presentations VALUES (?,?,?,?,?,?,?)').run(
      'deck-published', 'ws-a', 'owner-a', 'Published', '{}', 'published',
      JSON.stringify({ slides: [{ slots: { hero: { content_id: 'asset-public' } } }] }),
    );
    db.prepare('INSERT INTO presentations VALUES (?,?,?,?,?,?,NULL)')
      .run('deck-draft', 'ws-a', 'owner-a', 'Draft', JSON.stringify({ assets: [{ content_id: 'asset-draft' }] }), 'draft');
    db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('deck-published', 'asset-public');
    db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('deck-published', 'asset-linked-but-not-snapshot');
    db.prepare('INSERT INTO presentation_assets VALUES (?,?)').run('deck-draft', 'asset-draft');

    assert.equal(canServePresentationAsset(db, 'asset-public'), true);
    assert.deepEqual(presentationAssetAccess(db, 'asset-public'), { allowed: true, public: true });
    assert.equal(canServePresentationAsset(db, 'asset-linked-but-not-snapshot'), false);
    assert.equal(canServePresentationAsset(db, 'asset-draft'), false);
    assert.equal(canServePresentationAsset(db, 'asset-draft', { id: 'owner-a', role: 'user' }), true);
    assert.deepEqual(
      presentationAssetAccess(db, 'asset-draft', { id: 'owner-a', role: 'user' }),
      { allowed: true, public: false },
    );
    assert.equal(canServePresentationAsset(db, 'asset-draft', { id: 'peer-a', role: 'user' }), false);
    assert.equal(snapshotReferencesContent({ content_id: 'asset-public-suffix' }, 'asset-public'), false);
  } finally { db.close(); }
});
