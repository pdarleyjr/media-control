const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileZones } = require('../lib/reconcile-zones');

const existing = [
  { id: 'z1', sort_order: 0, x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
  { id: 'z2', sort_order: 1, x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
];

test('same count -> updates in place, no inserts/deletes, ids preserved', () => {
  const desired = [
    { sort_order: 0, x_percent: 0, y_percent: 0, width_percent: 60, height_percent: 100, name: 'L' },
    { sort_order: 1, x_percent: 60, y_percent: 0, width_percent: 40, height_percent: 100, name: 'R' },
  ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 2);
  assert.equal(r.updates[0].id, 'z1');
  assert.equal(r.updates[0].width_percent, 60);
  assert.equal(r.inserts.length, 0);
  assert.deepEqual(r.deleteIds, []);
});

test('more desired -> extra inserted, existing ids kept', () => {
  const desired = [ {sort_order:0}, {sort_order:1}, {sort_order:2} ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 2);
  assert.equal(r.inserts.length, 1);
  assert.deepEqual(r.deleteIds, []);
});

test('fewer desired -> surplus deleted', () => {
  const desired = [ {sort_order:0} ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 1);
  assert.equal(r.inserts.length, 0);
  assert.deepEqual(r.deleteIds, ['z2']);
});
