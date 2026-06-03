const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { planZoneSave } = require('../lib/zone-save');

// ---------------------------------------------------------------------------
// Part 1 — pure planner: reconcile preserves untouched zone ids (no churn).
// ---------------------------------------------------------------------------
const existing = [
  { id: 'z1', sort_order: 0, name: 'Left',  x_percent: 0,  y_percent: 0, width_percent: 50, height_percent: 100, background_color: '#111111' },
  { id: 'z2', sort_order: 1, name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, background_color: '#222222' },
];

test('same count -> updates reuse existing ids, no inserts/deletes', () => {
  const desired = [
    { name: 'L', x_percent: 0,  y_percent: 0, width_percent: 60, height_percent: 100 },
    { name: 'R', x_percent: 60, y_percent: 0, width_percent: 40, height_percent: 100 },
  ];
  const plan = planZoneSave(existing, desired);
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.updates[0].id, 'z1');
  assert.equal(plan.updates[1].id, 'z2');
  assert.equal(plan.updates[0].width_percent, 60);
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.deleteIds, []);
});

test('more desired -> existing ids kept, only the surplus is inserted', () => {
  const desired = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const plan = planZoneSave(existing, desired);
  assert.equal(plan.updates.length, 2);
  assert.deepEqual(plan.updates.map(z => z.id), ['z1', 'z2']);
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.inserts[0].name, 'c');
  assert.deepEqual(plan.deleteIds, []);
  // sort_order is assigned by slot for inserts (after the updated slots).
  assert.equal(plan.inserts[0].sort_order, 2);
});

test('fewer desired -> surplus zone deleted, kept zone keeps its id', () => {
  const desired = [{ name: 'only' }];
  const plan = planZoneSave(existing, desired);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 'z1');
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.deleteIds, ['z2']);
});

test('field defaults applied + background_color carried through', () => {
  const desired = [
    {}, // fully empty -> all column defaults
    { background_color: '#abcdef', zone_type: 'widget', fit_mode: 'contain' },
  ];
  const plan = planZoneSave(existing, desired);
  const a = plan.updates[0];
  assert.equal(a.name, 'Zone');
  assert.equal(a.width_percent, 100);
  assert.equal(a.height_percent, 100);
  assert.equal(a.zone_type, 'content');
  assert.equal(a.fit_mode, 'cover');
  assert.equal(a.background_color, '#000000');
  const b = plan.updates[1];
  assert.equal(b.background_color, '#abcdef');
  assert.equal(b.zone_type, 'widget');
  assert.equal(b.fit_mode, 'contain');
});

test('empty desired -> all existing deleted, no updates/inserts', () => {
  const plan = planZoneSave(existing, []);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.deleteIds, ['z1', 'z2']);
});

