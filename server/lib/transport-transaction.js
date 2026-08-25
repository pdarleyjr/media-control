'use strict';

const deviceContract = require('../player/device-contract');

const EXPLICIT_SYNCHRONIZED_ACTIONS = new Set([
  'next',
  'prev',
  'go_to_slide',
  'play',
  'pause',
  'seek',
  'restart',
  'stop',
]);

function text(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function synchronizedPayload(sourcePayload, transactionId) {
  const source = sourcePayload && typeof sourcePayload === 'object' ? sourcePayload : {};
  const action = text(source.action, 40).toLowerCase();
  const payload = {
    action,
    transport_transaction_id: transactionId,
    idempotency_key: transactionId,
    mirror_to_live_program: true,
    transaction_target_count: Math.max(1, Math.min(100, Number(source.transaction_target_count) || 1)),
  };
  if (source.content_instance_id) payload.content_instance_id = text(source.content_instance_id);
  if (action === 'go_to_slide') {
    const slide = Number(source.slide ?? source.page ?? source.slide_index);
    if (Number.isInteger(slide) && slide > 0) {
      payload.slide = slide;
      payload.page = slide;
      payload.slide_index = slide;
    }
  }
  if (action === 'seek') {
    for (const key of [
      'seconds', 'position_seconds', 'position', 'time',
      'position_normalized', 'normalized_position', 'progress',
      'position_percent', 'percent',
    ]) {
      if (source[key] != null && Number.isFinite(Number(source[key]))) {
        payload[key] = Number(source[key]);
      }
    }
  }
  return payload;
}

/**
 * Workspace-scoped, bounded idempotency gate for classroom -> Live Program
 * transport mirroring. Every dispatch re-checks content_active before consulting
 * the dedupe cache, so clearing Live Program immediately stops future mirrors.
 */
function createLiveTransportMirror({
  lookupWorkspace,
  getProgramState,
  getLiveDeviceId,
  markContentChanged,
  persistCommand,
  isDeviceOnline,
  emitCommand,
  queueCommand,
  now = Date.now,
  ttlMs = 5 * 60 * 1000,
  maxEntries = 1000,
} = {}) {
  for (const dependency of [
    lookupWorkspace,
    getProgramState,
    getLiveDeviceId,
    persistCommand,
    isDeviceOnline,
    emitCommand,
    queueCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('Live transport mirror dependencies are required');
    }
  }
  const transactions = new Map();

  function sweep(timestamp) {
    for (const [key, entry] of transactions) {
      if (timestamp - entry.created_at > ttlMs) transactions.delete(key);
    }
    while (transactions.size >= maxEntries) {
      transactions.delete(transactions.keys().next().value);
    }
  }

  function dispatch({ sourceDeviceId, envelope, userId } = {}) {
    const payload = envelope?.type === 'device:command' && envelope.payload;
    const action = text(payload?.action, 40).toLowerCase();
    const transactionId = text(payload?.transport_transaction_id || payload?.idempotency_key);
    if (!EXPLICIT_SYNCHRONIZED_ACTIONS.has(action)) {
      return { included: false, reason: 'ambiguous_or_unsupported_action', transaction_id: transactionId || null };
    }
    if (!transactionId) {
      return { included: false, reason: 'missing_transport_transaction', transaction_id: null };
    }
    if (
      text(payload.transport_transaction_id)
      && text(payload.idempotency_key)
      && text(payload.transport_transaction_id) !== text(payload.idempotency_key)
    ) {
      return { included: false, reason: 'transport_idempotency_mismatch', transaction_id: transactionId };
    }
    if (payload.mirror_to_live_program !== true) {
      return { included: false, reason: 'live_mirror_not_requested', transaction_id: transactionId };
    }

    const workspaceId = lookupWorkspace(sourceDeviceId);
    if (!workspaceId) {
      return { included: false, reason: 'workspace_not_found', transaction_id: transactionId };
    }
    const program = getProgramState(workspaceId) || {};
    if (!program.content_active) {
      return { included: false, reason: 'live_content_inactive', transaction_id: transactionId };
    }
    const liveDeviceId = getLiveDeviceId(workspaceId);
    if (!liveDeviceId || liveDeviceId === sourceDeviceId) {
      return { included: false, reason: 'live_receiver_not_eligible', transaction_id: transactionId };
    }

    const timestamp = Number(now()) || Date.now();
    sweep(timestamp);
    const dedupeKey = `${workspaceId}:${transactionId}`;
    const livePayload = synchronizedPayload(payload, transactionId);
    const fingerprint = JSON.stringify(livePayload);
    const existing = transactions.get(dedupeKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          included: false,
          reason: 'transport_idempotency_conflict',
          transaction_id: transactionId,
        };
      }
      return {
        ...existing.result,
        owner: false,
        deduplicated: true,
      };
    }

    // Deliberately rebuild the payload from the explicit transport vocabulary.
    // Classroom speaker/volume/mute fields are never copied to the virtual
    // program receiver; its audio remains controlled only by program policy.
    let persisted = null;
    try {
      persisted = persistCommand({
        target_type: 'display',
        target_id: liveDeviceId,
        command_type: action,
        payload: livePayload,
        issued_by: userId || null,
        requires_ack: 1,
      });
    } catch (_) {
      persisted = null;
    }
    if (!persisted?.command_id) {
      return { included: false, reason: 'live_command_persistence_failed', transaction_id: transactionId };
    }
    const liveEnvelope = deviceContract.createCommand({
      ...envelope,
      command_id: persisted.command_id,
      device_id: liveDeviceId,
      target_scope: 'display',
      payload: livePayload,
    });
    const online = isDeviceOnline(liveDeviceId);
    let delivered = false;
    let queued = false;
    if (online) {
      emitCommand(liveDeviceId, liveEnvelope);
      delivered = true;
    } else {
      queued = queueCommand(liveDeviceId, liveEnvelope) === true;
    }
    if (typeof markContentChanged === 'function') markContentChanged(liveDeviceId);
    const result = {
      included: true,
      owner: true,
      deduplicated: false,
      transaction_id: transactionId,
      target_count: livePayload.transaction_target_count,
      device_id: liveDeviceId,
      command_id: persisted.command_id,
      delivered,
      queued,
    };
    transactions.set(dedupeKey, { created_at: timestamp, fingerprint, result });
    return result;
  }

  return { dispatch };
}

