'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveClassroomAudioAuthority,
  classroomAudioMutePlan,
} = require('../lib/command-model');

const DEVICES = [
  { id: 'fc', name: 'Classroom 1 - Front Center' },
  { id: 'fl', name: 'Classroom 1 - Front Left' },
  { id: 'fr', name: 'Classroom 1 - Front Right' },
  { id: 'sl', name: 'Classroom 1 - Side Left' },
  { id: 'sr', name: 'Classroom 1 - Side Right' },
];

describe('classroom single audio authority', () => {
  it('selects Front Left as sole eARC authority', () => {
    const r = resolveClassroomAudioAuthority(DEVICES);
    assert.equal(r.valid, true);
    assert.equal(r.configured_authority_name, 'Front Left');
    assert.equal(r.authority_device_id, 'fl');
    assert.equal(r.followers.length, 4);
  });

  it('unmutes authority and mutes followers', () => {
    const plan = classroomAudioMutePlan(DEVICES, {
      onlineDeviceIds: DEVICES.map((d) => d.id),
    });
    const byId = Object.fromEntries(plan.plan.map((p) => [p.device_id, p]));
    assert.equal(byId.fl.muted, false);
    assert.equal(byId.fl.reason, 'single_audio_authority');
    for (const id of ['fc', 'fr', 'sl', 'sr']) {
      assert.equal(byId[id].muted, true);
      assert.equal(byId[id].role, 'follower');
    }
  });

  it('mutes everyone when authority is offline', () => {
    const plan = classroomAudioMutePlan(DEVICES, {
      onlineDeviceIds: ['fc', 'fr', 'sl', 'sr'],
    });
    assert.equal(plan.authority_online, false);
    assert.ok(plan.plan.every((p) => p.muted === true));
    assert.equal(
      plan.plan.find((p) => p.device_id === 'fl').reason,
      'authority_offline',
    );
  });

  it('reports invalid authority when Front Left missing', () => {
    const r = resolveClassroomAudioAuthority(DEVICES.filter((d) => d.id !== 'fl'));
    assert.equal(r.valid, false);
    assert.equal(r.error, 'audio_authority_offline_or_unconfigured');
    const plan = classroomAudioMutePlan(DEVICES.filter((d) => d.id !== 'fl'), {
      onlineDeviceIds: ['fc', 'fr'],
    });
    assert.ok(plan.plan.every((p) => p.muted === true));
  });

  it('keeps followers muted after authority reconnect planning', () => {
    const offline = classroomAudioMutePlan(DEVICES, { onlineDeviceIds: [] });
    assert.ok(offline.plan.every((p) => p.muted === true));
    const back = classroomAudioMutePlan(DEVICES, {
      onlineDeviceIds: DEVICES.map((d) => d.id),
    });
    assert.equal(back.plan.find((p) => p.device_id === 'fl').muted, false);
    assert.ok(
      back.plan.filter((p) => p.role === 'follower').every((p) => p.muted === true),
    );
  });
});