// ---------------------------------------------------------------------------
// Part 2 — atomicity: a mid-save failure leaves the PRIOR zones fully intact
// (transaction rollback), proving the old destructive half-wipe is impossible.
//
// Uses an in-memory better-sqlite3 DB with the real layout_zones column shape
// and runs the SAME transactional save logic the PUT /:id/zones route uses.
// ---------------------------------------------------------------------------
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE layout_zones (
      id              TEXT PRIMARY KEY,
      layout_id       TEXT NOT NULL,
      name            TEXT NOT NULL DEFAULT 'Zone',
      x_percent       REAL NOT NULL DEFAULT 0,
      y_percent       REAL NOT NULL DEFAULT 0,
      width_percent   REAL NOT NULL DEFAULT 100,
      height_percent  REAL NOT NULL DEFAULT 100,
      z_index         INTEGER NOT NULL DEFAULT 0,
      zone_type       TEXT NOT NULL DEFAULT 'content',
      fit_mode        TEXT NOT NULL DEFAULT 'cover',
      background_color TEXT DEFAULT '#000000',
      sort_order      INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seed(db, layoutId, rows) {
  const stmt = db.prepare(`INSERT INTO layout_zones
    (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (@id,@layout_id,@name,@x_percent,@y_percent,@width_percent,@height_percent,@z_index,@zone_type,@fit_mode,@background_color,@sort_order)`);
  rows.forEach(r => stmt.run({
    id: r.id, layout_id: layoutId, name: r.name, x_percent: r.x_percent, y_percent: r.y_percent,
    width_percent: r.width_percent, height_percent: r.height_percent, z_index: 0,
    zone_type: 'content', fit_mode: 'cover', background_color: r.background_color, sort_order: r.sort_order,
  }));
}

// Build a transactional save identical in shape to the route handler, but with
// an injectable insert statement so a test can force a mid-sequence failure.
function makeSaveZones(db, { insertStmt } = {}) {
  const update = db.prepare(`UPDATE layout_zones SET name=?, x_percent=?, y_percent=?, width_percent=?, height_percent=?, z_index=?, zone_type=?, fit_mode=?, background_color=?, sort_order=? WHERE id=?`);
  const insert = insertStmt || db.prepare(`INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const del = db.prepare('DELETE FROM layout_zones WHERE id = ?');
  const uuid = (() => { let n = 0; return () => `new-${++n}`; })();
  return db.transaction((layoutId, zoneList) => {
    const existingRows = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
    const { updates, inserts, deleteIds } = planZoneSave(existingRows, zoneList);
    updates.forEach(z => update.run(z.name, z.x_percent, z.y_percent, z.width_percent,
      z.height_percent, z.z_index, z.zone_type, z.fit_mode, z.background_color, z.sort_order, z.id));
    inserts.forEach(z => insert.run(uuid(), layoutId, z.name, z.x_percent, z.y_percent,
      z.width_percent, z.height_percent, z.z_index, z.zone_type, z.fit_mode, z.background_color, z.sort_order));
    deleteIds.forEach(id => del.run(id));
  });
}

const PRIOR = [
  { id: 'p1', name: 'Left',  x_percent: 0,  y_percent: 0, width_percent: 50, height_percent: 100, background_color: '#111111', sort_order: 0 },
  { id: 'p2', name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100, background_color: '#222222', sort_order: 1 },
];

test('ATOMIC: mid-save failure rolls back -> prior zones fully intact', () => {
  const db = freshDb();
  seed(db, 'L', PRIOR);

  // An insert statement that throws on its first run, simulating a failure
  // partway through persisting a larger desired set (would-be 3 zones: 2 update
  // slots + 1 insert). The route's old code wasn't transactional, so a failure
  // here after some DELETEs would have left the layout half-wiped.
  const throwingInsert = { run() { throw new Error('disk full during insert'); } };
  const saveZones = makeSaveZones(db, { insertStmt: throwingInsert });

  const desired = [
    { name: 'L2', x_percent: 0,  y_percent: 0, width_percent: 40, height_percent: 100, background_color: '#aaaaaa' },
    { name: 'R2', x_percent: 40, y_percent: 0, width_percent: 30, height_percent: 100, background_color: '#bbbbbb' },
    { name: 'NEW', x_percent: 70, y_percent: 0, width_percent: 30, height_percent: 100 }, // -> insert (throws)
  ];

  assert.throws(() => saveZones('L', desired), /disk full/);

  // Rollback: BOTH prior zones survive with their ORIGINAL ids and values —
  // the UPDATE that ran before the throwing INSERT was undone.
  const after = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all('L');
  assert.equal(after.length, 2);
  assert.deepEqual(after.map(z => z.id), ['p1', 'p2']);
  assert.equal(after[0].name, 'Left');                 // not 'L2' -> update rolled back
  assert.equal(after[0].width_percent, 50);            // original geometry preserved
  assert.equal(after[1].background_color, '#222222');  // original color preserved
});

test('ATOMIC: a successful save preserves surviving zone ids (no delete+recreate)', () => {
  const db = freshDb();
  seed(db, 'L', PRIOR);
  const saveZones = makeSaveZones(db);

  const desired = [
    { name: 'L-edited', x_percent: 0,  y_percent: 0, width_percent: 60, height_percent: 100, background_color: '#cccccc' },
    { name: 'R-edited', x_percent: 60, y_percent: 0, width_percent: 40, height_percent: 100, background_color: '#dddddd' },
  ];
  saveZones('L', desired);

  const after = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all('L');
  assert.equal(after.length, 2);
  // Ids are the SAME rows as before (updated in place), so any zone_id bindings
  // in playlist_items / schedules survive the save.
  assert.deepEqual(after.map(z => z.id), ['p1', 'p2']);
  assert.equal(after[0].name, 'L-edited');
  assert.equal(after[0].width_percent, 60);
  assert.equal(after[1].background_color, '#dddddd');
});
