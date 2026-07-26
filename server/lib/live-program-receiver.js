'use strict';

const crypto = require('node:crypto');

function receiverError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sourceDescriptor(source) {
  const value = source && typeof source === 'object' ? source : {};
  if (value.type === 'content' && value.contentId) {
    return {
      sourceType: 'content',
      sourceId: String(value.contentId),
      playerSource: { content_id: String(value.contentId) },
    };
  }
  if (value.type === 'presentation' && value.presentationId && value.remoteUrl) {
    return {
      sourceType: 'presentation',
      sourceId: String(value.presentationId),
      playerSource: { remote_url: String(value.remoteUrl) },
    };
  }
  if (value.type === 'remote_url' && value.remoteUrl) {
    return {
      sourceType: 'remote_url',
      sourceId: `sha256:${crypto.createHash('sha256').update(String(value.remoteUrl)).digest('hex').slice(0, 32)}`,
      playerSource: { remote_url: String(value.remoteUrl) },
    };
  }
  throw receiverError(
    'CONTENT_SOURCE_REQUIRED',
    'Live Program requires an authorized content, presentation, or remote source',
    400,
  );
}

function createLiveProgramReceiver({
  database,
  deliveryStore,
  ensureDisplay,
  sceneEngine,
  markContentChanged,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  confirmTimeoutMs = 15000,
} = {}) {
  if (!deliveryStore || !ensureDisplay || !sceneEngine || !markContentChanged) {
    throw new TypeError('Live Program receiver dependencies are required');
  }

  async function waitForDelivery(requestId, contentInstanceId) {
    const deadline = Date.now() + Math.max(250, Number(confirmTimeoutMs) || 15000);
    while (Date.now() <= deadline) {
      const request = deliveryStore.getRequest(requestId);
      const device = request && Array.isArray(request.devices) ? request.devices[0] : null;
      if (request && request.status === 'confirmed' && device && device.state === 'confirmed') {
        const state = device.confirmed_player_state || {};
        if (String(state.content_instance_id || '') !== String(contentInstanceId)) {
          throw receiverError(
            'RECEIVER_CONTENT_INSTANCE_MISMATCH',
            'Live Program confirmed a different content instance',
            409,
          );
        }
        if (!state.render_state || state.render_state === 'error' || state.error_state) {
          throw receiverError(
            'RECEIVER_RENDER_NOT_CONFIRMED',
            'Live Program did not report a render-ready state',
          );
        }
        return { request, device, state };
      }
      if (request && ['failed', 'partial', 'timed_out'].includes(request.status)) {
        throw receiverError(
          'RECEIVER_RENDER_NOT_CONFIRMED',
          device && device.failure_reason
            ? device.failure_reason
            : 'Live Program receiver did not confirm the requested render',
        );
      }
      await wait(100);
    }
    throw receiverError(
      'RECEIVER_RENDER_TIMEOUT',
      'Live Program receiver render confirmation timed out',
    );
  }

  async function assignContent({
    workspaceId,
    userId,
    source,
    contentInstanceId,
    requestId,
    io,
    contentContext,
  }) {
    const display = ensureDisplay({ workspaceId, userId });
    const descriptor = sourceDescriptor(source);
    const delivery = deliveryStore.createRequest({
      workspaceId,
      userId,
      sourceType: descriptor.sourceType,
      sourceId: descriptor.sourceId,
      typedTargets: [{ type: 'display', id: display.id }],
      expectedTargetCount: 1,
      idempotencyKey: requestId,
      requestFingerprint: crypto
        .createHash('sha256')
        .update(JSON.stringify({
          workspace_id: workspaceId,
          source: descriptor.sourceId,
          content_instance_id: contentInstanceId,
        }))
        .digest('hex'),
      targets: [{
        deviceId: display.id,
        expectedSourceId: descriptor.sourceType === 'content'
          ? descriptor.sourceId
          : null,
      }],
    });
    const deviceDelivery = delivery.devices[0];
    const result = sceneEngine.pushSourceToDevice(
      io,
      display.id,
      {
        ...descriptor.playerSource,
        content_instance_id: contentInstanceId,
      },
      {
        workspaceId,
        userId,
        contentContext,
        targetDeviceIds: [display.id],
        returnDetails: true,
        delivery: {
          requestId: delivery.id,
          commandId: deviceDelivery.command_id,
          sourceId: descriptor.sourceId,
          sourceType: descriptor.sourceType,
          expectedSourceId: descriptor.sourceType === 'content'
            ? descriptor.sourceId
            : null,
          contentInstanceId,
        },
      },
    );
    deliveryStore.markDispatched({
      requestId: delivery.id,
      deviceId: display.id,
      commandId: deviceDelivery.command_id,
      delivered: result.delivered,
      queued: result.queued,
      playlistRevision: result.playlistRevision,
      expectedSourceId: result.expectedSourceId,
      failureReason: result.failureReason,
    });
    if (!result.ok) {
      throw receiverError(
        'RECEIVER_ASSIGN_FAILED',
        result.failureReason || 'Live Program content assignment failed',
      );
    }
    markContentChanged(display.id);
    const confirmed = await waitForDelivery(delivery.id, contentInstanceId);
    return {
      confirmed: true,
      contentId: confirmed.state.current_content_id || result.expectedSourceId || null,
      contentInstanceId,
      playlistRevision: confirmed.device.playlist_revision || result.playlistRevision || null,
      renderGeneration: confirmed.device.render_generation ?? null,
      renderState: confirmed.state.render_state,
      requestId: delivery.id,
      displayId: display.id,
    };
  }

  async function clearContent({ workspaceId, contentInstanceId, io }) {
    const display = ensureDisplay({ workspaceId, userId: null });
    const device = database.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(display.id);
    if (device && device.playlist_id) {
      database.prepare(`
        UPDATE playlists
        SET status = 'published', published_snapshot = '[]', updated_at = strftime('%s','now')
        WHERE id = ?
      `).run(device.playlist_id);
    }
    try {
      const commandQueue = require('./command-queue');
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      if (io && typeof io.of === 'function') {
        commandQueue.queueOrEmitPlaylistUpdate(
          io.of('/device'),
          display.id,
          buildPlaylistPayload,
        );
      }
    } catch (_) {}
    markContentChanged(display.id);
    const deadline = Date.now() + Math.max(250, Number(confirmTimeoutMs) || 15000);
    while (Date.now() <= deadline) {
      const state = database.prepare(`
        SELECT current_content_id, render_state, error_state
        FROM display_states
        WHERE target_type = 'display' AND target_id = ?
      `).get(display.id);
      if (
        state
        && !state.current_content_id
        && !state.error_state
        && ['idle', 'cleared'].includes(String(state.render_state || '').toLowerCase())
      ) {
        return {
          confirmed: true,
          cleared: true,
          contentInstanceId: contentInstanceId || null,
          displayId: display.id,
        };
      }
      await wait(100);
    }
    throw receiverError(
      'RECEIVER_CLEAR_TIMEOUT',
      'Live Program receiver did not confirm content removal',
    );
  }

  async function setAudioPolicy(policy, { workspaceId, io, revision } = {}) {
    if (policy !== 'camera' && policy !== 'content_replace') {
      throw receiverError('INVALID_AUDIO_POLICY', 'Invalid Live Program audio policy', 400);
    }
    const display = ensureDisplay({ workspaceId, userId: null });
    const namespace = io && typeof io.of === 'function' ? io.of('/device') : null;
    if (!namespace || typeof namespace.timeout !== 'function') {
      throw receiverError(
        'RECEIVER_AUDIO_POLICY_UNAVAILABLE',
        'Live Program receiver audio-policy acknowledgement is unavailable',
      );
    }
    const expectedRevision = Number(revision) || 0;
    const responses = await new Promise((resolve, reject) => {
      namespace
        .timeout(Math.max(250, Number(confirmTimeoutMs) || 15000))
        .to(display.id)
        .emit('device:program-audio-policy', {
          policy,
          revision: expectedRevision,
        }, (error, acknowledgements) => {
          if (error) {
            reject(receiverError(
              'RECEIVER_AUDIO_POLICY_TIMEOUT',
              'Live Program receiver did not acknowledge the audio policy',
            ));
            return;
          }
          resolve(acknowledgements);
        });
    });
    const acknowledgement = Array.isArray(responses) ? responses[0] : responses;
    if (
      !acknowledgement
      || acknowledgement.ok !== true
      || acknowledgement.policy !== policy
      || Number(acknowledgement.revision) !== expectedRevision
    ) {
      throw receiverError(
        'RECEIVER_AUDIO_POLICY_MISMATCH',
        'Live Program receiver acknowledged a different audio policy or revision',
        409,
      );
    }
    return {
      policy,
      revision: expectedRevision,
      delivered: true,
      confirmed: true,
      displayId: display.id,
    };
  }

  return {
    assignContent,
    clearContent,
    setAudioPolicy,
  };
}

let defaultReceiver = null;

function getDefaultReceiver() {
  if (defaultReceiver) return defaultReceiver;
  const { db } = require('../db/database');
  const { getBroadcastDeliveryStore } = require('./broadcast-delivery');
  const sceneEngine = require('../services/scene-engine');
  const {
    ensureLiveStreamDisplay,
    markLiveContentChanged,
  } = require('./live-stream-display');
  defaultReceiver = createLiveProgramReceiver({
    database: db,
    deliveryStore: getBroadcastDeliveryStore(db),
    ensureDisplay: ensureLiveStreamDisplay,
    sceneEngine,
    markContentChanged: markLiveContentChanged,
    confirmTimeoutMs: Math.max(
      1000,
      Number(process.env.LIVE_STREAM_RECEIVER_CONFIRM_TIMEOUT_MS) || 15000,
    ),
  });
  return defaultReceiver;
}

module.exports = {
  assignContent(...args) {
    return getDefaultReceiver().assignContent(...args);
  },
  clearContent(...args) {
    return getDefaultReceiver().clearContent(...args);
  },
  createLiveProgramReceiver,
  setAudioPolicy(...args) {
    return getDefaultReceiver().setAudioPolicy(...args);
  },
};
