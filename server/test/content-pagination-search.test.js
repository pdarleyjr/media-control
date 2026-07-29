'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  contentCursorPredicate,
  contentFtsQuery,
  decodeContentCursor,
  encodeContentCursor,
} = require('../lib/content-pagination');
const { migrateContentSearch } = require('../db/migrations/media-pipeline');

test('content cursor round-trips the complete deterministic sort tuple', () => {
  const cursor = encodeContentCursor({
    folder: 'Training',
    created_at: 1234,
    id: 'content-z',
  });
  assert.deepEqual(decodeContentCursor(cursor), {
    v: 1,
    folder: 'Training',
    created_at: 1234,
    id: 'content-z',
  });
  assert.throws(() => decodeContentCursor('not-json'), /invalid_content_cursor/);
  assert.throws(
    () => decodeContentCursor(Buffer.from(JSON.stringify({ v: 1 })).toString('base64url')),
    /invalid_content_cursor/,
  );
});

test('cursor predicate walks folder/created/id ordering without gaps or duplicates', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE content (id TEXT PRIMARY KEY, folder TEXT, created_at INTEGER NOT NULL);
      INSERT INTO content VALUES
        ('z', NULL, 20),
        ('y', NULL, 20),
        ('x', NULL, 10),
        ('b', 'Folder', 30),
        ('a', 'Folder', 30);
    `);
    const page = (after = null) => {
      const predicate = after ? contentCursorPredicate(after) : null;
      return db.prepare(`
        SELECT * FROM content c
        ${predicate ? `WHERE ${predicate.sql}` : ''}
        ORDER BY COALESCE(c.folder, '') ASC, c.created_at DESC, c.id DESC
        LIMIT 2
      `).all(...(predicate?.params || []));
    };
    const first = page();
    const second = page(decodeContentCursor(encodeContentCursor(first.at(-1))));
    const third = page(decodeContentCursor(encodeContentCursor(second.at(-1))));
    assert.deepEqual(
      [...first, ...second, ...third].map((row) => row.id),
      ['z', 'y', 'x', 'b', 'a'],
    );
  } finally {
    db.close();
  }
});

test('FTS query construction tokenizes user input instead of exposing MATCH syntax', () => {
  assert.equal(contentFtsQuery('Fire safety'), '"Fire"* AND "safety"*');
  assert.equal(contentFtsQuery('" OR * NOT ('), '"OR"* AND "NOT"*');
  assert.equal(contentFtsQuery('Évacuation'), '"Évacuation"*');
});

test('FTS5 search indexes filename, tags, description, and owner and stays synchronized', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
      CREATE TABLE content (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        filename TEXT,
        tags_json TEXT,
        metadata_json TEXT
      );
      INSERT INTO users VALUES ('u1', 'Ada Instructor', 'ada@example.test');
      INSERT INTO content VALUES (
        'c1', 'u1', 'Evacuation Map.png', '["drill","classroom"]',
        '{"description":"South stairwell route"}'
      );
    `);
    const available = migrateContentSearch(db);
    if (!available) return;
    const match = (query) => db.prepare(
      'SELECT content_id FROM content_fts WHERE content_fts MATCH ?',
    ).all(contentFtsQuery(query)).map((row) => row.content_id);
    assert.deepEqual(match('Evacuation'), ['c1']);
    assert.deepEqual(match('drill'), ['c1']);
    assert.deepEqual(match('stairwell'), ['c1']);
    assert.deepEqual(match('Instructor'), ['c1']);

    db.prepare("UPDATE content SET filename='Assembly Plan.pdf' WHERE id='c1'").run();
    assert.deepEqual(match('Assembly'), ['c1']);
    assert.deepEqual(match('Evacuation'), []);
    db.prepare("UPDATE users SET name='Grace Trainer' WHERE id='u1'").run();
    assert.deepEqual(match('Grace'), ['c1']);
  } finally {
    db.close();
  }
});