const TRANSPORT_ACTIONS = new Set([
  'next', 'prev', 'next_slide', 'previous_slide', 'go_to_slide',
  'play', 'pause', 'play_pause', 'resume', 'stop', 'restart', 'restart_deck',
  'seek', 'seek_forward', 'seek_backward',
]);

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function present(value) {
  return value != null && value !== '';
}

function clonePayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : {};
}

/**
 * Relative transport is unsafe when one operator action fans out to several
 * renderers: a duplicated "next" advances twice. Convert it to the absolute
 * state the authoritative player has already reported whenever possible.
 */
function canonicalizeTransportAction(action, payload = {}, state = {}) {
  const requested = String(action || payload.action || '').trim().toLowerCase();
  const body = clonePayload(payload);
  delete body.action;

  if (requested === 'play_pause' && typeof state.paused === 'boolean') {
    const explicit = state.paused ? 'play' : 'pause';
    return { action: explicit, payload: { ...body, action: explicit } };
  }

  const isNext = requested === 'next' || requested === 'next_slide';
  const isPrevious = requested === 'prev' || requested === 'previous_slide';
  const slideIndex = integer(state.slide_index ?? state.slideIndex);
  const slideCount = integer(state.slide_count ?? state.slideCount);
  if ((isNext || isPrevious) && slideIndex != null && slideIndex >= 1) {
    const candidate = slideIndex + (isNext ? 1 : -1);
    const target = slideCount != null && slideCount >= 1
      ? Math.min(slideCount, Math.max(1, candidate))
      : Math.max(1, candidate);
    return {
      action: 'go_to_slide',
      payload: {
        ...body,
        action: 'go_to_slide',
        slide: target,
        page: target,
        slide_index: target,
      },
    };
  }

  return { action: requested, payload: { ...body, action: requested } };
}

function stablePayloadFingerprint(payload) {
  const source = clonePayload(payload);
  const sorted = {};
  for (const key of Object.keys(source).sort()) sorted[key] = source[key];
  return JSON.stringify(sorted);
}

