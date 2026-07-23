'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  putPlan,
  getPlan,
  consumePlanForStart,
  normalizePlanInput,
} = require('../lib/production-plan');

describe('production-plan', () => {
  it('stores fixed camera plan', () => {
    const plan = putPlan('ws-1', {
      production_mode: 'fixed_camera',
      camera_id: 1,
      audio_mode: 'speech',
      recording_requested: true,
    });
    assert.equal(plan.director_mode, 'manual');
    assert.equal(plan.scene_name, 'KAMRUI_CAMERA_1_FULL');
    assert.ok(plan.production_plan_id);
    assert.equal(getPlan('ws-1').production_plan_id, plan.production_plan_id);
  });

  it('ai director requires auto mode', () => {
    const n = normalizePlanInput({ production_mode: 'ai_director', confirm_auto_canary: true });
    assert.equal(n.director_mode, 'auto');
    assert.equal(n.confirm_auto_canary, true);
  });

  it('consume rejects missing plan without body mode', () => {
    assert.throws(() => consumePlanForStart('ws-empty', {}), /No production plan/);
  });

  it('consume accepts matching plan id', () => {
    const plan = putPlan('ws-2', { production_mode: 'manual_multicamera', audio_mode: 'content_audio' });
    const got = consumePlanForStart('ws-2', { production_plan_id: plan.production_plan_id });
    assert.equal(got.production_mode, 'manual_multicamera');
    assert.equal(got.director_mode, 'manual');
  });
});
