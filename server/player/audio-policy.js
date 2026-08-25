(function initAudioPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MbfdAudioPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function audioPolicyFactory() {
  'use strict';

  function text(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function createRendererSessionId(cryptoApi) {
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      return `renderer-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    throw new Error('secure renderer session identity unavailable');
  }

  function normalizeAudioPolicy(raw, deviceId) {
    if (!raw || typeof raw !== 'object' || Number(raw.version) !== 1) return null;
    const ownerDeviceId = text(raw.owner_device_id);
    const rendererId = text(deviceId);
    const outputDeviceId = text(raw.output_device_id);
    const contentInstanceId = text(raw.content_instance_id);
    const transactionId = text(raw.transaction_id);
    const generation = positiveSafeInteger(raw.generation);
    const revision = positiveSafeInteger(raw.revision);
    if (!outputDeviceId || !contentInstanceId || !transactionId
        || generation === null || revision === null) return null;
    const audioAllowed = Boolean(ownerDeviceId && rendererId && ownerDeviceId === rendererId);
    return {
      version: 1,
      output_device_id: outputDeviceId,
      owner_device_id: ownerDeviceId,
      content_instance_id: contentInstanceId,
      transaction_id: transactionId,
      generation,
      revision,
      ...(text(raw.source_key) ? { source_key: text(raw.source_key) } : {}),
      ...(text(raw.playlist_revision) ? { playlist_revision: text(raw.playlist_revision) } : {}),
      audio_allowed: audioAllowed,
      force_muted: !audioAllowed,
    };
  }

  function samePolicyEpoch(left, right) {
    if (!left || !right) return false;
    return [
      'output_device_id',
      'content_instance_id',
      'transaction_id',
      'generation',
      'revision',
      'source_key',
    ].every((key) => String(left[key] ?? '') === String(right[key] ?? ''));
  }

  function samePolicyIdentity(left, right) {
    return samePolicyEpoch(left, right)
      && String(left?.owner_device_id || '') === String(right?.owner_device_id || '')
      && String(left?.playlist_revision || '') === String(right?.playlist_revision || '');
  }

  function positiveSafeInteger(value) {
    const number = finiteNumber(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function hostMuteRequest(raw) {
    const request = {
      version: 1,
      device_id: text(raw?.device_id),
      renderer_session_id: text(raw?.renderer_session_id),
      transaction_id: text(raw?.transaction_id),
      revision: positiveSafeInteger(raw?.revision),
      generation: positiveSafeInteger(raw?.generation),
    };
    return request.device_id
      && request.renderer_session_id
      && request.transaction_id
      && request.revision !== null
      && request.generation !== null
      ? request
      : null;
  }

  async function confirmHostMuted({ bridge, state, timeoutMs = 1000 } = {}) {
    const request = hostMuteRequest(state);
    if (!request) return { confirmed: false, reason: 'host_mute_confirmation_invalid' };
    if (!bridge || typeof bridge.confirmHostMuted !== 'function') {
      return { confirmed: false, reason: 'host_mute_bridge_unavailable' };
    }
    let confirmation;
    try {
      confirmation = bridge.confirmHostMuted(request);
    } catch (_) {
      return { confirmed: false, reason: 'host_mute_confirmation_failed' };
    }
    let timer = null;
    const timeout = Math.max(1, Math.min(5000, Number(timeoutMs) || 1000));
    try {
      const response = await Promise.race([
        Promise.resolve(confirmation),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ __mbfd_timeout: true }), timeout);
        }),
      ]);
      if (response?.__mbfd_timeout === true) {
        return { confirmed: false, reason: 'host_mute_confirmation_timeout' };
      }
      const exact = response
        && Number(response.version) === 1
        && response.confirmed === true
        && response.process_muted === true
        && text(response.device_id) === request.device_id
        && text(response.renderer_session_id) === request.renderer_session_id
        && text(response.transaction_id) === request.transaction_id
        && positiveSafeInteger(response.revision) === request.revision
        && positiveSafeInteger(response.generation) === request.generation;
      return exact
        ? { confirmed: true, reason: null }
        : { confirmed: false, reason: 'host_mute_confirmation_mismatch' };
    } catch (_) {
      return { confirmed: false, reason: 'host_mute_confirmation_failed' };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function createAudioPolicyController({ deviceId, fallbackAllowed = false } = {}) {
    const rendererId = text(deviceId);
    let current = null;
    let activeFence = null;
    let authorizationRevoked = false;
    let authorizationReason = null;
    // Cold start is fail-muted until either a durable cached policy or a fresh
    // authoritative playlist payload has been applied.
    let blocked = true;
    let blockedReason = 'cold_start';

    function reject(reason) {
      blocked = true;
      blockedReason = reason;
      return { applied: false, reason, policy: current ? { ...current } : null };
    }

    function block(reason = 'audio_policy_blocked') {
      blocked = true;
      blockedReason = String(reason || 'audio_policy_blocked');
      return { applied: true, reason: blockedReason, policy: current ? { ...current } : null };
    }

    function revokeAuthorization(reason = 'audio_authorization_revoked') {
      authorizationRevoked = true;
      authorizationReason = String(reason || 'audio_authorization_revoked');
      return block(authorizationReason);
    }

    function restoreAuthorization() {
      authorizationRevoked = false;
      authorizationReason = null;
    }

    function fence(raw) {
      const next = normalizeAudioPolicy(raw, rendererId);
      if (!next || next.revision === null || !next.transaction_id) {
        return reject('invalid_audio_policy_fence');
      }
      const floorRevision = Math.max(
        current?.revision ?? Number.NEGATIVE_INFINITY,
        activeFence?.revision ?? Number.NEGATIVE_INFINITY,
      );
      if (next.revision < floorRevision) return reject('stale_audio_policy');
      if (activeFence && next.revision === activeFence.revision
          && !samePolicyIdentity(next, activeFence)) {
        return reject('audio_policy_fence_conflict');
      }
      activeFence = { ...next };
      blocked = true;
      blockedReason = 'mute_before_owner_grant';
      return { applied: true, reason: blockedReason, policy: current ? { ...current } : null };
    }

    function apply(raw, context = {}) {
      if (authorizationRevoked) {
        return reject(authorizationReason || 'audio_authorization_revoked');
      }
      const next = normalizeAudioPolicy(raw, rendererId);
      if (!next || next.revision === null || !next.transaction_id) {
        return reject('invalid_audio_policy');
      }
      if (activeFence && next.revision < activeFence.revision) {
        return reject('stale_audio_policy');
      }
      if (activeFence && next.revision === activeFence.revision) {
        const ownerMatchesFence = !next.owner_device_id
          || next.owner_device_id === activeFence.owner_device_id;
        if (!samePolicyEpoch(next, activeFence) || !ownerMatchesFence) {
          return reject('audio_policy_fence_conflict');
        }
      }
      if (current && next.revision < current.revision) {
        return reject('stale_audio_policy');
      }
      if (current && next.revision === current.revision
          && !samePolicyIdentity(next, current)) {
        return reject('audio_policy_revision_conflict');
      }
      const contentIds = (Array.isArray(context.content_instance_ids)
        ? context.content_instance_ids
        : [])
        .map(text)
        .filter(Boolean);
      if (next.content_instance_id && contentIds.length && !contentIds.includes(next.content_instance_id)) {
        return reject('audio_content_instance_mismatch');
      }
      const playlistRevision = text(context.playlist_revision);
      if (next.playlist_revision && playlistRevision && next.playlist_revision !== playlistRevision) {
        return reject('audio_playlist_revision_mismatch');
      }
      const generations = (Array.isArray(context.content_generations)
        ? context.content_generations
        : [])
        .map(finiteNumber)
        .filter((value) => value !== null);
      if (next.generation !== null && generations.length && !generations.includes(next.generation)) {
        return reject('audio_generation_mismatch');
      }
      current = next;
      if (!activeFence || next.revision >= activeFence.revision) activeFence = null;
      blocked = false;
      blockedReason = null;
      return { applied: true, reason: null, policy: { ...current } };
    }

    function clear() {
      current = null;
      activeFence = null;
      blocked = authorizationRevoked;
      blockedReason = authorizationRevoked ? authorizationReason : null;
    }

    function audioAllowed() {
      if (blocked) return false;
      if (current) return current.audio_allowed === true && current.force_muted !== true;
      return fallbackAllowed === true;
    }

    function snapshot() {
      return current ? { ...current } : null;
    }

    function statusSnapshot() {
      if (!activeFence) return snapshot();
      return {
        ...activeFence,
        owner_device_id: null,
        audio_allowed: false,
        force_muted: true,
      };
    }

    function stateFields() {
      if (!current) return {};
      return {
        audio_owner_device_id: current.owner_device_id,
        audio_output_device_id: current.output_device_id,
        audio_policy_transaction_id: current.transaction_id,
        audio_policy_generation: current.generation,
        audio_policy_revision: current.revision,
      };
    }

    return {
      apply,
      audioAllowed,
      block,
      blockReason: () => blockedReason,
      clear,
      fence,
      hasPolicy: () => current !== null,
      isBlocked: () => blocked,
      restoreAuthorization,
      revokeAuthorization,
      snapshot,
      statusSnapshot,
      stateFields,
    };
  }

  return {
    confirmHostMuted,
    createAudioPolicyController,
    createRendererSessionId,
    normalizeAudioPolicy,
  };
}));
