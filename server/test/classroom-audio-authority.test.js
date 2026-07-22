const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { mergeDisplayState } = require('../lib/command-model');

const AUTH_KEY = 'CLASSROOM_AUDIO_AUTHORITY_DEVICE_ID';

function rowFor(id) {
  return db.prepare(
    'SELECT muted, volume FROM display_states WHERE target_type = ? AND target_id = ?'
  ).get('display', id);
}

test('audio authority: unset env does not rewrite follower unmute', () => {
  const prev = process.env[AUTH_KEY];
  delete process.env[AUTH_KEY];
  const id = `aa-follower-${crypto.randomUUID()}`;
  try {
    mergeDisplayState('display', id, { muted: false, volume: 80 });
    const row = rowFor(id);
    assert.equal(row.muted, 0);
    assert.equal(row.volume, 80);
  } finally {
    if (prev === undefined) delete process.env[AUTH_KEY];
    else process.env[AUTH_KEY] = prev;
    db.prepare('DELETE FROM display_states WHERE target_id = ?').run(id);
  }
});

test('audio authority: follower unmute heartbeat is forced muted with volume 0', () => {
  const authority = `aa-auth-${crypto.randomUUID()}`;
  const follower = `aa-fol-${crypto.randomUUID()}`;
  const prev = process.env[AUTH_KEY];
  process.env[AUTH_KEY] = authority;
  try {
    mergeDisplayState('display', follower, { muted: false, volume: 100 });
    const row = rowFor(follower);
    assert.equal(row.muted, 1);
    assert.equal(row.volume, 0);
  } finally {
    if (prev === undefined) delete process.env[AUTH_KEY];
    else process.env[AUTH_KEY] = prev;
    db.prepare('DELETE FROM display_states WHERE target_id IN (?, ?)').run(authority, follower);
  }
});

test('audio authority: authority device may remain unmuted', () => {
  const authority = `aa-auth-${crypto.randomUUID()}`;
  const prev = process.env[AUTH_KEY];
  process.env[AUTH_KEY] = authority;
  try {
    mergeDisplayState('display', authority, { muted: false, volume: 80 });
    const row = rowFor(authority);
    assert.equal(row.muted, 0);
    assert.equal(row.volume, 80);
  } finally {
    if (prev === undefined) delete process.env[AUTH_KEY];
    else process.env[AUTH_KEY] = prev;
    db.prepare('DELETE FROM display_states WHERE target_id = ?').run(authority);
  }
});

test('audio authority: duplicate audio prevention across multiple followers', () => {
  const authority = `aa-auth-${crypto.randomUUID()}`;
  const f1 = `aa-f1-${crypto.randomUUID()}`;
  const f2 = `aa-f2-${crypto.randomUUID()}`;
  const prev = process.env[AUTH_KEY];
  process.env[AUTH_KEY] = authority;
  try {
    mergeDisplayState('display', authority, { muted: false, volume: 75 });
    mergeDisplayState('display', f1, { muted: false, volume: 90 });
    mergeDisplayState('display', f2, { muted: false, volume: 90 });
    assert.equal(rowFor(authority).muted, 0);
    assert.equal(rowFor(f1).muted, 1);
    assert.equal(rowFor(f2).muted, 1);
    assert.equal(rowFor(f1).volume, 0);
    assert.equal(rowFor(f2).volume, 0);
  } finally {
    if (prev === undefined) delete process.env[AUTH_KEY];
    else process.env[AUTH_KEY] = prev;
    db.prepare('DELETE FROM display_states WHERE target_id IN (?, ?, ?)').run(authority, f1, f2);
  }
});

test('audio authority: empty env string disables pin', () => {
  const id = `aa-empty-${crypto.randomUUID()}`;
  const prev = process.env[AUTH_KEY];
  process.env[AUTH_KEY] = '   ';
  try {
    mergeDisplayState('display', id, { muted: false, volume: 50 });
    assert.equal(rowFor(id).muted, 0);
  } finally {
    if (prev === undefined) delete process.env[AUTH_KEY];
    else process.env[AUTH_KEY] = prev;
    db.prepare('DELETE FROM display_states WHERE target_id = ?').run(id);
  }
});
