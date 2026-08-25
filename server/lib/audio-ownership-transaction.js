'use strict';

const { buildAudioPolicy } = require('./audio-ownership');

function ids(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function mutedPolicy(policy) {
  return buildAudioPolicy({
    outputDeviceId: policy?.output_device_id,
    ownerDeviceId: null,
    contentInstanceId: policy?.content_instance_id,
    transactionId: policy?.transaction_id,
    generation: policy?.generation,
    revision: policy?.revision,
    sourceKey: policy?.source_key,
  });
}

function validFenceAck(ack, deviceId, policy) {
  const revision = Number(policy?.revision);
  const generation = Number(policy?.generation);
  return Boolean(
    ack
    && ack.ok === true
    && ack.muted === true
    && ack.host_muted === true
    && String(ack.phase || '') === 'muted'
    && String(ack.device_id || '') === String(deviceId)
    && String(ack.transaction_id || '') === String(policy.transaction_id || '')
    && Number.isSafeInteger(revision)
    && revision > 0
    && Number(ack.revision) === revision
    && Number.isSafeInteger(generation)
    && generation > 0
    && Number(ack.generation) === generation
    && String(ack.renderer_session_id || '').trim(),
  );
}

function emitFence(namespace, deviceId, payload, timeoutMs, expectedAckCount) {
  return new Promise((resolve) => {
    try {
      let operator = namespace.to(deviceId);
      if (operator && typeof operator.timeout === 'function') operator = operator.timeout(timeoutMs);
      if (!operator || typeof operator.emit !== 'function') {
        resolve({ ok: false, reason: 'audio_fence_transport_unavailable' });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'audio_fence_timeout' }), timeoutMs);
      if (timer.unref) timer.unref();
      operator.emit('device:audio-policy-fence', payload, (error, responses) => {
        clearTimeout(timer);
        if (error) {
          finish({ ok: false, reason: 'audio_fence_timeout' });
          return;
        }
        const responseList = Array.isArray(responses) ? responses : [responses];
        const validAcks = responseList.filter((candidate) => (
          validFenceAck(candidate, deviceId, payload.audio_policy)
        ));
        const rendererSessions = new Set(validAcks.map((ack) => String(ack.renderer_session_id)));
        const allSessionsMuted = responseList.length === expectedAckCount
          && validAcks.length === expectedAckCount
          && rendererSessions.size === expectedAckCount;
        finish(allSessionsMuted
          ? { ok: true, acks: validAcks }
          : { ok: false, reason: 'audio_fence_ack_mismatch' });
      });
    } catch (error) {
      resolve({ ok: false, reason: error?.message || 'audio_fence_emit_failed' });
    }
  });
}

async function fenceAudioOwnershipTargets(namespace, {
  deviceIds,
  policy,
  timeoutMs = 1500,
} = {}) {
  const participants = ids(deviceIds);
  const fencePolicy = mutedPolicy(policy);
  const offline = participants.filter((deviceId) => {
    const room = namespace?.adapter?.rooms?.get(deviceId);
    return !room || room.size === 0;
  });
  const online = participants.filter((deviceId) => !offline.includes(deviceId));
  const payload = {
    version: 1,
    phase: 'mute-before-owner-grant',
    pending_owner_device_id: policy?.owner_device_id || null,
    audio_policy: fencePolicy,
  };
  const results = await Promise.all(online.map(async (deviceId) => ({
    deviceId,
    result: await emitFence(
      namespace,
      deviceId,
      payload,
      Math.max(25, Number(timeoutMs) || 1500),
      namespace.adapter.rooms.get(deviceId).size,
    ),
  })));
  const acknowledged = results.filter((entry) => entry.result.ok).map((entry) => entry.deviceId);
  const failed = [
    ...offline,
    ...results.filter((entry) => !entry.result.ok).map((entry) => entry.deviceId),
  ];
  const ok = participants.length > 0 && failed.length === 0;
  return {
    ok,
    acknowledged_device_ids: acknowledged,
    offline_device_ids: offline,
    failed_device_ids: failed,
    committed_policy: ok ? { ...policy } : fencePolicy,
  };
}

module.exports = {
  fenceAudioOwnershipTargets,
  validFenceAck,
};
