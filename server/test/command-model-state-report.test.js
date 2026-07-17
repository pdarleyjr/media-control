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
      wall_id: 'wall-1',
      layout_id: 'wall-1:layout:2',
      group_id: 'wall-1:group:left',
      member_id: targetId,
      playback_revision: 12,
      command_revision: 'command-12',
    });

    const row = db.prepare(`
      SELECT target_type, target_id, current_content_id, current_asset_id, content_type,
             layout_mode, slide_index, "current_time" AS current_time, duration, paused, muted, volume,
             local_asset_ready, last_ack_at, wall_id, layout_id, group_id, member_id,
             playback_revision, command_revision
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
    assert.equal(row.wall_id, 'wall-1');
    assert.equal(row.layout_id, 'wall-1:layout:2');
    assert.equal(row.group_id, 'wall-1:group:left');
    assert.equal(row.member_id, targetId);
    assert.equal(row.playback_revision, 12);
    assert.equal(row.command_revision, 'command-12');
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

test('mergeDisplayState rejects malformed numeric and boolean telemetry', () => {
  const targetId = `test-state-types-${crypto.randomUUID()}`;
  try {
    mergeDisplayState('display', targetId, {
      current_time: '14:31:43',
      duration: 'not-a-duration',
      volume: 'loud',
      paused: 'false',
      muted: 'true',
      local_asset_ready: 'ready',
      slide_index: '3',
    });

    const row = db.prepare(`
      SELECT "current_time" AS current_time, duration, volume, paused, muted, local_asset_ready, slide_index
      FROM display_states
      WHERE target_type = ? AND target_id = ?
    `).get('display', targetId);

    assert.equal(row.current_time, null);
    assert.equal(row.duration, null);
    assert.equal(row.volume, null);
    assert.equal(row.paused, null);
    assert.equal(row.muted, null);
    assert.equal(row.local_asset_ready, null);
    assert.equal(row.slide_index, 3);
  } finally {
    db.prepare('DELETE FROM display_states WHERE target_type = ? AND target_id = ?')
      .run('display', targetId);
  }
});
