const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { db } = require('../db/database');
const { mergeDisplayState } = require('../lib/command-model');

test('mergeDisplayState coerces boolean state values into sqlite-friendly scalars', () => {
  const targetId = `test-state-report-${crypto.randomUUID()}`;
  try {
    mergeDisplayState('display', targetId, {
      workspace_id: null,
      current_content_id: 'content-123',
      current_asset_id: 'asset-123',
      content_type: 'document',
      layout_mode: 'wall-leader',
      slide_index: 4,
      duration: 30,
      paused: true,
      muted: false,
      volume: 0.75,
      local_asset_ready: true,
      last_ack_at: 1234567890,
      render_state: 'playing',
      error_state: null,
      idle_screensaver_id: null,
      default_screensaver_id: null,
    });

    const row = db.prepare(`
      SELECT target_type, target_id, current_content_id, current_asset_id, content_type,
             layout_mode, slide_index, "current_time" AS current_time, duration, paused, muted, volume,
             local_asset_ready, last_ack_at
      FROM display_states
      WHERE target_type = ? AND target_id = ?
    `).get('display', targetId);

    assert.ok(row, 'expected display_states row to be written');
    assert.equal(row.current_content_id, 'content-123');
    assert.equal(row.current_asset_id, 'asset-123');
    assert.equal(row.content_type, 'document');
    assert.equal(row.layout_mode, 'wall-leader');
    assert.equal(row.slide_index, 4);
    assert.equal(row.duration, 30);
    assert.equal(row.paused, 1);
    assert.equal(row.muted, 0);
    assert.equal(row.volume, 0.75);
    assert.equal(row.local_asset_ready, 1);
    assert.equal(row.last_ack_at, 1234567890);
  } finally {
    db.prepare('DELETE FROM display_states WHERE target_type = ? AND target_id = ?')
      .run('display', targetId);
  }
});

test('mergeDisplayState assigns monotonic revisions and rejects stale reports', () => {
  const targetId = `test-state-revision-${crypto.randomUUID()}`;
  try {
    const first = mergeDisplayState('display', targetId, {
      slide_index: 4,
      state_revision: 8,
    });
    const stale = mergeDisplayState('display', targetId, {
      slide_index: 1,
      state_revision: 7,
    });
    const next = mergeDisplayState('display', targetId, {
      slide_index: 5,
    });

    const row = db.prepare(`
      SELECT slide_index, state_revision
      FROM display_states
      WHERE target_type = ? AND target_id = ?
    `).get('display', targetId);

    assert.equal(first.applied, true);
    assert.equal(first.state_revision, 8);
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, 'stale_revision');
    assert.equal(next.applied, true);
    assert.equal(next.state_revision, 9);
    assert.equal(row.slide_index, 5);
    assert.equal(row.state_revision, 9);
  } finally {
    db.prepare('DELETE FROM display_states WHERE target_type = ? AND target_id = ?')
      .run('display', targetId);
  }
});
