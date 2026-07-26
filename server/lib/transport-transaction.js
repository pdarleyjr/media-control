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

module.exports = {
  EXPLICIT_SYNCHRONIZED_ACTIONS,
  createLiveTransportMirror,
  synchronizedPayload,
};