function createTransportTransactionCoordinator(dependencies = {}) {
  const {
    getDevice,
    listWorkspaceDevices,
    getDisplayState,
    getLiveState,
    getRoomRevision,
    getContentGeneration,
    isDeviceOnline,
    emitToDevice,
    queueToDevice,
    ingestCommand,
    createCommand,
    resolveAudioAuthority,
    getAudioPolicy,
    randomUUID,
    now,
  } = dependencies;
  for (const dependency of [
    getDevice,
    listWorkspaceDevices,
    getLiveState,
    isDeviceOnline,
    emitToDevice,
    ingestCommand,
    createCommand,
  ]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('Transport transaction coordinator dependencies are required');
    }
  }
  const uuid = typeof randomUUID === 'function'
    ? randomUUID
    : () => require('crypto').randomUUID();
  const clock = typeof now === 'function' ? now : Date.now;
  const idempotencyTtlMs = Math.max(1000, Number(dependencies.idempotencyTtlMs) || 5 * 60 * 1000);
  const legacyWindowMs = Math.max(100, Number(dependencies.legacyWindowMs) || 600);
  const transactions = new Map();
  const legacyTransactions = new Map();

  function sweep(expireAt) {
    for (const [key, transaction] of transactions) {
      if (transaction.expiresAt <= expireAt) transactions.delete(key);
    }
    for (const [key, transaction] of legacyTransactions) {
      if (transaction.legacyExpiresAt <= expireAt) legacyTransactions.delete(key);
    }
  }

  function snapshot(transaction, options = {}) {
    return {
      ok: transaction.ok !== false,
      duplicate: options.duplicate === true,
      transaction_id: transaction.id,
      idempotency_key: transaction.idempotencyKey,
      workspace_id: transaction.workspaceId,
      action: transaction.action,
      content_instance_id: transaction.contentInstanceId,
      expected_revision: transaction.expectedRevision,
      expected_generation: transaction.expectedGeneration,
      targets: [...transaction.targets.values()].map((target) => ({ ...target })),
      ...(transaction.error ? { error: transaction.error } : {}),
    };
  }

  function invalid(error, details = {}) {
    return {
      ok: false,
      duplicate: false,
      error,
      targets: [],
      ...details,
    };
  }

  function sourceStateFor(deviceIds) {
    if (typeof getDisplayState !== 'function') return {};
    for (const id of deviceIds) {
      const state = getDisplayState(id);
      if (state && typeof state === 'object') return state;
    }
    return {};
  }

  function resolveContext(request, deviceIds) {
    const sourceState = sourceStateFor(deviceIds);
    const incoming = clonePayload(request.payload);
    const canonical = canonicalizeTransportAction(request.action, incoming, sourceState);
    const contentId = incoming.content_id
      ?? sourceState.current_content_id
      ?? sourceState.content_id
      ?? null;
    const contentInstanceId = incoming.content_instance_id
      ?? request.contentInstanceId
      ?? sourceState.content_instance_id
      ?? sourceState.current_asset_id
      ?? contentId;
    const expectedRevision = incoming.expected_revision
      ?? request.expectedRevision
      ?? (typeof getRoomRevision === 'function'
        ? getRoomRevision(request.workspaceId, request.roomId)
        : sourceState.state_revision ?? sourceState.playback_revision ?? null);
    const expectedGeneration = incoming.expected_generation
      ?? request.expectedGeneration
      ?? sourceState.expected_generation
      ?? sourceState.generation
      ?? (typeof getContentGeneration === 'function'
        ? getContentGeneration(contentId, sourceState.current_asset_id ?? null)
        : null);
    return {
      action: canonical.action,
      payload: canonical.payload,
      contentId,
      contentInstanceId: present(contentInstanceId) ? contentInstanceId : null,
      expectedRevision: present(expectedRevision) ? expectedRevision : null,
      expectedGeneration: present(expectedGeneration) ? expectedGeneration : null,
    };
  }

  function audioAuthority(workspaceId, deviceIds) {
    if (typeof getAudioPolicy === 'function') {
      const policies = deviceIds.map((deviceId) => getAudioPolicy(deviceId));
      const first = policies[0] || null;
      const common = Boolean(first)
        && policies.every((policy) => (
          policy
          && String(policy.transaction_id || '') === String(first.transaction_id || '')
          && Number(policy.revision) === Number(first.revision)
          && String(policy.content_instance_id || '') === String(first.content_instance_id || '')
          && Number(policy.generation) === Number(first.generation)
          && String(policy.owner_device_id || '') === String(first.owner_device_id || '')
          && String(policy.output_device_id || '') === String(first.output_device_id || '')
        ));
      return {
        authorityDeviceId: common ? (first.owner_device_id || null) : null,
        audioPolicy: common ? first : null,
        conflict: !common,
      };
    }
    const devices = listWorkspaceDevices(workspaceId) || [];
    const resolved = typeof resolveAudioAuthority === 'function'
      ? resolveAudioAuthority(devices)
      : { valid: false, authority_device_id: null };
    return {
      authorityDeviceId: resolved && resolved.valid ? resolved.authority_device_id : null,
      audioPolicy: null,
      conflict: false,
    };
  }

  function buildTransaction(request, deviceIds, idempotencyKey, fingerprint) {
    const context = resolveContext(request, deviceIds);
    const createdAt = clock();
    const audio = audioAuthority(request.workspaceId, deviceIds);
    return {
      ok: true,
      id: uuid(),
      idempotencyKey,
      fingerprint,
      workspaceId: request.workspaceId,
      roomId: request.roomId || null,
      issuedBy: request.issuedBy || null,
      action: context.action,
      payload: context.payload,
      contentId: context.contentId,
      contentInstanceId: context.contentInstanceId,
      expectedRevision: context.expectedRevision,
      expectedGeneration: context.expectedGeneration,
      requestPayload: clonePayload(request.payload),
      requestOverrides: {
        contentId: request.contentId,
        contentInstanceId: request.contentInstanceId,
        expectedRevision: request.expectedRevision,
        expectedGeneration: request.expectedGeneration,
      },
      authorityDeviceId: audio.authorityDeviceId,
      audioPolicy: audio.audioPolicy,
      audioPolicyConflict: audio.conflict,
      targets: new Map(),
      liveConsidered: false,
      createdAt,
      expiresAt: createdAt + idempotencyTtlMs,
      legacyExpiresAt: createdAt + legacyWindowMs,
    };
  }

  function targetPayload(transaction, deviceId, targetRole) {
    const state = (typeof getDisplayState === 'function' ? getDisplayState(deviceId) : null) || {};
    const incoming = clonePayload(transaction.requestPayload || {});
    const overrides = transaction.requestOverrides || {};
    const contentId = present(overrides.contentId) ? overrides.contentId
      : incoming.content_id ?? state.current_content_id ?? state.content_id ?? transaction.contentId ?? null;
    const contentInstanceId = present(overrides.contentInstanceId) ? overrides.contentInstanceId
      : incoming.content_instance_id ?? state.content_instance_id ?? state.current_asset_id ?? contentId;
    const expectedGeneration = present(overrides.expectedGeneration) ? overrides.expectedGeneration
      : incoming.expected_generation
        ?? state.expected_generation
        ?? state.generation
        ?? (typeof getContentGeneration === 'function'
          ? getContentGeneration(contentId, state.current_asset_id ?? null)
          : null);
    const audioPolicyMatches = !transaction.audioPolicy || (
      present(transaction.audioPolicy.content_instance_id)
      && present(contentInstanceId)
      && String(transaction.audioPolicy.content_instance_id) === String(contentInstanceId)
      && Number.isFinite(Number(transaction.audioPolicy.generation))
      && Number.isFinite(Number(expectedGeneration))
      && Number(transaction.audioPolicy.generation) === Number(expectedGeneration)
    );
    const audioAllowed = targetRole === 'physical'
      && transaction.authorityDeviceId === deviceId
      && audioPolicyMatches;
    return {
      ...transaction.payload,
      action: transaction.action,
      device_id: deviceId,
      workspace_id: transaction.workspaceId,
      transport_transaction_id: transaction.id,
      idempotency_key: transaction.idempotencyKey,
      ...(present(transaction.roomId) ? { room_id: transaction.roomId } : {}),
      ...(present(contentId) ? { content_id: contentId } : {}),
      ...(present(contentInstanceId)
        ? { content_instance_id: contentInstanceId }
        : {}),
      ...(present(transaction.expectedRevision)
        ? { expected_revision: transaction.expectedRevision }
        : {}),
      ...(present(expectedGeneration)
        ? { expected_generation: expectedGeneration }
        : {}),
      audio_authority_device_id: transaction.authorityDeviceId,
      audio_allowed: audioAllowed,
      force_muted: !audioAllowed,
      ...(transaction.audioPolicy ? {
        audio_policy_transaction_id: transaction.audioPolicy.transaction_id || null,
        audio_policy_revision: transaction.audioPolicy.revision ?? null,
        audio_policy_content_instance_id: transaction.audioPolicy.content_instance_id || null,
        audio_policy_generation: transaction.audioPolicy.generation ?? null,
      } : {}),
      ...(transaction.audioPolicy && !audioPolicyMatches ? { audio_policy_mismatch: true } : {}),
      ...(transaction.audioPolicyConflict ? { audio_policy_conflict: true } : {}),
    };
  }

  function dispatchTarget(transaction, deviceId, targetRole, suppliedCommandId = null) {
    if (transaction.targets.has(deviceId)) return transaction.targets.get(deviceId);
    const commandId = suppliedCommandId || uuid();
    const payload = targetPayload(transaction, deviceId, targetRole);
    const envelope = createCommand({
      command_id: commandId,
      device_id: deviceId,
      target_scope: 'display',
      payload,
    });
    const target = {
      device_id: deviceId,
      target_role: targetRole,
      command_id: envelope.command_id,
      delivered: false,
      queued: false,
      status: 'pending',
    };

    try {
      const online = isDeviceOnline(deviceId);
      const command = ingestCommand({
        target_type: 'display',
        target_id: deviceId,
        command_type: transaction.action,
        payload,
        issued_by: transaction.issuedBy,
        requires_ack: online ? 1 : 0,
        command_id: envelope.command_id,
        created_at: Date.parse(envelope.issued_at),
      });
      if (command && command.command_id) target.command_id = command.command_id;
      if (target.command_id !== envelope.command_id) {
        throw new Error('Persisted command identity mismatch');
      }
      if (online) {
        emitToDevice(deviceId, envelope);
        target.delivered = true;
        target.status = 'delivered';
      } else {
        target.queued = typeof queueToDevice === 'function'
          ? queueToDevice(deviceId, envelope) === true
          : false;
        target.status = target.queued ? 'queued' : 'offline';
        target.reason = 'offline';
      }
    } catch (error) {
      target.status = 'failed';
      target.reason = 'persistence_failed';
      target.error = error && error.message ? error.message : String(error);
    }
    transaction.targets.set(deviceId, target);
    return target;
  }

  function validatePhysicalTargets(workspaceId, deviceIds) {
    const normalized = [...new Set((Array.isArray(deviceIds) ? deviceIds : [])
      .filter(Boolean)
      .map(String))];
    if (!workspaceId) return { error: 'missing_workspace_id', deviceIds: [] };
    if (!normalized.length) return { error: 'missing_device_ids', deviceIds: [] };
    for (const deviceId of normalized) {
      const device = getDevice(deviceId);
      if (!device) return { error: 'device_not_found', deviceIds: [], deviceId };
      if (String(device.workspace_id || '') !== String(workspaceId)) {
        return { error: 'workspace_mismatch', deviceIds: [], deviceId };
      }
    }
    return { error: null, deviceIds: normalized };
  }

  function includeLiveProgram(transaction) {
    if (transaction.liveConsidered) return;
    transaction.liveConsidered = true;
    const live = getLiveState(transaction.workspaceId);
    if (!live || live.content_active !== true || !live.display_id) return;
    if (transaction.targets.has(String(live.display_id))) return;
    dispatchTarget(transaction, String(live.display_id), 'live-program');
  }

  function dispatch(request = {}) {
    const at = clock();
    sweep(at);
    const workspaceId = String(request.workspaceId || '').trim();
    const action = String(request.action || request.payload?.action || '').trim().toLowerCase();
    if (!TRANSPORT_ACTIONS.has(action)) return invalid('invalid_transport_action');
    const validation = validatePhysicalTargets(workspaceId, request.deviceIds);
    if (validation.error) {
      return invalid(validation.error, validation.deviceId ? { device_id: validation.deviceId } : {});
    }
    const deviceIds = validation.deviceIds;
    const idempotencyKey = String(request.idempotencyKey || uuid()).trim();
    const fingerprint = JSON.stringify({
      workspaceId,
      deviceIds: [...deviceIds].sort(),
      action,
      payload: stablePayloadFingerprint(request.payload),
    });
    const cacheKey = `${workspaceId}\u0000${idempotencyKey}`;
    const existing = transactions.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return invalid('idempotency_conflict', {
          transaction_id: existing.id,
          idempotency_key: idempotencyKey,
        });
      }
      return snapshot(existing, { duplicate: true });
    }

    const transaction = buildTransaction(
      { ...request, workspaceId, action },
      deviceIds,
      idempotencyKey,
      fingerprint,
    );
    transactions.set(cacheKey, transaction);
    for (const deviceId of deviceIds) dispatchTarget(transaction, deviceId, 'physical');
    includeLiveProgram(transaction);
    return snapshot(transaction);
  }

  function dispatchLegacyTarget(request = {}) {
    const at = clock();
    sweep(at);
    const workspaceId = String(request.workspaceId || '').trim();
    const action = String(request.action || request.payload?.action || '').trim().toLowerCase();
    if (!TRANSPORT_ACTIONS.has(action)) return invalid('invalid_transport_action');
    const validation = validatePhysicalTargets(workspaceId, [request.deviceId]);
    if (validation.error) {
      return invalid(validation.error, validation.deviceId ? { device_id: validation.deviceId } : {});
    }
    const sharedPayload = clonePayload(request.payload);
    delete sharedPayload.device_id;
    delete sharedPayload.transport_transaction_id;
    delete sharedPayload.idempotency_key;
    delete sharedPayload.transaction_target_count;
    delete sharedPayload.mirror_to_live_program;
    const payloadFingerprint = stablePayloadFingerprint(sharedPayload);
    const suppliedIdempotencyKey = String(
      request.payload?.transport_transaction_id
      || request.payload?.idempotency_key
      || '',
    ).trim();
    const fingerprint = JSON.stringify({ workspaceId, action, payload: payloadFingerprint });
    const legacyKey = suppliedIdempotencyKey
      ? [workspaceId, String(request.issuedBy || ''), suppliedIdempotencyKey].join('\u0000')
      : [
        workspaceId,
        String(request.issuedBy || ''),
        action,
        payloadFingerprint,
        Math.floor(at / legacyWindowMs),
      ].join('\u0000');
    let transaction = legacyTransactions.get(legacyKey);
    if (transaction && transaction.fingerprint !== fingerprint) {
      return invalid('idempotency_conflict', {
        transaction_id: transaction.id,
        idempotency_key: transaction.idempotencyKey,
      });
    }
    if (!transaction) {
      const idempotencyKey = suppliedIdempotencyKey || `legacy-${uuid()}`;
      transaction = buildTransaction(
        { ...request, workspaceId, action },
        validation.deviceIds,
        idempotencyKey,
        fingerprint,
      );
      legacyTransactions.set(legacyKey, transaction);
      transactions.set(`${workspaceId}\u0000${idempotencyKey}`, transaction);
      dispatchTarget(transaction, request.deviceId, 'physical', request.commandId);
      includeLiveProgram(transaction);
    } else {
      dispatchTarget(transaction, request.deviceId, 'physical', request.commandId);
      transaction.legacyExpiresAt = at + legacyWindowMs;
    }
    return snapshot(transaction, {
      duplicate: transaction.targets.has(request.deviceId)
        && transaction.targets.size > 1,
    });
  }

  return {
    dispatch,
    dispatchLegacyTarget,
  };
}

module.exports = {
  EXPLICIT_SYNCHRONIZED_ACTIONS,
  TRANSPORT_ACTIONS,
  canonicalizeTransportAction,
  createTransportTransactionCoordinator,
  createLiveTransportMirror,
  synchronizedPayload,
};
