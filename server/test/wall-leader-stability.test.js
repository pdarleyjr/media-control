const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveEffectiveLayoutLeaders } = require('../lib/wall-layout');

test('effective wall failover is deterministic without changing the configured leader', () => {
  const layout = {
    groups: [{
      id: 'group-1',
      layout: 'span',
      member_ids: ['tv-1', 'tv-2', 'tv-3'],
      leader_device_id: 'tv-1',
    }],
  };
  const members = [
    { device_id: 'tv-1', status: 'offline' },
    { device_id: 'tv-2', status: 'online' },
    { device_id: 'tv-3', status: 'online' },
  ];

  const failedOver = resolveEffectiveLayoutLeaders(layout, members);
  assert.equal(failedOver.groups[0].leader_device_id, 'tv-2');
  assert.equal(failedOver.groups[0].configured_leader_device_id, 'tv-1');
  assert.equal(failedOver.groups[0].leader_failover_active, true);
  assert.equal(layout.groups[0].leader_device_id, 'tv-1', 'resolver must not mutate persisted layout state');

  const recovered = resolveEffectiveLayoutLeaders(layout, members.map((member) => ({ ...member, status: 'online' })));
  assert.equal(recovered.groups[0].leader_device_id, 'tv-1');
  assert.equal(recovered.groups[0].leader_failover_active, false);
});

test('socket reconnect and disconnect never rewrite persisted wall leadership', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.doesNotMatch(source, /UPDATE video_walls SET leader_device_id/);
  assert.match(source, /resolveEffectiveLayoutLeaders/);
  assert.match(source, /configured_leader_device_id/);
});
